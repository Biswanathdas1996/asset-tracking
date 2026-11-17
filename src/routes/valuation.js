import { Router } from 'express';
import * as yahoo from '../services/yahoo.js';
import * as coingecko from '../services/coingecko.js';
import { FREQUENCIES } from '../services/sip.js';
import { resolveBuyPrice, priceHolding, priceCrypto, recalculateSip, refreshAll } from '../services/valuation.js';
import { keyToDate, toDateKey } from '../services/dates.js';
import { portfolioHistory } from '../services/history.js';
import { asyncRoute, BadRequest, positiveNumber, nonNegativeNumber, pastOrTodayDate, normalizeStockSymbol } from './util.js';

/**
 * Stateless valuation endpoints. The browser keeps all records (encrypted in localStorage)
 * and sends them here only to be priced; the server stores nothing.
 */
const r = Router();
const round = (n) => Math.round(n * 100) / 100;
const MAX_RECORDS = 5000;

// Client-owned fields passed through untouched
const passThrough = (b) => {
  const out = {};
  if (typeof b._id === 'string' && b._id.length <= 64) out._id = b._id;
  if (b.createdAt) out.createdAt = b.createdAt;
  return out;
};
const text = (v, max = 500) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max));

async function identify(type, body) {
  if (type === 'stock') {
    const symbol = normalizeStockSymbol(body.symbol);
    const quote = await yahoo.getQuote(symbol).catch((e) => {
      throw e.status === 404 ? new BadRequest(`"${symbol}" was not found on NSE/BSE. Use the search to pick a valid symbol.`) : e;
    });
    return { symbol, name: text(body.name, 200) || quote.name, exchange: symbol.endsWith('.BO') ? 'BSE' : 'NSE', live: quote };
  }
  const coinId = String(body.coinId || '').trim().toLowerCase();
  if (!coinId) throw new BadRequest('coinId is required (CoinGecko id, e.g. "bitcoin")');
  const live = await coingecko.getPriceInr(coinId).catch((e) => {
    throw e.status === 404 ? new BadRequest(`Coin "${coinId}" was not found on CoinGecko. Use the search to pick a coin.`) : e;
  });
  const fallbackName = coinId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { coinId, symbol: String(body.symbol || coinId).trim().toUpperCase(), name: text(body.name, 200) || fallbackName, exchange: 'CoinGecko', live };
}

/** Validate a stock/crypto purchase and value it: buy price (market close on buy date unless given) + live price. */
r.post('/value/holding', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const type = b.assetType;
  if (!['stock', 'crypto'].includes(type)) throw new BadRequest('assetType must be "stock" or "crypto"');
  const id = await identify(type, b);
  const h = {
    ...passThrough(b),
    assetType: type,
    symbol: id.symbol,
    coinId: id.coinId,
    name: id.name,
    exchange: id.exchange,
    quantity: positiveNumber(b.quantity, 'quantity'),
    buyDate: keyToDate(pastOrTodayDate(b.buyDate, 'buyDate')),
    fees: nonNegativeNumber(b.fees, 'fees'),
    notes: text(b.notes),
  };
  const manual = b.buyPrice !== undefined && b.buyPrice !== null && b.buyPrice !== '';
  if (manual) {
    h.buyPrice = positiveNumber(b.buyPrice, 'buyPrice');
    h.buyPriceSource = 'manual';
  } else {
    const p = await resolveBuyPrice(h, toDateKey(h.buyDate));
    h.buyPrice = round(p.price);
    h.buyPriceSource = 'market';
    h.buyPriceDate = keyToDate(p.date);
  }
  h.investedValue = round(h.buyPrice * h.quantity + h.fees);
  if (type === 'stock') priceHolding(h, id.live);
  else priceCrypto(h, id.live);
  res.json(h);
}));

function readSip(b) {
  const out = {
    ...passThrough(b),
    name: text(b.name, 200) || 'Gold SIP',
    platform: text(b.platform, 200) || undefined,
    sipAmount: positiveNumber(b.sipAmount, 'sipAmount'),
    gstPercent: 3,
    gstInclusive: b.gstInclusive === undefined ? true : b.gstInclusive === true || b.gstInclusive === 'true',
    premiumPercent: 0,
  };
  if (b.gstPercent !== undefined && b.gstPercent !== '') {
    const g = Number(b.gstPercent);
    if (!Number.isFinite(g) || g < 0 || g > 100) throw new BadRequest('gstPercent must be between 0 and 100');
    out.gstPercent = g;
  }
  if (!FREQUENCIES.includes(b.frequency)) throw new BadRequest(`frequency must be one of: ${FREQUENCIES.join(', ')}`);
  out.frequency = b.frequency;
  out.startDate = keyToDate(pastOrTodayDate(b.startDate, 'startDate'));
  if (b.endDate) {
    try { out.endDate = keyToDate(toDateKey(b.endDate)); } catch { throw new BadRequest('endDate is not a valid date'); }
    if (toDateKey(out.endDate) < toDateKey(out.startDate)) throw new BadRequest('endDate must be after startDate');
  } else out.endDate = null;
  if (b.premiumPercent !== undefined && b.premiumPercent !== '') {
    const p = Number(b.premiumPercent);
    if (!Number.isFinite(p) || p < 0 || p > 50) throw new BadRequest('premiumPercent must be between 0 and 50');
    out.premiumPercent = p;
  }
  return out;
}

/** Validate a gold SIP and build its installment ledger from historical gold rates. */
r.post('/value/gold-sip', asyncRoute(async (req, res) => {
  const sip = readSip(req.body || {});
  await recalculateSip(sip);
  res.json(sip);
}));

/** Revalue everything the browser holds with live prices. */
r.post('/portfolio/refresh', asyncRoute(async (req, res) => {
  const { holdings = [], goldSips = [] } = req.body || {};
  if (!Array.isArray(holdings) || !Array.isArray(goldSips)) throw new BadRequest('holdings and goldSips must be arrays');
  if (holdings.length + goldSips.length > MAX_RECORDS) throw new BadRequest(`At most ${MAX_RECORDS} records can be refreshed at once`);
  const valid = (x) => x && typeof x === 'object';
  res.json(await refreshAll(holdings.filter(valid), goldSips.filter(valid)));
}));

/** Rebuild portfolio value over time from historical market prices (for the chart). */
r.post('/portfolio/history', asyncRoute(async (req, res) => {
  const { holdings = [], goldSips = [] } = req.body || {};
  if (!Array.isArray(holdings) || !Array.isArray(goldSips)) throw new BadRequest('holdings and goldSips must be arrays');
  if (holdings.length + goldSips.length > MAX_RECORDS) throw new BadRequest(`At most ${MAX_RECORDS} records at once`);
  const valid = (x) => x && typeof x === 'object';
  res.json(await portfolioHistory(holdings.filter(valid), goldSips.filter(valid)));
}));

export default r;
