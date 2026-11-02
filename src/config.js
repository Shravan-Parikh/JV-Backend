import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 4100),
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3100')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  firebase: {
    // The web API key is a public project identifier, not a secret — access is
    // controlled by Firestore security rules (see firestore.rules).
    apiKey: process.env.FIREBASE_API_KEY || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
  },

  // This is a single-business tool: accounts are provisioned, never self-served.
  allowPublicSignup: String(process.env.ALLOW_PUBLIC_SIGNUP || 'false') === 'true',
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Default GST rate on job-work billing. Guidance on the rate for yarn
  // twisting under SAC 9988 is not consistent, so it is configurable here and
  // overridable per client and per entry — never hardcoded in the domain code.
  defaultGstRate: Number(process.env.DEFAULT_GST_RATE ?? 5),
};

/** Fail fast at boot rather than on the first request. */
export function assertConfig() {
  const missing = [];
  if (!config.firebase.apiKey) missing.push('FIREBASE_API_KEY');
  if (!config.firebase.projectId) missing.push('FIREBASE_PROJECT_ID');
  if (missing.length) {
    throw new Error(
      `Missing required env: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`,
    );
  }
}
