import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installmentDates, splitGst, computeSip } from '../src/services/sip.js';
import { closeOnOrBefore } from '../src/services/dates.js';
import { perGramInr, TROY_OUNCE_GRAMS } from '../src/services/gold.js';

test('monthly schedule clamps to month end', () => {
  assert.deepEqual(installmentDates('2025-01-31', 'monthly', '2025-05-01'), ['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30']);
});

test('weekly, daily and quarterly schedules', () => {
  assert.deepEqual(installmentDates('2025-01-01', 'weekly', '2025-01-20'), ['2025-01-01', '2025-01-08', '2025-01-15']);
  assert.equal(installmentDates('2024-02-01', 'daily', '2024-02-29').length, 29);
  assert.deepEqual(installmentDates('2025-01-15', 'quarterly', '2025-12-31'), ['2025-01-15', '2025-04-15', '2025-07-15', '2025-10-15']);
});

test('GST inclusive vs exclusive', () => {
  const inc = splitGst(1030, 3, true);
  assert.equal(Math.round(inc.net * 100) / 100, 1000);
  assert.equal(inc.paid, 1030);
  const exc = splitGst(1000, 3, false);
  assert.deepEqual(exc, { paid: 1030, gst: 30, net: 1000 });
});

test('computeSip values each installment at that day\'s rate', () => {
  const prices = { '2025-01-10': 8000, '2025-02-10': 10000, '2025-03-10': 5000 };
  const r = computeSip(
    { sipAmount: 1030, gstPercent: 3, gstInclusive: true, frequency: 'monthly', startDate: '2025-01-10' },
    '2025-03-20',
    (d) => prices[d],
  );
  assert.equal(r.installmentCount, 3);
  assert.equal(r.totalInvested, 3090);
  assert.equal(r.totalGst, 90);
  assert.equal(r.totalGrams, 0.425);
  assert.equal(r.nextInstallmentDate.toISOString().slice(0, 10), '2025-04-10');
});

test('computeSip stops at endDate and applies platform premium', () => {
  const r = computeSip(
    { sipAmount: 100, gstPercent: 0, gstInclusive: true, frequency: 'daily', startDate: '2025-01-01', endDate: '2025-01-05', premiumPercent: 25 },
    '2025-02-01',
    () => 80,
  );
  assert.equal(r.installmentCount, 5);
  assert.equal(r.totalGrams, 5); // 100 / (80 * 1.25)
  assert.equal(r.nextInstallmentDate, null);
});

test('closeOnOrBefore carries the last trading day over holidays', () => {
  const s = [{ date: '2025-01-03', close: 1 }, { date: '2025-01-06', close: 2 }];
  assert.equal(closeOnOrBefore(s, '2025-01-05').close, 1);
  assert.equal(closeOnOrBefore(s, '2025-01-06').close, 2);
  assert.equal(closeOnOrBefore(s, '2025-01-01'), null);
});

test('gold per gram conversion', () => {
  assert.equal(perGramInr(TROY_OUNCE_GRAMS, 100, 0), 100);
  assert.equal(Math.round(perGramInr(TROY_OUNCE_GRAMS, 100, 6) * 100) / 100, 106);
});
