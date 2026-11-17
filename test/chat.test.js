import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { parseDuckDuckGo, htmlToText, isPrivateAddress, fetchUrl, _cache as webCache } from '../src/services/webTools.js';

const realFetch = globalThis.fetch;
const saved = { ...config };
let chatCalls = [];
let turns = [];
const ndjson = (chunks) => new Response(chunks.map((c) => JSON.stringify(c)).join('\n') + '\n', { status: 200 });

before(() => {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/api/chat')) {
      chatCalls.push(JSON.parse(opts.body));
      const t = turns.shift();
      if (t instanceof Error) return new Response(JSON.stringify({ error: t.message }), { status: 500 });
      return ndjson(t);
    }
    if (u.endsWith('/api/web_search')) {
      return new Response(JSON.stringify({ results: [{ title: 'Nifty closes higher', url: 'https://example.com/nifty', content: 'Nifty 50 ended at 24,500.' }] }), { status: 200 });
    }
    if (u.includes('news.google.com')) {
      return new Response(`<rss><channel><item><title>RBI holds repo rate - Livemint</title><link>https://news.example/rbi</link><pubDate>${new Date().toUTCString()}</pubDate><source url="x">Livemint</source></item></channel></rss>`, { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
});
after(() => { globalThis.fetch = realFetch; Object.assign(config, saved); });
beforeEach(() => {
  chatCalls = [];
  turns = [];
  webCache.clear();
  Object.assign(config, { ollamaApiKey: 'test-key', ollamaHost: 'https://ollama.com', chatModel: 'test-model', chatMaxSteps: 4 });
});

const events = (text) => text.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type !== 'ping');

test('answers directly when no tool is needed', async () => {
  turns = [[{ message: { content: 'Hello' } }, { message: { content: ' there!' }, done: true }]];
  const res = await request(createApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  const ev = events(res.text);
  assert.deepEqual(ev.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello there!');
  assert.equal(ev.at(-1).type, 'done');
  assert.ok(chatCalls[0].tools.some((t) => t.function.name === 'web_search'));
  assert.equal(chatCalls[0].messages[0].role, 'system');
});

test('runs web and news tools, then answers with sources', async () => {
  turns = [
    [{ message: { content: '', tool_calls: [
      { function: { name: 'web_search', arguments: { query: 'nifty today' } } },
      { function: { name: 'news_search', arguments: { query: 'RBI policy', days: 2 } } },
    ] }, done: true }],
    [{ message: { content: 'Nifty ended at 24,500 [example](https://example.com/nifty).' }, done: true }],
  ];
  const res = await request(createApp()).post('/api/chat').send({
    messages: [{ role: 'user', content: 'What happened in markets?' }],
    holdings: [{ name: 'Reliance Industries', symbol: 'RELIANCE.NS', assetType: 'stock', quantity: 10 }],
  });
  const ev = events(res.text);
  const steps = ev.filter((e) => e.type === 'step');
  assert.equal(steps.filter((s) => s.status === 'done').length, 2);
  const done = ev.at(-1);
  assert.equal(done.type, 'done');
  assert.deepEqual(done.sources.map((s) => s.url).sort(), ['https://example.com/nifty', 'https://news.example/rbi']);
  // Tool results go back to the model; holdings are named in the system prompt without amounts.
  const second = chatCalls[1].messages;
  assert.equal(second.filter((m) => m.role === 'tool').length, 2);
  assert.match(second[0].content, /Reliance Industries \(RELIANCE\.NS\)/);
  assert.doesNotMatch(JSON.stringify(chatCalls), /quantity/);
});

test('drops draft text when the model switches to a tool call', async () => {
  turns = [
    [{ message: { content: 'Let me check.' } }, { message: { tool_calls: [{ function: { name: 'web_search', arguments: '{"query":"x"}' } }] }, done: true }],
    [{ message: { content: 'Done.' }, done: true }],
  ];
  const ev = events((await request(createApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'q' }] })).text);
  assert.ok(ev.some((e) => e.type === 'reset'));
});

test('stops offering tools on the last round', async () => {
  const call = [{ message: { tool_calls: [{ function: { name: 'web_search', arguments: { query: 'x' } } }] }, done: true }];
  turns = [call, call, call, [{ message: { content: 'Best effort answer.' }, done: true }]];
  const ev = events((await request(createApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'q' }] })).text);
  assert.equal(chatCalls.length, 4);
  assert.equal(chatCalls[3].tools, undefined);
  assert.equal(ev.at(-1).type, 'done');
});

test('a failing tool is reported and the model still answers', async () => {
  turns = [
    [{ message: { tool_calls: [{ function: { name: 'fetch_url', arguments: { url: 'http://127.0.0.1/admin' } } }] }, done: true }],
    [{ message: { content: 'Could not open that link.' }, done: true }],
  ];
  const ev = events((await request(createApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'open it' }] })).text);
  assert.ok(ev.some((e) => e.type === 'step' && e.status === 'error' && /not public/.test(e.detail)));
  assert.match(chatCalls[1].messages.at(-1).content, /^Error: /);
});

test('model errors are streamed as an error event', async () => {
  turns = [new Error('model overloaded')];
  const ev = events((await request(createApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'q' }] })).text);
  assert.equal(ev.at(-1).type, 'error');
  assert.match(ev.at(-1).message, /overloaded/);
});

test('validates the request', async () => {
  const app = createApp();
  assert.equal((await request(app).post('/api/chat').send({})).status, 400);
  assert.equal((await request(app).post('/api/chat').send({ messages: [{ role: 'system', content: 'x' }] })).status, 400);
  assert.equal((await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })).status, 400);
});

test('returns 503 without a model configured', async () => {
  Object.assign(config, { ollamaApiKey: '', ollamaHost: 'https://ollama.com' });
  const res = await request(createApp()).post('/api/chat').send({ messages: [{ role: 'user', content: 'q' }] });
  assert.equal(res.status, 503);
  assert.equal((await request(createApp()).get('/api/chat/status')).body.enabled, false);
});

test('parses DuckDuckGo results and skips ads', () => {
  const html = `
    <div class="result results_links result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
    <div class="result results_links"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1&amp;rut=x">Example <b>A</b></a></h2>
      <a class="result__snippet" href="#">Snippet &amp; more</a></div>`;
  assert.deepEqual(parseDuckDuckGo(html), [{ title: 'Example A', url: 'https://example.org/a?b=1', content: 'Snippet & more' }]);
});

test('extracts readable text from HTML', () => {
  const r = htmlToText('<html><head><title>T &amp; C</title><style>x{}</style></head><body><nav>menu</nav><p>Hello <b>world</b></p><script>bad()</script><p>Second</p></body></html>');
  assert.equal(r.title, 'T & C');
  assert.equal(r.content, 'Hello world\nSecond');
});

test('blocks private and loopback addresses', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  await assert.rejects(fetchUrl('http://localhost:4000/api/health'), /not public/);
  await assert.rejects(fetchUrl('file:///etc/passwd'), /http and https/);
});
