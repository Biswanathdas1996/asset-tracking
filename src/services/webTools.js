import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../config.js';
import { getText, ttlCache, UpstreamError } from './http.js';
import { parseRss } from './news.js';

/**
 * Web tools for the chat agent.
 * - Search / fetch use Ollama's hosted web APIs when OLLAMA_API_KEY is set (best quality),
 *   otherwise DuckDuckGo's HTML results and a direct page fetch.
 * - News comes from Google News RSS (real time, no key).
 */
const cache = ttlCache();
const OLLAMA_WEB = 'https://ollama.com/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const MAX_PAGE_CHARS = 12000;

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');
const stripTags = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function ollamaWeb(endpoint, body) {
  let res;
  try {
    res = await fetch(`${OLLAMA_WEB}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ollamaApiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new UpstreamError(`Ollama ${endpoint} unreachable: ${err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new UpstreamError(`Ollama ${endpoint} ${res.status}: ${data?.error || res.statusText}`);
  return data;
}

// ---------- search ----------
/** Parse DuckDuckGo's HTML results page. Exported for tests. */
export function parseDuckDuckGo(html) {
  const out = [];
  const blocks = String(html).split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const b of blocks) {
    if (/result--ad\b/.test(b.slice(0, 200))) continue;
    const a = b.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let href = decode(a[0].match(/href="([^"]+)"/i)?.[1] || '');
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (!/^https?:\/\//i.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const snippet = b.match(/<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i)?.[1];
    out.push({ title: stripTags(a[1]), url: href, content: stripTags(snippet) });
  }
  return out;
}

async function duckDuckGo(query, max) {
  let res;
  try {
    res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: new URLSearchParams({ q: query, kl: 'in-en' }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new UpstreamError(`Web search failed: ${err.message}`);
  }
  if (!res.ok) throw new UpstreamError(`Web search responded ${res.status}`);
  return parseDuckDuckGo(await res.text()).slice(0, max);
}

export async function webSearch(query, maxResults = 6) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) throw new Error('query is required');
  const max = Math.min(10, Math.max(1, Number(maxResults) || 6));
  return cache.get(`s:${max}:${q}`, 5 * 60000, async () => {
    if (config.ollamaApiKey) {
      try {
        const data = await ollamaWeb('web_search', { query: q, max_results: max });
        return (data?.results || []).map((r) => ({ title: r.title || r.url, url: r.url, content: clip(String(r.content || '').replace(/\s+/g, ' ').trim(), 1500) }));
      } catch { /* fall back to DuckDuckGo */ }
    }
    return duckDuckGo(q, max);
  });
}

// ---------- fetch ----------
const v4num = (ip) => ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
const PRIVATE_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4']
  .map((c) => { const [base, bits] = c.split('/'); const mask = (~0 << (32 - Number(bits))) >>> 0; return [(v4num(base) & mask) >>> 0, mask]; });
const privateV4 = (ip) => { const n = v4num(ip); return PRIVATE_V4.some(([b, mask]) => ((n & mask) >>> 0) === b); };
/** True for loopback, private, link-local and other non-public addresses. Exported for tests. */
export function isPrivateAddress(ip) {
  const v = isIP(ip);
  if (v === 4) return privateV4(ip);
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateV4(mapped[1]);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  return true;
}

/** Only public http(s) addresses: the server must not be steered into the local network. */
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Not a valid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https links can be opened');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('That address is not public');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new Error(`Cannot resolve ${host}`); });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('That address is not public');
  return u;
}

/** Readable text from an HTML page. Exported for tests. */
export function htmlToText(html) {
  const s = String(html);
  const title = stripTags(s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const body = (s.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? s)
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>|<br\s*\/?>/gi, '\n');
  const text = decode(body.replace(/<[^>]+>/g, ' '))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 1).join('\n');
  return { title, content: text };
}

async function directFetch(url) {
  let u = await assertPublicUrl(url);
  for (let hop = 0; hop < 4; hop++) {
    let res;
    try {
      res = await fetch(u, {
        redirect: 'manual',
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new UpstreamError(`Could not open ${u.hostname}: ${err.message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      u = await assertPublicUrl(new URL(res.headers.get('location'), u).href);
      continue;
    }
    if (!res.ok) throw new UpstreamError(`${u.hostname} responded ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/text|html|json|xml/.test(type)) throw new Error(`Cannot read ${type || 'this kind of file'}`);
    const raw = (await res.text()).slice(0, 2_000_000);
    if (/html/.test(type)) return { url: u.href, ...htmlToText(raw) };
    return { url: u.href, title: u.hostname, content: raw };
  }
  throw new Error('Too many redirects');
}

export async function fetchUrl(url) {
  const target = String(url || '').trim();
  if (!target) throw new Error('url is required');
  return cache.get(`f:${target}`, 10 * 60000, async () => {
    let page = null;
    if (config.ollamaApiKey) {
      try {
        const u = await assertPublicUrl(target);
        const data = await ollamaWeb('web_fetch', { url: u.href });
        page = { url: u.href, title: data?.title || u.hostname, content: String(data?.content || '') };
      } catch { /* fall back to a direct fetch */ }
    }
    if (!page?.content) page = await directFetch(target);
    return { ...page, content: clip(page.content.trim(), MAX_PAGE_CHARS) };
  });
}

// ---------- news ----------
export async function newsSearch(query, days = 3) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) throw new Error('query is required');
  const d = Math.min(30, Math.max(1, Math.round(Number(days) || 3)));
  return cache.get(`n:${d}:${q}`, 5 * 60000, async () => {
    const qs = new URLSearchParams({ q: `${q} when:${d}d`, hl: 'en-IN', gl: 'IN', ceid: 'IN:en' });
    const items = parseRss(await getText(`https://news.google.com/rss/search?${qs}`));
    return items
      .sort((a, b) => (Date.parse(b.publishedAt || 0) || 0) - (Date.parse(a.publishedAt || 0) || 0))
      .slice(0, 12);
  });
}

export const _cache = cache;
