import { Router } from 'express';
import { newsBrief } from '../services/newsAgent.js';
import { asyncRoute, BadRequest } from './util.js';

const r = Router();
const MAX_HOLDINGS = 60;
const text = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * POST /api/news/brief  { holdings: [{ key, assetType, symbol, name, dayChangePercent? }] }
 * Only names and symbols are needed (no quantities or amounts). The server stores nothing.
 */
r.post('/news/brief', asyncRoute(async (req, res) => {
  const list = req.body?.holdings;
  if (!Array.isArray(list)) throw new BadRequest('holdings must be an array');
  if (list.length > MAX_HOLDINGS) throw new BadRequest(`At most ${MAX_HOLDINGS} holdings per request`);
  const seen = new Set();
  const holdings = [];
  for (const h of list) {
    if (!['stock', 'crypto', 'gold'].includes(h?.assetType)) throw new BadRequest('assetType must be "stock", "crypto" or "gold"');
    const key = text(h.key, 80);
    if (!key) throw new BadRequest('key is required');
    if (seen.has(key)) continue;
    seen.add(key);
    const symbol = text(h.symbol, 40);
    const name = text(h.name, 200) || symbol;
    if (h.assetType !== 'gold' && !name) throw new BadRequest('name or symbol is required');
    const dc = Number(h.dayChangePercent);
    holdings.push({ key, assetType: h.assetType, symbol, name, dayChangePercent: h.dayChangePercent == null || !Number.isFinite(dc) ? null : dc });
  }
  if (!holdings.length) throw new BadRequest('Add a holding to get news');
  res.json(await newsBrief(holdings));
}));

export default r;
