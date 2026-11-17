import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { parseRss, articleId, _cache as feedCache } from '../src/services/news.js';
import { sanitize, keywordFlags, parseJson, cleanSummary, _cache as briefCache } from '../src/services/newsAgent.js';

const now = new Date();
const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map(([title, source, link]) => `
  <item><title>${title} - ${source}</title><link>${link}</link><pubDate>${now.toUTCString()}</pubDate><source url="https://x">${source}</source></item>`).join('')}</channel></rss>`;

const FEEDS = {
  share: rss([
    ['Reliance Q2 net profit jumps 12% to &#8377;19,000 crore', 'Livemint', 'https://news.example/rel-q2'],
    ['10 stocks to watch today', 'Blog', 'https://news.example/listicle'],
  ]),
  market: rss([['Sensex, Nifty rally on FII inflows', 'Rediff', 'https://news.example/mkt']]),
};

let ollamaCalls = [];
let ollamaReply = null;
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/chat')) {
      ollamaCalls.push({ url: u, headers: opts.headers, body: JSON.parse(opts.body) });
      if (ollamaReply instanceof Error) return new Response(JSON.stringify({ error: ollamaReply.message }), { status: 500 });
      return new Response(JSON.stringify({ message: { content: JSON.stringify(ollamaReply) } }), { status: 200 });
    }
    if (u.includes('news.google.com')) {
      const q = new URL(u).searchParams.get('q');
      return new Response(q.includes('share') ? FEEDS.share : q.includes('Sensex') ? FEEDS.market : rss([]), { status: 200 });
    }
    if (u.includes('finance/search')) return new Response(JSON.stringify({ news: [] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  ollamaCalls = [];
  feedCache.clear();
  briefCache.clear();
  config.ollamaHost = 'https://ollama.com';
  config.ollamaApiKey = 'test-key';
  config.ollamaModel = 'gpt-oss:120b';
});

const app = createApp();
const holdings = [{ key: 'RELIANCE.NS', assetType: 'stock', symbol: 'RELIANCE.NS', name: 'Reliance Industries Limited', dayChangePercent: 1.2 }];
const relId = articleId('https://news.example/rel-q2', 'Reliance Q2 net profit jumps 12% to ₹19,000 crore');

test('parses Google News RSS, stripping the source suffix and decoding entities', () => {
  const items = parseRss(FEEDS.share);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Reliance Q2 net profit jumps 12% to ₹19,000 crore');
  assert.equal(items[0].source, 'Livemint');
  assert.ok(items[0].publishedAt);
});

test('extracts JSON wrapped in prose or code fences', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJson('no json here'));
});

test('summary keeps paragraph breaks and drops a sentence cut off by the cap', () => {
  assert.equal(cleanSummary('Gold is at a one-year low.\n\nJio faces selling from anchor investors.'), 'Gold is at a one-year low.\n\nJio faces selling from anchor investors.');
  const cut = cleanSummary('Gold fell to a one-year low. Jio Platforms faces selling from anchor investors. Extra words that run on without ending', 90);
  assert.equal(cut, 'Gold fell to a one-year low. Jio Platforms faces selling from anchor investors.');
});

test('sanitize drops flags for unknown articles and clamps enums', () => {
  const arts = [{ id: 'a1', holding: 'X', title: 't' }];
  const out = sanitize({
    summary: 's',
    flags: [
      { id: 'a1', holding: 'nope', impact: 'BULLISH', severity: 'extreme', kpis: ['EPS', 'x'.repeat(80)], why: 'w' },
      { id: 'made-up', holding: 'X', impact: 'bearish', severity: 'high' },
      { id: 'a1', holding: 'X', impact: 'bearish', severity: 'high' },
    ],
    holdings: [{ holding: 'X', sentiment: 'great', note: 'n' }, { holding: 'Y', sentiment: 'bullish' }],
  }, arts, ['X']);
  assert.equal(out.flags.length, 1);
  assert.deepEqual(out.flags[0], { id: 'a1', holding: 'X', impact: 'bullish', severity: 'low', kpis: ['EPS', 'x'.repeat(40)], why: 'w' });
  assert.deepEqual(out.holdings, [{ holding: 'X', sentiment: 'neutral', note: 'n' }]);
});

test('keyword scan flags price-moving headlines and skips noise', () => {
  const flags = keywordFlags([
    { id: '1', holding: 'X', title: 'Infosys Q2 profit jumps 8%, beats estimates' },
    { id: '2', holding: 'X', title: 'SEBI imposes penalty on promoter' },
    { id: '3', holding: 'X', title: 'Ten things to know before the bell' },
  ]);
  assert.deepEqual(flags.map((f) => [f.id, f.impact, f.severity]), [['1', 'bullish', 'medium'], ['2', 'bearish', 'medium']]);
  assert.ok(flags[0].kpis.includes('Earnings'));
});

test('news brief: the model flags stories by id; headlines and links come from the feed', async () => {
  ollamaReply = {
    summary: 'Reliance results lead the news.',
    holdings: [{ holding: 'RELIANCE.NS', sentiment: 'bullish', note: 'Strong quarter.' }],
    flags: [
      { id: relId, holding: 'RELIANCE.NS', impact: 'bullish', severity: 'high', kpis: ['Q2 net profit'], why: 'Profit up 12%.' },
      { id: 'hallucinated', holding: 'RELIANCE.NS', impact: 'bearish', severity: 'high', kpis: [], why: 'x' },
    ],
  };
  const res = await request(app).post('/api/news/brief').send({ holdings });
  assert.equal(res.status, 200, res.body.error);
  assert.deepEqual(res.body.ai, { model: 'gpt-oss:120b' });
  assert.equal(res.body.summary, 'Reliance results lead the news.');
  assert.equal(res.body.items.length, 3);
  const top = res.body.items[0];
  assert.equal(top.id, relId);
  assert.equal(top.flagged, true);
  assert.equal(top.url, 'https://news.example/rel-q2');
  assert.deepEqual(top.kpis, ['Q2 net profit']);
  assert.equal(res.body.items.filter((i) => i.flagged).length, 1);
  assert.ok(res.body.items.some((i) => i.holding === 'market'));

  assert.equal(ollamaCalls.length, 2);
  const call = ollamaCalls[0];
  assert.match(call.body.messages[0].content, /Leave "summary" as an empty string/);
  const brief = ollamaCalls[1];
  assert.match(brief.body.messages[0].content, /Position sizes are unknown/);
  assert.equal(brief.body.options.num_predict, 900);
  const briefIn = JSON.parse(brief.body.messages[1].content);
  assert.equal(briefIn.flagged[0].title, 'Reliance Q2 net profit jumps 12% to ₹19,000 crore');
  assert.equal(briefIn.holdings[0].dayChangePercent, 1.2);
  assert.equal(call.url, 'https://ollama.com/api/chat');
  assert.equal(call.headers.Authorization, 'Bearer test-key');
  assert.equal(call.body.model, 'gpt-oss:120b');
  assert.equal(call.body.stream, false);
  const sent = JSON.parse(call.body.messages[1].content);
  assert.equal(sent.holdings[0].key, 'RELIANCE.NS');
  assert.equal(sent.holdings[0].quantity, undefined); // no position sizes leave the server
});

test('news brief falls back to a keyword scan when the model fails', async () => {
  ollamaReply = new Error('model overloaded');
  const res = await request(app).post('/api/news/brief').send({ holdings });
  assert.equal(res.status, 200);
  assert.equal(res.body.ai, null);
  assert.match(res.body.errors.join(), /keyword scan/);
  assert.equal(res.body.items.find((i) => i.id === relId).flagged, true);
});

test('news brief uses the keyword scan without calling Ollama when no key is set', async () => {
  config.ollamaApiKey = '';
  const res = await request(app).post('/api/news/brief').send({ holdings });
  assert.equal(res.status, 200);
  assert.equal(res.body.ai, null);
  assert.equal(ollamaCalls.length, 0);
  assert.deepEqual(res.body.errors, []);
});

test('news brief validates its input', async () => {
  assert.equal((await request(app).post('/api/news/brief').send({})).status, 400);
  assert.equal((await request(app).post('/api/news/brief').send({ holdings: [] })).status, 400);
  assert.equal((await request(app).post('/api/news/brief').send({ holdings: [{ key: 'x', assetType: 'bond', name: 'x' }] })).status, 400);
});
