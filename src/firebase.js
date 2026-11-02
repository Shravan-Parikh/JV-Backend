/**
 * firebase.js — Firebase Auth + Firestore access for the JV Enterprises API.
 *
 * This is the one module that knows Firebase exists. Everything above it deals
 * in plain objects, so moving JV to its own Firebase project (or off Firebase
 * entirely) means replacing this file and the two env vars in config.js.
 *
 * Deliberately uses Firebase's REST APIs rather than `firebase-admin`, so the
 * server needs only the public web API key + project id (no service-account
 * JSON to provision, rotate or leak). Trade-offs:
 *
 *   - Firestore calls are made **as the signed-in user**, carrying their ID
 *     token, so security rules are genuinely enforced (see firestore.rules).
 *   - ID tokens are verified locally against Google's public certs — no network
 *     round-trip per request.
 *
 * If this ever needs privileged server-side writes (cron jobs, backfills),
 * that's the point to switch to firebase-admin with a service account.
 *
 * Collection names come from collections.js and are all prefixed `jv_`, so the
 * Firebase project shared with another app is never read or written.
 *
 * `collection` is a path, not just a name, so sub-collections work unchanged:
 * `getDoc('jv_ledgers/<uid>/months', '2026-11', token)`.
 */

import jwt from 'jsonwebtoken';
import { config } from './config.js';

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts';
const SECURE_TOKEN = 'https://securetoken.googleapis.com/v1/token';
const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

const firestoreBase = () =>
  `https://firestore.googleapis.com/v1/projects/${config.firebase.projectId}/databases/(default)/documents`;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FirebaseError extends Error {
  constructor(message, status = 400, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Turn Firebase's SCREAMING_SNAKE error codes into something a human reads. */
const FRIENDLY = {
  EMAIL_EXISTS: 'An account with that email already exists',
  EMAIL_NOT_FOUND: 'Invalid credentials',
  INVALID_PASSWORD: 'Invalid credentials',
  INVALID_LOGIN_CREDENTIALS: 'Invalid credentials',
  USER_DISABLED: 'This account has been disabled',
  WEAK_PASSWORD: 'Password must be at least 6 characters',
  INVALID_EMAIL: 'That email address looks invalid',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts — please try again later',
  TOKEN_EXPIRED: 'Session expired',
  INVALID_REFRESH_TOKEN: 'Session expired',
};

async function callIdentity(path, body) {
  const res = await fetch(`${IDENTITY}:${path}?key=${config.firebase.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = data?.error?.message || 'AUTH_FAILED';
    const key = String(raw).split(' ')[0];
    const status = key.includes('PASSWORD') || key.includes('CREDENTIAL') ? 401 : 400;
    throw new FirebaseError(FRIENDLY[key] || raw, status, key);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Auth — Identity Toolkit
// ---------------------------------------------------------------------------

/** Create an account. Returns { uid, idToken, refreshToken, expiresIn }. */
export async function signUp(email, password, displayName) {
  const data = await callIdentity('signUp', {
    email,
    password,
    displayName,
    returnSecureToken: true,
  });
  return {
    uid: data.localId,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresIn: Number(data.expiresIn || 3600),
  };
}

/** Sign in with email + password. */
export async function signIn(email, password) {
  const data = await callIdentity('signInWithPassword', {
    email,
    password,
    returnSecureToken: true,
  });
  return {
    uid: data.localId,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    displayName: data.displayName || '',
    expiresIn: Number(data.expiresIn || 3600),
  };
}

/** Exchange a refresh token for a fresh ID token. */
export async function refreshIdToken(refreshToken) {
  const res = await fetch(`${SECURE_TOKEN}?key=${config.firebase.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const key = String(data?.error?.message || 'INVALID_REFRESH_TOKEN').split(' ')[0];
    throw new FirebaseError(FRIENDLY[key] || 'Session expired', 401, key);
  }
  return {
    uid: data.user_id,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in || 3600),
  };
}

/**
 * Send a password-reset email. Firebase delivers it, so this needs no mail
 * provider and costs nothing.
 *
 * Deliberately does not reveal whether the address exists — the caller always
 * reports success, so this endpoint can't be used to enumerate pilot accounts.
 */
export async function sendPasswordReset(email) {
  try {
    await callIdentity('sendOobCode', { requestType: 'PASSWORD_RESET', email });
  } catch (e) {
    // EMAIL_NOT_FOUND is expected and must stay invisible to the caller.
    if (e instanceof FirebaseError && /not found|Invalid credentials/i.test(e.message)) return;
    throw e;
  }
}

/** Set the display name on an existing account. */
export async function updateDisplayName(idToken, displayName) {
  return callIdentity('update', { idToken, displayName, returnSecureToken: false });
}

// ---------------------------------------------------------------------------
// ID token verification (local, against Google's rotating public certs)
// ---------------------------------------------------------------------------

let certCache = { certs: null, expiresAt: 0 };

async function googleCerts() {
  if (certCache.certs && Date.now() < certCache.expiresAt) return certCache.certs;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new FirebaseError('Could not fetch Google signing certs', 503);
  const certs = await res.json();
  // Respect Google's cache header; fall back to an hour.
  const cc = res.headers.get('cache-control') || '';
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] || 3600);
  certCache = { certs, expiresAt: Date.now() + maxAge * 1000 };
  return certs;
}

