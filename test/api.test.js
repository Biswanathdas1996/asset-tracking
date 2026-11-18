import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';

// Stub the market data APIs so tests are deterministic and offline.
const day = (d) => Date.parse(`${d}T09:15:00Z`) / 1000;
const chart = (symbol, price, bars = []) => ({
  chart: { result: [{
    meta: { symbol, longName: `${symbol} Ltd`, regularMarketPrice: price, chartPreviousClose: price - 10, currency: 'INR', gmtoffset: 19800, regularMarketTime: day('2026-01-01') },
    timestamp: bars.map((b) => day(b[0])),
    indicators: { quote: [{ close: bars.map((b) => b[1]) }] },
  }] },
});
const routes = [
  [/chart\/RELIANCE\.NS/, () => chart('RELIANCE.NS', 1500, [['2024-03-14', 1390], ['2024-03-15', 1400]])],
  [/chart\/BAD\.NS/, () => ({ status: 404, body: { chart: { error: { description: 'No data found' } } } })],
  [/chart\/GC%3DF|chart\/GC=F/, () => chart('GC=F', 3110.34768, [['2024-12-31', 3110.34768], ['2025-01-31', 3110.34768]])],
  [/chart\/USDINR/, () => chart('USDINR=X', 100, [['2024-12-31', 80], ['2025-01-31', 100]])],
  [/simple\/price/, () => ({ bitcoin: { inr: 5000000, inr_24h_change: 1.5, last_updated_at: 1767225600 } })],
];
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = async (url) => {
    const hit = routes.find(([re]) => re.test(String(url)));
    if (!hit) return new Response('{}', { status: 404 });
    const out = hit[1]();
    return out.status ? new Response(JSON.stringify(out.body), { status: out.status }) : new Response(JSON.stringify(out), { status: 200 });
  };
});
after(() => { globalThis.fetch = realFetch; });

const app = createApp();
const records = {};

test('values a stock using the market close on the buy date, keeping the client id', async () => {
  const res = await request(app).post('/api/value/holding').send({ _id: 'h1', assetType: 'stock', symbol: 'reliance', quantity: 10, buyDate: '2024-03-16' });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body._id, 'h1');
  assert.equal(res.body.symbol, 'RELIANCE.NS');
  assert.equal(res.body.buyPrice, 1400); // Saturday -> Friday's close
  assert.equal(res.body.investedValue, 14000);
  assert.equal(res.body.currentValue, 15000);
  assert.equal(res.body.pnl, 1000);
  records.stock = res.body;
});

test('manual buy price + fees', async () => {
  const res = await request(app).post('/api/value/holding').send({ _id: 'h2', assetType: 'crypto', coinId: 'bitcoin', symbol: 'btc', quantity: 0.1, buyDate: '2025-01-01', buyPrice: 4000000, fees: 100 });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body.buyPriceSource, 'manual');
  assert.equal(res.body.investedValue, 400100);
  assert.equal(res.body.currentValue, 500000);
  assert.equal(res.body.dayChangePercent, 1.5);
  records.crypto = res.body;
});

test('rejects unknown symbols and bad input', async () => {
  assert.equal((await request(app).post('/api/value/holding').send({ assetType: 'stock', symbol: 'BAD', quantity: 1, buyDate: '2024-01-01' })).status, 400);
  assert.equal((await request(app).post('/api/value/holding').send({ assetType: 'stock', symbol: 'RELIANCE', quantity: 0, buyDate: '2024-01-01' })).status, 400);
  assert.equal((await request(app).post('/api/value/holding').send({ assetType: 'stock', symbol: 'RELIANCE', quantity: 1, buyDate: '2999-01-01' })).status, 400);
  assert.equal((await request(app).post('/api/value/gold-sip').send({ sipAmount: 100, frequency: 'hourly', startDate: '2025-01-01' })).status, 400);
  assert.equal((await request(app).post('/api/portfolio/refresh').send({ holdings: 'x' })).status, 400);
});

