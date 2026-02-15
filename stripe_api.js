const express = require('express');
const { DateTime } = require('luxon');
const { Pool } = require('pg');
const router = express.Router();

const CHICAGO_ZONE = 'America/Chicago';

// Set STRIPE_SECRET_KEY in .env or Cloud Run (never commit the real key)
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? require('stripe')(stripeSecretKey) : null;

// Database pool for station lookup (stations.stripe_id = charge.customer)
const CLOUD_SQL_CONNECTION_NAME = process.env.CLOUD_SQL_CONNECTION_NAME || 'keyextract-482721:us-central1:cuub-db';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASS = process.env.DB_PASS || '1Cuubllc!';
const DB_NAME = process.env.DB_NAME || 'postgres';
const poolConfig = {
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
};
if (CLOUD_SQL_CONNECTION_NAME && CLOUD_SQL_CONNECTION_NAME.includes(':')) {
  poolConfig.host = `/cloudsql/${CLOUD_SQL_CONNECTION_NAME}`;
} else {
  poolConfig.host = process.env.DB_HOST || 'localhost';
  poolConfig.port = process.env.DB_PORT || 5432;
}
const pool = new Pool(poolConfig);

/**
 * Return YYYY-MM-DD for a Unix timestamp (seconds) in Chicago time (for grouping and mtd range).
 */
function chicagoDateStringFromUnix(unixSeconds) {
  return DateTime.fromSeconds(unixSeconds, { zone: 'utc' }).setZone(CHICAGO_ZONE).toISODate().slice(0, 10);
}

/**
 * Parse a date string (YYYY-MM-DD) or "mtd" to Unix seconds. All in America/Chicago.
 * "mtd" = start of current month in Chicago.
 * YYYY-MM-DD = that day in Chicago (start or end of day).
 */
function parseDateToUnixSeconds(value, endOfDay = false) {
  let dt;
  if (value === 'mtd' || value === undefined) {
    dt = DateTime.now().setZone(CHICAGO_ZONE).startOf('month');
  } else {
    dt = DateTime.fromISO(value + 'T00:00:00', { zone: CHICAGO_ZONE });
    if (endOfDay) dt = dt.endOf('day');
    else dt = dt.startOf('day');
  }
  return Math.floor(dt.toSeconds());
}

/**
 * Fetch all balance transactions in a date range (paginates until done).
 */
async function fetchAllBalanceTransactionsInRange(gteUnix, lteUnix) {
  const all = [];
  let startingAfter = undefined;
  do {
    const listParams = {
      limit: 100,
      created: { gte: gteUnix, lte: lteUnix },
      ...(startingAfter && { starting_after: startingAfter }),
    };
    const batch = await stripe.balanceTransactions.list(listParams);
    all.push(...batch.data);
    startingAfter = batch.has_more ? batch.data[batch.data.length - 1].id : null;
  } while (startingAfter);
  return all;
}

/**
 * Fetch all charges in a date range (paginates until done).
 * @param {number} gteUnix - start of range (Unix seconds)
 * @param {number} lteUnix - end of range (Unix seconds)
 * @param {string} [customerId] - optional Stripe customer ID (maps to stations.stripe_id) to filter by
 */
async function fetchAllChargesInRange(gteUnix, lteUnix, customerId = null) {
  const all = [];
  let startingAfter = undefined;
  do {
    const listParams = {
      limit: 100,
      created: { gte: gteUnix, lte: lteUnix },
      ...(customerId && { customer: customerId }),
      ...(startingAfter && { starting_after: startingAfter }),
    };
    const batch = await stripe.charges.list(listParams);
    all.push(...batch.data);
    startingAfter = batch.has_more ? batch.data[batch.data.length - 1].id : null;
  } while (startingAfter);
  return all;
}

/**
 * Format date string YYYY-MM-DD as "Feb 1, 2026" (interpreted as local date for display).
 */
function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

// Transaction types included in positive/negative revenue (customer revenue + fee types for true net).
const REVENUE_TYPES = new Set([
  'charge',
  'payment',
  'payment_refund',
  'refund',
  'payment_reversal',
  'payment_failure_refund',
  'stripe_fee',
  'stripe_fx_fee',
  'tax_fee',
]);

