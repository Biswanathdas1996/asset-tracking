import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from '../src/services/crypto.js';
import { _clearCache } from '../src/services/coindcx.js';

// Offline stubs for the CoinDCX and CoinGecko public APIs.
const market = (target, quote, ecode = 'I') => ({
  coindcx_name: `${target}${quote}`, target_currency_short_name: target, base_currency_short_name: quote,
  pair: `${ecode}-${target}_${quote}`, ecode, status: 'active',
});
const ticker = (m, last, change) => ({ market: m, last_price: String(last), change_24_hour: String(change), timestamp: 1794935996 });
const day = (d) => Date.parse(`${d}T00:00:00Z`);

let dcxDown = false;
const calls = [];
const routes = [
  [/markets_details/, () => [market('BTC', 'INR'), market('BTC', 'USDT', 'B'), market('PEPE', 'USDT', 'B'), market('USDT', 'INR'), { ...market('OLD', 'INR'), status: 'inactive' }]],
  [/exchange\/ticker/, () => [ticker('BTCINR', 6677193.2, -2.5), ticker('BTCUSDT', 64000, -1.4), ticker('PEPEUSDT', 0.00001, 10), ticker('USDTINR', 100, 0)]],
  [/candles\?.*pair=I-BTC_INR/, () => [{ close: 8800000, time: day('2025-01-03') }, { close: 8900000, time: day('2025-01-04') }]],
  [/candles\?.*pair=B-PEPE_USDT/, () => [{ close: 0.00002, time: day('2025-01-04') }]],
  [/candles\?.*pair=I-USDT_INR/, () => [{ close: 90, time: day('2025-01-04') }]],
  [/simple\/price/, () => ({ dogecoin: { inr: 30, inr_24h_change: 2, last_updated_at: 1794935900 } })],
];
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (dcxDown && u.includes('coindcx')) return new Response('{}', { status: 404 });
    const hit = routes.find(([re]) => re.test(u));
    return hit ? new Response(JSON.stringify(hit[1]()), { status: 200 }) : new Response('{}', { status: 404 });
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { _clearCache(); calls.length = 0; dcxDown = false; });

test('prices from the CoinDCX INR market, USDT market x USDT/INR, and CoinGecko fallback', async () => {
  const p = await crypto.getPricesInr([
    { id: 'bitcoin', symbol: 'btc' },
    { id: 'pepe', symbol: 'PEPE' },
    { id: 'dogecoin', symbol: 'DOGE' },
    { id: 'old-coin', symbol: 'OLD' },
  ]);
  assert.equal(p.bitcoin.price, 6677193.2);
  assert.equal(p.bitcoin.change24hPct, -2.5);
  assert.equal(p.bitcoin.source, 'coindcx');
  assert.ok(Math.abs(p.pepe.price - 0.001) < 1e-12);
  assert.ok(Math.abs(p.pepe.change24hPct - 10) < 1e-9);
  assert.equal(p.dogecoin.price, 30);
  assert.equal(p.dogecoin.source, 'coingecko');
  assert.equal(p['old-coin'], undefined); // inactive on CoinDCX, unknown to CoinGecko
  assert.equal(calls.filter((u) => u.includes('exchange/ticker')).length, 1);
});

test('falls back to CoinGecko when CoinDCX is unreachable', async () => {
  dcxDown = true;
  const p = await crypto.getPricesInr([{ id: 'dogecoin', symbol: 'DOGE' }]);
  assert.equal(p.dogecoin.source, 'coingecko');
});

test('historical price uses CoinDCX daily candles (close on or before the date)', async () => {
  assert.deepEqual(await crypto.getPriceOnDate({ id: 'bitcoin', symbol: 'BTC' }, '2025-01-04'), { date: '2025-01-04', price: 8900000, source: 'coindcx' });
  const pepe = await crypto.getPriceOnDate({ id: 'pepe', symbol: 'PEPE' }, '2025-01-04');
  assert.equal(pepe.source, 'coindcx');
  assert.ok(Math.abs(pepe.price - 0.0018) < 1e-12);
});

test('daily INR closes for the history chart: INR market directly, USDT market x USDT/INR', async () => {
  const { getDailyCloses } = await import('../src/services/coindcx.js');
  const btc = await getDailyCloses('btc', '2025-01-01', '2025-01-05');
  assert.deepEqual(btc, [{ date: '2025-01-03', close: 8800000 }, { date: '2025-01-04', close: 8900000 }]);
  const pepe = await getDailyCloses('PEPE', '2025-01-01', '2025-01-05');
  assert.equal(pepe.length, 1);
  assert.ok(Math.abs(pepe[0].close - 0.0018) < 1e-12);
  assert.equal(await getDailyCloses('DOGE', '2025-01-01', '2025-01-05'), null); // not on CoinDCX
});