test('gold SIP ledger is built from historical gold prices', async () => {
  const res = await request(app).post('/api/value/gold-sip').send({ _id: 'g1', sipAmount: 1030, gstPercent: 3, frequency: 'monthly', startDate: '2025-01-01', endDate: '2025-02-01' });
  assert.equal(res.status, 200, res.body.error);
  // Jan 1 -> uses Dec 31 close: 3110.34768 * 80 / 31.1034768 * 1.06 = 8480/g ; Feb 1 -> Jan 31 close: 10600/g
  assert.equal(res.body._id, 'g1');
  assert.equal(res.body.installmentCount, 2);
  assert.equal(res.body.installments[0].pricePerGram, 8480);
  assert.equal(res.body.installments[1].pricePerGram, 10600);
  assert.equal(res.body.totalInvested, 2060);
  assert.equal(res.body.totalGst, 60);
  assert.equal(res.body.currentPricePerGram, 10600);
  records.sip = res.body;
});

test('refresh revalues the records sent by the browser and returns them', async () => {
  const stale = { ...records.stock, currentPrice: 1, currentValue: 10 };
  const res = await request(app).post('/api/portfolio/refresh').send({ holdings: [stale, records.crypto], goldSips: [records.sip] });
  assert.equal(res.status, 200, res.body.error);
  assert.deepEqual(res.body.errors, []);
  assert.equal(res.body.holdings[0]._id, 'h1');
  assert.equal(res.body.holdings[0].currentValue, 15000);
  assert.equal(res.body.holdings[1].currentValue, 500000);
  assert.equal(res.body.goldSips[0].installmentCount, 2);
  assert.equal(res.body.goldLive.pricePerGram, 10600);
});

test('rebuilds portfolio value history from daily closes', async () => {
  const res = await request(app).post('/api/portfolio/history').send({
    holdings: [{ assetType: 'stock', symbol: 'RELIANCE.NS', quantity: 10, buyDate: '2024-03-14', investedValue: 13900 }],
    goldSips: [],
  });
  assert.equal(res.status, 200, res.body.error);
  const { points } = res.body;
  assert.equal(points[0].date, '2024-03-14');
  assert.deepEqual([points[0].value, points[0].invested], [13900, 13900]);
  assert.equal(points.at(-1).value, 14000); // last close carried forward
  assert.ok(points.every((p, i) => !i || p.date > points[i - 1].date), 'dates ascend');
});

test('history is one point per day and carries a lot at its buy price before its first close', async () => {
  const res = await request(app).post('/api/portfolio/history').send({
    holdings: [{ assetType: 'stock', symbol: 'RELIANCE.NS', quantity: 10, buyDate: '2024-03-10', buyPrice: 1380, investedValue: 13810 }],
    goldSips: [],
  });
  assert.equal(res.status, 200, res.body.error);
  const { points } = res.body;
  assert.equal(points[0].date, '2024-03-10');
  assert.deepEqual([points[0].value, points[0].invested], [13800, 13810]);
  assert.equal(points.find((p) => p.date === '2024-03-14').value, 13900);
  assert.ok(points.every((p, i) => !i || Date.parse(p.date) - Date.parse(points[i - 1].date) === 86400000), 'daily, no gaps');
  assert.deepEqual(res.body.errors, []);
});

test('history reports assets with no price data and values them at cost', async () => {
  const res = await request(app).post('/api/portfolio/history').send({
    holdings: [{ assetType: 'stock', symbol: 'BAD.NS', name: 'Bad Co', quantity: 1, buyDate: '2026-01-01', investedValue: 500 }],
    goldSips: [],
  });
  assert.equal(res.status, 200, res.body.error);
  assert.ok(res.body.points.every((p) => p.value === 500));
  assert.match(res.body.errors.join(), /Bad Co: no price history/);
});

test('history rejects non-array input', async () => {
  const res = await request(app).post('/api/portfolio/history').send({ holdings: 'x' });
  assert.equal(res.status, 400);
});