/**
 * Aggregate balance transactions into positive/negative totals and per-day rents/money.
 * @param {Array} balanceTransactions - from Stripe
 * @param {string[]} [dayKeys] - optional sorted list of YYYY-MM-DD keys; if provided, byDay is pre-initialized with these days
 * @returns {{ positiveCents: number, negativeCents: number, byDay: Object }}
 */
function aggregateRents(balanceTransactions, dayKeys = null) {
  const byDay = {};
  if (Array.isArray(dayKeys)) {
    for (const key of dayKeys) {
      byDay[key] = { date: formatDateLabel(key), rents: 0, netCents: 0 };
    }
  }
  let positiveCents = 0;
  let negativeCents = 0;
  for (const bt of balanceTransactions) {
    const net = bt.net != null ? bt.net : 0;
    const type = bt.type || '';
    const key = chicagoDateStringFromUnix(bt.created);
    if (!REVENUE_TYPES.has(type)) continue;
    if (net > 0) positiveCents += net;
    else if (net < 0) negativeCents += net;
    if (!byDay[key]) byDay[key] = { date: formatDateLabel(key), rents: 0, netCents: 0 };
    byDay[key].netCents += net;
    if (type === 'charge' && net > 0) byDay[key].rents += 1;
  }
  return { positiveCents, negativeCents, byDay };
}

/**
 * Aggregate charges into positive/negative totals and per-day rents/money.
 * positive = sum of amount_captured; negative = sum of amount_refunded; money = net (amount_captured - amount_refunded) per day.
 * @param {Array} charges - from stripe.charges.list
 * @param {string[]} [dayKeys] - optional sorted list of YYYY-MM-DD keys
 * @returns {{ positiveCents: number, negativeCents: number, byDay: Object }}
 */
function aggregateCharges(charges, dayKeys = null) {
  const byDay = {};
  if (Array.isArray(dayKeys)) {
    for (const key of dayKeys) {
      byDay[key] = { date: formatDateLabel(key), rents: 0, netCents: 0 };
    }
  }
  let positiveCents = 0;
  let negativeCents = 0;
  for (const ch of charges) {
    const captured = ch.amount_captured ?? ch.amount ?? 0;
    const refunded = ch.amount_refunded ?? 0;
    // Only count refunds when there was a capture (exclude amount_captured:0, amount_refunded:300)
    const net = captured > 0 ? captured - refunded : 0;
    const refundForNegative = captured > 0 ? refunded : 0;
    const key = chicagoDateStringFromUnix(ch.created);
    positiveCents += captured;
    negativeCents += refundForNegative;
    if (!byDay[key]) byDay[key] = { date: formatDateLabel(key), rents: 0, netCents: 0 };
    byDay[key].netCents += net;
    if (net > 0) byDay[key].rents += 1;
  }
  return { positiveCents, negativeCents, byDay };
}

/**
 * GET /rents/mtd
 * Returns month-to-date rents from Stripe balance transactions. positive/negative filtered by REVENUE_TYPES (charge, payment, refund, etc.); per-day net and rents.
 */
