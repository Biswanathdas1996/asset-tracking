import { test } from 'node:test';
import assert from 'node:assert/strict';
import { despike, stitch } from '../src/services/history.js';

const s = (...rows) => rows.map(([date, close]) => ({ date, close }));

test('despike drops a lone bad tick and non-positive closes, keeps real moves', () => {
  const out = despike(s(['2025-01-01', 100], ['2025-01-02', 0], ['2025-01-03', 101], ['2025-01-06', 1000], ['2025-01-07', 102], ['2025-01-08', 400], ['2025-01-09', 410]));
  assert.deepEqual(out.map((p) => p.close), [100, 101, 102, 400, 410]);
});

test('stitch fills older and newer dates from a fallback, scaled to meet the primary', () => {
  const base = s(['2025-01-10', 110], ['2025-01-11', 111]);
  const extra = s(['2025-01-08', 98], ['2025-01-09', 99], ['2025-01-10', 100], ['2025-01-11', 101], ['2025-01-12', 102]);
  const out = stitch(base, extra);
  assert.deepEqual(out.map((p) => p.date), ['2025-01-08', '2025-01-09', '2025-01-10', '2025-01-11', '2025-01-12']);
  assert.ok(Math.abs(out[0].close - 98 * 1.1) < 1e-9);
  assert.ok(Math.abs(out.at(-1).close - 102 * (111 / 101)) < 1e-9);
});

test('stitch refuses a fallback that disagrees too much at the join', () => {
  const base = s(['2025-01-10', 100]);
  const out = stitch(base, s(['2025-01-09', 10], ['2025-01-10', 10]));
  assert.deepEqual(out, base);
});
