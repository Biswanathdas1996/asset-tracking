import { createHash } from 'node:crypto';
import { config, aiEnabled } from '../config.js';
import { ttlCache } from './http.js';
import { collectHeadlines } from './news.js';

/**
 * News agent: gathers recent headlines for every holding, then asks an LLM on Ollama Cloud
 * (or a self-hosted Ollama) which stories could move the price, in which direction, and which
 * KPI / catalyst is at stake. Without a model configured it falls back to a keyword scan, so
 * the section always works.
 *
 * The model only ever refers to articles by id, so links and headlines shown to the user come
 * from the real feeds, never from the model.
 */
const cache = ttlCache();
const IMPACTS = ['bullish', 'bearish', 'mixed'];
const SEVERITIES = ['high', 'medium', 'low'];
const SENTIMENTS = ['bullish', 'bearish', 'neutral', 'mixed'];
const SEV_RANK = { high: 0, medium: 1, low: 2 };
const CHUNK_HOLDINGS = 8;

const SYSTEM = `You are a markets news analyst for an Indian retail investor. You receive the investor's holdings
(NSE/BSE stocks, crypto, gold) and recent headlines found for each one, plus market-wide headlines.

Your job: flag only the stories that could plausibly move the price of a holding, e.g. quarterly results and guidance,
order wins, M&A, management changes, promoter selling or pledging, block deals, analyst rating or target changes,
regulatory action (SEBI, RBI, government, exchanges), tax or duty changes, index inclusion, crypto ETF flows, hacks,
listings or bans, central-bank and dollar moves for gold, and macro events (RBI policy, inflation, FII flows, Fed).
Ignore generic listicles, "stocks to watch" round-ups with nothing specific, and duplicate coverage of the same event
(flag the most informative headline once).

For every flagged story give:
- impact: "bullish", "bearish" or "mixed" for the holding's price
- severity: "high" (likely to move the price meaningfully soon), "medium", or "low"
- kpis: 1-3 short labels of the metric or catalyst at stake (e.g. "Q2 net profit", "EBITDA margin", "Order book",
  "Promoter stake", "Brokerage target", "Import duty", "ETF inflows", "RBI repo rate")
- why: one plain sentence on why it matters for the holding, citing the number from the headline when there is one

Use only the headlines provided. Do not invent facts, numbers or events. Refer to articles only by their "id".
Leave "summary" as an empty string; a later step writes the brief. Put the effort into accurate flags and holding notes.
Reply with JSON only, matching this shape:
{"summary": "",
 "holdings": [{"holding": "<holding key>", "sentiment": "bullish|bearish|neutral|mixed", "note": "one short sentence on the specific fact"}],
 "flags": [{"id": "<article id>", "holding": "<holding key or market>", "impact": "bullish|bearish|mixed",
            "severity": "high|medium|low", "kpis": ["..."], "why": "one sentence citing the number from the headline when there is one"}]}`;

const SUMMARY_SYSTEM = `You write a news brief for an Indian retail investor (NSE/BSE stocks, crypto, gold).
You are given holdings, each holding's move today if known, and stories already flagged from real headlines.
Position sizes are unknown. Never call anything "the main portfolio risk", and do not rank holdings by how much of the portfolio they are.

Write two or three short paragraphs, separated by a blank line, about 140-180 words:
- First: what is most likely to move a price over the next few sessions. Name the holding and the specific fact from a flagged story (the figure, the event, who did it). If today's percentage move is in the input, you may cite it as today's move, not as proof the headline caused it.
- Then: the other material items, including news that cuts the other way. A support and a pressure on the same holding both belong in the brief.
- Close on what is still thin or disputed: a headline with no number, two stories that disagree, or a holding with nothing material (leave quiet holdings out).

Rules:
- Use only facts, numbers, names and dates present in the input. Do not invent a cause the headline does not state.
- Finish every sentence. Do not stop mid-word or mid-name.
- Calm and specific, the way a broker note reads. No hype.
Reply with JSON only: {"summary": "paragraph one\\n\\nparagraph two"}`;