router.get('/rents/mtd', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ success: false, error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
  }
  try {
    const chicagoNow = DateTime.now().setZone(CHICAGO_ZONE);
    const monthStart = chicagoNow.startOf('month');
    const todayStart = chicagoNow.startOf('day');
    const gte = Math.floor(monthStart.toSeconds());
    const lte = Math.floor(DateTime.now().toSeconds());

    const prevMonthStart = monthStart.minus({ months: 1 });
    const prevMonthSameDay = todayStart.minus({ months: 1 });
    const gtePrev = Math.floor(prevMonthStart.toSeconds());
    const ltePrev = Math.floor(prevMonthSameDay.endOf('day').toSeconds());

    const [balanceTransactions, prevBalanceTransactions] = await Promise.all([
      fetchAllBalanceTransactionsInRange(gte, lte),
      fetchAllBalanceTransactionsInRange(gtePrev, ltePrev),
    ]);

    const dayCount = Math.round(todayStart.diff(monthStart, 'days').days) + 1;
    const dayKeys = [];
    for (let i = 0; i < dayCount; i++) {
      const d = monthStart.plus({ days: i });
      dayKeys.push(d.toISODate().slice(0, 10));
    }

    const prevDayCount = Math.round(prevMonthSameDay.diff(prevMonthStart, 'days').days) + 1;
    const prevDayKeys = [];
    for (let i = 0; i < prevDayCount; i++) {
      const d = prevMonthStart.plus({ days: i });
      prevDayKeys.push(d.toISODate().slice(0, 10));
    }

    const { positiveCents, negativeCents, byDay } = aggregateRents(balanceTransactions, dayKeys);
    const { positiveCents: ppositiveCents, negativeCents: pnegativeCents, byDay: byDayPrev } = aggregateRents(prevBalanceTransactions, prevDayKeys);

    const firstDayStr = monthStart.toISODate().slice(0, 10);
    const lastDayStr = todayStart.toISODate().slice(0, 10);

    const data = dayKeys.map((key) => {
      const [y, m, d] = key.split('-').map(Number);
      const prevKey = DateTime.fromObject({ year: y, month: m, day: d }, { zone: CHICAGO_ZONE })
        .minus({ months: 1 })
        .toISODate()
        .slice(0, 10);
      const prev = byDayPrev[prevKey];
      return {
        date: byDay[key].date,
        rents: byDay[key].rents,
        money: '$' + (byDay[key].netCents / 100).toFixed(0),
        prents: prev ? prev.rents : 0,
        pmoney: prev ? '$' + (prev.netCents / 100).toFixed(0) : '$0',
      };
    });

    res.json({
      success: true,
      mtd: `${formatDateLabel(firstDayStr)} – ${formatDateLabel(lastDayStr)}`,
      positive: positiveCents / 100,
      negative: negativeCents / 100,
      ppositive: ppositiveCents / 100,
      pnegative: pnegativeCents / 100,
      data,
    });
  } catch (error) {
    console.error('Stripe API error (rents/mtd):', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to fetch rents mtd',
    });
  }
});

/**
 * GET /rents/mtd/:station_id
 * Returns month-to-date rents for a single station from Stripe charges. Station is looked up in DB (stations.stripe_id = charge.customer).
 * Same format as /rents/mtd; uses stripe/charges?from=mtd filtered by customer (station's stripe_id).
 */
