import { verifyIdToken, getDoc, FirebaseError } from '../firebase.js';
import { USERS } from '../collections.js';

/**
 * Requires a valid Firebase ID token. Attaches:
 *   req.user    { uid, email, name }
 *   req.idToken the raw token, so downstream Firestore calls run AS the user
 *               and are subject to security rules.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = await verifyIdToken(token);
    req.user = {
      uid: payload.sub,
      email: payload.email || '',
      name: payload.name || payload.display_name || '',
    };
    req.idToken = token;
    next();
  } catch (e) {
    const status = e instanceof FirebaseError ? e.status : 401;
    return res.status(status).json({ error: e.message || 'Invalid or expired token' });
  }
}

/** Requires the caller's profile to carry role === 'admin'. Use after requireAuth. */
export async function requireAdmin(req, res, next) {
  try {
    const profile = await getDoc(USERS, req.user.uid, req.idToken);
    if (profile?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.profile = profile;
    next();
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e.message || 'Could not verify role' });
  }
}
