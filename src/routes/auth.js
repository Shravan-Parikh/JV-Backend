import { Router } from 'express';
import { config } from '../config.js';
import {
  signUp,
  signIn,
  refreshIdToken,
  sendPasswordReset,
  getDoc,
  setDoc,
  queryCollection,
  FirebaseError,
} from '../firebase.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { USERS } from '../collections.js';
import { logEvent } from '../activity.js';

const router = Router();

const roleFor = (email) =>
  config.adminEmails.includes(String(email).toLowerCase()) ? 'admin' : 'member';

const publicUser = (p) => ({
  id: p.uid,
  name: p.name || '',
  email: p.email || '',
  role: p.role || 'member',
});

const session = (auth, profile) => ({
  token: auth.idToken,
  refreshToken: auth.refreshToken,
  expiresIn: auth.expiresIn,
  user: publicUser(profile),
});

/** Wrap async handlers so thrown FirebaseErrors become clean HTTP responses. */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const status = e instanceof FirebaseError ? e.status : 500;
    res.status(status).json({ error: e.message || 'Something went wrong' });
  }
};

/**
 * Create the account's Firestore profile. Runs as the new user (their own
 * idToken), so no admin privileges are needed and rules stay strict.
 */
async function createProfile({ uid, name, email, idToken }) {
  const profile = {
    uid,
    name: String(name || '').trim(),
    email: String(email).trim().toLowerCase(),
    role: roleFor(email),
    createdAt: new Date(),
    lastLoginAt: new Date(),
  };
  await setDoc(USERS, uid, profile, idToken);
  return profile;
}

// --- Register (disabled by default for the pilot) --------------------------

router.post(
  '/register',
  handle(async (req, res) => {
    if (!config.allowPublicSignup) {
      return res.status(403).json({
        error: 'Sign-ups are closed. Accounts for JV Enterprises are created by an admin.',
      });
    }
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }
    const auth = await signUp(email, password, name);
    const profile = await createProfile({ ...auth, name, email });
    logEvent(req, 'auth.register', {});
    res.status(201).json(session(auth, profile));
  }),
);

// --- Login -----------------------------------------------------------------

router.post(
  '/login',
  handle(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    const auth = await signIn(email, password);

    // Self-heal: an account can exist in Firebase Auth without a profile doc
    // (e.g. created straight from the console).
    let profile = await getDoc(USERS, auth.uid, auth.idToken);
    if (!profile) {
      profile = await createProfile({
        uid: auth.uid,
        name: auth.displayName || email.split('@')[0],
        email,
        idToken: auth.idToken,
      });
    } else {
      await setDoc(USERS, auth.uid, { lastLoginAt: new Date() }, auth.idToken);
    }

    logEvent({ user: { uid: auth.uid }, idToken: auth.idToken }, 'auth.login', {});
    res.json(session(auth, profile));
  }),
);

// --- Refresh ---------------------------------------------------------------

router.post(
  '/refresh',
  handle(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });
    const auth = await refreshIdToken(refreshToken);
    const profile =
      (await getDoc(USERS, auth.uid, auth.idToken)) || { uid: auth.uid, role: 'member' };
    res.json(session(auth, profile));
  }),
);

// --- Password reset --------------------------------------------------------

/**
 * Accounts are admin-provisioned, so without this a forgotten password means a
 * manual reset by hand. Always responds 200, whether or not the address exists,
 * so the endpoint can't enumerate accounts.
 */
router.post(
  '/forgot-password',
  handle(async (req, res) => {
    const email = String(req.body?.email || '').trim();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    await sendPasswordReset(email);
    res.json({
      ok: true,
      message: 'If that address has an account, a reset link is on its way.',
    });
  }),
);

// --- Current user ----------------------------------------------------------

router.get(
  '/me',
  requireAuth,
  handle(async (req, res) => {
    const profile = await getDoc(USERS, req.user.uid, req.idToken);
    res.json({
      user: publicUser(profile || { uid: req.user.uid, ...req.user }),
    });
  }),
);

// --- Admin: provision an account -------------------------------------------

router.post(
  '/admin/users',
  requireAuth,
  requireAdmin,
  handle(async (req, res) => {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }
    // signUp returns the *new* user's token, which we use to write their own
    // profile — so admins never need write access to other users' documents.
    const auth = await signUp(email, password, name);
    const profile = await createProfile({ ...auth, name, email });
    logEvent(req, 'admin.user_created', {});
    res.status(201).json({ user: publicUser(profile) });
  }),
);

// --- Admin: list users -----------------------------------------------------

router.get(
  '/admin/users',
  requireAuth,
  requireAdmin,
  handle(async (req, res) => {
    const users = await queryCollection(USERS, {
      idToken: req.idToken,
      orderBy: { field: 'createdAt', direction: 'DESCENDING' },
      limit: 200,
    });
    res.json({ users: users.map(publicUser) });
  }),
);

export default router;