router.get('/rents/mtd/:station_id', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ success: false, error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
  }
  const { station_id } = req.params;
  if (!station_id || station_id.trim() === '') {
    return res.status(400).json({ success: false, error: 'station_id is required.' });
  }
  let client;
  try {
    client = await pool.connect();
    const stationResult = await client.query(
      'SELECT id, title, stripe_id FROM stations WHERE id = $1',
      [station_id.trim()]
    );
    if (stationResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Station not found.' });
    }
    const stripeId = stationResult.rows[0].stripe_id;
    if (!stripeId || stripeId.trim() === '') {
      return res.status(400).json({ success: false, error: 'Station has no stripe_id configured.' });
    }

    const chicagoNow = DateTime.now().setZone(CHICAGO_ZONE);
    const monthStart = chicagoNow.startOf('month');
    const todayStart = chicagoNow.startOf('day');
    const gte = Math.floor(monthStart.toSeconds());
    const lte = Math.floor(DateTime.now().toSeconds());

    const prevMonthStart = monthStart.minus({ months: 1 });
    const prevMonthSameDay = todayStart.minus({ months: 1 });
    const gtePrev = Math.floor(prevMonthStart.toSeconds());
    const ltePrev = Math.floor(prevMonthSameDay.endOf('day').toSeconds());

    const [charges, prevCharges] = await Promise.all([
      fetchAllChargesInRange(gte, lte, stripeId.trim()),
      fetchAllChargesInRange(gtePrev, ltePrev, stripeId.trim()),
    ]);

    const dayCount = Math.round(todayStart.diff(monthStart, 'days').days) + 1;
    const dayKeys = [];
    for (let i = 0; i < dayCount; i++) {
      const d = monthStart.plus({ days: i });
      dayKeys.push(d.toISODate().slice(0, 10));
    }

    const prevDayCount = Math.round(prevMonthSameDay.diff(prevMonthStart, 'days').days) + 1;
    const prevDayKeys = [];
    for (let i = 0; i < prevDayCount; i++) {
      const d = prevMonthStart.plus({ days: i });
      prevDayKeys.push(d.toISODate().slice(0, 10));
    }

    const { positiveCents, negativeCents, byDay } = aggregateCharges(charges, dayKeys);
    const { positiveCents: ppositiveCents, negativeCents: pnegativeCents, byDay: byDayPrev } = aggregateCharges(prevCharges, prevDayKeys);

    const firstDayStr = monthStart.toISODate().slice(0, 10);
    const lastDayStr = todayStart.toISODate().slice(0, 10);

    const data = dayKeys.map((key) => {
      const [y, m, d] = key.split('-').map(Number);
      const prevKey = DateTime.fromObject({ year: y, month: m, day: d }, { zone: CHICAGO_ZONE })
        .minus({ months: 1 })
        .toISODate()
        .slice(0, 10);
      const prev = byDayPrev[prevKey];
      return {
        date: byDay[key].date,
        rents: byDay[key].rents,
        money: '$' + (byDay[key].netCents / 100).toFixed(0),
        prents: prev ? prev.rents : 0,
        pmoney: prev ? '$' + (prev.netCents / 100).toFixed(0) : '$0',
      };
    });

    res.json({
      success: true,
      station_id: station_id.trim(),
      mtd: `${formatDateLabel(firstDayStr)} – ${formatDateLabel(lastDayStr)}`,
      positive: positiveCents / 100,
      negative: -(negativeCents / 100),
      ppositive: ppositiveCents / 100,
      pnegative: -(pnegativeCents / 100),
      data,
    });
  } catch (error) {
    console.error('Stripe API error (rents/mtd/:station_id):', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to fetch rents mtd for station',
    });
  } finally {
    if (client) client.release();
  }
});

/**
 * GET /rents/range?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Aggregated rents for a date range. Includes previous-month comparison (ppositive, pnegative, prents, pmoney) like /rents/mtd.
 */
router.get('/rents/range', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ success: false, error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
  }
  const fromParam = req.query.from;
  const toParam = req.query.to;
  if (!fromParam || !toParam) {
    return res.status(400).json({ success: false, error: 'Query params from and to (YYYY-MM-DD) are required.' });
  }
  try {
    const fromDt = DateTime.fromISO(fromParam + 'T00:00:00', { zone: CHICAGO_ZONE });
    const toDt = DateTime.fromISO(toParam + 'T00:00:00', { zone: CHICAGO_ZONE });
    if (fromDt > toDt) {
      return res.status(400).json({ success: false, error: 'from must be on or before to.' });
    }
    const dayKeys = [];
    let d = fromDt;
    while (d <= toDt) {
      dayKeys.push(d.toISODate().slice(0, 10));
      d = d.plus({ days: 1 });
    }
    const prevFromDt = fromDt.minus({ months: 1 });
    const prevToDt = toDt.minus({ months: 1 });
    const prevFromParam = prevFromDt.toISODate().slice(0, 10);
    const prevToParam = prevToDt.toISODate().slice(0, 10);
    const gte = parseDateToUnixSeconds(fromParam, false);
    const lte = parseDateToUnixSeconds(toParam, true);
    const gtePrev = parseDateToUnixSeconds(prevFromParam, false);
    const ltePrev = parseDateToUnixSeconds(prevToParam, true);

    const [balanceTransactions, prevBalanceTransactions] = await Promise.all([
      fetchAllBalanceTransactionsInRange(gte, lte),
      fetchAllBalanceTransactionsInRange(gtePrev, ltePrev),
    ]);

    const prevDayKeys = [];
    let dp = prevFromDt;
    while (dp <= prevToDt) {
      prevDayKeys.push(dp.toISODate().slice(0, 10));
      dp = dp.plus({ days: 1 });
    }

    const { positiveCents, negativeCents, byDay } = aggregateRents(balanceTransactions, dayKeys);
    const { positiveCents: ppositiveCents, negativeCents: pnegativeCents, byDay: byDayPrev } = aggregateRents(prevBalanceTransactions, prevDayKeys);

    const data = dayKeys.map((key) => {
      const [y, m, day] = key.split('-').map(Number);
      const prevKey = DateTime.fromObject({ year: y, month: m, day }, { zone: CHICAGO_ZONE })
        .minus({ months: 1 })
        .toISODate()
        .slice(0, 10);
      const prev = byDayPrev[prevKey];
      return {
        date: byDay[key].date,
        rents: byDay[key].rents,
        money: '$' + (byDay[key].netCents / 100).toFixed(0),
        prents: prev ? prev.rents : 0,
        pmoney: prev ? '$' + (prev.netCents / 100).toFixed(0) : '$0',
      };
    });

    res.json({
      success: true,
      range: `${formatDateLabel(fromParam)} – ${formatDateLabel(toParam)}`,
      positive: positiveCents / 100,
      negative: negativeCents / 100,
      ppositive: ppositiveCents / 100,
      pnegative: pnegativeCents / 100,
      data,
    });
  } catch (error) {
    console.error('Stripe API error (rents/range):', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to fetch rents range',
    });
  }
});

