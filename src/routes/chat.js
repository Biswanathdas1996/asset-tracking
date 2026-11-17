import { Router } from 'express';
import { chat } from '../services/chatAgent.js';
import { aiEnabled, config } from '../config.js';
import { BadRequest } from './util.js';

const r = Router();
const MAX_MESSAGES = 24;
const MAX_CHARS = 6000;
const MAX_HOLDINGS = 60;
const text = (v, max) => String(v ?? '').trim().slice(0, max);

r.get('/chat/status', (req, res) => res.json({ enabled: aiEnabled(), model: config.chatModel }));

/**
 * POST /api/chat  { messages: [{ role: 'user'|'assistant', content }], holdings?: [{ name, symbol, assetType }] }
 * Streams newline-delimited JSON events (see services/chatAgent.js). Nothing is stored on the server.
 */
r.post('/chat', async (req, res, next) => {
  let messages, holdings;
  try {
    const list = req.body?.messages;
    if (!Array.isArray(list) || !list.length) throw new BadRequest('messages must be a non-empty array');
    messages = list.slice(-MAX_MESSAGES).map((m) => {
      if (!['user', 'assistant'].includes(m?.role)) throw new BadRequest('role must be "user" or "assistant"');
      return { role: m.role, content: text(m.content, MAX_CHARS) };
    }).filter((m) => m.content);
    if (messages.at(-1)?.role !== 'user') throw new BadRequest('The last message must be from the user');
    holdings = (Array.isArray(req.body?.holdings) ? req.body.holdings : []).slice(0, MAX_HOLDINGS)
      .filter((h) => ['stock', 'crypto', 'gold'].includes(h?.assetType))
      .map((h) => ({ name: text(h.name, 120) || text(h.symbol, 40), symbol: text(h.symbol, 40), assetType: h.assetType }))
      .filter((h) => h.name);
    if (!aiEnabled()) throw Object.assign(new Error('The chat assistant needs an AI model. Set OLLAMA_API_KEY (or OLLAMA_HOST) on the server.'), { status: 503 });
  } catch (err) {
    return next(err);
  }

  res.status(200).set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  const emit = (ev) => { if (!res.writableEnded && !abort.signal.aborted) res.write(`${JSON.stringify(ev)}\n`); };
  // Keep proxies from closing a quiet connection while the model thinks.
  const ping = setInterval(() => emit({ type: 'ping' }), 15000);
  try {
    await chat({ messages, holdings }, emit, abort.signal);
  } catch (err) {
    if (!abort.signal.aborted) {
      if (!err.status || err.status >= 500) console.error('chat:', err.message);
      emit({ type: 'error', message: err.message || 'Something went wrong' });
    }
  } finally {
    clearInterval(ping);
    res.end();
  }
});

export default r;
