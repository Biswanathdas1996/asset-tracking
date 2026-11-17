import * as yahoo from './yahoo.js';
import * as gold from './gold.js';
import { toDateKey, addDays, todayIST, closeOnOrBefore } from './dates.js';

const round = (n) => Math.round(n * 100) / 100;
const MAX_DAYS = 1825; // up to 5 years of history
const DAILY_DAYS = 400; // daily points for the most recent ~13 months, weekly before that

/** Yahoo Finance symbol carrying a holding's daily INR closes. */
const marketSymbol = (h) => (h.assetType === 'stock' ? h.symbol : h.symbol ? `${String(h.symbol).toUpperCase()}-INR` : null);

function sampleDates(from, to) {
  const dailyFrom = addDays(to, -DAILY_DAYS);
  const out = [];
  let d = from;
  while (d < dailyFrom && d <= to) { out.push(d); d = addDays(d, 7); }
  if (d < dailyFrom) d = dailyFrom;
  for (; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Rebuild the portfolio's value over time from the records the browser sends:
 * each holding is valued at that day's market close from its buy date on, and each gold SIP
 * at that day's gold rate for the grams accumulated so far. Nothing is stored.
 */
export async function portfolioHistory(holdings, sips) {
  const today = todayIST();
  const errors = [];
  const lots = holdings
    .filter((h) => h && h.buyDate && Number(h.quantity) > 0)
    .map((h) => ({ start: toDateKey(h.buyDate), qty: Number(h.quantity), invested: Number(h.investedValue) || 0, sym: marketSymbol(h), name: h.name || h.symbol }));
  const installments = sips
    .flatMap((s) => (Array.isArray(s?.installments) ? s.installments : []))
    .map((i) => ({ date: toDateKey(i.date), grams: Number(i.grams) || 0, paid: Number(i.amountPaid) || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const starts = [...lots.map((l) => l.start), ...installments.slice(0, 1).map((i) => i.date)].sort();
  if (!starts.length) return { points: [], errors };
  const floor = addDays(today, -MAX_DAYS);
  const from = starts[0] < floor ? floor : starts[0] > today ? today : starts[0];

  const series = {};
  await Promise.all([...new Set(lots.map((l) => l.sym).filter(Boolean))].map(async (sym) => {
    try { series[sym] = await yahoo.getDailyCloses(sym, addDays(from, -10), today); } catch (e) { errors.push(`${sym}: ${e.message}`); }
  }));
  let goldOn = null;
  if (installments.length) {
    try { goldOn = await gold.getHistoricalPriceFn(from, today); } catch (e) { errors.push(`gold: ${e.message}`); }
  }

  let gi = 0, grams = 0, goldPaid = 0;
  const points = sampleDates(from, today).map((date) => {
    let value = 0, invested = 0;
    for (const l of lots) {
      if (l.start > date) continue;
      invested += l.invested;
      const c = l.sym && series[l.sym] ? closeOnOrBefore(series[l.sym], date) : null;
      value += c ? c.close * l.qty : l.invested; // no market data: carry at cost
    }
    while (gi < installments.length && installments[gi].date <= date) { grams += installments[gi].grams; goldPaid += installments[gi].paid; gi++; }
    if (goldPaid) {
      invested += goldPaid;
      let rate = null;
      try { rate = goldOn ? goldOn(date) : null; } catch { /* no rate that day */ }
      value += rate ? grams * rate : goldPaid;
    }
    return { date, value: round(value), invested: round(invested) };
  });
  return { points, errors };
}