/**
 * GET /rents/from?from=YYYY-MM-DD
 * Aggregated rents from a date to today (to omitted = today in Chicago). Includes previous-month comparison like /rents/range.
 */
router.get('/rents/from', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ success: false, error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
  }
  const fromParam = req.query.from;
  if (!fromParam) {
    return res.status(400).json({ success: false, error: 'Query param from (YYYY-MM-DD) is required.' });
  }
  try {
    const chicagoNow = DateTime.now().setZone(CHICAGO_ZONE);
    const toParam = chicagoNow.toISODate().slice(0, 10);
    const fromDt = DateTime.fromISO(fromParam + 'T00:00:00', { zone: CHICAGO_ZONE });
    const toDt = DateTime.fromISO(toParam + 'T00:00:00', { zone: CHICAGO_ZONE });
    if (fromDt > toDt) {
      return res.status(400).json({ success: false, error: 'from must be on or before today.' });
    }
    const dayKeys = [];
    let d = fromDt;
    while (d <= toDt) {
      dayKeys.push(d.toISODate().slice(0, 10));
      d = d.plus({ days: 1 });
    }
    const prevFromDt = fromDt.minus({ months: 1 });
    const prevToDt = toDt.minus({ months: 1 });
    const prevFromParam = prevFromDt.toISODate().slice(0, 10);
    const prevToParam = prevToDt.toISODate().slice(0, 10);
    const gte = parseDateToUnixSeconds(fromParam, false);
    const lte = parseDateToUnixSeconds(toParam, true);
    const gtePrev = parseDateToUnixSeconds(prevFromParam, false);
    const ltePrev = parseDateToUnixSeconds(prevToParam, true);

    const [balanceTransactions, prevBalanceTransactions] = await Promise.all([
      fetchAllBalanceTransactionsInRange(gte, lte),
      fetchAllBalanceTransactionsInRange(gtePrev, ltePrev),
    ]);

    const prevDayKeys = [];
    let dp = prevFromDt;
    while (dp <= prevToDt) {
      prevDayKeys.push(dp.toISODate().slice(0, 10));
      dp = dp.plus({ days: 1 });
    }

    const { positiveCents, negativeCents, byDay } = aggregateRents(balanceTransactions, dayKeys);
    const { positiveCents: ppositiveCents, negativeCents: pnegativeCents, byDay: byDayPrev } = aggregateRents(prevBalanceTransactions, prevDayKeys);

    const data = dayKeys.map((key) => {
      const [y, m, day] = key.split('-').map(Number);
      const prevKey = DateTime.fromObject({ year: y, month: m, day }, { zone: CHICAGO_ZONE })
        .minus({ months: 1 })
        .toISODate()
        .slice(0, 10);
      const prev = byDayPrev[prevKey];
      return {
        date: byDay[key].date,
        rents: byDay[key].rents,
        money: '$' + (byDay[key].netCents / 100).toFixed(0),
        prents: prev ? prev.rents : 0,
        pmoney: prev ? '$' + (prev.netCents / 100).toFixed(0) : '$0',
      };
    });

    res.json({
      success: true,
      range: `${formatDateLabel(fromParam)} – ${formatDateLabel(toParam)}`,
      positive: positiveCents / 100,
      negative: negativeCents / 100,
      ppositive: ppositiveCents / 100,
      pnegative: pnegativeCents / 100,
      data,
    });
  } catch (error) {
    console.error('Stripe API error (rents/from):', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to fetch rents from',
    });
  }
});

