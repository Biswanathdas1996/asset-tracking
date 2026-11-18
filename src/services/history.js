import * as yahoo from './yahoo.js';
import * as coindcx from './coindcx.js';
import * as coingecko from './coingecko.js';
import * as gold from './gold.js';
import { toDateKey, keyToDate, addDays, todayIST, closeOnOrBefore } from './dates.js';

const round = (n) => Math.round(n * 100) / 100;
const MAX_DAYS = 3650; // up to 10 years of history, one point per day
const LOOKBACK = 10; // fetch a little before the first buy so a weekend/holiday buy date still has a prior close
const STALE_DAYS = 7; // a source whose data stops this far short of the range is topped up from the next source
const MAX_STITCH_GAP = 0.25; // sources disagreeing by more than this at the join are not stitched (wrong units / split basis)
const SPIKE = 3; // a single close 3x away from both neighbours is a bad tick
const CONCURRENCY = 4;
const DAY = 86400000;

const daysBetween = (a, b) => Math.round((keyToDate(b) - keyToDate(a)) / DAY);

/**
 * Daily INR price sources for a holding, most trusted first. The first source is the one its live
 * price comes from, so the chart lines up with today's value; the rest fill gaps and older years.
 */
function sourcesFor(h) {
  const sym = String(h.symbol || '').trim();
  if (h.assetType === 'stock') {
    if (!sym) return [];
    const alt = sym.endsWith('.NS') ? `${sym.slice(0, -3)}.BO` : sym.endsWith('.BO') ? `${sym.slice(0, -3)}.NS` : null;
    return [sym, alt].filter(Boolean).map((s) => ({ label: s, fetch: (from, to) => yahoo.getDailyCloses(s, from, to) }));
  }
  if (h.assetType !== 'crypto') return [];
  const coin = sym.toUpperCase();
  const id = typeof h.coinId === 'string' ? h.coinId.trim().toLowerCase() : '';
  return [
    coin && { label: `${coin} (CoinDCX)`, fetch: (from, to) => coindcx.getDailyCloses(coin, from, to) },
    id && { label: `${coin || id} (CoinGecko)`, fetch: (from, to) => coingecko.getDailyCloses(id, daysBetween(from, to) + 1) },
    coin && { label: `${coin}-INR (Yahoo)`, fetch: (from, to) => yahoo.getDailyCloses(`${coin}-INR`, from, to) },
  ].filter(Boolean);
}

/** Drop non-positive closes and isolated spikes (one bar far away from both neighbours). */
export function despike(series) {
  const s = (series || []).filter((p) => p && Number.isFinite(p.close) && p.close > 0);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const prev = out.at(-1), next = s[i + 1];
    if (prev && next) {
      const a = s[i].close / prev.close, b = s[i].close / next.close;
      if ((a > SPIKE && b > SPIKE) || (a < 1 / SPIKE && b < 1 / SPIKE)) continue;
    }
    out.push(s[i]);
  }
  return out;
}

/**
 * Extend `base` with `extra`'s closes before its first and after its last date, scaled so the two
 * sources meet at the join (NSE vs BSE, CoinDCX vs global INR rates differ slightly).
 */
export function stitch(base, extra) {
  if (!base.length) return extra;
  const join = (anchor) => {
    const ref = closeOnOrBefore(extra, anchor.date) || extra.find((p) => p.date >= anchor.date);
    const k = ref ? anchor.close / ref.close : NaN;
    return Math.abs(k - 1) <= MAX_STITCH_GAP ? k : null;
  };
  const first = base[0], last = base.at(-1);
  const before = extra.filter((p) => p.date < first.date);
  const after = extra.filter((p) => p.date > last.date);
  const kb = before.length ? join(first) : null;
  const ka = after.length ? join(last) : null;
  return [
    ...(kb ? before.map((p) => ({ date: p.date, close: p.close * kb })) : []),
    ...base,
    ...(ka ? after.map((p) => ({ date: p.date, close: p.close * ka })) : []),
  ];
}

