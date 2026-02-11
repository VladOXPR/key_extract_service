const express = require('express');
const router = express.Router();

// Set STRIPE_SECRET_KEY in .env or Cloud Run (never commit the real key)
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? require('stripe')(stripeSecretKey) : null;

/**
 * Return YYYY-MM-DD for a Date in the server's local timezone (used for grouping and mtd range).
 */
function localDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Parse a date string (YYYY-MM-DD) or "mtd" to Unix seconds.
 * "mtd" = start of current month in server local timezone.
 * YYYY-MM-DD is interpreted as local midnight.
 */
function parseDateToUnixSeconds(value, endOfDay = false) {
  let date;
  if (value === 'mtd' || value === undefined) {
    date = new Date();
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
  } else {
    date = new Date(value + 'T00:00:00');
  }
  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  }
  return Math.floor(date.getTime() / 1000);
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
    const now = new Date();
    const gte = parseDateToUnixSeconds('mtd', false);
    const lte = Math.floor(now.getTime() / 1000);

    const balanceTransactions = await fetchAllBalanceTransactionsInRange(gte, lte);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayCount = Math.round((today - monthStart) / (24 * 60 * 60 * 1000)) + 1;

    const byDay = {};
    for (let i = 0; i < dayCount; i++) {
      const d = new Date(monthStart);
      d.setDate(d.getDate() + i);
      const key = localDateString(d);
      byDay[key] = { date: formatDateLabel(key), rents: 0, netCents: 0 };
    }

    let positiveCents = 0;
    let negativeCents = 0;

    for (const bt of balanceTransactions) {
      const net = bt.net != null ? bt.net : 0;
      const type = bt.type || '';
      const created = new Date(bt.created * 1000);
      const key = localDateString(created);

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

    const firstDayStr = localDateString(monthStart);
    const lastDayStr = localDateString(today);

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
        : parseDateToUnixSeconds(localDateString(new Date()), true);
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
