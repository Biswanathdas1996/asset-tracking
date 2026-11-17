import { getJson, ttlCache, UpstreamError } from './http.js';
import { config } from '../config.js';
import { toDateKey, todayIST, addDays } from './dates.js';
import * as yahoo from './yahoo.js';

const BASE = 'https://api.coingecko.com/api/v3';
const cache = ttlCache();
const headers = () => (config.coingeckoApiKey ? { 'x-cg-demo-api-key': config.coingeckoApiKey } : {});

export async function searchCoins(query) {
  const data = await getJson(`${BASE}/search?query=${encodeURIComponent(query)}`, { headers: headers() });
  return (data.coins || []).slice(0, 15).map((c) => ({
    id: c.id,
    symbol: c.symbol?.toUpperCase(),
    name: c.name,
    rank: c.market_cap_rank,
    thumb: c.thumb,
  }));
}

/** Live INR prices for many coins in a single call. */
export async function getPricesInr(ids) {
  const unique = [...new Set(ids)].sort();
  if (!unique.length) return {};
  return cache.get(`p:${unique.join(',')}`, config.priceCacheSeconds * 1000, async () => {
    const qs = new URLSearchParams({
      ids: unique.join(','),
      vs_currencies: 'inr',
      include_24hr_change: 'true',
      include_last_updated_at: 'true',
    });
    const data = await getJson(`${BASE}/simple/price?${qs}`, { headers: headers() });
    const out = {};
    for (const id of unique) {
      const d = data[id];
      if (!d || typeof d.inr !== 'number') continue;
      out[id] = {
        price: d.inr,
        change24hPct: d.inr_24h_change ?? null,
        marketTime: d.last_updated_at ? new Date(d.last_updated_at * 1000) : new Date(),
      };
    }
    return out;
  });
}

export async function getPriceInr(id) {
  const prices = await getPricesInr([id]);
  if (!prices[id]) throw new UpstreamError(`No live INR price for coin "${id}"`, 404);
  return prices[id];
}

/**
 * INR price of a coin on a past date. CoinGecko's free API only serves the last 365 days of
 * history, so older dates fall back to Yahoo Finance's SYMBOL-INR daily series.
 */
export async function getPriceOnDate({ id, symbol }, dateKey) {
  const key = toDateKey(dateKey);
  if (key >= todayIST()) return { date: key, price: (await getPriceInr(id)).price, source: 'coingecko' };

  if (key > addDays(todayIST(), -360)) {
    try {
      const [y, m, d] = key.split('-');
      const data = await cache.get(`hist:${id}:${key}`, 24 * 3600 * 1000, () =>
        getJson(`${BASE}/coins/${encodeURIComponent(id)}/history?date=${d}-${m}-${y}&localization=false`, { headers: headers() }));
      const price = data?.market_data?.current_price?.inr;
      if (typeof price === 'number') return { date: key, price, source: 'coingecko' };
    } catch { /* fall through to Yahoo */ }
  }
  if (!symbol) throw new UpstreamError(`No historical price for ${id} on ${key}`, 404);
  const r = await yahoo.getPriceOnDate(`${symbol.toUpperCase()}-INR`, key);
  return { ...r, source: 'yahoo' };
}