/** Daily closes covering [from, to], built from the first source and topped up from the others where it falls short. */
async function buildSeries(sources, from, to) {
  let series = [];
  const errors = [];
  for (const src of sources) {
    if (series.length && series[0].date <= addDays(from, LOOKBACK + STALE_DAYS) && series.at(-1).date >= addDays(to, -STALE_DAYS)) break;
    try {
      const s = despike(await src.fetch(from, to));
      if (s.length) series = stitch(series, s);
    } catch (e) { errors.push(`${src.label}: ${e.message}`); }
  }
  return { series, errors };
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/**
 * Rebuild the portfolio's value over time from the records the browser sends: every holding is
 * valued each day at its own historical market close from its buy date on, and every gold SIP at
 * that day's gold rate for the grams accumulated so far. One point per calendar day. Nothing is stored.
 */
export async function portfolioHistory(holdings, sips) {
  const today = todayIST();
  const floor = addDays(today, -MAX_DAYS);
  const errors = [];
  const lots = [];
  for (const h of holdings) {
    if (!h || !h.buyDate || !(Number(h.quantity) > 0)) continue;
    let start;
    try { start = toDateKey(h.buyDate); } catch { continue; }
    if (start > today) continue;
    const sources = sourcesFor(h);
    lots.push({
      start,
      qty: Number(h.quantity),
      invested: Number(h.investedValue) || 0,
      buyPrice: Number(h.buyPrice) > 0 ? Number(h.buyPrice) : null,
      key: sources.length ? `${h.assetType}|${sources.map((s) => s.label).join('|')}` : null,
      sources,
      name: h.name || h.symbol || 'holding',
    });
  }
  const installments = sips
    .flatMap((s) => (Array.isArray(s?.installments) ? s.installments : []))
    .map((i) => { try { return { date: toDateKey(i.date), grams: Number(i.grams) || 0, paid: Number(i.amountPaid) || 0 }; } catch { return null; } })
    .filter((i) => i && i.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  const starts = [...lots.map((l) => l.start), ...installments.slice(0, 1).map((i) => i.date)].sort();
  if (!starts.length) return { points: [], errors };
  const from = starts[0] < floor ? floor : starts[0];

  // One fetch per distinct asset, from its own earliest buy date
  const assets = new Map();
  for (const l of lots) {
    if (!l.key) continue;
    const a = assets.get(l.key) || { sources: l.sources, start: l.start, names: new Set() };
    if (l.start < a.start) a.start = l.start;
    a.names.add(l.name);
    assets.set(l.key, a);
  }
  const series = new Map();
  const goldTask = installments.length
    ? gold.getHistoricalPriceFn(from, today).catch((e) => { errors.push(`Gold: ${e.message}`); return null; })
    : Promise.resolve(null);
  await mapLimit([...assets], CONCURRENCY, async ([key, a]) => {
    const start = a.start < from ? from : a.start;
    const r = await buildSeries(a.sources, addDays(start, -LOOKBACK), today);
    if (r.series.length) series.set(key, r.series);
    else errors.push(`${[...a.names].join(', ')}: no price history (${r.errors.join('; ') || 'no data'}), shown at cost`);
  });
  const goldOn = await goldTask;
  for (const l of lots) if (!l.key) errors.push(`${l.name}: unknown asset, shown at cost`);

  const points = [];
  let gi = 0, grams = 0, goldPaid = 0;
  for (let date = from; date <= today; date = addDays(date, 1)) {
    let value = 0, invested = 0;
    for (const l of lots) {
      if (l.start > date) continue;
      invested += l.invested;
      const s = l.key && series.get(l.key);
      const c = s ? closeOnOrBefore(s, date) : null;
      // Before the first available close (or with no data at all) the lot is carried at its buy price
      value += c ? c.close * l.qty : l.buyPrice ? l.buyPrice * l.qty : l.invested;
    }
    while (gi < installments.length && installments[gi].date <= date) { grams += installments[gi].grams; goldPaid += installments[gi].paid; gi++; }
    if (goldPaid) {
      invested += goldPaid;
      let rate = null;
      try { rate = goldOn ? goldOn(date) : null; } catch { /* no rate before the first gold close */ }
      value += rate ? grams * rate : goldPaid;
    }
    points.push({ date, value: round(value), invested: round(invested) });
  }
  return { points, errors };
}
