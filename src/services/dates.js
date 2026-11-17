const DAY = 86400000;

/** Normalise any date-ish input to a 'YYYY-MM-DD' string (calendar date, no time zone drift). */
export function toDateKey(d) {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${d}`);
  return date.toISOString().slice(0, 10);
}

export const keyToDate = (key) => new Date(`${key}T00:00:00.000Z`);
export const addDays = (key, n) => toDateKey(new Date(keyToDate(key).getTime() + n * DAY));

/** Today's calendar date in India (prices and SIP debits follow IST). */
export function todayIST() {
  return toDateKey(new Date(Date.now() + 5.5 * 3600 * 1000));
}

/** Last value in a sorted [{date, close}] series on or before `key` (markets are shut on holidays). */
export function closeOnOrBefore(series, key) {
  let lo = 0, hi = series.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= key) { found = series[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}
