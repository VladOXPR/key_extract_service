const express = require('express');
const { DateTime } = require('luxon');
const router = express.Router();

const CHICAGO_ZONE = 'America/Chicago';

// Set STRIPE_SECRET_KEY in .env or Cloud Run (never commit the real key)
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? require('stripe')(stripeSecretKey) : null;

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
 * GET /rents/mtd
 * Returns month-to-date rents: per-day count and sum from charges only; positive/negative from allowed revenue types only.
 */
router.get('/rents/mtd', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ success: false, error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
  }
  try {
    const chicagoNow = DateTime.now().setZone(CHICAGO_ZONE);
    const gte = parseDateToUnixSeconds('mtd', false);
    const lte = Math.floor(DateTime.now().toSeconds());

    const balanceTransactions = await fetchAllBalanceTransactionsInRange(gte, lte);

    const monthStart = chicagoNow.startOf('month');
    const todayStart = chicagoNow.startOf('day');
    const dayCount = Math.round(todayStart.diff(monthStart, 'days').days) + 1;

    const byDay = {};
    for (let i = 0; i < dayCount; i++) {
      const d = monthStart.plus({ days: i });
      const key = d.toISODate().slice(0, 10);
      byDay[key] = { date: formatDateLabel(key), rents: 0, netCents: 0 };
    }

    let positiveCents = 0;
    let negativeCents = 0;

    for (const bt of balanceTransactions) {
      const net = bt.net != null ? bt.net : 0;
      const type = bt.type || '';
      const key = chicagoDateStringFromUnix(bt.created);

      if (!REVENUE_TYPES.has(type)) continue;

      if (net > 0) {
        positiveCents += net;
      } else if (net < 0) {
        negativeCents += net;
      }

      if (byDay[key]) {
        byDay[key].netCents += net;
        if (type === 'charge' && net > 0) byDay[key].rents += 1;
      }
    }

    const firstDayStr = monthStart.toISODate().slice(0, 10);
    const lastDayStr = todayStart.toISODate().slice(0, 10);

    const data = Object.keys(byDay)
      .sort()
      .map((key) => ({
        date: byDay[key].date,
        rents: byDay[key].rents,
        money: '$' + (byDay[key].netCents / 100).toFixed(0),
      }));

    res.json({
      success: true,
      mtd: `${formatDateLabel(firstDayStr)} – ${formatDateLabel(lastDayStr)}`,
      positive: positiveCents / 100,
      negative: negativeCents / 100,
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
 * GET /stripe/balance-transactions
 * Returns Stripe balance transactions, optionally filtered by date range.
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
