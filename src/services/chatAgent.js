import { config, aiEnabled } from '../config.js';
import { webSearch, fetchUrl, newsSearch } from './webTools.js';
import * as yahoo from './yahoo.js';
import * as gold from './gold.js';

/**
 * Chat agent: an Ollama model with tools for web search, reading pages, live news and live prices.
 * It loops (model -> tools -> model) until the model answers, streaming events to the caller:
 *   { type: 'step', id, tool, label, status: 'running' | 'done' | 'error', detail? }
 *   { type: 'delta', text }   answer text as it is generated
 *   { type: 'reset' }         drop the draft text (the model decided to call a tool instead)
 *   { type: 'done', sources, model }
 */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the whole web for any topic: facts, people, companies, products, how-tos, documentation, sports, weather, prices, recent events. Returns titles, URLs and text snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query, written the way you would type it into a search engine' },
          max_results: { type: 'integer', description: 'How many results (1-10, default 6)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Open a web page and read its main text. Use it on promising search results when snippets are not enough, or on a link the user gives.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full http(s) URL' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'news_search',
      description: 'Real-time news headlines (Google News, India edition) with source and publish time, newest first. Use for anything about what is happening now: markets, companies, politics, sports, tech, world events.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Topic, company or keywords' },
          days: { type: 'integer', description: 'Look back this many days (1-30, default 3)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_quote',
      description: 'Live market price. Yahoo Finance symbols: NSE stocks end in .NS (RELIANCE.NS), BSE in .BO, indices ^NSEI (Nifty 50), ^BSESN (Sensex), ^NSEBANK, US stocks plain (AAPL), crypto BTC-INR / ETH-USD, forex USDINR=X, commodities GC=F (gold USD/oz), CL=F (crude). Use GOLD-INR for the Indian 24K gold price per gram.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', description: 'Yahoo Finance symbol, or GOLD-INR' } },
        required: ['symbol'],
      },
    },
  },
];

const istNow = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });

function systemPrompt(holdings) {
  const held = holdings.length
    ? `\nThe user's holdings (names and symbols only, no amounts): ${holdings.map((h) => `${h.name}${h.symbol && h.symbol !== h.name ? ` (${h.symbol})` : ''} [${h.assetType}]`).join('; ')}.
When they say "my stocks", "my portfolio" or "my holdings", they mean these.`
    : '';
  return `You are the research assistant inside Asset Tracker, a personal portfolio app for an Indian investor (NSE/BSE stocks, crypto, gold).
You can help with anything, not just finance. Current date and time: ${istNow()} (IST).${held}

Tools:
- web_search: any question that needs facts from the web, anything after your training data, or anything you are not sure of.
- news_search: what is happening now. Prefer it for news, markets, and "latest" / "today" questions.
- fetch_url: read a page in full when snippets are thin, or when the user shares a link.
- get_quote: live prices for stocks, indices, crypto, forex, commodities and Indian gold.

How to work:
- For anything time-sensitive (prices, news, scores, weather, releases, "latest", "today", "now"), use the tools. Do not answer from memory.
- Run several searches in parallel when a question has several parts. Refine the query and search again if results are off-target.
- Answer from what the tools returned. Never invent numbers, dates, quotes or URLs. If sources disagree or nothing turns up, say so.
- Cite sources inline as markdown links, e.g. [Livemint](https://...), using only URLs the tools returned.
- Give dates for news (e.g. "on 17 Nov"). Give prices with currency and the time they are from.
- Write in clear markdown: a direct answer first, then short paragraphs or bullets. Use a table only when comparing several items.
- For buy/sell questions, lay out the facts and the main risks both ways, and note briefly that this is not personalised financial advice.
- Plain conversation (greetings, maths, rewriting text) needs no tools.`;
}

const short = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function quote(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s) throw new Error('symbol is required');
  if (['GOLD-INR', 'GOLD', 'GOLD INR'].includes(s)) {
    const g = await gold.getLivePrice();
    return {
      symbol: 'GOLD-INR', name: 'Gold 24K (India, before GST)', price: Math.round(g.pricePerGram * 100) / 100, unit: 'INR per gram',
      basis: `COMEX ${g.usdPerOz} USD/oz x USDINR ${g.usdInr} + ${g.importDutyPct}% import duty`, asOf: g.marketTime.toISOString(),
    };
  }
  const q = await yahoo.getQuote(s);
  const change = q.previousClose ? ((q.price - q.previousClose) / q.previousClose) * 100 : null;
  return {
    symbol: q.symbol, name: q.name, price: q.price, currency: q.currency, exchange: q.exchange,
    previousClose: q.previousClose, changePercent: change == null ? null : Math.round(change * 100) / 100,
    asOf: q.marketTime.toISOString(),
  };
}

