import { getText, ttlCache } from './http.js';

/**
 * Promoter / FII / DII / retail (Screener's "Public") holding trend for NSE/BSE companies, read from the quarterly shareholding
 * pattern on Screener.in (free, key-less). Shareholding changes once a quarter, so
 * results (including "no data") are cached for half a day.
 */
const cache = ttlCache();
const TTL = 12 * 3600 * 1000;
const CONCURRENCY = 4;

const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const round2 = (n) => Math.round(n * 100) / 100;

/** "RELIANCE.NS" -> "RELIANCE", "500325.BO" -> "500325". */
export const screenerCode = (symbol) => String(symbol || '').trim().toUpperCase().replace(/\.(NS|BO)$/, '');

/** Parse the quarterly shareholding table from a Screener company page. Exported for tests. */
export function parseShareholding(html) {
  const start = String(html).indexOf('<div id="quarterly-shp"');
  if (start < 0) return null;
  const end = html.indexOf('</table>', start);
  const block = html.slice(start, end < 0 ? undefined : end);
  const quarters = [...block.matchAll(/<th[^>]*>([^<]*\d{4})\s*<\/th>/g)].map((m) => m[1].trim());
  const rows = {};
  for (const [, tr] of block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
    if (cells.length < 2) continue;
    const label = cells[0].replace(/\s*\+$/, '').toLowerCase();
    const key = /^promoters?$/.test(label) ? 'promoter' : /^fiis?$/.test(label) ? 'fii' : /^diis?$/.test(label) ? 'dii'
      : /^public$/.test(label) ? 'retail' : null;
    if (!key) continue;
    rows[key] = cells.slice(1).map((c) => { const n = parseFloat(c); return Number.isFinite(n) ? n : null; });
  }
  if (!Object.keys(rows).length) return null;

  const trend = (vals) => {
    if (!vals) return null;
    const idx = vals.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
    if (!idx.length) return null;
    const last = idx[idx.length - 1];
    const prev = idx.length > 1 ? idx[idx.length - 2] : null;
    return {
      pct: vals[last],
      change: prev == null ? null : round2(vals[last] - vals[prev]),
      quarter: quarters[last] ?? null,
      prevQuarter: prev == null ? null : quarters[prev] ?? null,
    };
  };
  const out = { promoter: trend(rows.promoter), fii: trend(rows.fii), dii: trend(rows.dii), retail: trend(rows.retail) };
  const first = out.promoter || out.fii || out.dii || out.retail;
  if (!first) return null;
  return { ...out, asOf: first.quarter };
}

const validCode = (code) => /^[A-Z0-9&-]{1,20}$/.test(code);
const inflight = new Map();

/** One Screener company page, shared by the holding breakdown and the logo. */
function companyPage(code) {
  if (inflight.has(code)) return inflight.get(code);
  const pending = cache.get(`html:${code}`, TTL, async () => {
    try {
      return await getText(`https://www.screener.in/company/${encodeURIComponent(code)}/`, { headers: { Accept: 'text/html' } });
    } catch {
      return null; // unlisted on Screener, ETF, or upstream hiccup
    }
  }).finally(() => inflight.delete(code));
  inflight.set(code, pending);
  return pending;
}

/** Square company mark from a Screener company page, or null when the page only has a placeholder. */
export function parseLogo(html) {
  const urls = [...String(html).matchAll(/https:\/\/cdn-media\.screener\.in\/company-logos\/[^"'\s>]+/gi)].map((m) => m[0]);
  return urls.find((u) => !/\/dummy\./i.test(u) && /\.(webp|png|jpe?g)(\?|$)/i.test(u)) || null;
}

export function getShareholding(symbol) {
  const code = screenerCode(symbol);
  if (!validCode(code)) return Promise.resolve(null);
  return companyPage(code).then((html) => (html ? parseShareholding(html) : null));
}

/**
 * Logo URL for a listed company. Screener's thumbnail first (a real square mark);
 * Financial Modeling Prep's ticker image when Screener has none (some ETFs).
 */
export async function getLogoUrl(symbol) {
  const code = screenerCode(symbol);
  if (!validCode(code)) return null;
  const html = await companyPage(code);
  const fromPage = html ? parseLogo(html) : null;
  if (fromPage) return fromPage;
  const sym = /\.(NS|BO)$/i.test(String(symbol)) ? String(symbol).trim().toUpperCase() : `${code}.NS`;
  if (!/^[A-Z0-9.&-]{1,24}$/.test(sym)) return null;
  const url = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(sym)}.png`;
  return cache.get(`fmp:${sym}`, TTL, async () => {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      const type = res.headers.get('content-type') || '';
      return res.ok && type.startsWith('image/') ? url : null;
    } catch {
      return null;
    }
  });
}

/** Look up several symbols with limited concurrency. Returns { [symbol]: data | null }. */
export async function getShareholdingMany(symbols) {
  const out = {};
  const queue = [...new Set(symbols)];
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      out[s] = await getShareholding(s);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return out;
}

export const _cache = cache;
