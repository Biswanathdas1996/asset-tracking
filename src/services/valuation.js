import * as yahoo from './yahoo.js';
import * as crypto from './crypto.js';
import * as gold from './gold.js';
import { computeSip } from './sip.js';
import { toDateKey, todayIST } from './dates.js';
import { UpstreamError } from './http.js';

const round = (n) => Math.round(n * 100) / 100;

/** Resolve the buy price for a new stock/crypto purchase from historical market data. */
export async function resolveBuyPrice({ assetType, symbol, coinId }, buyDate) {
  if (assetType === 'stock') return yahoo.getPriceOnDate(symbol, buyDate);
  return crypto.getPriceOnDate({ id: coinId, symbol }, buyDate);
}

/** Value a stock/crypto holding at a live price. Mutates and returns `h`. */
export function priceHolding(h, { price, previousClose = null, dayChangePercent = null, marketTime = new Date() }) {
  h.currentPrice = price;
  h.previousClose = previousClose;
  h.currentValue = round(price * h.quantity);
  h.pnl = round(h.currentValue - h.investedValue);
  h.pnlPercent = h.investedValue ? round((h.pnl / h.investedValue) * 100) : 0;
  h.dayChangePercent = dayChangePercent ?? (previousClose ? round(((price - previousClose) / previousClose) * 100) : null);
  h.priceUpdatedAt = marketTime;
  return h;
}

/** Value a crypto holding from a live INR price (CoinDCX, or CoinGecko fallback). */
export function priceCrypto(h, p) {
  return priceHolding(h, { price: p.price, dayChangePercent: p.change24hPct != null ? round(p.change24hPct) : null, marketTime: p.marketTime });
}

/** Value a gold SIP at the live gold rate. Mutates and returns `sip`. */
export function priceSip(sip, { pricePerGram, marketTime = new Date() }) {
  sip.currentPricePerGram = round(pricePerGram);
  sip.currentValue = round((sip.totalGrams || 0) * pricePerGram);
  sip.pnl = round(sip.currentValue - (sip.totalInvested || 0));
  sip.pnlPercent = sip.totalInvested ? round((sip.pnl / sip.totalInvested) * 100) : 0;
  sip.priceUpdatedAt = marketTime;
  return sip;
}

/** (Re)build a SIP's installment ledger from the schedule + historical gold rates, then value it live. */
export async function recalculateSip(sip, livePrice) {
  const today = todayIST();
  const start = toDateKey(sip.startDate);
  const priceOn = start <= today ? await gold.getHistoricalPriceFn(start, today) : () => 0;
  const live = livePrice || (await gold.getLivePrice());
  // Today's installment uses the live rate; past ones use that day's closing rate.
  const result = computeSip(sip, today, (d) => (d === today ? live.pricePerGram : priceOn(d)));
  Object.assign(sip, result, { calculatedUpTo: today });
  priceSip(sip, live);
  return sip;
}

/**
 * Revalue the holdings and SIPs sent by the browser with live market prices.
 * Nothing is stored on the server — the updated records are returned to the caller.
 */
export async function refreshAll(holdings, sips) {
  const errors = [];

  // Stocks — one quote per unique symbol
  const stockSymbols = [...new Set(holdings.filter((h) => h.assetType === 'stock').map((h) => h.symbol))];
  const quotes = {};
  await Promise.all(stockSymbols.map(async (s) => {
    try { quotes[s] = await yahoo.getQuote(s); } catch (e) { errors.push(`${s}: ${e.message}`); }
  }));

  // Crypto — one batched CoinDCX ticker call (CoinGecko for coins not on CoinDCX)
  const coins = holdings.filter((h) => h.assetType === 'crypto').map((h) => ({ id: h.coinId, symbol: h.symbol }));
  let coinPrices = {};
  if (coins.length) {
    try { coinPrices = await crypto.getPricesInr(coins); } catch (e) { errors.push(`crypto: ${e.message}`); }
  }

  for (const h of holdings) {
    if (h.assetType === 'stock' && quotes[h.symbol]) priceHolding(h, quotes[h.symbol]);
    if (h.assetType === 'crypto' && coinPrices[h.coinId]) {
      priceCrypto(h, coinPrices[h.coinId]);
      h.exchange = coinPrices[h.coinId].source === 'coindcx' ? 'CoinDCX' : 'CoinGecko';
    }
  }

  // Gold — live rate, and extend each SIP's ledger with any installments that fell due since last run
  let goldLive = null;
  if (sips.length) {
    try { goldLive = await gold.getLivePrice(); } catch (e) { errors.push(`gold: ${e.message}`); }
  }
  for (const sip of sips) {
    if (!goldLive) continue;
    try {
      if (sip.calculatedUpTo !== todayIST() || !Array.isArray(sip.installments)) await recalculateSip(sip, goldLive);
      else priceSip(sip, goldLive);
    } catch (e) { errors.push(`${sip.name}: ${e.message}`); }
  }

  return { holdings, goldSips: sips, goldLive, errors, refreshedAt: new Date() };
}

export { UpstreamError };
