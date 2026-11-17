import { Router } from 'express';
import * as yahoo from '../services/yahoo.js';
import * as coingecko from '../services/coingecko.js';
import * as gold from '../services/gold.js';
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
  const out = { id: req.params.id, ...(await coingecko.getPriceInr(req.params.id)) };
  if (req.query.date) out.onDate = await coingecko.getPriceOnDate({ id: req.params.id, symbol: req.query.symbol }, pastOrTodayDate(req.query.date, 'date'));
  res.json(out);
}));

r.get('/quote/gold', asyncRoute(async (req, res) => res.json(await gold.getLivePrice())));

export default r;
