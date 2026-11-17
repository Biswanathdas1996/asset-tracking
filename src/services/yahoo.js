import { getJson, ttlCache, UpstreamError } from './http.js';
import { config } from '../config.js';
import { toDateKey, keyToDate, addDays, closeOnOrBefore, todayIST } from './dates.js';

const BASE = 'https://query1.finance.yahoo.com';
const cache = ttlCache();

async function chart(symbol, params) {
  const qs = new URLSearchParams({ interval: '1d', includePrePost: 'false', ...params });
  const data = await getJson(`${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`);
  const result = data?.chart?.result?.[0];
  if (!result) throw new UpstreamError(`No market data for ${symbol}`, 404);
  return result;
}

/** Live quote: last traded price from the exchange feed. */
export function getQuote(symbol) {
  return cache.get(`q:${symbol}`, config.priceCacheSeconds * 1000, async () => {
    const r = await chart(symbol, { range: '1d' });
    const m = r.meta;
    if (typeof m.regularMarketPrice !== 'number') throw new UpstreamError(`No live price for ${symbol}`, 404);
    return {
      symbol: m.symbol,
      name: m.longName || m.shortName || m.symbol,
      price: m.regularMarketPrice,
      previousClose: m.chartPreviousClose ?? m.previousClose ?? null,
      currency: m.currency,
      exchange: m.fullExchangeName || m.exchangeName,
      marketTime: m.regularMarketTime ? new Date(m.regularMarketTime * 1000) : new Date(),
    };
  });
}

/** Daily closing prices between two calendar dates (inclusive), keyed by exchange-local date. */
export function getDailyCloses(symbol, fromKey, toKey) {
  const from = toDateKey(fromKey);
  const to = toDateKey(toKey);
  return cache.get(`h:${symbol}:${from}:${to}`, 6 * 3600 * 1000, async () => {
    const r = await chart(symbol, {
      period1: String(Math.floor(keyToDate(from).getTime() / 1000) - 86400),
      period2: String(Math.floor(keyToDate(addDays(to, 1)).getTime() / 1000) + 86400),
    });
    const ts = r.timestamp || [];
    const closes = r.indicators?.quote?.[0]?.close || [];
    const offset = (r.meta.gmtoffset || 0) * 1000;
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null) continue;
      out.push({ date: toDateKey(new Date(ts[i] * 1000 + offset)), close: closes[i] });
    }
    // de-duplicate (Yahoo sometimes repeats the live bar) keeping the latest
    const byDate = new Map(out.map((p) => [p.date, p]));
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  });
}

/** Closing price on a given date (or the previous trading day if the market was shut). */
export async function getPriceOnDate(symbol, dateKey) {
  const key = toDateKey(dateKey);
  if (key >= todayIST()) {
    const q = await getQuote(symbol);
    return { date: key, price: q.price };
  }
  const series = await getDailyCloses(symbol, addDays(key, -14), key);
  const hit = closeOnOrBefore(series, key);
  if (!hit) throw new UpstreamError(`No ${symbol} price found on or before ${key}`, 404);
  return { date: hit.date, price: hit.close };
}

/** Search NSE / BSE listed securities. */
export async function searchIndian(query) {
  const qs = new URLSearchParams({ q: query, quotesCount: '15', newsCount: '0', listsCount: '0' });
  const data = await getJson(`${BASE}/v1/finance/search?${qs}`);
  return (data.quotes || [])
    .filter((q) => ['NSI', 'BSE'].includes(q.exchange) && ['EQUITY', 'ETF', 'MUTUALFUND'].includes(q.quoteType))
    .map((q) => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
      exchange: q.exchange === 'NSI' ? 'NSE' : 'BSE',
      type: q.typeDisp || q.quoteType,
    }));
}

export const _cache = cache;