/**
 * Verify a Firebase ID token and return its payload.
 * Checks signature (RS256 against the matching kid), issuer, audience and exp.
 */
export async function verifyIdToken(token) {
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded?.header?.kid;
  if (!kid) throw new FirebaseError('Malformed token', 401);

  const certs = await googleCerts();
  const cert = certs[kid];
  if (!cert) throw new FirebaseError('Unknown token signing key', 401);

  const { projectId } = config.firebase;
  try {
    return jwt.verify(token, cert, {
      algorithms: ['RS256'],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
    });
  } catch (e) {
    const expired = e?.name === 'TokenExpiredError';
    throw new FirebaseError(expired ? 'Session expired' : 'Invalid token', 401);
  }
}

// ---------------------------------------------------------------------------
// Firestore REST — value encoding
// ---------------------------------------------------------------------------

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}

function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = encodeValue(v);
  return fields;
}

function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}

/** Pull the document id off a Firestore REST `name` path. */
const docId = (name) => String(name || '').split('/').pop();

// ---------------------------------------------------------------------------
// Firestore REST — operations (all performed AS the user, so rules apply)
// ---------------------------------------------------------------------------

async function firestore(path, { idToken, method = 'GET', body, query } = {}) {
  const url = new URL(`${firestoreBase()}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else if (v !== undefined) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Firestore ${res.status}`;
    throw new FirebaseError(msg, res.status === 403 ? 403 : 502);
  }
  return data;
}

/** Read one document. Returns the decoded data, or null if absent. */
export async function getDoc(collection, id, idToken) {
  const doc = await firestore(`/${collection}/${encodeURIComponent(id)}`, { idToken });
  if (!doc || !doc.fields) return null;
  return { id: docId(doc.name), ...decodeFields(doc.fields) };
}

/**
 * Create-or-merge a document at a known id. Only the supplied top-level fields
 * are written (updateMask), so concurrent writers don't clobber each other.
 */
export async function setDoc(collection, id, data, idToken) {
  const fieldPaths = Object.keys(data);
  const doc = await firestore(`/${collection}/${encodeURIComponent(id)}`, {
    idToken,
    method: 'PATCH',
    body: { fields: encodeFields(data) },
    query: { 'updateMask.fieldPaths': fieldPaths },
  });
  return { id, ...decodeFields(doc?.fields || {}) };
}

/** Append a document with a server-generated id. */
export async function addDoc(collection, data, idToken) {
  const doc = await firestore(`/${collection}`, {
    idToken,
    method: 'POST',
    body: { fields: encodeFields(data) },
  });
  return { id: docId(doc?.name), ...decodeFields(doc?.fields || {}) };
}

/** Delete a document. */
export async function deleteDoc(collection, id, idToken) {
  await firestore(`/${collection}/${encodeURIComponent(id)}`, { idToken, method: 'DELETE' });
}

/**
 * Run a structured query against one collection.
 * `where` is an optional { field, op, value }; `orderBy` an optional
 * { field, direction }. Kept to single-field predicates so Firestore's
 * automatic indexes suffice — no composite index to deploy.
 */
export async function queryCollection(
  collection,
  { where, orderBy, limit = 100, idToken } = {},
) {
  const structuredQuery = { from: [{ collectionId: collection }], limit };
  if (where) {
    structuredQuery.where = {
      fieldFilter: {
        field: { fieldPath: where.field },
        op: where.op || 'EQUAL',
        value: encodeValue(where.value),
      },
    };
  }
  if (orderBy) {
    structuredQuery.orderBy = [
      {
        field: { fieldPath: orderBy.field },
        direction: orderBy.direction || 'DESCENDING',
      },
    ];
  }
  const rows = await firestore(':runQuery', {
    idToken,
    method: 'POST',
    body: { structuredQuery },
  });
  return (rows || [])
    .filter((r) => r.document)
    .map((r) => ({ id: docId(r.document.name), ...decodeFields(r.document.fields || {}) }));
}

/**
 * List every document in a collection, paging until Firestore stops returning a
 * token. Used by the migration script and as a repair path when a ledger's
 * month index is missing; normal reads go straight to a known document id.
 */
export async function listDocuments(collection, { idToken, pageSize = 300 } = {}) {
  const out = [];
  let pageToken;
  do {
    const page = await firestore(`/${collection}`, {
      idToken,
      query: { pageSize, ...(pageToken ? { pageToken } : {}) },
    });
    for (const doc of page?.documents || []) {
      out.push({ id: docId(doc.name), ...decodeFields(doc.fields || {}) });
    }
    pageToken = page?.nextPageToken;
  } while (pageToken);
  return out;
}
