import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import marketRoutes from './routes/market.js';
import valuationRoutes from './routes/valuation.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  // Behind Railway's (or any) reverse proxy: trust X-Forwarded-* headers.
  app.set('trust proxy', 1);
  // Gold SIP ledgers (daily SIPs over several years) are sent back for revaluation, so allow a roomy body.
  app.use(express.json({ limit: '20mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', marketRoutes);
  app.use('/api', valuationRoutes);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(path.join(here, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || 500;
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') status = err.status || 400;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Internal error' });
  });
  return app;
}
