import { getJson, ttlCache } from './http.js';
import { config } from '../config.js';
import { toDateKey } from './dates.js';

/**
 * CoinDCX public market data (no API key). Prices are the actual INR rates traded on an
 * Indian exchange, which usually differ from the global CoinGecko INR rate.
 * Coins with an INR market are priced directly; coins only listed against USDT are
 * converted with the USDT/INR rate.
 */
const API = 'https://api.coindcx.com';
const PUBLIC = 'https://public.coindcx.com';
const cache = ttlCache();
const DAY_MS = 24 * 3600 * 1000;

/** symbol -> { inr?: market, usdt?: market } for every active market. Changes rarely. */
async function getMarkets() {
  return cache.get('markets', 6 * 3600 * 1000, async () => {
    const list = await getJson(`${API}/exchange/v1/markets_details`);
    const out = new Map();
    for (const m of list || []) {
      if (m.status !== 'active') continue;
      const quote = m.base_currency_short_name;
      if (quote !== 'INR' && quote !== 'USDT') continue;
      const sym = String(m.target_currency_short_name || '').toUpperCase();
      if (!sym) continue;
      const entry = out.get(sym) || {};
      // Prefer the INR-ecode ("I-") pair when the same market is listed on several engines
      const key = quote === 'INR' ? 'inr' : 'usdt';
      if (!entry[key] || m.ecode === 'I') entry[key] = { name: m.coindcx_name, pair: m.pair };
      out.set(sym, entry);
    }
    return out;
  });
}

/** market name (e.g. "BTCINR") -> ticker, for all markets in one call. */
async function getTickers() {
  return cache.get('tickers', config.cryptoPriceCacheSeconds * 1000, async () => {
    const list = await getJson(`${API}/exchange/ticker`);
    return new Map((list || []).map((t) => [t.market, t]));
  });
}

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

function livePrice(sym, markets, tickers) {
  const m = markets.get(sym);
  if (!m) return null;
  const at = (t) => (t?.timestamp ? new Date(t.timestamp * 1000) : new Date());

  const inr = m.inr && tickers.get(m.inr.name);
  if (inr && num(inr.last_price) > 0) {
    const ch = num(inr.change_24_hour);
    return { price: num(inr.last_price), change24hPct: Number.isFinite(ch) ? ch : null, marketTime: at(inr), source: 'coindcx', market: m.inr.name };
  }

  const usdt = m.usdt && tickers.get(m.usdt.name);
  const fx = tickers.get('USDTINR');
  if (usdt && fx && num(usdt.last_price) > 0 && num(fx.last_price) > 0) {
    const a = num(usdt.change_24_hour);
    const b = num(fx.change_24_hour);
    const change = Number.isFinite(a) && Number.isFinite(b) ? ((1 + a / 100) * (1 + b / 100) - 1) * 100 : null;
    return { price: num(usdt.last_price) * num(fx.last_price), change24hPct: change, marketTime: at(usdt), source: 'coindcx', market: m.usdt.name };
  }
  return null;
}

/** Live INR prices keyed by upper-case symbol. Symbols not traded on CoinDCX are omitted. */
export async function getPricesInr(symbols) {
  const syms = [...new Set(symbols.filter(Boolean).map((s) => String(s).toUpperCase()))];
  if (!syms.length) return {};
  const [markets, tickers] = await Promise.all([getMarkets(), getTickers()]);
  const out = {};
  for (const s of syms) {
    const p = livePrice(s, markets, tickers);
    if (p) out[s] = p;
  }
  return out;
}

/** Daily close for a CoinDCX pair on a date (the last candle at or before that UTC day). */
async function closeOn(pair, dateKey) {
  const dayStart = Date.parse(`${dateKey}T00:00:00Z`);
  const candles = await cache.get(`c:${pair}:${dateKey}`, DAY_MS, () =>
    // CoinDCX ignores endTime unless startTime is also given
    getJson(`${PUBLIC}/market_data/candles?${new URLSearchParams({ pair, interval: '1d', startTime: String(dayStart - 7 * DAY_MS), endTime: String(dayStart), limit: '8' })}`));
  const c = (candles || []).filter((x) => x.time <= dayStart && num(x.close) > 0).sort((x, y) => y.time - x.time)[0];
  return c ? { date: toDateKey(new Date(c.time)), price: num(c.close) } : null;
}

/** INR price of a symbol on a past date from CoinDCX daily candles, or null if unavailable. */
export async function getPriceOnDate(symbol, dateKey) {
  const sym = String(symbol || '').toUpperCase();
  const markets = await getMarkets();
  const m = markets.get(sym);
  if (!m) return null;
  if (m.inr) {
    const r = await closeOn(m.inr.pair, dateKey);
    if (r) return { ...r, source: 'coindcx' };
  }
  const fxPair = markets.get('USDT')?.inr?.pair;
  if (m.usdt && fxPair) {
    const [r, fx] = await Promise.all([closeOn(m.usdt.pair, dateKey), closeOn(fxPair, dateKey)]);
    if (r && fx) return { date: r.date, price: r.price * fx.price, source: 'coindcx' };
  }
  return null;
}

/** All daily candles of a pair between two date keys, ascending as [{ date, close }]. Pages past the 1000-candle limit. */
async function candleSeries(pair, fromKey, toKey) {
  return cache.get(`s:${pair}:${fromKey}:${toKey}`, 6 * 3600 * 1000, async () => {
    const start = Date.parse(`${fromKey}T00:00:00Z`);
    let end = Date.parse(`${toKey}T00:00:00Z`);
    const byDate = new Map();
    while (end >= start) {
      const page = await getJson(`${PUBLIC}/market_data/candles?${new URLSearchParams({ pair, interval: '1d', startTime: String(start), endTime: String(end), limit: '1000' })}`);
      if (!Array.isArray(page) || !page.length) break;
      let oldest = end;
      for (const c of page) {
        if (num(c.close) > 0) byDate.set(toDateKey(new Date(c.time)), num(c.close));
        oldest = Math.min(oldest, c.time);
      }
      if (page.length < 1000) break;
      end = oldest - DAY_MS;
    }
    return [...byDate].sort((a, b) => a[0].localeCompare(b[0])).map(([date, close]) => ({ date, close }));
  });
}

/**
 * Daily INR closes for a symbol from CoinDCX, ascending as [{ date, close }] (same shape as
 * yahoo.getDailyCloses), or null if CoinDCX doesn't trade it.
 */
export async function getDailyCloses(symbol, fromKey, toKey) {
  const sym = String(symbol || '').toUpperCase();
  const from = toDateKey(fromKey);
  const to = toDateKey(toKey);
  const markets = await getMarkets();
  const m = markets.get(sym);
  if (!m) return null;
  if (m.inr) {
    const s = await candleSeries(m.inr.pair, from, to);
    if (s.length) return s;
  }
  const fxPair = markets.get('USDT')?.inr?.pair;
  if (m.usdt && fxPair) {
    const [s, fx] = await Promise.all([candleSeries(m.usdt.pair, from, to), candleSeries(fxPair, from, to)]);
    const out = [];
    let j = 0, rate = null;
    for (const p of s) {
      while (j < fx.length && fx[j].date <= p.date) rate = fx[j++].close;
      if (rate) out.push({ date: p.date, close: p.close * rate });
    }
    if (out.length) return out;
  }
  return null;
}

export const _clearCache = () => cache.clear();
