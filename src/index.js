import express from 'express';
import cors from 'cors';
import { config, assertConfig } from './config.js';
import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import entryRoutes from './routes/entries.js';
import ledgerRoutes from './routes/ledger.js';
import exportRoutes from './routes/export.js';

assertConfig();

const app = express();

/**
 * An allowed origin is either an exact match or a `*.` wildcard entry, so a
 * single `https://*.run.app` covers a redeployed frontend without
 * re-configuring the service on each push.
 */
function originAllowed(origin) {
  return config.corsOrigins.some((allowed) => {
    if (allowed === origin) return true;
    if (!allowed.includes('*')) return false;
    const pattern = new RegExp(
      `^${allowed.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*')}$`,
    );
    return pattern.test(origin);
  });
}

app.use(
  cors({
    origin: (origin, cb) => {
      // allow same-origin / curl / server-to-server (no Origin header)
      if (!origin || originAllowed(origin)) return cb(null, true);
      return cb(null, false);
    },
  }),
);
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'jv-enterprises-api' }));

// Public auth routes
app.use('/api/auth', authRoutes);

// Everything below requires a valid token. Each router also carries its own
// requireAuth, so a route can never be exposed by a mistake in this file alone.
app.use('/api', requireAuth, clientRoutes);
app.use('/api', requireAuth, entryRoutes);
app.use('/api', requireAuth, ledgerRoutes);
app.use('/api', requireAuth, exportRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(config.port, () => {
  console.log(`JV Enterprises API listening on http://localhost:${config.port}`);
});
