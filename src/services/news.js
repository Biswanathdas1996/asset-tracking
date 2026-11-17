import { createHash } from 'node:crypto';
import { getJson, getText, ttlCache } from './http.js';
import { config } from '../config.js';

/**
 * Headline collection for the news agent. Free, key-less sources:
 * - Google News RSS search (India edition): best coverage of NSE/BSE companies.
 * - Yahoo Finance search news: extra coverage for listed symbols and crypto.
 */
const cache = ttlCache();
const FEED_TTL = 10 * 60 * 1000;
const PER_TOPIC = 8;

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();
const tag = (xml, name) => decode(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1]);

export const articleId = (url, title) => createHash('sha1').update(`${url}|${title.toLowerCase()}`).digest('hex').slice(0, 12);

/** Parse an RSS feed into articles. Exported for tests. */
export function parseRss(xml) {
  const out = [];
  for (const [, item] of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    let title = tag(item, 'title');
    const source = tag(item, 'source');
    // Google News titles end with " - Source"
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const url = tag(item, 'link');
    const published = Date.parse(tag(item, 'pubDate'));
    if (!title || !url) continue;
    out.push({ title, url, source: source || new URL(url).hostname.replace(/^www\./, ''), publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null });
  }
  return out;
}

async function googleNews(query) {
  const qs = new URLSearchParams({ q: `${query} when:${config.newsLookbackDays}d`, hl: 'en-IN', gl: 'IN', ceid: 'IN:en' });
  return cache.get(`g:${query}`, FEED_TTL, async () => parseRss(await getText(`https://news.google.com/rss/search?${qs}`)));
}

async function yahooNews(query) {
  const qs = new URLSearchParams({ q: query, quotesCount: '0', newsCount: '10', listsCount: '0' });
  return cache.get(`y:${query}`, FEED_TTL, async () => {
    const data = await getJson(`https://query1.finance.yahoo.com/v1/finance/search?${qs}`, { retries: 1 });
    return (data.news || []).map((n) => ({
      title: decode(n.title),
      url: n.link,
      source: n.publisher || 'Yahoo Finance',
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    })).filter((n) => n.title && n.url);
  });
}

const cleanName = (name) => String(name || '')
  .replace(/\b(limited|ltd\.?|corporation|corp\.?|inc\.?|plc|company)\b/gi, '')
  .replace(/[^\w&.' -]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Search topics for one holding. */
function topicQueries(h) {
  if (h.assetType === 'gold') return { google: ['gold price India', 'gold rate outlook'], yahoo: [] };
  if (h.assetType === 'crypto') {
    const n = cleanName(h.name) || h.symbol;
    return { google: [`${n} crypto`], yahoo: [`${h.symbol}-USD`] };
  }
  const n = cleanName(h.name) || h.symbol.replace(/\.(NS|BO)$/, '');
  return { google: [`"${n}" share`], yahoo: [h.symbol] };
}

/** Market-wide topics, based on which asset classes the portfolio holds. */
export function marketTopics(types) {
  const t = ['Sensex Nifty market today'];
  if (types.has('stock')) t.push('RBI SEBI policy markets');
  if (types.has('crypto')) t.push('crypto market India');
  return t;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const k = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

function recent(list) {
  const cutoff = Date.now() - config.newsLookbackDays * 86400000;
  return list
    .filter((a) => !a.publishedAt || Date.parse(a.publishedAt) >= cutoff)
    .sort((a, b) => (Date.parse(b.publishedAt || 0) || 0) - (Date.parse(a.publishedAt || 0) || 0));
}

async function settle(promises) {
  const out = [];
  const errors = [];
  for (const r of await Promise.allSettled(promises)) {
    if (r.status === 'fulfilled') out.push(...r.value);
    else errors.push(r.reason?.message || String(r.reason));
  }
  return { out, errors };
}

/**
 * Collect recent headlines for each holding plus the overall market.
 * Returns articles tagged with `holding` (the holding key, or "market").
 */
export async function collectHeadlines(holdings) {
  const errors = [];
  const byKey = new Map();
  await Promise.all(holdings.map(async (h) => {
    const q = topicQueries(h);
    const r = await settle([...q.google.map(googleNews), ...q.yahoo.map(yahooNews)]);
    errors.push(...r.errors);
    byKey.set(h.key, recent(dedupe(r.out)).slice(0, PER_TOPIC));
  }));
  const types = new Set(holdings.map((h) => h.assetType));
  const m = await settle(marketTopics(types).map(googleNews));
  errors.push(...m.errors);
  byKey.set('market', recent(dedupe(m.out)).slice(0, PER_TOPIC));

  // A story can surface under several topics: keep it once, under the first holding that found it.
  const seen = new Set();
  const articles = [];
  for (const key of [...holdings.map((h) => h.key), 'market']) {
    for (const a of byKey.get(key) || []) {
      const id = articleId(a.url, a.title);
      if (seen.has(id)) continue;
      seen.add(id);
      articles.push({ id, holding: key, ...a });
    }
  }
  return { articles, errors: [...new Set(errors)] };
}

export const _cache = cache;
