import { toDateKey, keyToDate, addDays } from './dates.js';

export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly'];
const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

function addMonthsClamped(startKey, months) {
  const s = keyToDate(startKey);
  const y = s.getUTCFullYear();
  const m = s.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toDateKey(new Date(Date.UTC(y, m, Math.min(s.getUTCDate(), lastDay))));
}

/** Every debit date from start up to (and including) `untilKey`. */
export function installmentDates(startKey, frequency, untilKey) {
  const start = toDateKey(startKey);
  const until = toDateKey(untilKey);
  if (!FREQUENCIES.includes(frequency)) throw new Error(`frequency must be one of ${FREQUENCIES.join(', ')}`);
  const dates = [];
  for (let i = 0; ; i++) {
    let d;
    if (frequency === 'daily') d = addDays(start, i);
    else if (frequency === 'weekly') d = addDays(start, 7 * i);
    else d = addMonthsClamped(start, (frequency === 'monthly' ? 1 : 3) * i);
    if (d > until) break;
    dates.push(d);
  }
  return dates;
}

/**
 * Split a SIP debit into GST and the amount that actually buys gold.
 * gstInclusive=true  -> the SIP amount already contains GST (how most digital-gold apps work)
 * gstInclusive=false -> GST is charged on top of the SIP amount
 */
export function splitGst(amount, gstPct, gstInclusive) {
  if (gstInclusive) {
    const net = amount / (1 + gstPct / 100);
    return { paid: amount, gst: amount - net, net };
  }
  const gst = (amount * gstPct) / 100;
  return { paid: amount + gst, gst, net: amount };
}

/**
 * Build the full installment ledger and totals for a gold SIP.
 * priceOn(dateKey) must return the INR/gram rate (pre-GST) for that date.
 */
export function computeSip({ sipAmount, gstPercent, gstInclusive, frequency, startDate, endDate, premiumPercent = 0 }, todayKey, priceOn) {
  const until = endDate && toDateKey(endDate) < todayKey ? toDateKey(endDate) : todayKey;
  const dates = toDateKey(startDate) > until ? [] : installmentDates(startDate, frequency, until);
  const installments = dates.map((date) => {
    const { paid, gst, net } = splitGst(sipAmount, gstPercent, gstInclusive);
    const pricePerGram = priceOn(date) * (1 + premiumPercent / 100);
    return { date: keyToDate(date), amountPaid: round(paid), gst: round(gst), netAmount: round(net), pricePerGram: round(pricePerGram), grams: round(net / pricePerGram, 4) };
  });
  const totals = installments.reduce(
    (t, i) => ({ paid: t.paid + i.amountPaid, gst: t.gst + i.gst, net: t.net + i.netAmount, grams: t.grams + i.grams }),
    { paid: 0, gst: 0, net: 0, grams: 0 },
  );
  return {
    installments,
    installmentCount: installments.length,
    totalInvested: round(totals.paid),
    totalGst: round(totals.gst),
    totalNetInvested: round(totals.net),
    totalGrams: round(totals.grams, 4),
    avgCostPerGram: totals.grams ? round(totals.paid / totals.grams) : 0,
    nextInstallmentDate: nextDate(startDate, frequency, todayKey, endDate),
  };
}

function nextDate(startKey, frequency, todayKey, endDate) {
  const future = installmentDates(startKey, frequency, addDays(todayKey, 100)).find((d) => d > todayKey);
  if (!future || (endDate && future > toDateKey(endDate))) return null;
  return keyToDate(future);
}
