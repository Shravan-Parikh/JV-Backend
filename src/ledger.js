/**
 * ledger.js — what the entries add up to.
 *
 * Every figure here is derived on read and none of it is stored. That is the
 * point: a mistyped entry corrected next week can never leave a stale balance
 * behind it, and there is no reconciliation job to run.
 *
 * Two balances matter, and they are not the same thing:
 *
 *   material (kg)  Σ inward net − Σ outward net, per client.
 *                  Positive means that much of *their* yarn is still on JV's
 *                  floor. Job work only — traded material is JV's own stock.
 *
 *   money (₹)      opening + Σ outward total − Σ payments, per client.
 *                  Positive means the client owes JV.
 *
 * Yarn always loses a little weight in process, so a closed lot's outward never
 * equals its inward. That gap is wastage, and it is the figure that causes
 * arguments — so it is computed per lot rather than left to be noticed.
 */

import { money, kg, kgSigned } from './yarn.js';

/** Date first, then insertion order, so same-day entries read as they were entered. */
export const byDate = (a, b) =>
  (a.date || '').localeCompare(b.date || '') ||
  (a.createdAt || '').localeCompare(b.createdAt || '');

/** Signed effect of an entry on what the client owes. */
export function moneyDelta(entry) {
  if (entry.kind === 'payment') return -money(entry.amount);
  if (entry.kind === 'outward') return money(entry.totalAmount);
  return 0;
}

/** Signed effect of an entry on the client's material lying with JV. */
export function materialDelta(entry) {
  if (entry.account !== 'jobwork') return 0;
  if (entry.kind === 'inward') return kg(entry.netWeight);
  if (entry.kind === 'outward') return -kg(entry.netWeight);
  return 0;
}

/**
 * Attach a running money balance to each entry, oldest first.
 *
 * Only meaningful for a single client's statement, so the caller filters first;
 * across clients the running total would be a number nobody can act on.
 */
export function withRunningBalance(entries, openingBalance = 0) {
  let running = money(openingBalance);
  return [...entries].sort(byDate).map((e) => {
    running = money(running + moneyDelta(e));
    return { ...e, runningBalance: running };
  });
}

/**
 * Group material entries into lots.
 *
 * A lot is keyed by client *and* lot number, because two clients can quite
 * reasonably both call something "L-01".
 */
export function lots(entries) {
  const map = new Map();

  for (const e of entries) {
    if (e.kind !== 'inward' && e.kind !== 'outward') continue;
    if (!e.lotNo) continue;
    const key = `${e.clientId}::${e.lotNo}`;

    if (!map.has(key)) {
      map.set(key, {
        key,
        lotNo: e.lotNo,
        clientId: e.clientId,
        clientName: e.clientName,
        account: e.account,
        yarnType: e.yarnType,
        denier: e.denier,
        shade: e.shade,
        ply: e.ply,
        tpm: e.tpm,
        twist: e.twist,
        inwardKg: 0,
        outwardKg: 0,
        inwardCones: 0,
        outwardCones: 0,
        firstDate: e.date,
        lastDate: e.date,
        entries: 0,
      });
    }

    const lot = map.get(key);
    lot.entries += 1;
    if (e.date && e.date < lot.firstDate) lot.firstDate = e.date;
    if (e.date && e.date > lot.lastDate) lot.lastDate = e.date;

    if (e.kind === 'inward') {
      lot.inwardKg = kg(lot.inwardKg + kg(e.netWeight));
      lot.inwardCones += e.cones || 0;
      // The inward entry describes what the yarn actually is; an outward entry
      // may leave those fields blank, so inward wins.
      lot.yarnType = e.yarnType || lot.yarnType;
      lot.denier = e.denier || lot.denier;
      lot.shade = e.shade || lot.shade;
    } else {
      lot.outwardKg = kg(lot.outwardKg + kg(e.netWeight));
      lot.outwardCones += e.cones || 0;
      lot.ply = e.ply || lot.ply;
      lot.tpm = e.tpm || lot.tpm;
      lot.twist = e.twist || lot.twist;
    }
  }

  return [...map.values()]
    .map((lot) => {
      const balanceKg = kg(Math.max(0, lot.inwardKg - lot.outwardKg));
      return {
        ...lot,
        balanceKg,
        // Read as "still to come back" on an open lot, and as wastage once the
        // lot is finished. The UI says which, using `delivered`.
        gapPercent: lot.inwardKg > 0 ? money(((lot.inwardKg - lot.outwardKg) / lot.inwardKg) * 100) : 0,
        delivered: lot.outwardKg > 0,
        open: balanceKg > 0.0005,
      };
    })
    .sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));
}

