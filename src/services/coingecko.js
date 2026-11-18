import { getJson, ttlCache, UpstreamError } from './http.js';
import { config } from '../config.js';
import { toDateKey, todayIST, addDays } from './dates.js';
import * as yahoo from './yahoo.js';

const BASE = 'https://api.coingecko.com/api/v3';
const cache = ttlCache();
const LOGO_TTL = 12 * 3600 * 1000;
const IMAGE_HOSTS = new Set(['coin-images.coingecko.com', 'assets.coingecko.com']);
const headers = () => (config.coingeckoApiKey ? { 'x-cg-demo-api-key': config.coingeckoApiKey } : {});

/** CoinGecko-hosted coin image, or null. Other hosts are dropped so a redirect cannot leave CoinGecko. */
export function coinImageUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'https:' || !IMAGE_HOSTS.has(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

export async function searchCoins(query) {
  const data = await getJson(`${BASE}/search?query=${encodeURIComponent(query)}`, { headers: headers() });
  return (data.coins || []).slice(0, 15).map((c) => ({
    id: c.id,
    symbol: c.symbol?.toUpperCase(),
    name: c.name,
    rank: c.market_cap_rank,
    thumb: c.thumb,
    image: coinImageUrl(c.large) || coinImageUrl(c.thumb),
  }));
}

/** Square coin mark for a CoinGecko id (polygon-ecosystem-token, bitcoin, …). Cached, including misses. */
export async function getCoinLogoUrl(id) {
  const coinId = String(id || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(coinId)) return null;
  return cache.get(`logo:${coinId}`, LOGO_TTL, async () => {
    try {
      const data = await getJson(
        `${BASE}/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`,
        { headers: headers() },
      );
      return coinImageUrl(data?.image?.small) || coinImageUrl(data?.image?.large) || coinImageUrl(data?.image?.thumb);
    } catch {
      return null;
    }
  });
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
 * Daily INR closes for a coin over the last `days` (max 365 on the free API), ascending as
 * [{ date, close }] (same shape as yahoo.getDailyCloses).
 */
export async function getDailyCloses(id, days) {
  const n = Math.max(1, Math.min(365, Math.ceil(days)));
  return cache.get(`series:${id}:${n}`, 6 * 3600 * 1000, async () => {
    const qs = new URLSearchParams({ vs_currency: 'inr', days: String(n), interval: 'daily' });
    const data = await getJson(`${BASE}/coins/${encodeURIComponent(id)}/market_chart?${qs}`, { headers: headers() });
    const byDate = new Map();
    for (const [ms, price] of data?.prices || []) if (typeof price === 'number' && price > 0) byDate.set(toDateKey(new Date(ms)), price);
    return [...byDate].sort((a, b) => a[0].localeCompare(b[0])).map(([date, close]) => ({ date, close }));
  });
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