/** Run one tool call. Returns { content (for the model), sources, label, detail }. */
export async function runTool(name, args = {}) {
  switch (name) {
    case 'web_search': {
      const results = await webSearch(args.query, args.max_results);
      return {
        label: `Searched the web for "${short(args.query, 60)}"`,
        detail: `${results.length} result${results.length === 1 ? '' : 's'}`,
        sources: results.map((r) => ({ title: r.title, url: r.url })),
        content: results.length ? JSON.stringify(results) : 'No results. Try a different query.',
      };
    }
    case 'fetch_url': {
      const page = await fetchUrl(args.url);
      return {
        label: `Read ${host(page.url) || 'page'}`,
        detail: short(page.title, 80),
        sources: [{ title: page.title || host(page.url), url: page.url }],
        content: JSON.stringify(page),
      };
    }
    case 'news_search': {
      const items = await newsSearch(args.query, args.days);
      return {
        label: `Checked the news for "${short(args.query, 60)}"`,
        detail: `${items.length} headline${items.length === 1 ? '' : 's'}`,
        sources: items.map((i) => ({ title: i.title, url: i.url, source: i.source, publishedAt: i.publishedAt })),
        content: items.length ? JSON.stringify(items) : 'No recent headlines. Try broader keywords or more days.',
      };
    }
    case 'get_quote': {
      const q = await quote(args.symbol);
      return {
        label: `Got the live price of ${q.symbol}`,
        detail: `${q.price}${q.currency ? ` ${q.currency}` : ''}${q.changePercent != null ? ` (${q.changePercent > 0 ? '+' : ''}${q.changePercent}%)` : ''}`,
        sources: [],
        content: JSON.stringify(q),
      };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

/** Stream one model turn. Returns the assistant message. */
async function modelTurn(messages, { tools, signal, onDelta }) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.ollamaApiKey) headers.Authorization = `Bearer ${config.ollamaApiKey}`;
  let res;
  try {
    res = await fetch(`${config.ollamaHost}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.chatModel, stream: true, messages, ...(tools ? { tools } : {}), options: { temperature: 0.3 } }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180000)].filter(Boolean)),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(`AI model unreachable: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`AI model error ${res.status}: ${body?.error || res.statusText}`);
  }
  const msg = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
  const handle = (line) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line);
    if (chunk.error) throw new Error(`AI model error: ${chunk.error}`);
    const m = chunk.message || {};
    if (m.thinking) msg.thinking += m.thinking;
    if (m.tool_calls?.length) msg.tool_calls.push(...m.tool_calls);
    if (m.content) { msg.content += m.content; onDelta?.(m.content); }
  };
  const decoder = new TextDecoder();
  let buf = '';
  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf + decoder.decode());
  return msg;
}

const parseArgs = (a) => {
  if (a && typeof a === 'object') return a;
  try { return JSON.parse(a || '{}'); } catch { return {}; }
};

/**
 * Answer a conversation. messages: [{ role: 'user'|'assistant', content }], holdings: [{ name, symbol, assetType }]
 * emit(event) is called for every streamed event.
 */
export async function chat({ messages, holdings = [] }, emit, signal) {
  if (!aiEnabled()) throw Object.assign(new Error('The chat assistant needs an AI model. Set OLLAMA_API_KEY (or OLLAMA_HOST) on the server.'), { status: 503 });
  const convo = [{ role: 'system', content: systemPrompt(holdings) }, ...messages];
  const sources = new Map();
  let stepId = 0;

  for (let round = 0; round < config.chatMaxSteps; round++) {
    const last = round === config.chatMaxSteps - 1;
    if (last) convo.push({ role: 'system', content: 'Tool budget used up. Answer now from what you have, and say what you could not confirm.' });
    let streamed = false;
    const msg = await modelTurn(convo, {
      tools: last ? undefined : TOOLS,
      signal,
      onDelta: (text) => { streamed = true; emit({ type: 'delta', text }); },
    });
    if (!msg.tool_calls.length) {
      if (!msg.content.trim()) throw new Error('The model returned an empty answer. Try asking again.');
      emit({ type: 'done', model: config.chatModel, sources: [...sources.values()].slice(0, 30) });
      return;
    }
    if (streamed) emit({ type: 'reset' });
    convo.push({ role: 'assistant', content: msg.content, ...(msg.thinking ? { thinking: msg.thinking } : {}), tool_calls: msg.tool_calls });

    const calls = msg.tool_calls.slice(0, 6);
    const results = await Promise.all(calls.map(async (call) => {
      const name = call.function?.name;
      const args = parseArgs(call.function?.arguments);
      const id = ++stepId;
      emit({ type: 'step', id, tool: name, label: pendingLabel(name, args), status: 'running' });
      try {
        const r = await runTool(name, args);
        for (const s of r.sources) if (s.url && !sources.has(s.url)) sources.set(s.url, s);
        emit({ type: 'step', id, tool: name, label: r.label, detail: r.detail, status: 'done' });
        return { name, content: r.content };
      } catch (err) {
        emit({ type: 'step', id, tool: name, label: pendingLabel(name, args), detail: err.message, status: 'error' });
        return { name, content: `Error: ${err.message}` };
      }
    }));
    if (signal?.aborted) return;
    for (const r of results) convo.push({ role: 'tool', tool_name: r.name, content: r.content });
  }
}

function pendingLabel(name, a) {
  switch (name) {
    case 'web_search': return `Searching the web for "${short(a.query, 60)}"`;
    case 'fetch_url': return `Reading ${host(a.url) || 'page'}`;
    case 'news_search': return `Checking the news for "${short(a.query, 60)}"`;
    case 'get_quote': return `Getting the live price of ${short(a.symbol, 20)}`;
    default: return `Running ${name}`;
  }
}