async function chat(system, user, { numPredict = 4096 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.ollamaApiKey) headers.Authorization = `Bearer ${config.ollamaApiKey}`;
  let res;
  try {
    res = await fetch(`${config.ollamaHost}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: false,
        format: 'json',
        options: { temperature: 0.2, num_predict: numPredict },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    throw new Error(`Ollama unreachable: ${err.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${body?.error || res.statusText}`);
  return parseJson(body?.message?.content);
}

/** Models sometimes wrap JSON in prose or code fences; take the outermost object. */
export function parseJson(text) {
  const s = String(text || '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ }
  }
  throw new Error('The model did not return valid JSON');
}

const pick = (v, allowed, d) => (allowed.includes(String(v).toLowerCase()) ? String(v).toLowerCase() : d);
const short = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Keep paragraph breaks. If a cap lands mid-sentence, end on the previous finished sentence. */
export function cleanSummary(v, n = 1800) {
  const full = String(v ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
  if (full.length <= n) return full;
  const s = full.slice(0, n);
  let end = -1;
  for (const m of s.matchAll(/[.!?](?=\s|$)/g)) end = m.index;
  if (end >= 40) return s.slice(0, end + 1).trim();
  const sp = s.lastIndexOf(' ');
  return (sp > 40 ? s.slice(0, sp) : s).trim();
}

/** Keep only well-formed flags that point at real articles. */
export function sanitize(raw, articles, holdingKeys) {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const keys = new Set([...holdingKeys, 'market']);
  const flags = [];
  const seen = new Set();
  for (const f of Array.isArray(raw?.flags) ? raw.flags : []) {
    const a = byId.get(String(f?.id));
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    flags.push({
      id: a.id,
      holding: keys.has(f.holding) ? f.holding : a.holding,
      impact: pick(f.impact, IMPACTS, 'mixed'),
      severity: pick(f.severity, SEVERITIES, 'low'),
      kpis: (Array.isArray(f.kpis) ? f.kpis : []).map((k) => short(k, 40)).filter(Boolean).slice(0, 3),
      why: short(f.why, 300),
    });
  }
  const holdings = (Array.isArray(raw?.holdings) ? raw.holdings : [])
    .filter((h) => keys.has(h?.holding))
    .map((h) => ({ holding: h.holding, sentiment: pick(h.sentiment, SENTIMENTS, 'neutral'), note: short(h.note, 200) }));
  return { summary: cleanSummary(raw?.summary), flags, holdings };
}

// ---------- keyword fallback ----------
const RULES = [
  [/\b(results?|earnings|q[1-4]|quarter|profit|revenue|ebitda|margin|guidance|net income)\b/i, 'Earnings'],
  [/\b(dividend|bonus|buyback|split|record date)\b/i, 'Shareholder payout'],
  [/\b(upgrade|downgrade|target price|price target|rating|overweight|underweight|buy call|sell call|brokerage)\b/i, 'Analyst rating'],
  [/\b(sebi|rbi|regulat|probe|penalty|fine|ban|lawsuit|court|tax|duty|gst|ed raid|income tax)\b/i, 'Regulation'],
  [/\b(acqui|merger|demerger|stake|deal|order|contract|partnership|jv|joint venture|ipo|qip|fund ?rais)\b/i, 'Deals & orders'],
  [/\b(promoter|pledge|block deal|bulk deal|insider|fii|dii|mutual fund)\b/i, 'Ownership flows'],
  [/\b(plant|capex|expansion|capacity|launch(es)?|crore investment)\b/i, 'Capex & expansion'],
  [/\b(ceo|cfo|md|chairman|resign|appoint|management)\b/i, 'Management'],
  [/\b(etf|inflow|outflow|hack|exploit|listing|delist|halving|sec)\b/i, 'Crypto catalyst'],
  [/\b(repo rate|inflation|cpi|fed|dollar|rupee|crude|yields?|gdp)\b/i, 'Macro'],
];
// Verb stems also match -s / -es / -ed / -d / -ing forms ("jumps", "beats", "plunged").
const BULL = /\b(lays foundation|new plant|surge|soar|jump|rall(y|ies|ied)|gain|rise|climb|record high|upgrade|beat|win|bag|secure|strong|boost|outperform|hike in (profit|dividend)|inflow)(s|es|ed|d|ing)?\b/i;
const BEAR = /\b(fall|fell|plunge|slump|drop|tumble|crash|decline|slide|slid|sink|sank|downgrade|miss|loss|weak|cut|probe|penalty|penalties|fine|ban|resign|pledge|sell-?off|outflow|hack|lawsuit|raid)(s|es|ed|d|ing)?\b/i;

export function keywordFlags(articles) {
  const flags = [];
  for (const a of articles) {
    const kpis = RULES.filter(([re]) => re.test(a.title)).map(([, k]) => k).slice(0, 3);
    if (!kpis.length) continue;
    const bull = BULL.test(a.title), bear = BEAR.test(a.title);
    const impact = bull && !bear ? 'bullish' : bear && !bull ? 'bearish' : 'mixed';
    const severity = /Earnings|Regulation|Deals & orders|Analyst rating|Crypto catalyst|Ownership flows/.test(kpis.join()) && impact !== 'mixed' ? 'medium' : 'low';
    flags.push({ id: a.id, holding: a.holding, impact, severity, kpis, why: '' });
  }
  return flags;
}

// ---------- agent ----------
function holdingBrief(h) {
  return {
    key: h.key, name: h.name, symbol: h.symbol, type: h.assetType,
    dayChangePercent: h.dayChangePercent == null ? undefined : Math.round(h.dayChangePercent * 100) / 100,
  };
}

function promptFor(holdings, articles) {
  return JSON.stringify({
    today: new Date().toISOString().slice(0, 10),
    holdings: holdings.map(holdingBrief),
    articles: articles.map((a) => ({ id: a.id, holding: a.holding, title: a.title, source: a.source, published: a.publishedAt?.slice(0, 16) })),
  });
}

/** Second pass: a brief written only from stories already tied to real headlines. */
async function writeSummary(holdings, articles, analysis) {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const flagged = [...analysis.flags]
    .sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3))
    .slice(0, 18)
    .map((f) => {
      const a = byId.get(f.id);
      return a ? { holding: f.holding, title: a.title, source: a.source, published: a.publishedAt?.slice(0, 16), impact: f.impact, severity: f.severity, kpis: f.kpis, why: f.why } : null;
    })
    .filter(Boolean);
  if (!flagged.length) return '';
  const raw = await chat(SUMMARY_SYSTEM, JSON.stringify({
    today: new Date().toISOString().slice(0, 10),
    note: 'Position sizes are unknown. dayChangePercent is today\'s move only.',
    holdings: holdings.map(holdingBrief),
    holdingNotes: analysis.holdings.filter((h) => h.note).map((h) => ({ holding: h.holding, sentiment: h.sentiment, note: h.note })),
    flagged,
  }), { numPredict: 900 });
  return cleanSummary(raw?.summary);
}

async function analyse(holdings, articles) {
  const keys = holdings.map((h) => h.key);
  const chunks = [];
  for (let i = 0; i < holdings.length; i += CHUNK_HOLDINGS) chunks.push(holdings.slice(i, i + CHUNK_HOLDINGS));
  if (!chunks.length) chunks.push([]);
  const results = await Promise.all(chunks.map((hs, i) => {
    const ks = new Set(hs.map((h) => h.key));
    // Market-wide stories go with the first chunk.
    const arts = articles.filter((a) => ks.has(a.holding) || (i === 0 && a.holding === 'market'));
    return chat(SYSTEM, promptFor(hs, arts)).then((raw) => sanitize(raw, articles, keys));
  }));
  const merged = {
    summary: '',
    flags: results.flatMap((r) => r.flags),
    holdings: results.flatMap((r) => r.holdings),
  };
  try {
    merged.summary = await writeSummary(holdings, articles, merged);
  } catch { /* flags still stand; the card lists them without a brief */ }
  return merged;
}

/**
 * Build the news brief for a set of holdings.
 * holdings: [{ key, assetType, symbol, name, dayChangePercent? }]
 */
export async function newsBrief(holdings) {
  const cacheKey = createHash('sha1').update(JSON.stringify([config.ollamaModel, aiEnabled(), holdings.map((h) => [h.key, h.name])])).digest('hex');
  return cache.get(cacheKey, config.newsCacheMinutes * 60000, async () => {
    const { articles, errors } = await collectHeadlines(holdings);
    let analysis = null;
    let ai = null;
    if (aiEnabled() && articles.length) {
      try {
        analysis = await analyse(holdings, articles);
        ai = { model: config.ollamaModel };
      } catch (err) {
        errors.push(`AI analysis unavailable (${err.message}); showing a keyword scan instead`);
      }
    }
    if (!analysis) analysis = { summary: '', flags: keywordFlags(articles), holdings: [] };
    const flagged = new Map(analysis.flags.map((f) => [f.id, f]));
    const items = articles.map((a) => ({ ...a, ...(flagged.get(a.id) || {}), holding: flagged.get(a.id)?.holding || a.holding, flagged: flagged.has(a.id) }));
    items.sort((a, b) => (b.flagged - a.flagged)
      || ((SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3))
      || ((Date.parse(b.publishedAt || 0) || 0) - (Date.parse(a.publishedAt || 0) || 0)));
    return {
      generatedAt: new Date().toISOString(),
      ai,
      summary: analysis.summary,
      holdings: analysis.holdings,
      items,
      errors,
    };
  });
}

export const _cache = cache;
