/**
 * entries.js — the ledger itself: inward, outward and payments.
 *
 * Every figure that can be derived is derived (see ledger.js), so these routes
 * only ever store what was actually observed: weights off the scale, what was
 * on the challan, what was agreed as a rate, what was received.
 *
 * Writes go through yarn.js for sanitising, which means a create, an edit and
 * anything imported later all obey one set of rules.
 */

import { Router } from 'express';
import { FirebaseError } from '../firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { logEvent } from '../activity.js';
import { monthKey } from '../collections.js';
import { reference, sanitiseEntry, validateEntry, ISO_DATE } from '../yarn.js';
import { readEntries, addEntry, updateEntry, deleteEntry, locateEntry } from '../ledgerStore.js';
import { lots, totalsFor } from '../ledger.js';

const router = Router();

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const status = e instanceof FirebaseError ? e.status : 500;
    res.status(status).json({ error: e.message || 'Something went wrong' });
  }
};

/** Reject a malformed date rather than quietly reading the whole book. */
function range(req) {
  const from = ISO_DATE.test(req.query.from || '') ? req.query.from : '';
  const to = ISO_DATE.test(req.query.to || '') ? req.query.to : '';
  return { from, to };
}

/** The filters the ledger page drives from the URL. */
function applyFilters(entries, query) {
  const client = String(query.client || '');
  const kind = String(query.kind || '');
  const account = String(query.account || '');
  const lot = String(query.lot || '');
  const q = String(query.q || '').trim().toLowerCase();

  return entries.filter((e) => {
    if (client && e.clientId !== client) return false;
    if (kind && e.kind !== kind) return false;
    if (account && e.account !== account) return false;
    if (lot && e.lotNo !== lot) return false;
    if (q) {
      const haystack = [
        e.clientName,
        e.lotNo,
        e.challanNo,
        e.partyChallanNo,
        e.denier,
        e.shade,
        e.vehicleNo,
        e.transporter,
        e.lrNo,
        e.reference,
        e.notes,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

// --- Reference data for the form -------------------------------------------

router.get('/reference', requireAuth, (_req, res) => res.json(reference()));

// --- List ------------------------------------------------------------------

router.get(
  '/entries',
  requireAuth,
  handle(async (req, res) => {
    const { from, to } = range(req);
    const all = await readEntries(req, { from, to });
    const entries = applyFilters(all, req.query);
    res.json({
      entries,
      totals: totalsFor(entries),
      // Lots are computed from the unfiltered set: the open-lot picker has to
      // offer lots whose inward falls outside the current filter.
      lots: lots(all),
    });
  }),
);

// --- Create ----------------------------------------------------------------

router.post(
  '/entries',
  requireAuth,
  handle(async (req, res) => {
    const fields = sanitiseEntry(req.body);
    const complaint = validateEntry(fields);
    if (complaint) return res.status(400).json({ error: complaint });

    const entry = await addEntry(req, fields);
    logEvent(req, 'entry.create', { kind: entry.kind, account: entry.account });
    res.status(201).json({ entry });
  }),
);

// --- Update ----------------------------------------------------------------

router.patch(
  '/entries/:id',
  requireAuth,
  handle(async (req, res) => {
    // The client knows the entry's current date, so it can say which month
    // document to open and save a scan across the book.
    const hint = ISO_DATE.test(req.body?.currentDate || '')
      ? monthKey(req.body.currentDate)
      : undefined;

    const found = await locateEntry(req, req.params.id, hint);
    if (!found) return res.status(404).json({ error: 'Entry not found' });

    // Merge onto what is stored, then check it — a rejected edit must leave the
    // existing entry untouched, so nothing is written until this passes.
    const fields = sanitiseEntry(req.body, found.entry);
    const complaint = validateEntry(fields);
    if (complaint) return res.status(400).json({ error: complaint });

    const entry = await updateEntry(req, req.params.id, fields, found.month);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    logEvent(req, 'entry.update', { kind: entry.kind });
    res.json({ entry });
  }),
);

// --- Delete ----------------------------------------------------------------

router.delete(
  '/entries/:id',
  requireAuth,
  handle(async (req, res) => {
    const hint = ISO_DATE.test(req.query?.date || '') ? monthKey(req.query.date) : undefined;
    const removed = await deleteEntry(req, req.params.id, hint);
    if (!removed) return res.status(404).json({ error: 'Entry not found' });
    logEvent(req, 'entry.delete', {});
    res.json({ ok: true });
  }),
);

export { applyFilters, range };
export default router;