/**
 * GET /rents/recent?limit=N
 * Aggregated rents for the most recent N balance transactions (no date filter). Default limit 10, max 100.
 */
router.get('/rents/recent', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ success: false, error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
  }
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
    const listResult = await stripe.balanceTransactions.list({ limit });
    const balanceTransactions = listResult.data;
    const { positiveCents, negativeCents, byDay } = aggregateRents(balanceTransactions);
    const dayKeys = Object.keys(byDay).sort();
    const data = dayKeys.map((key) => ({
      date: byDay[key].date,
      rents: byDay[key].rents,
      money: '$' + (byDay[key].netCents / 100).toFixed(0),
    }));
    res.json({
      success: true,
      positive: positiveCents / 100,
      negative: negativeCents / 100,
      data,
    });
  } catch (error) {
    console.error('Stripe API error (rents/recent):', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to fetch rents recent',
    });
  }
});

/**
 * GET /stripe/charges
 * Returns Stripe charges (stripe.charges.list), optionally filtered by date range.
 * Query:
 *   - limit (optional, default 10, max 100) when no date filter.
 *   - from (optional): YYYY-MM-DD or "mtd" for month-to-date (first day of current month).
 *   - to (optional): YYYY-MM-DD; defaults to today when "from" is set.
 */
router.get('/stripe/charges', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ success: false, error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
  }
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 100);
    const fromParam = req.query.from;
    const toParam = req.query.to;

    const listParams = { limit };

    if (fromParam !== undefined && fromParam !== '') {
      const gte = parseDateToUnixSeconds(fromParam === 'mtd' ? 'mtd' : fromParam, false);
      const lte = toParam
        ? parseDateToUnixSeconds(toParam, true)
        : parseDateToUnixSeconds(DateTime.now().setZone(CHICAGO_ZONE).toISODate().slice(0, 10), true);
      listParams.created = { gte, lte };
    }

    const charges = await stripe.charges.list(listParams);

    res.json({
      success: true,
      data: charges.data,
      has_more: charges.has_more,
    });
  } catch (error) {
    console.error('Stripe API error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to fetch charges',
    });
  }
});

/**
 * GET /stripe/balance-transactions
 * Returns Stripe balance transactions (stripe.balanceTransactions.list), optionally filtered by date range.
 * Query:
 *   - limit (optional, default 10, max 100) when no date filter.
 *   - from (optional): YYYY-MM-DD or "mtd" for month-to-date (first day of current month).
 *   - to (optional): YYYY-MM-DD; defaults to today when "from" is set.
 */
router.get('/stripe/balance-transactions', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ success: false, error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
  }
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 100);
    const fromParam = req.query.from;
    const toParam = req.query.to;

    const listParams = { limit };

    if (fromParam !== undefined && fromParam !== '') {
      const gte = parseDateToUnixSeconds(fromParam === 'mtd' ? 'mtd' : fromParam, false);
      const lte = toParam
        ? parseDateToUnixSeconds(toParam, true)
        : parseDateToUnixSeconds(DateTime.now().setZone(CHICAGO_ZONE).toISODate().slice(0, 10), true);
      listParams.created = { gte, lte };
    }

    const balanceTransactions = await stripe.balanceTransactions.list(listParams);

    res.json({
      success: true,
      data: balanceTransactions.data,
      has_more: balanceTransactions.has_more,
    });
  } catch (error) {
    console.error('Stripe API error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to fetch balance transactions',
    });
  }
});

module.exports = router;
