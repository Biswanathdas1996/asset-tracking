import * as yahoo from './yahoo.js';
import { config } from '../config.js';
import { closeOnOrBefore, addDays, toDateKey } from './dates.js';
import { UpstreamError } from './http.js';

export const TROY_OUNCE_GRAMS = 31.1034768;
const GOLD = 'GC=F'; // COMEX gold, USD per troy ounce
const USDINR = 'USDINR=X';

/** INR per gram of 24K (999) gold in India, before GST. */
export function perGramInr(usdPerOz, usdInr, dutyPct = config.goldImportDutyPct) {
  return (usdPerOz * usdInr / TROY_OUNCE_GRAMS) * (1 + dutyPct / 100);
}

export async function getLivePrice() {
  const [g, fx] = await Promise.all([yahoo.getQuote(GOLD), yahoo.getQuote(USDINR)]);
  return {
    pricePerGram: perGramInr(g.price, fx.price),
    usdPerOz: g.price,
    usdInr: fx.price,
    importDutyPct: config.goldImportDutyPct,
    marketTime: new Date(Math.max(g.marketTime.getTime(), fx.marketTime.getTime())),
  };
}

/**
 * Returns a function date -> INR/gram for every date in [fromKey, toKey], using the last
 * available close on or before each date (weekends/holidays carry the previous close).
 */
export async function getHistoricalPriceFn(fromKey, toKey) {
  const from = addDays(toDateKey(fromKey), -10);
  const to = toDateKey(toKey);
  const [gold, fx] = await Promise.all([yahoo.getDailyCloses(GOLD, from, to), yahoo.getDailyCloses(USDINR, from, to)]);
  return (dateKey) => {
    const g = closeOnOrBefore(gold, dateKey);
    const f = closeOnOrBefore(fx, dateKey);
    if (!g || !f) throw new UpstreamError(`No gold price available for ${dateKey}`, 404);
    return perGramInr(g.close, f.close);
  };
}
