/**
 * collections.js — every Firestore path this app touches, in one place.
 *
 * JV currently shares a Firebase project with another app, so each name carries
 * a `jv_` prefix and no other app's data is ever read or written. When JV moves
 * to its own project the prefix becomes dead weight: set `JV_COLLECTION_PREFIX=`
 * (empty) in the environment and every path drops it, with no route file changed.
 *
 * Storage shape, and why:
 *
 *   jv_users/{uid}                     profile + role
 *   jv_clients/{uid}                   { clients: [...] }  — one document
 *   jv_ledgers/{uid}                   { months: ['2026-11', ...] }
 *   jv_ledgers/{uid}/months/{YYYY-MM}  { entries: [...] }
 *   jv_activity/{eventId}              append-only usage log
 *
 * Clients fit comfortably in a single document (a few hundred at ~400 bytes
 * each). Ledger entries do not — a handful a day would pass Firestore's 1 MB
 * document limit inside a year — so they are partitioned by month, and the
 * summary document lists which months exist.
 *
 * The pay-off is that every read is a direct `get` by an id we already know:
 * nothing is ever *queried*, so there are no composite indexes to deploy, no
 * index errors on first use, and no query that could stray into a neighbouring
 * app's collections.
 */

const PREFIX = process.env.JV_COLLECTION_PREFIX ?? 'jv_';

export const USERS = `${PREFIX}users`;
export const CLIENTS = `${PREFIX}clients`;
export const LEDGERS = `${PREFIX}ledgers`;
export const ACTIVITY = `${PREFIX}activity`;

/** Sub-collection under a user's ledger document, one document per month. */
export const MONTHS = 'months';

/** `jv_ledgers/{uid}/months` — the collection path a month document lives in. */
export const monthsPath = (uid) => `${LEDGERS}/${uid}/${MONTHS}`;

/** The month key an ISO date (YYYY-MM-DD) belongs to. */
export const monthKey = (isoDate) => String(isoDate).slice(0, 7);

/** Every month key from `from` to `to` inclusive, oldest first. */
export function monthRange(from, to) {
  const keys = [];
  let [y, m] = monthKey(from).split('-').map(Number);
  const [ey, em] = monthKey(to).split('-').map(Number);
  // Guard against a reversed or malformed range producing an endless loop.
  if (!y || !m || !ey || !em || y * 12 + m > ey * 12 + em) return keys;
  while (y * 12 + m <= ey * 12 + em) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) {
      m = 1;
      y += 1;
    }
  }
  return keys;
}
