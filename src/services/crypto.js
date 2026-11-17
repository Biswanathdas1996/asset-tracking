import * as coindcx from './coindcx.js';
import * as coingecko from './coingecko.js';
import { UpstreamError } from './http.js';
import { toDateKey, todayIST } from './dates.js';

/**
 * Crypto pricing: CoinDCX (Indian exchange INR rate, near real-time) first, CoinGecko as the
 * fallback for coins CoinDCX doesn't list or when CoinDCX is unreachable.
 * Coins are identified by { id: CoinGecko id, symbol }; CoinDCX is matched on the symbol.
 */

/** Live INR prices keyed by CoinGecko id. */
export async function getPricesInr(coins) {
  const byId = new Map();
  for (const c of coins) if (c?.id && !byId.has(c.id)) byId.set(c.id, c.symbol ? String(c.symbol).toUpperCase() : null);
  if (!byId.size) return {};

  const out = {};
  let dcxError = null;
  try {
    const dcx = await coindcx.getPricesInr([...byId.values()]);
    for (const [id, sym] of byId) if (sym && dcx[sym]) out[id] = dcx[sym];
  } catch (e) { dcxError = e; }

  const missing = [...byId.keys()].filter((id) => !out[id]);
  if (missing.length) {
    try {
      const cg = await coingecko.getPricesInr(missing);
      for (const id of missing) if (cg[id]) out[id] = { ...cg[id], source: 'coingecko' };
    } catch (e) {
      if (!Object.keys(out).length) throw dcxError || e;
    }
  }
  return out;
}

export async function getPriceInr({ id, symbol }) {
  const prices = await getPricesInr([{ id, symbol }]);
  if (!prices[id]) throw new UpstreamError(`No live INR price for coin "${id}"`, 404);
  return prices[id];
}

/** INR price on a date, from the same source the live price comes from so P&L stays consistent. */
export async function getPriceOnDate({ id, symbol }, dateKey) {
  const key = toDateKey(dateKey);
  if (key >= todayIST()) {
    const live = await getPriceInr({ id, symbol });
    return { date: key, price: live.price, source: live.source };
  }
  if (symbol) {
    const live = await coindcx.getPricesInr([symbol]).catch(() => ({}));
    if (live[String(symbol).toUpperCase()]) {
      const r = await coindcx.getPriceOnDate(symbol, key).catch(() => null);
      if (r) return r;
    }
  }
  return coingecko.getPriceOnDate({ id, symbol }, key);
}
