/**
 * clients.js — the client book.
 *
 * One document per user holding the whole list: a few hundred clients at a few
 * hundred bytes each sits far inside Firestore's document limit, and it means
 * the ledger page loads every client it needs to render names and defaults in a
 * single read.
 *
 * Clients are deactivated rather than deleted once they have entries against
 * them — removing one would orphan history that still carries a balance.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getDoc, setDoc, FirebaseError } from '../firebase.js';
import { CLIENTS } from '../collections.js';
import { requireAuth } from '../middleware/auth.js';
import { logEvent } from '../activity.js';
import { sanitiseClient, validateClient } from '../yarn.js';
import { readEntries } from '../ledgerStore.js';

const router = Router();

const MAX_CLIENTS = 1000;

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const status = e instanceof FirebaseError ? e.status : 500;
    res.status(status).json({ error: e.message || 'Something went wrong' });
  }
};

async function readClients(req) {
  const doc = await getDoc(CLIENTS, req.user.uid, req.idToken);
  return Array.isArray(doc?.clients) ? doc.clients : [];
}

async function writeClients(req, clients) {
  await setDoc(
    CLIENTS,
    req.user.uid,
    { uid: req.user.uid, clients: clients.slice(0, MAX_CLIENTS), updatedAt: new Date() },
    req.idToken,
  );
}

const sortByName = (a, b) => a.name.localeCompare(b.name, 'en-IN');

/** Catches "Shah Textiles" being added twice with different spacing or case. */
const sameName = (a, b) =>
  a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');

// --- List ------------------------------------------------------------------

router.get(
  '/clients',
  requireAuth,
  handle(async (req, res) => {
    res.json({ clients: (await readClients(req)).sort(sortByName) });
  }),
);

// --- Create ----------------------------------------------------------------

router.post(
  '/clients',
  requireAuth,
  handle(async (req, res) => {
    const fields = sanitiseClient(req.body);
    const complaint = validateClient(fields);
    if (complaint) return res.status(400).json({ error: complaint });

    const clients = await readClients(req);
    if (clients.length >= MAX_CLIENTS) {
      return res.status(409).json({ error: `The client list is full (${MAX_CLIENTS}).` });
    }
    // The ledger page offers "add client" inline, so a double-tap would
    // otherwise create a duplicate the balances then split across.
    const existing = clients.find((c) => sameName(c.name, fields.name));
    if (existing) {
      return res.status(200).json({ client: existing, clients: clients.sort(sortByName), duplicate: true });
    }

    const client = { id: randomUUID(), createdAt: new Date().toISOString(), ...fields };
    const next = [...clients, client].sort(sortByName);
    await writeClients(req, next);
    logEvent(req, 'client.create', { hasGstin: !!client.gstin });
    res.status(201).json({ client, clients: next });
  }),
);

// --- Update ----------------------------------------------------------------

router.patch(
  '/clients/:id',
  requireAuth,
  handle(async (req, res) => {
    const clients = await readClients(req);
    const i = clients.findIndex((c) => c.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Client not found' });

    const updated = {
      ...clients[i],
      ...sanitiseClient(req.body, clients[i]),
      updatedAt: new Date().toISOString(),
    };
    const complaint = validateClient(updated);
    if (complaint) return res.status(400).json({ error: complaint });

    const clash = clients.find((c) => c.id !== updated.id && sameName(c.name, updated.name));
    if (clash) return res.status(409).json({ error: `“${clash.name}” is already in the list` });

    const next = [...clients];
    next[i] = updated;
    next.sort(sortByName);
    await writeClients(req, next);
    res.json({ client: updated, clients: next });
  }),
);

// --- Delete ----------------------------------------------------------------

/**
 * Only ever deletes a client with no entries. One that has been traded with is
 * deactivated instead, so its history keeps a name and its balance keeps
 * counting towards the totals.
 */
router.delete(
  '/clients/:id',
  requireAuth,
  handle(async (req, res) => {
    const clients = await readClients(req);
    const client = clients.find((c) => c.id === req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const entries = await readEntries(req);
    const used = entries.filter((e) => e.clientId === client.id).length;

    if (used > 0) {
      const next = clients.map((c) => (c.id === client.id ? { ...c, active: false } : c));
      await writeClients(req, next);
      return res.json({
        clients: next,
        deactivated: true,
        message: `${client.name} has ${used} ledger ${used === 1 ? 'entry' : 'entries'}, so they were made inactive rather than deleted.`,
      });
    }

    const next = clients.filter((c) => c.id !== client.id);
    await writeClients(req, next);
    logEvent(req, 'client.delete', {});
    res.json({ clients: next, deactivated: false });
  }),
);

export default router;
