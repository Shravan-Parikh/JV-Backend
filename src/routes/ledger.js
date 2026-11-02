/**
 * ledger.js (routes) — the derived views: balances, statements, open lots.
 *
 * Nothing here reads a stored total. Every number is computed from the entries
 * on each request, which is why a correction made today fixes last month's
 * balance without any reconciliation step.
 */

import { Router } from 'express';
import { getDoc, FirebaseError } from '../firebase.js';
import { CLIENTS } from '../collections.js';
import { requireAuth } from '../middleware/auth.js';
import { readEntries } from '../ledgerStore.js';
import { summarise, lots, withRunningBalance, totalsFor } from '../ledger.js';
import { ISO_DATE } from '../yarn.js';

const router = Router();

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const status = e instanceof FirebaseError ? e.status : 500;
    res.status(status).json({ error: e.message || 'Something went wrong' });
  }
};

async function clientList(req) {
  const doc = await getDoc(CLIENTS, req.user.uid, req.idToken);
  return Array.isArray(doc?.clients) ? doc.clients : [];
}

// --- Summary ---------------------------------------------------------------

/**
 * Balances per client plus the totals behind the dashboard tiles.
 *
 * Always computed over the whole book, never a date range: a balance that only
 * counted the last month would be actively misleading.
 */
router.get(
  '/ledger/summary',
  requireAuth,
  handle(async (req, res) => {
    const [entries, clients] = await Promise.all([readEntries(req), clientList(req)]);
    const { clients: rows, totals } = summarise(entries, clients);
    const allLots = lots(entries);

    const month = new Date().toISOString().slice(0, 7);
    const thisMonth = entries.filter((e) => (e.date || '').startsWith(month));

    res.json({
      clients: rows,
      totals,
      openLots: allLots.filter((l) => l.open),
      month: { key: month, ...totalsFor(thisMonth) },
      recent: [...entries].reverse().slice(0, 12),
    });
  }),
);

// --- Statement -------------------------------------------------------------

/**
 * One client's book, oldest first, with a running balance.
 *
 * The running total starts from the client's opening balance, so the closing
 * figure is what they actually owe rather than only what this app has seen.
 */
router.get(
  '/ledger/statement',
  requireAuth,
  handle(async (req, res) => {
    const clientId = String(req.query.client || '');
    if (!clientId) return res.status(400).json({ error: 'A client is required' });

    const from = ISO_DATE.test(req.query.from || '') ? req.query.from : '';
    const to = ISO_DATE.test(req.query.to || '') ? req.query.to : '';

    const [all, clients] = await Promise.all([readEntries(req), clientList(req)]);
    const client = clients.find((c) => c.id === clientId);

    const mine = all.filter((e) => e.clientId === clientId);
    const withBalance = withRunningBalance(mine, client?.openingBalance ?? 0);

    // The balance is carried in from before the window, so a part-year
    // statement still opens at the right figure.
    const before = withBalance.filter((e) => from && (e.date || '') < from);
    const openingBalance = before.length
      ? before[before.length - 1].runningBalance
      : (client?.openingBalance ?? 0);

    const rows = withBalance.filter(
      (e) => (!from || (e.date || '') >= from) && (!to || (e.date || '') <= to),
    );

    const { clients: summaryRows } = summarise(mine, clients);

    res.json({
      client: client || { id: clientId, name: mine[0]?.clientName || 'Unknown client' },
      entries: rows,
      openingBalance,
      closingBalance: rows.length ? rows[rows.length - 1].runningBalance : openingBalance,
      summary: summaryRows[0] || null,
      lots: lots(mine),
      totals: totalsFor(rows),
    });
  }),
);

export default router;