/**
 * Per-client balances and the totals across all of them.
 *
 * `clients` supplies opening balances and names; a client that has entries but
 * no record (imported or since deleted) still appears, so no money goes
 * missing from the totals.
 */
export function summarise(entries, clients = []) {
  const byClient = new Map();

  const seed = (id, name) => {
    if (byClient.has(id)) return byClient.get(id);
    const client = clients.find((c) => c.id === id);
    const row = {
      clientId: id,
      clientName: client?.name || name || 'Unknown client',
      active: client ? client.active !== false : true,
      known: !!client,
      openingBalance: money(client?.openingBalance ?? 0),
      materialKg: 0,
      billed: 0,
      paid: 0,
      inwardKg: 0,
      outwardKg: 0,
      entries: 0,
      lastEntryDate: '',
    };
    byClient.set(id, row);
    return row;
  };

  // Clients with an opening balance but no entries yet still owe money, so they
  // are seeded before the entries are walked.
  for (const c of clients) {
    if (c.openingBalance) seed(c.id, c.name);
  }

  for (const e of entries) {
    const row = seed(e.clientId, e.clientName);
    row.entries += 1;
    if ((e.date || '') > row.lastEntryDate) row.lastEntryDate = e.date || '';

    row.materialKg = kgSigned(row.materialKg + materialDelta(e));
    if (e.kind === 'inward') row.inwardKg = kg(row.inwardKg + kg(e.netWeight));
    if (e.kind === 'outward') {
      row.outwardKg = kg(row.outwardKg + kg(e.netWeight));
      row.billed = money(row.billed + money(e.totalAmount));
    }
    if (e.kind === 'payment') row.paid = money(row.paid + money(e.amount));
  }

  const rows = [...byClient.values()]
    .map((r) => ({ ...r, balance: money(r.openingBalance + r.billed - r.paid) }))
    .sort((a, b) => b.balance - a.balance || a.clientName.localeCompare(b.clientName));

  const totals = rows.reduce(
    (t, r) => ({
      clients: t.clients + 1,
      materialKg: kgSigned(t.materialKg + r.materialKg),
      inwardKg: kg(t.inwardKg + r.inwardKg),
      outwardKg: kg(t.outwardKg + r.outwardKg),
      billed: money(t.billed + r.billed),
      paid: money(t.paid + r.paid),
      opening: money(t.opening + r.openingBalance),
      outstanding: money(t.outstanding + Math.max(0, r.balance)),
      advance: money(t.advance + Math.min(0, r.balance)),
      entries: t.entries + r.entries,
    }),
    {
      clients: 0,
      materialKg: 0,
      inwardKg: 0,
      outwardKg: 0,
      billed: 0,
      paid: 0,
      opening: 0,
      outstanding: 0,
      advance: 0,
      entries: 0,
    },
  );

  return { clients: rows, totals };
}

/** Totals for an arbitrary slice of entries — powers the ledger's footer strip. */
export function totalsFor(entries) {
  return entries.reduce(
    (t, e) => ({
      entries: t.entries + 1,
      inwardKg: kg(t.inwardKg + (e.kind === 'inward' ? kg(e.netWeight) : 0)),
      outwardKg: kg(t.outwardKg + (e.kind === 'outward' ? kg(e.netWeight) : 0)),
      billed: money(t.billed + (e.kind === 'outward' ? money(e.totalAmount) : 0)),
      gst: money(t.gst + (e.kind === 'outward' ? money(e.gstAmount) : 0)),
      paid: money(t.paid + (e.kind === 'payment' ? money(e.amount) : 0)),
    }),
    { entries: 0, inwardKg: 0, outwardKg: 0, billed: 0, gst: 0, paid: 0 },
  );
}
