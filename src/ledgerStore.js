/**
 * ledgerStore.js — reading and writing the month-partitioned ledger.
 *
 *   jv_ledgers/{uid}                   { months: ['2026-11', ...] }
 *   jv_ledgers/{uid}/months/{YYYY-MM}  { entries: [...] }
 *
 * The summary document names every month that holds entries, so a read is a set
 * of direct document gets by ids already in hand. Nothing is ever *queried*,
 * which is what keeps this free of composite indexes — and means a query can
 * never stray into the collections of the other app sharing this Firebase
 * project.
 *
 * All writes are read-modify-write on a single month document. This is a
 * single-operator tool, so there is no concurrent writer to lose an update to;
 * if JV ever puts two people on the ledger at once, this is the file that needs
 * a transaction.
 */

import { randomUUID } from 'node:crypto';
import { getDoc, setDoc, listDocuments, FirebaseError } from './firebase.js';
import { LEDGERS, monthsPath, monthKey, monthRange } from './collections.js';
import { byDate } from './ledger.js';

/** Comfortably under Firestore's 1 MB document ceiling at ~600 bytes an entry. */
const MAX_ENTRIES_PER_MONTH = 1200;

// ---------------------------------------------------------------------------
// Month index
// ---------------------------------------------------------------------------

/**
 * The months that hold entries, newest first.
 *
 * If the summary document is ever lost while month documents survive, the
 * ledger would silently read as empty — the worst possible failure for a book
 * of accounts. So an empty index is verified against the sub-collection itself
 * before being believed.
 */
export async function readMonths(req) {
  const doc = await getDoc(LEDGERS, req.user.uid, req.idToken);
  const months = Array.isArray(doc?.months) ? doc.months.filter(Boolean) : [];
  if (months.length) return [...months].sort().reverse();

  const found = await listDocuments(monthsPath(req.user.uid), { idToken: req.idToken });
  if (!found.length) return [];

  const repaired = found.map((d) => d.id).sort().reverse();
  await writeMonths(req, repaired);
  return repaired;
}

async function writeMonths(req, months) {
  await setDoc(
    LEDGERS,
    req.user.uid,
    { uid: req.user.uid, months: [...new Set(months)].sort(), updatedAt: new Date() },
    req.idToken,
  );
}

async function registerMonth(req, month, known) {
  if (known.includes(month)) return known;
  const next = [...known, month];
  await writeMonths(req, next);
  return next;
}

// ---------------------------------------------------------------------------
// Month documents
// ---------------------------------------------------------------------------

async function readMonth(req, month) {
  const doc = await getDoc(monthsPath(req.user.uid), month, req.idToken);
  return Array.isArray(doc?.entries) ? doc.entries : [];
}

async function writeMonth(req, month, entries) {
  await setDoc(
    monthsPath(req.user.uid),
    month,
    { month, entries, updatedAt: new Date() },
    req.idToken,
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every entry in a date range, oldest first.
 *
 * With no range this reads the whole book. At a few entries a day that is a
 * couple of dozen document reads against a 50,000/day free quota, and it buys
 * instant client-side filtering, search and totals. The `from`/`to` parameters
 * exist so narrowing the window later is a parameter change, not a redesign.
 */
export async function readEntries(req, { from, to } = {}) {
  const known = await readMonths(req);
  if (!known.length) return [];

  const wanted =
    from && to
      ? monthRange(from, to).filter((m) => known.includes(m))
      : from
        ? known.filter((m) => m >= monthKey(from))
        : to
          ? known.filter((m) => m <= monthKey(to))
          : known;

  const pages = await Promise.all(wanted.map((m) => readMonth(req, m)));
  const entries = pages.flat();

  // A month document holds whole months, so a part-month range still needs the
  // day-level trim.
  const trimmed = entries.filter(
    (e) => (!from || (e.date || '') >= from) && (!to || (e.date || '') <= to),
  );
  return trimmed.sort(byDate);
}

/** Find an entry and the month document holding it. `hint` avoids a scan. */
export async function locateEntry(req, id, hint) {
  const known = await readMonths(req);
  const order = hint && known.includes(hint) ? [hint, ...known.filter((m) => m !== hint)] : known;

  for (const month of order) {
    const entries = await readMonth(req, month);
    const index = entries.findIndex((e) => e.id === id);
    if (index >= 0) return { month, entries, index, entry: entries[index] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function addEntry(req, fields) {
  const month = monthKey(fields.date);
  const known = await readMonths(req);
  const entries = await readMonth(req, month);

  if (entries.length >= MAX_ENTRIES_PER_MONTH) {
    throw new FirebaseError(
      `That month already holds ${MAX_ENTRIES_PER_MONTH} entries, which is as many as one month can take.`,
      409,
    );
  }

  const entry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: '',
    ...fields,
  };

  await writeMonth(req, month, [...entries, entry].sort(byDate));
  await registerMonth(req, month, known);
  return entry;
}

/**
 * Replace an entry. An edited date can move it to a different month, in which
 * case it is removed from the old document and appended to the new one.
 */
export async function updateEntry(req, id, fields, hint) {
  const found = await locateEntry(req, id, hint);
  if (!found) return null;

  const updated = {
    ...found.entry,
    ...fields,
    id: found.entry.id,
    createdAt: found.entry.createdAt,
    updatedAt: new Date().toISOString(),
  };

  const target = monthKey(updated.date);

  if (target === found.month) {
    const next = [...found.entries];
    next[found.index] = updated;
    await writeMonth(req, found.month, next.sort(byDate));
    return updated;
  }

  const known = await readMonths(req);
  const destination = await readMonth(req, target);
  await writeMonth(req, target, [...destination, updated].sort(byDate));
  await writeMonth(
    req,
    found.month,
    found.entries.filter((e) => e.id !== id),
  );
  await registerMonth(req, target, known);
  return updated;
}

export async function deleteEntry(req, id, hint) {
  const found = await locateEntry(req, id, hint);
  if (!found) return false;
  await writeMonth(
    req,
    found.month,
    found.entries.filter((e) => e.id !== id),
  );
  return true;
}
