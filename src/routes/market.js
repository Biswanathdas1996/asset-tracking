import { Router } from 'express';
import * as yahoo from '../services/yahoo.js';
import * as coingecko from '../services/coingecko.js';
import * as crypto from '../services/crypto.js';
import * as gold from '../services/gold.js';
import * as shareholding from '../services/shareholding.js';
import { asyncRoute, BadRequest, normalizeStockSymbol, pastOrTodayDate } from './util.js';

const r = Router();
const q = (req) => {
  const v = String(req.query.q || '').trim();
  if (v.length < 2) throw new BadRequest('q must be at least 2 characters');
  return v;
};

r.get('/search/stocks', asyncRoute(async (req, res) => res.json(await yahoo.searchIndian(q(req)))));
r.get('/search/crypto', asyncRoute(async (req, res) => res.json(await coingecko.searchCoins(q(req)))));

r.get('/quote/stock/:symbol', asyncRoute(async (req, res) => {
  const symbol = normalizeStockSymbol(req.params.symbol);
  const quote = await yahoo.getQuote(symbol);
  const out = { ...quote };
  if (req.query.date) out.onDate = await yahoo.getPriceOnDate(symbol, pastOrTodayDate(req.query.date, 'date'));
  res.json(out);
}));

r.get('/quote/crypto/:id', asyncRoute(async (req, res) => {
  const coin = { id: req.params.id, symbol: req.query.symbol ? String(req.query.symbol) : undefined };
  const out = { id: coin.id, ...(await crypto.getPriceInr(coin)) };
  if (req.query.date) out.onDate = await crypto.getPriceOnDate(coin, pastOrTodayDate(req.query.date, 'date'));
  res.json(out);
}));

// GET /api/logo/JPL.NS -> 302 to the company mark, or 404 when none is published.
r.get('/logo/:symbol', asyncRoute(async (req, res) => {
  const symbol = normalizeStockSymbol(req.params.symbol);
  const url = await shareholding.getLogoUrl(symbol);
  if (!url) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  res.redirect(302, url);
}));

// GET /api/crypto-logo/polygon-ecosystem-token -> 302 to the coin mark, or 404 when none is published.
r.get('/crypto-logo/:id', asyncRoute(async (req, res) => {
  const url = await coingecko.getCoinLogoUrl(req.params.id);
  if (!url) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  res.redirect(302, url);
}));

// GET /api/shareholding?symbols=RELIANCE.NS,TCS.NS -> { [symbol]: { fii, dii, asOf } | null }
r.get('/shareholding', asyncRoute(async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!symbols.length) throw new BadRequest('symbols is required');
  if (symbols.length > 60) throw new BadRequest('At most 60 symbols per request');
  res.set('Cache-Control', 'private, max-age=3600');
  res.json(await shareholding.getShareholdingMany(symbols));
}));

r.get('/quote/gold',asyncRoute(async (req, res) => res.json(await gold.getLivePrice())));

export default r;
