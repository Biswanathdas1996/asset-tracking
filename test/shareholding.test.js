import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShareholding, parseLogo, screenerCode } from '../src/services/shareholding.js';

const html = `<div id="quarterly-shp"><table><thead><tr><th class="text"></th>
  <th data-date-key="2026-03-31">Mar 2026</th><th data-date-key="2026-06-30">Jun 2026</th><th data-date-key="2026-09-30">Sep 2026</th></tr></thead>
  <tbody>
  <tr class="stripe"><td class="text"><button>Promoters&nbsp;<span>+</span></button></td><td>50.00%</td><td>50.48%</td><td>50.44%</td></tr>
  <tr><td class="text"><button>FIIs&nbsp;<span class="blue-icon">+</span></button></td><td>18.67%</td><td>17.19%</td><td>16.67%</td></tr>
  <tr class="stripe"><td class="text"><button>DIIs&nbsp;<span class="blue-icon">+</span></button></td><td>19.10%</td><td>19.80%</td><td>20.15%</td></tr>
  <tr><td class="text"><button>Public&nbsp;<span class="blue-icon">+</span></button></td><td>12.00%</td><td>12.40%</td><td>12.60%</td></tr>
  </tbody></table></div>`;

test('parses promoter / FII / DII / retail latest holding and quarter-on-quarter change', () => {
  const r = parseShareholding(html);
  assert.deepEqual(r.fii, { pct: 16.67, change: -0.52, quarter: 'Sep 2026', prevQuarter: 'Jun 2026' });
  assert.deepEqual(r.dii, { pct: 20.15, change: 0.35, quarter: 'Sep 2026', prevQuarter: 'Jun 2026' });
  assert.deepEqual(r.promoter, { pct: 50.44, change: -0.04, quarter: 'Sep 2026', prevQuarter: 'Jun 2026' });
  assert.deepEqual(r.retail, { pct: 12.6, change: 0.2, quarter: 'Sep 2026', prevQuarter: 'Jun 2026' });
  assert.equal(r.asOf, 'Sep 2026');
});

test('returns null when the page has no shareholding table', () => {
  assert.equal(parseShareholding('<html>nothing</html>'), null);
});

test('reads the company mark and skips Screener placeholders', () => {
  const logo = 'https://cdn-media.screener.in/company-logos/thumbnails/d1b4fc4ed283e1d0a3a981c6.webp';
  assert.equal(parseLogo(`<img src="${logo}" alt="">`), logo);
  assert.equal(parseLogo('<img src="https://cdn-media.screener.in/company-logos/dummy.png" alt="">'), null);
  assert.equal(parseLogo('<html>nothing</html>'), null);
});

test('maps Yahoo symbols to Screener codes', () => {
  assert.equal(screenerCode('reliance.ns'), 'RELIANCE');
  assert.equal(screenerCode('500325.BO'), '500325');
});
