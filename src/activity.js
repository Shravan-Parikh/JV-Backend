/**
 * activity.js — lightweight usage log.
 *
 * Knowing which parts of the ledger actually get used decides what gets built
 * next, so every meaningful action lands in `jv_activity`. Writes are
 * fire-and-forget: a logging failure must never break the entry someone was
 * trying to save.
 *
 * Meta must stay small and non-sensitive — counts and kinds, never client
 * names, amounts or anything that would duplicate the ledger itself.
 */

import { addDoc } from './firebase.js';
import { ACTIVITY } from './collections.js';

/**
 * @param {object} ctx  an Express req (or any { user:{uid}, idToken })
 * @param {string} event  dotted event name, e.g. 'entry.create'
 * @param {object} meta   small, non-sensitive detail
 */
export function logEvent(ctx, event, meta = {}) {
  const uid = ctx?.user?.uid;
  const idToken = ctx?.idToken;
  if (!uid || !idToken) return;

  addDoc(
    ACTIVITY,
    {
      uid,
      event,
      meta,
      at: new Date(),
    },
    idToken,
  ).catch(() => {
    /* logging is best-effort by design */
  });
}
