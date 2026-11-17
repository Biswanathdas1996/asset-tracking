import { createVault, VAULT_KEY } from './vault.js';
import { summarize, addSnapshot, upsert, newId } from './portfolio.js';

// ---------- formatting helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inrC = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 });
const qty = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 8 });
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const fmtShort = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (n) => (n > 0 ? 'gain' : n < 0 ? 'loss' : '');
const chipCls = (n) => (n > 0 ? 'gain' : n < 0 ? 'loss' : 'flat');
const signed = (n, f = inr) => (n == null ? '—' : `${n > 0 ? '+' : ''}${f.format(n)}`);
const pct = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);
const icon = (name, c = '') => `<svg class="i ${c}"><use href="#i-${name}"/></svg>`;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const shortSym = (s) => String(s || '').replace(/\.(NS|BO)$/i, '');

const KEYS = ['stock', 'crypto', 'gold'];
const META = {
  stock: { label: 'Indian stocks', noun: 'stock', icon: 'stock', color: 'var(--stock)' },
  crypto: { label: 'Crypto', noun: 'crypto', icon: 'coins', color: 'var(--crypto)' },
  gold: { label: 'Gold SIP', noun: 'SIP', icon: 'gem', color: 'var(--gold)' },
};
const PRICE_STALE_MS = 60000;
const IDLE_LOCK_MS = 15 * 60000;

const vault = createVault();
const DEFAULT_SORT = { stock: { key: 'currentValue', dir: -1 }, crypto: { key: 'currentValue', dir: -1 }, gold: { key: 'currentValue', dir: -1 } };
let state = { tab: 'stock', data: null, errors: [], q: '', range: 90, busy: false, sort: structuredClone(DEFAULT_SORT) };
let version = 0; // bumps on every local change so an in-flight refresh never overwrites newer edits
try {
  state.tab = localStorage.getItem('tab') || 'stock';
  const r = Number(localStorage.getItem('range'));
  if ([0, 30, 90, 180, 365].includes(r) && localStorage.getItem('range') !== null) state.range = r;
  const s = JSON.parse(localStorage.getItem('sort') || 'null');
  if (s && KEYS.every((k) => s[k]?.key)) state.sort = s;
} catch { /* storage unavailable */ }
if (!KEYS.includes(state.tab)) state.tab = 'stock';

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the Asset Tracker server. Is it running? Start it with start.bat.');
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ---------- toasts & confirm ----------
function toast(message, type = 'info', action = null) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info')}<span style="flex:1">${esc(message)}</span>${action ? `<button class="link" style="color:inherit;text-decoration:underline">${esc(action.label)}</button>` : ''}`;
  const remove = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 250); };
  if (action) el.querySelector('button').addEventListener('click', () => { remove(); action.fn(); });
  $('#toasts').append(el);
  setTimeout(remove, action ? 6000 : 3500);
}

const confirmDlg = $('#confirmDialog');
function confirmDialog({ title, text = '', ok = 'Delete', danger = true }) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = ok;
  $('#confirmOk').className = `btn ${danger ? 'danger' : 'primary'}`;
  confirmDlg.returnValue = '';
  confirmDlg.showModal();
  $('#confirmCancel').focus();
  return new Promise((resolve) => confirmDlg.addEventListener('close', () => resolve(confirmDlg.returnValue === 'ok'), { once: true }));
}

// ---------- theme ----------
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_COLOR = { light: '#f6f7fb', dark: '#0a0c11' };
let theme = document.documentElement.dataset.theme || 'system';
function applyTheme(t) {
  theme = t;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  // Keep the mobile browser's address bar / status bar in step with a forced theme.
  for (const m of $$('meta[name="theme-color"]')) {
    m.dataset.orig ??= m.content;
    m.content = t === 'system' ? m.dataset.orig : THEME_COLOR[t];
  }
  const btn = $('#themeBtn');
  btn.innerHTML = icon(THEME_ICON[t]);
  btn.dataset.tip = `Theme: ${t}`;
  try { if (t === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', t); } catch { /* ignore */ }
}
$('#themeBtn').addEventListener('click', () => applyTheme({ system: 'light', light: 'dark', dark: 'system' }[theme]));
applyTheme(theme);

// ---------- rendering ----------
const avatar = (text, color) => `<span class="avatar" style="--c:${color}">${esc(text)}</span>`;
const assetInitials = (r, type) => (type === 'gold' ? 'Au' : shortSym(r.symbol).replace(/[^A-Z0-9]/gi, '').slice(0, type === 'crypto' ? 3 : 2).toUpperCase() || '?');

let shownNet = null;
function setNetWorth(v) {
  const el = $('#netWorth');
  const html = (n) => { const [a, b = '00'] = inr.format(n).split('.'); return `${a}<span class="paise">.${b}</span>`; };
  const from = shownNet;
  shownNet = v;
  if (from == null || from === v || reducedMotion()) { el.innerHTML = html(v); return; }
  const t0 = performance.now(), dur = 700;
  const step = (t) => {
    if (shownNet !== v) return;
    const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
    el.innerHTML = html(from + (v - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Today's move across holdings that report a day change (stocks & crypto). */
function dayChange(holdings) {
  let change = 0, prev = 0, n = 0;
  for (const h of holdings) {
    if (h.currentValue == null || h.dayChangePercent == null) continue;
    const before = h.currentValue / (1 + h.dayChangePercent / 100);
    change += h.currentValue - before;
    prev += before;
    n++;
  }
  return n ? { change, percent: prev ? (change / prev) * 100 : 0 } : null;
}

function renderHero(d) {
  const t = d.summary.total;
  setNetWorth(t.value);
  const day = dayChange(vault.data.holdings);
  const arrow = t.pnl >= 0 ? 'arrow-up' : 'arrow-down';
  $('#heroMeta').innerHTML = `
    <span class="chip ${chipCls(t.pnl)}">${t.pnl ? icon(arrow) : ''}${signed(t.pnl, inr0)} · ${pct(t.pnlPercent)}</span>
    <span>all-time</span><span class="sep"></span>
    <span>Invested <b>${inr0.format(t.invested)}</b></span>
    ${day ? `<span class="sep"></span><span>Today <b class="${cls(day.change)}">${signed(day.change, inr0)} (${pct(day.percent)})</b></span>` : ''}`;
}

function renderCategories(s) {
  const total = s.total.value || 0;
  $('#summaryCards').innerHTML = KEYS.map((k) => {
    const b = s[k], m = META[k];
    const share = total ? (b.value / total) * 100 : 0;
    const count = k === 'gold' ? `${b.count} SIP${b.count === 1 ? '' : 's'}` : `${b.count} holding${b.count === 1 ? '' : 's'}`;
    return `<button class="cat ${state.tab === k ? 'active' : ''}" data-cat="${k}" style="--c:${m.color}">
      <div class="cat-top"><span class="cat-ic">${icon(m.icon)}</span><span class="cat-name">${m.label}</span><span class="cat-count">${count}</span></div>
      <div class="cat-value">${inr0.format(b.value)}</div>
      <div class="cat-foot"><span>Invested ${inrC.format(b.invested)}</span><span class="mini-chip ${chipCls(b.pnl)}">${signed(b.pnl, inrC)} · ${pct(b.pnlPercent)}</span></div>
      <div class="bar" title="${share.toFixed(1)}% of portfolio"><span style="width:${share}%"></span></div>
    </button>`;
  }).join('');
  for (const k of KEYS) { const c = $(`[data-count="${k}"]`); if (c) c.textContent = s[k].count; }
}

let allocSel = null; // category picked by tap/click in the allocation card

function renderAlloc(s, goldPrice) {
  const total = s.total.value || 0;
  const share = (k) => (total ? (s[k].value / total) * 100 : 0);
  const r = 60, C = 2 * Math.PI * r;
  const keys = KEYS.filter((k) => s[k].value > 0);
  if (allocSel && !keys.includes(allocSel)) allocSel = null;
  const gap = keys.length > 1 ? 3 : 0;
  let off = 0;
  const arcs = keys.map((k) => {
    const len = (s[k].value / total) * C;
    const arc = `<circle class="seg-arc" data-k="${k}" cx="75" cy="75" r="${r}" style="stroke:${META[k].color}" stroke-dasharray="${Math.max(len - gap, 0.5).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`;
    off += len;
    return arc;
  }).join('');
  $('#donut').innerHTML = `<svg viewBox="0 0 150 150" aria-hidden="true"><circle class="track" cx="75" cy="75" r="${r}"/>${arcs}</svg>
    <div class="donut-center" id="donutCenter"></div>`;
  $('#allocBar').innerHTML = keys.length
    ? keys.map((k) => `<span data-k="${k}" style="flex-grow:${share(k).toFixed(3)};background:${META[k].color}"></span>`).join('')
    : '<span class="empty"></span>';
  $('#allocLegend').innerHTML = KEYS.map((k) => {
    const b = s[k], m = META[k], sh = share(k);
    return `<li data-k="${k}" style="--c:${m.color}" role="button" tabindex="0" aria-pressed="false" ${b.value ? '' : 'class="none"'}>
      <span class="al-ic">${icon(m.icon)}</span>
      <span class="al-main">
        <span class="al-row"><span class="nm">${m.label}</span><span class="pc">${sh.toFixed(1)}<small>%</small></span></span>
        <span class="al-meter"><span style="width:${sh.toFixed(2)}%"></span></span>
        <span class="al-row al-sub"><span class="vl">${inr0.format(b.value)}</span>${b.invested ? `<span class="al-pl ${chipCls(b.pnl)}">${pct(b.pnlPercent)}</span>` : ''}</span>
      </span>
    </li>`;
  }).join('');
  const gr = $('#goldRate');
  gr.hidden = !goldPrice;
  if (goldPrice) gr.innerHTML = `<span class="sw" style="width:8px;height:8px;border-radius:50%;background:var(--gold)"></span>24K ${inr0.format(goldPrice.pricePerGram)}/g`;
  allocData = { s, total };
  highlightAlloc(allocSel);
}

let allocData = null;
/** Emphasise one category across the donut, bar and list, and show its numbers in the summary. */
function highlightAlloc(k) {
  if (!allocData) return;
  const { s, total } = allocData;
  const card = $('.alloc-card');
  card.classList.toggle('focusing', !!k);
  $$('[data-k]', card).forEach((n) => {
    n.classList.toggle('hot', n.dataset.k === k);
    if (n.tagName === 'LI') n.setAttribute('aria-pressed', String(n.dataset.k === allocSel));
  });
  const b = k ? s[k] : s.total;
  const label = k ? META[k].label : total ? 'Total value' : 'No assets yet';
  const share = k && total ? `${((b.value / total) * 100).toFixed(1)}% of portfolio` : `${KEYS.filter((x) => s[x].value > 0).length} asset classes`;
  $('#donutCenter').innerHTML = `<span>${label}</span><b>${total ? inrC.format(b.value) : '₹0'}</b>${k ? `<em>${share}</em>` : ''}`;
  $('#allocSummary').innerHTML = `<div><span class="lbl">${label}</span><b>${inr0.format(b.value)}</b></div>
    ${total ? `<span class="mini-chip ${chipCls(b.pnl)}">${signed(b.pnl, inrC)} · ${pct(b.pnlPercent)}</span>` : ''}
    <span class="alloc-hint">${share}</span>`;
}

// Allocation interactions: hover previews, tap/click/Enter pins a category
const allocCard = $('.alloc-card');
allocCard.addEventListener('mouseover', (e) => {
  if (!matchMedia('(hover: hover)').matches) return;
  highlightAlloc(e.target.closest('[data-k]')?.dataset.k || allocSel);
});
allocCard.addEventListener('mouseleave', () => highlightAlloc(allocSel));
const pickAlloc = (e) => {
  const n = e.target.closest('[data-k]');
  if (!n || n.classList.contains('none')) return;
  allocSel = allocSel === n.dataset.k ? null : n.dataset.k;
  highlightAlloc(allocSel);
};
allocCard.addEventListener('click', pickAlloc);
allocCard.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('li[data-k]')) { e.preventDefault(); pickAlloc(e); } });

// ---------- holdings table ----------
function th(key, label, num = false) {
  const s = state.sort[state.tab];
  const on = s.key === key;
  return `<th class="sortable ${num ? 'num' : ''} ${on ? 'sorted' : ''}" data-sort="${key}" aria-sort="${on ? (s.dir > 0 ? 'ascending' : 'descending') : 'none'}" tabindex="0">${label}${icon(on ? (s.dir > 0 ? 'arrow-up' : 'arrow-down') : 'sort', 'sort-ic')}</th>`;
}

function sortRows(rows) {
  const { key, dir } = state.sort[state.tab];
  return [...rows].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
}

function filterRows(rows) {
  const q = state.q.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => [r.name, r.symbol, r.notes, r.platform].some((v) => String(v || '').toLowerCase().includes(q)));
}

const rowActions = (id) => `<div class="row-actions">
  <button class="icon-btn sm" data-edit="${esc(id)}" aria-label="Edit">${icon('edit')}</button>
  <button class="icon-btn sm danger" data-del="${esc(id)}" aria-label="Delete">${icon('trash')}</button></div>`;

function emptyState(type) {
  const copy = {
    stock: ['No stocks yet', 'Search any NSE/BSE stock, enter quantity and date — we fetch the historical price for you.', 'Add your first stock'],
    crypto: ['No crypto yet', 'Track Bitcoin, Ethereum and thousands of coins valued live in rupees.', 'Add your first coin'],
    gold: ['No gold SIP yet', 'Enter your SIP amount, GST and frequency. Every installment is valued at that day\'s gold rate.', 'Set up a gold SIP'],
  }[type];
  return `<div class="empty-state" style="--c:${META[type].color}"><span class="big-ic">${icon(META[type].icon)}</span>
    <h3>${copy[0]}</h3><p>${copy[1]}</p><button class="btn primary" data-add>${icon('plus')}${copy[2]}</button></div>`;
}
const noMatches = () => `<div class="empty-state"><span class="big-ic">${icon('search')}</span><h3>No matches</h3><p>Nothing matches “${esc(state.q)}”.</p><button class="btn subtle" data-clear-filter>Clear filter</button></div>`;

function stockTable(all, type) {
  if (!all.length) return emptyState(type);
  const rows = sortRows(filterRows(all));
  if (!rows.length) return noMatches();
  const c = META[type].color;
  const tot = rows.reduce((t, r) => ({ inv: t.inv + r.investedValue, val: t.val + (r.currentValue ?? r.investedValue) }), { inv: 0, val: 0 });
  const tpnl = tot.val - tot.inv;
  return `<table class="holdings-table">
    <thead><tr>${th('name', type === 'stock' ? 'Stock' : 'Coin')}${th('quantity', 'Qty', true)}${th('buyPrice', 'Avg buy', true)}${th('investedValue', 'Invested', true)}
      ${th('currentPrice', 'Live price', true)}${th('dayChangePercent', 'Day', true)}${th('currentValue', 'Value', true)}${th('pnl', 'P&amp;L', true)}<th></th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr>
        <td class="lead"><div class="asset">${avatar(assetInitials(r, type), c)}<div>
          <div class="name">${esc(r.name)}</div>
          <div class="sub">${esc(shortSym(r.symbol))} · ${fmtDate(r.buyDate)}${r.notes ? ` · ${esc(r.notes)}` : ''}</div></div></div>${rowActions(r._id)}</td>
        <td class="num" data-label="Qty">${qty.format(r.quantity)}</td>
        <td class="num hide-sm" data-label="Avg buy">${inr.format(r.buyPrice)}<div class="sub">${r.buyPriceSource === 'manual' ? 'entered' : `close ${fmtDate(r.buyPriceDate)}`}</div></td>
        <td class="num" data-label="Invested">${inr.format(r.investedValue)}</td>
        <td class="num" data-label="Live price">${r.currentPrice != null ? inr.format(r.currentPrice) : '—'}</td>
        <td class="num" data-label="Day"><span class="mini-chip ${chipCls(r.dayChangePercent)}">${pct(r.dayChangePercent)}</span></td>
        <td class="num" data-label="Value"><b>${r.currentValue != null ? inr.format(r.currentValue) : '—'}</b></td>
        <td class="num" data-label="P&amp;L"><div class="pnl-cell"><span class="${cls(r.pnl)}">${signed(r.pnl)}</span><span class="mini-chip ${chipCls(r.pnl)}">${pct(r.pnlPercent)}</span></div></td>
        <td class="actions">${rowActions(r._id)}</td>
      </tr>`).join('')}</tbody>
    <tfoot><tr><td>Total · ${rows.length}</td><td></td><td></td><td class="num hide-sm">${inr.format(tot.inv)}</td><td></td><td></td>
      <td class="num" data-label="Value">${inr.format(tot.val)}</td><td class="num ${cls(tpnl)}" data-label="P&amp;L">${signed(tpnl)}</td><td></td></tr></tfoot>
  </table>`;
}

function goldTable(all) {
  if (!all.length) return emptyState('gold');
  const sips = sortRows(filterRows(all));
  if (!sips.length) return noMatches();
  return `<table class="holdings-table">
    <thead><tr>${th('name', 'SIP')}${th('installmentCount', 'Installments', true)}${th('totalInvested', 'Invested', true)}${th('totalGrams', 'Gold held', true)}
      ${th('currentPricePerGram', 'Live rate', true)}${th('currentValue', 'Value', true)}${th('pnl', 'P&amp;L', true)}<th></th></tr></thead>
    <tbody>${sips.map((s) => `
      <tr class="has-ledger">
        <td class="lead"><div class="asset">${avatar('Au', META.gold.color)}<div>
          <div class="name">${esc(s.name)} ${s.platform ? `<span class="badge">${esc(s.platform)}</span>` : ''} ${s.nextInstallmentDate ? '<span class="badge ok">Active</span>' : '<span class="badge done">Completed</span>'}</div>
          <div class="sub">${inr.format(s.sipAmount)} ${esc(s.frequency)} · GST ${s.gstPercent}% ${s.gstInclusive ? 'incl.' : 'extra'} · since ${fmtDate(s.startDate)}${s.endDate ? ` → ${fmtDate(s.endDate)}` : ''}</div></div></div>${rowActions(s._id)}</td>
        <td class="num" data-label="Installments">${s.installmentCount ?? 0}<div class="sub">${s.nextInstallmentDate ? `next ${fmtDate(s.nextInstallmentDate)}` : 'done'}</div></td>
        <td class="num" data-label="Invested">${inr.format(s.totalInvested || 0)}<div class="sub">GST ${inr.format(s.totalGst || 0)}</div></td>
        <td class="num" data-label="Gold held">${(s.totalGrams || 0).toFixed(4)} g<div class="sub">avg ${inr.format(s.avgCostPerGram || 0)}/g</div></td>
        <td class="num hide-sm" data-label="Live rate">${s.currentPricePerGram ? `${inr.format(s.currentPricePerGram)}/g` : '—'}</td>
        <td class="num" data-label="Value"><b>${s.currentValue != null ? inr.format(s.currentValue) : '—'}</b></td>
        <td class="num" data-label="P&amp;L"><div class="pnl-cell"><span class="${cls(s.pnl)}">${signed(s.pnl)}</span><span class="mini-chip ${chipCls(s.pnl)}">${pct(s.pnlPercent)}</span></div></td>
        <td class="actions">${rowActions(s._id)}</td>
      </tr>
      <tr class="ledger-row"><td colspan="8"><details class="ledger" data-ledger="${esc(s._id)}"><summary>${icon('chevron')}Installment history · ${s.installmentCount ?? 0}</summary><div class="scroll">Loading…</div></details></td></tr>`).join('')}</tbody>
  </table>`;
}

// Column headers are hidden in the mobile card layout, so sorting there goes through a select.
const SORT_OPTIONS = {
  holding: [
    ['currentValue', -1, 'Value: high to low'], ['currentValue', 1, 'Value: low to high'],
    ['pnl', -1, 'P&L: high to low'], ['pnl', 1, 'P&L: low to high'],
    ['pnlPercent', -1, 'Return %: high to low'], ['dayChangePercent', -1, 'Today: best first'],
    ['dayChangePercent', 1, 'Today: worst first'], ['investedValue', -1, 'Invested: high to low'],
    ['name', 1, 'Name: A to Z'], ['name', -1, 'Name: Z to A'],
  ],
  gold: [
    ['currentValue', -1, 'Value: high to low'], ['currentValue', 1, 'Value: low to high'],
    ['pnl', -1, 'P&L: high to low'], ['pnlPercent', -1, 'Return %: high to low'],
    ['totalInvested', -1, 'Invested: high to low'], ['totalGrams', -1, 'Gold held: most first'],
    ['name', 1, 'Name: A to Z'],
  ],
};
function renderSortSelect() {
  const sel = $('#sortSelect');
  const opts = SORT_OPTIONS[state.tab === 'gold' ? 'gold' : 'holding'];
  const { key, dir } = state.sort[state.tab];
  const cur = `${key}:${dir}`;
  const list = opts.map(([k, d, label]) => [`${k}:${d}`, label]);
  if (!list.some(([v]) => v === cur)) list.unshift([cur, 'Custom (from column)']);
  sel.innerHTML = list.map(([v, label]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`).join('');
}
$('#sortSelect').addEventListener('change', (e) => {
  const [key, dir] = e.target.value.split(':');
  state.sort[state.tab] = { key, dir: Number(dir) };
  try { localStorage.setItem('sort', JSON.stringify(state.sort)); } catch { /* ignore */ }
  renderTable();
});

function renderTable() {
  const d = state.data;
  if (!d) return;
  $$('.tab').forEach((t) => { const on = t.dataset.tab === state.tab; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
  $$('.cat').forEach((c) => c.classList.toggle('active', c.dataset.cat === state.tab));
  $('#addLabel').textContent = { stock: 'Add stock', crypto: 'Add crypto', gold: 'Add SIP' }[state.tab];
  renderSortSelect();
  $('#tableWrap').innerHTML = state.tab === 'stock' ? stockTable(d.stocks, 'stock') : state.tab === 'crypto' ? stockTable(d.crypto, 'crypto') : goldTable(d.goldSips);
}

// ---------- history chart ----------
/** Chart points by day: backfilled market history, overridden by recorded snapshots, ending with today's live total. */
function chartSeries() {
  const d = vault.data;
  const byDay = new Map();
  for (const p of d.meta.history?.points || []) byDay.set(p.date, { invested: p.invested, value: p.value, pnl: p.value - p.invested });
  for (const s of d.snapshots) byDay.set(s.at.slice(0, 10), s.total);
  if (state.data && (d.holdings.length || d.goldSips.length)) byDay.set(today(), state.data.summary.total);
  return [...byDay].sort((a, b) => a[0].localeCompare(b[0])).map(([at, total]) => ({ at, total }));
}

const historyKey = (d) => `${today()}|${JSON.stringify([
  d.holdings.map((h) => [h._id, h.quantity, h.buyDate, h.investedValue]),
  d.goldSips.map((s) => [s._id, s.installmentCount, s.totalInvested]),
])}`;

/** Backfill the chart from historical prices once per day, or when holdings change. Cached in the vault. */
async function fetchHistory() {
  if (!vault.unlocked || state.historyLoading) return;
  const d = vault.data;
  if (!d.holdings.length && !d.goldSips.length) { if (d.meta.history) { delete d.meta.history; await vault.save(); renderHistory(); } return; }
  const key = historyKey(d);
  if (d.meta.history?.key === key) return;
  state.historyLoading = true;
  renderHistory();
  const startVersion = version;
  try {
    const r = await api('/portfolio/history', {
      method: 'POST',
      body: {
        holdings: d.holdings.map(({ assetType, symbol, quantity, buyDate, investedValue, name }) => ({ assetType, symbol, quantity, buyDate, investedValue, name })),
        goldSips: d.goldSips.map(({ installments }) => ({ installments })),
      },
    });
    if (!vault.unlocked || version !== startVersion) return;
    vault.data.meta.history = { key, points: r.points };
    await vault.save();
    chartAnimate = true;
  } catch { /* offline or upstream error: the chart falls back to recorded snapshots */ } finally {
    state.historyLoading = false;
    if (vault.unlocked) renderHistory();
  }
}

let chart = null; // geometry of the drawn chart, for hover
let chartAnimate = true;
function renderHistory() {
  const el = $('#historyChart');
  const legend = $('#chartLegend');
  $$('#rangeSeg button').forEach((b) => b.classList.toggle('active', Number(b.dataset.range) === state.range));
  const all = chartSeries();
  const since = state.range ? new Date(Date.now() - state.range * 86400000).toISOString().slice(0, 10) : '';
  const pts = all.filter((p) => p.at >= since);
  $('#chartTip').hidden = true;
  if (pts.length < 2) {
    chart = null;
    const d = vault.data;
    const none = !d.holdings.length && !d.goldSips.length;
    const [title, text] = state.historyLoading
      ? ['Building your history…', 'Fetching past market prices for your holdings.']
      : none
        ? ['No history yet', 'Add a holding and its value over time appears here.']
        : all.length < 2
          ? ['History unavailable right now', 'Past prices could not be fetched. It will retry on the next refresh.']
          : ['Not enough history in this range', 'Try a longer range, or <b>All</b>.'];
    el.innerHTML = `<div class="chart-empty ${state.historyLoading ? 'loading' : ''}"><div>${icon('stock')}<div><b style="color:var(--text)">${title}</b></div><div>${text}</div></div></div>`;
    legend.innerHTML = '';
    return;
  }
  const W = Math.max(el.clientWidth, 280), H = el.clientHeight || 230;
  const P = { l: 6, r: 6, t: 14, b: 26 };
  const vals = pts.flatMap((p) => [p.total.value, p.total.invested]);
  let min = Math.min(...vals), max = Math.max(...vals);
  const pad = (max - min) * 0.15 || max * 0.05 || 1;
  min = Math.max(0, min - pad); max += pad;
  const x = (i) => P.l + (i / (pts.length - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  const path = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.total[k]).toFixed(1)}`).join('');
  const vPath = path('value');
  const area = `${vPath}L${x(pts.length - 1).toFixed(1)},${H - P.b}L${x(0).toFixed(1)},${H - P.b}Z`;
  const ticks = [1, 2, 3].map((j) => min + ((max - min) * j) / 4);
  const xl = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  const first = pts[0].total, last = pts.at(-1).total;
  const delta = last.pnl - first.pnl;
  el.style.setProperty('--line', delta >= 0 ? 'var(--gain)' : 'var(--loss)');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Portfolio value over time">
    <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--line);stop-opacity:.28"/><stop offset="1" style="stop-color:var(--line);stop-opacity:0"/></linearGradient></defs>
    <g class="grid">${ticks.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`).join('')}</g>
    <g class="axis">${ticks.map((v) => `<text x="${P.l + 2}" y="${(y(v) - 5).toFixed(1)}">${inrC.format(v)}</text>`).join('')}
      ${xl.map((i, n) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][n]}">${fmtShort(pts[i].at)}</text>`).join('')}</g>
    <path class="area" d="${area}" fill="url(#areaGrad)"/>
    <path class="i-line" d="${path('invested')}"/>
    <path class="v-line" d="${vPath}"/>
    <line class="cursor" y1="${P.t}" y2="${H - P.b}" visibility="hidden"/>
    <circle class="cursor-dot" r="5" visibility="hidden"/>
  </svg>`;
  chart = { pts, x, y, P, W, H };
  if (chartAnimate && !reducedMotion()) {
    const line = $('.v-line', el);
    line.style.setProperty('--len', line.getTotalLength());
    line.classList.add('draw');
  }
  chartAnimate = false;
  legend.innerHTML = `<span class="key"><span class="ln"></span>Value</span><span class="key"><span class="ln dash"></span>Invested</span>
    <span class="range-delta ${cls(delta)}">${signed(delta, inr0)} P&amp;L ${state.range ? `in ${$('#rangeSeg .active')?.textContent}` : 'since start'}</span>`;
}

function chartHover(e) {
  if (!chart) return;
  const svg = $('#historyChart svg');
  const tip = $('#chartTip');
  const rect = svg.getBoundingClientRect();
  const { pts, x, y, P, W } = chart;
  const px = ((e.clientX - rect.left) / rect.width) * W;
  const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (pts.length - 1))));
  const p = pts[i], cx = x(i), cy = y(p.total.value);
  const cur = $('.cursor', svg), dot = $('.cursor-dot', svg);
  cur.setAttribute('x1', cx); cur.setAttribute('x2', cx); cur.setAttribute('visibility', 'visible');
  dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
  tip.innerHTML = `<div class="d">${fmtDate(p.at)}</div>
    <div class="r"><span>Value</span><b>${inr0.format(p.total.value)}</b></div>
    <div class="r"><span>Invested</span><b>${inr0.format(p.total.invested)}</b></div>
    <div class="r"><span>P&amp;L</span><b class="${cls(p.total.pnl)}">${signed(p.total.pnl, inr0)}</b></div>`;
  tip.hidden = false;
  const left = rect.left + (cx / W) * rect.width;
  const half = tip.offsetWidth / 2 + 8;
  tip.style.left = `${Math.min(innerWidth - half, Math.max(half, left))}px`;
  tip.style.top = `${Math.max(tip.offsetHeight + 20, rect.top + (cy / chart.H) * rect.height)}px`;
}
function chartLeave() {
  $('#chartTip').hidden = true;
  const svg = $('#historyChart svg');
  if (!svg) return;
  $$('.cursor, .cursor-dot', svg).forEach((n) => n.setAttribute('visibility', 'hidden'));
}
// Mouse: hover to inspect. Touch/pen: tap or drag sideways to inspect; the tip stays until you tap elsewhere or scroll.
const chartEl = $('#historyChart');
chartEl.addEventListener('pointerdown', chartHover);
chartEl.addEventListener('pointermove', chartHover);
chartEl.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') chartLeave(); });
chartEl.addEventListener('pointercancel', chartLeave); // vertical swipe handed over to page scroll
document.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && !e.target.closest('#historyChart')) chartLeave(); }, { passive: true });
window.addEventListener('scroll', () => { if (!$('#chartTip').hidden) chartLeave(); }, { passive: true });
let resizeRaf;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => { if (vault.unlocked && state.data) renderHistory(); });
}).observe($('#historyChart'));
$('#rangeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  state.range = Number(b.dataset.range);
  try { localStorage.setItem('range', state.range); } catch { /* ignore */ }
  chartAnimate = true;
  renderHistory();
});

// ---------- status ----------
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `on ${fmtShort(iso)}`;
}
function renderStatus() {
  const st = $('#status');
  const at = state.data?.refreshedAt;
  st.classList.remove('live', 'stale', 'busy');
  if (state.busy) { st.classList.add('busy'); $('#updated').textContent = 'Fetching live prices…'; return; }
  if (!at) { $('#updated').textContent = 'Prices not fetched yet'; st.title = ''; return; }
  st.classList.add(Date.now() - Date.parse(at) < 5 * 60000 ? 'live' : 'stale');
  $('#updated').textContent = `Live · ${ago(at)}`;
  st.title = `Last updated ${new Date(at).toLocaleString('en-IN')}`;
}

/** Build the view model from the decrypted data. */
function buildView() {
  const d = vault.data;
  return {
    summary: summarize(d.holdings, d.goldSips),
    stocks: d.holdings.filter((h) => h.assetType === 'stock'),
    crypto: d.holdings.filter((h) => h.assetType === 'crypto'),
    goldSips: [...d.goldSips],
    goldPrice: d.meta.goldPrice || null,
    refreshedAt: d.meta.refreshedAt || null,
  };
}

function render() {
  if (!vault.unlocked) return;
  state.data = buildView();
  const d = state.data;
  renderHero(d);
  renderCategories(d.summary);
  renderAlloc(d.summary, d.goldPrice);
  renderTable();
  renderStatus();
  $('#alerts').innerHTML = state.errors.length
    ? `<div class="alert">${icon('alert')}<div><b>Some prices could not be updated.</b> ${esc(state.errors.join('; '))}</div><button class="icon-btn sm x" data-dismiss aria-label="Dismiss">${icon('x')}</button></div>`
    : '';
  renderHistory();
}

/** Persist a change to the encrypted store and redraw. */
async function mutate(fn) {
  fn(vault.data);
  version++;
  await vault.save();
  render();
  fetchHistory();
}

/** Revalue everything with live prices. The server prices the records and returns them; it stores nothing. */
async function load(refresh = false) {
  if (!vault.unlocked) return;
  render();
  const d = vault.data;
  const stale = !d.meta.refreshedAt || Date.now() - Date.parse(d.meta.refreshedAt) > PRICE_STALE_MS;
  if (!d.holdings.length && !d.goldSips.length) {
    if (refresh) toast('Add a holding first — then prices refresh automatically.');
    return;
  }
  if (!refresh && !stale) return;
  if (state.busy) return;
  const btn = $('#refreshBtn');
  btn.disabled = true;
  btn.classList.add('spinning');
  state.busy = true;
  renderStatus();
  const startVersion = version;
  try {
    const r = await api('/portfolio/refresh', { method: 'POST', body: { holdings: d.holdings, goldSips: d.goldSips } });
    if (!vault.unlocked || version !== startVersion) return; // locked or edited meanwhile; the next refresh catches up
    const data = vault.data;
    data.holdings = r.holdings;
    data.goldSips = r.goldSips;
    if (r.goldLive) data.meta.goldPrice = r.goldLive;
    data.meta.refreshedAt = r.refreshedAt;
    data.snapshots = addSnapshot(data.snapshots, summarize(data.holdings, data.goldSips));
    state.errors = r.errors || [];
    await vault.save();
    if (refresh && !state.errors.length) toast('Prices updated', 'success');
  } catch (e) {
    state.errors = [e.message];
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.classList.remove('spinning');
    render();
    fetchHistory();
  }
}

// ---------- forms ----------
const dialog = $('#dialog');
let formCtx = null;

const field = (name, label, attrs = '', hint = '', prefix = '') => `
  <div class="field"><label for="f-${name}">${label}</label>${prefix ? `<div class="prefix-wrap" data-prefix="${prefix}">` : ''}<input id="f-${name}" name="${name}" ${attrs} />${prefix ? '</div>' : ''}${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;

function setPreview(html) {
  $('#preview').innerHTML = html ? `${icon('info')}<span>${html}</span>` : '';
}

function openForm(type, existing = null) {
  formCtx = { type, existing, picked: existing ? { symbol: existing.symbol, coinId: existing.coinId, name: existing.name } : null };
  $('#formError').textContent = '';
  setPreview('');
  const v = (k, d = '') => esc(existing?.[k] ?? d);
  const dv = (k) => (existing?.[k] ? String(existing[k]).slice(0, 10) : '');
  const m = META[type];
  $('#formIcon').style.setProperty('--c', m.color);
  $('#formIcon').innerHTML = icon(m.icon);
  let html = '';
  if (type === 'stock' || type === 'crypto') {
    $('#formTitle').textContent = `${existing ? 'Edit' : 'Add'} ${type === 'stock' ? 'stock' : 'crypto'} purchase`;
    html += existing
      ? `<div class="picked">${avatar(assetInitials(existing, type), m.color)}<div class="grow"><b>${esc(existing.name)}</b><span>${esc(shortSym(existing.symbol))}</span></div></div>`
      : `<div class="field"><label for="f-search">${type === 'stock' ? 'Stock' : 'Coin'}</label>
          <div class="search" style="width:100%;height:42px">${icon('search')}<input id="f-search" placeholder="${type === 'stock' ? 'Search Reliance, TCS, HDFC Bank…' : 'Search Bitcoin, ETH, Solana…'}" required autocomplete="off" role="combobox" aria-expanded="false" aria-controls="suggest" /></div>
          <div class="suggest" id="suggest" role="listbox" hidden></div></div>`;
    html += `<div class="row">${field('quantity', 'Quantity', `type="number" step="any" min="0" required inputmode="decimal" placeholder="0" value="${v('quantity')}"`)}
      ${field('buyDate', 'Bought on', `type="date" max="${today()}" required value="${dv('buyDate') || today()}"`)}</div>
      <div class="row">${field('buyPrice', 'Buy price per unit', `type="number" step="any" min="0" inputmode="decimal" placeholder="Auto: market close" value="${existing?.buyPriceSource === 'manual' ? v('buyPrice') : ''}"`, 'Leave empty to use that day\'s market price', '₹')}
      ${field('fees', 'Charges', `type="number" step="any" min="0" inputmode="decimal" placeholder="0" value="${v('fees', '')}"`, 'Brokerage, taxes — optional', '₹')}</div>
      ${field('notes', 'Notes', `value="${v('notes')}" placeholder="Optional"`)}`;
  } else {
    $('#formTitle').textContent = `${existing ? 'Edit' : 'Add'} gold SIP`;
    html += `<div class="row">${field('name', 'Name', `value="${v('name', 'Gold SIP')}"`)}${field('platform', 'Platform', `value="${v('platform')}" placeholder="e.g. PhonePe, Paytm"`)}</div>
      <div class="row">${field('sipAmount', 'SIP amount', `type="number" step="any" min="1" required inputmode="decimal" value="${v('sipAmount')}"`, '', '₹')}
      <div class="field"><label for="f-frequency">Frequency</label><select id="f-frequency" name="frequency">
        ${['daily', 'weekly', 'monthly', 'quarterly'].map((f) => `<option value="${f}" ${(existing?.frequency || 'monthly') === f ? 'selected' : ''}>${f[0].toUpperCase() + f.slice(1)}</option>`).join('')}</select></div></div>
      <div class="row">${field('gstPercent', 'GST %', `type="number" step="any" min="0" max="100" required value="${v('gstPercent', 3)}"`)}
      ${field('premiumPercent', 'Platform spread %', `type="number" step="any" min="0" max="50" value="${v('premiumPercent', 0)}"`, 'Extra over market rate, if any')}</div>
      <label class="check"><input type="checkbox" name="gstInclusive" ${existing?.gstInclusive === false ? '' : 'checked'} /> SIP amount already includes GST</label>
      <div class="row">${field('startDate', 'First installment', `type="date" max="${today()}" required value="${dv('startDate')}"`)}
      ${field('endDate', 'End date', `type="date" value="${dv('endDate')}"`, 'Leave empty if ongoing')}</div>`;
  }
  $('#formBody').innerHTML = html;
  $('#saveBtn').textContent = existing ? 'Save changes' : 'Add to portfolio';
  bindSearch();
  updatePreview();
  dialog.showModal();
  ($('#f-search') || $('#f-quantity') || $('#f-sipAmount'))?.focus();
}

let searchTimer;
function bindSearch() {
  const { type } = formCtx;
  const search = $('#f-search');
  if (!search) return;
  const box = $('#suggest');
  const hide = () => { box.hidden = true; search.setAttribute('aria-expanded', 'false'); };
  // Keep focus in the input while tapping a suggestion, so the mobile keyboard doesn't
  // collapse and the list doesn't close before the tap lands.
  box.addEventListener('mousedown', (e) => e.preventDefault());
  search.addEventListener('input', () => {
    formCtx.picked = null;
    setPreview('');
    clearTimeout(searchTimer);
    const q = search.value.trim();
    if (q.length < 2) { hide(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const res = await api(`/search/${type === 'stock' ? 'stocks' : 'crypto'}?q=${encodeURIComponent(q)}`);
        if (search.value.trim() !== q) return;
        box.innerHTML = res.length
          ? res.map((r, i) => `<button type="button" role="option" data-i="${i}" class="${i === 0 ? 'hl' : ''}">${avatar(assetInitials(r, type), META[type].color)}<span class="grow">${esc(r.name)}</span><span class="muted">${esc(shortSym(r.symbol))}${r.exchange ? ` · ${esc(r.exchange)}` : ''}</span></button>`).join('')
          : '<div class="none">No matches</div>';
        box.hidden = false;
        search.setAttribute('aria-expanded', 'true');
        box.onclick = (e) => {
          const b = e.target.closest('button[data-i]');
          if (!b) return;
          const r = res[b.dataset.i];
          formCtx.picked = { symbol: r.symbol, coinId: r.id, name: r.name };
          search.value = `${r.name} (${shortSym(r.symbol)})`;
          hide();
          $('#f-quantity')?.focus();
          updatePreview();
        };
      } catch (err) { box.innerHTML = `<div class="none">${esc(err.message)}</div>`; box.hidden = false; }
    }, 250);
  });
  search.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    const btns = $$('button[data-i]', box);
    if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
    if (!btns.length) return;
    let i = btns.findIndex((b) => b.classList.contains('hl'));
    if (e.key === 'ArrowDown') i = (i + 1) % btns.length;
    else if (e.key === 'ArrowUp') i = (i - 1 + btns.length) % btns.length;
    else if (e.key === 'Enter') { e.preventDefault(); (btns[i] || btns[0]).click(); return; } else return;
    e.preventDefault();
    btns.forEach((b, j) => b.classList.toggle('hl', j === i));
    btns[i].scrollIntoView({ block: 'nearest' });
  });
  search.addEventListener('blur', () => setTimeout(hide, 180));
}

$('#formBody').addEventListener('change', () => updatePreview());
$('#formBody').addEventListener('input', (e) => { if (['quantity', 'buyPrice', 'sipAmount', 'fees', 'gstPercent'].includes(e.target.name)) updatePreview(); });

let previewSeq = 0;
async function updatePreview() {
  if (!formCtx) return;
  const { type, picked } = formCtx;
  const f = new FormData($('#form'));
  const seq = ++previewSeq;
  if (type === 'gold') {
    const amt = Number(f.get('sipAmount')), g = Number(f.get('gstPercent'));
    if (!amt) { setPreview(''); return; }
    const incl = f.get('gstInclusive') === 'on';
    const net = incl ? amt / (1 + g / 100) : amt;
    const rate = state.data?.goldPrice?.pricePerGram;
    setPreview(`Each debit <b>${inr.format(incl ? amt : amt * (1 + g / 100))}</b> → <b>${inr.format(net)}</b> buys gold${rate ? ` ≈ <b>${(net / rate).toFixed(4)} g</b> at today's rate` : ''}. Past installments are valued at each day's gold rate.`);
    return;
  }
  if (!picked) { setPreview(''); return; }
  const q = Number(f.get('quantity'));
  const manual = Number(f.get('buyPrice'));
  const fees = Number(f.get('fees') || 0);
  const date = f.get('buyDate');
  if (manual) { setPreview(q ? `You invested <b>${inr.format(manual * q + fees)}</b>` : ''); return; }
  if (!date) return;
  setPreview('Fetching market price…');
  try {
    const path = type === 'stock'
      ? `/quote/stock/${encodeURIComponent(picked.symbol)}?date=${date}`
      : `/quote/crypto/${encodeURIComponent(picked.coinId)}?date=${date}&symbol=${encodeURIComponent(picked.symbol)}`;
    const r = await api(path);
    if (seq !== previewSeq) return;
    const now = q ? r.price * q : null, then = q ? r.onDate.price * q + fees : null;
    setPreview(`Close on ${fmtDate(r.onDate.date)}: <b>${inr.format(r.onDate.price)}</b> · live <b>${inr.format(r.price)}</b>${q ? `<br>Invested <b>${inr.format(then)}</b> → worth <b>${inr.format(now)}</b> <span class="${cls(now - then)}">(${signed(now - then)})</span>` : ''}`);
  } catch (e) { if (seq === previewSeq) setPreview(esc(e.message)); }
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { type, existing, picked } = formCtx;
  const f = Object.fromEntries(new FormData(e.target));
  const save = $('#saveBtn');
  $('#formError').textContent = '';
  const ids = { _id: existing?._id || newId(), createdAt: existing?.createdAt || new Date().toISOString() };
  let path, body;
  if (type === 'gold') {
    body = { ...f, ...ids, gstInclusive: f.gstInclusive === 'on', endDate: f.endDate || null };
    path = '/value/gold-sip';
  } else {
    if (!existing && !picked) { $('#formError').textContent = 'Pick a result from the search list.'; $('#f-search')?.focus(); return; }
    const src = existing || { assetType: type, ...picked };
    body = { ...ids, assetType: src.assetType, symbol: src.symbol, coinId: src.coinId, name: src.name, quantity: f.quantity, buyDate: f.buyDate, fees: f.fees || 0, notes: f.notes };
    if (f.buyPrice) body.buyPrice = f.buyPrice;
    path = '/value/holding';
  }
  const label = save.textContent;
  save.disabled = true; save.textContent = 'Saving…';
  try {
    const record = await api(path, { method: 'POST', body });
    record.updatedAt = new Date().toISOString();
    await mutate((d) => {
      if (type === 'gold') d.goldSips = upsert(d.goldSips, record);
      else d.holdings = upsert(d.holdings, record);
    });
    dialog.close();
    toast(`${existing ? 'Updated' : 'Added'} ${record.name}`, 'success');
  } catch (err) {
    $('#formError').textContent = err.message;
  } finally {
    save.disabled = false; save.textContent = label;
  }
});
$('#cancelBtn').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { formCtx = null; });

// Close buttons and backdrop clicks for all dialogs
document.addEventListener('click', (e) => { const c = e.target.closest('[data-close]'); if (c) c.closest('dialog').close(); });
for (const d of $$('dialog.sheet')) {
  let downOnBackdrop = false;
  d.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === d; });
  d.addEventListener('click', (e) => { if (e.target === d && downOnBackdrop) d.close(); });
}

// ---------- events ----------
function setTab(tab) {
  if (!KEYS.includes(tab)) return;
  state.tab = tab;
  try { localStorage.setItem('tab', state.tab); } catch { /* ignore */ }
  renderTable();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
$('#summaryCards').addEventListener('click', (e) => {
  const c = e.target.closest('[data-cat]');
  if (!c) return;
  setTab(c.dataset.cat);
  $('.holdings').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
});
$('#addBtn').addEventListener('click', () => openForm(state.tab));
$('#refreshBtn').addEventListener('click', () => load(true));
$('#filter').addEventListener('input', (e) => { state.q = e.target.value; renderTable(); });
$('#filter').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; state.q = ''; renderTable(); e.target.blur(); } });
$('#alerts').addEventListener('click', (e) => { if (e.target.closest('[data-dismiss]')) { state.errors = []; $('#alerts').innerHTML = ''; } });

function sortBy(key) {
  const s = state.sort[state.tab];
  state.sort[state.tab] = s.key === key ? { key, dir: -s.dir } : { key, dir: key === 'name' ? 1 : -1 };
  try { localStorage.setItem('sort', JSON.stringify(state.sort)); } catch { /* ignore */ }
  renderTable();
}

$('#tableWrap').addEventListener('keydown', (e) => {
  const h = e.target.closest('th[data-sort]');
  if (h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sortBy(h.dataset.sort); }
});
$('#tableWrap').addEventListener('click', async (e) => {
  const h = e.target.closest('th[data-sort]');
  if (h) { sortBy(h.dataset.sort); return; }
  if (e.target.closest('[data-add]')) { openForm(state.tab); return; }
  if (e.target.closest('[data-clear-filter]')) { $('#filter').value = ''; state.q = ''; renderTable(); return; }
  const edit = e.target.closest('[data-edit]');
  const del = e.target.closest('[data-del]');
  const isGold = state.tab === 'gold';
  const list = state.tab === 'stock' ? state.data.stocks : state.tab === 'crypto' ? state.data.crypto : state.data.goldSips;
  if (edit) openForm(state.tab, list.find((x) => x._id === edit.dataset.edit));
  if (del) {
    const item = list.find((x) => x._id === del.dataset.del);
    if (!item) return;
    if (!(await confirmDialog({ title: `Delete ${item.name}?`, text: 'It will be removed from your portfolio. You can undo right after.' }))) return;
    try {
      await mutate((d) => {
        if (isGold) d.goldSips = d.goldSips.filter((x) => x._id !== item._id);
        else d.holdings = d.holdings.filter((x) => x._id !== item._id);
      });
      toast(`Deleted ${item.name}`, 'success', {
        label: 'Undo',
        fn: () => {
          if (!vault.unlocked) return;
          mutate((d) => { if (isGold) d.goldSips = upsert(d.goldSips, item); else d.holdings = upsert(d.holdings, item); })
            .then(() => toast(`Restored ${item.name}`, 'success'))
            .catch((err) => toast(err.message, 'error'));
        },
      });
    } catch (err) { toast(err.message, 'error'); }
  }
});

$('#tableWrap').addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.matches?.('details.ledger') || !d.open || d.dataset.loaded) return;
  const sip = vault.data.goldSips.find((x) => x._id === d.dataset.ledger);
  if (!sip) return;
  d.dataset.loaded = '1';
  d.querySelector('.scroll').innerHTML = `<table><thead><tr><th>Date</th><th class="num">Paid</th><th class="num">GST</th><th class="num">Rate / g</th><th class="num">Grams</th></tr></thead>
    <tbody>${[...(sip.installments || [])].reverse().map((i) => `<tr><td>${fmtDate(i.date)}</td><td class="num">${inr.format(i.amountPaid)}</td><td class="num">${inr.format(i.gst)}</td><td class="num">${inr.format(i.pricePerGram)}</td><td class="num">${i.grams.toFixed(4)}</td></tr>`).join('')}</tbody></table>`;
}, true);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (!vault.unlocked || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (e.target.closest('input, select, textarea, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (k === '/') { e.preventDefault(); $('#filter').focus(); }
  else if (k === 'n') { e.preventDefault(); openForm(state.tab); }
  else if (k === 'r') { e.preventDefault(); load(true); }
  else if (['1', '2', '3'].includes(k)) setTab(KEYS[Number(k) - 1]);
});

// ---------- lock screen / encrypted vault ----------
let lockMode = 'unlock'; // 'create' | 'unlock' | 'restore'
let restoreText = null;
let lastActivity = Date.now();

function strengthScore(p) {
  if (!p) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  let s = p.length >= 8 ? 1 : 0;
  if (p.length >= 12) s++;
  if (classes >= 3) s++;
  if (p.length >= 16 || (p.length >= 12 && classes === 4)) s++;
  return Math.max(1, Math.min(4, s));
}
$('#lockPass').addEventListener('input', (e) => {
  if (lockMode !== 'create') return;
  const p = e.target.value, sc = strengthScore(p);
  const meter = $('#strength');
  meter.hidden = !p;
  meter.dataset.score = sc;
  $('#strengthLabel').textContent = p.length < 8 ? 'Too short' : ['', 'Weak', 'Fair', 'Good', 'Strong'][sc];
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-reveal]');
  if (!b) return;
  const input = document.getElementById(b.dataset.reveal);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  b.innerHTML = icon(show ? 'eye-off' : 'eye');
  b.setAttribute('aria-label', show ? 'Hide passphrase' : 'Show passphrase');
  input.focus();
});

function showLock(message = '') {
  lockMode = restoreText ? 'restore' : vault.exists() ? 'unlock' : 'create';
  const create = lockMode === 'create';
  $('#appShell').hidden = true;
  $('#lock').hidden = false;
  $('#lockTitle').textContent = lockMode === 'restore' ? 'Restore backup' : create ? 'Welcome to Asset Tracker' : 'Welcome back';
  $('#lockIntro').textContent = lockMode === 'restore'
    ? 'Enter the passphrase that was in use when this backup was made.'
    : create
      ? 'Choose a passphrase. Your portfolio is encrypted with it and stored only in this browser. It cannot be recovered if forgotten, so keep it safe and download backups.'
      : 'Your portfolio is encrypted on this device. Enter your passphrase to open it.';
  $('#lockConfirmWrap').hidden = !create;
  $('#lockConfirm').required = create;
  $('#lockPass').autocomplete = create ? 'new-password' : 'current-password';
  $('#lockPass').type = 'password';
  $('[data-reveal="lockPass"]').innerHTML = icon('eye');
  $('#strength').hidden = true;
  $('#lockSubmit').textContent = lockMode === 'restore' ? 'Restore backup' : create ? 'Create vault' : 'Unlock';
  $('#lockFile').hidden = lockMode !== 'restore';
  $('#cancelRestoreBtn').hidden = lockMode !== 'restore';
  $('#restoreBtn').hidden = lockMode === 'restore';
  $('#resetBtn').hidden = lockMode !== 'unlock';
  $('#lockError').textContent = message;
  $('#lockPass').value = '';
  $('#lockConfirm').value = '';
  $('#lockPass').focus();
}

function enterApp() {
  restoreText = null;
  state.errors = [];
  lastActivity = Date.now();
  shownNet = null;
  chartAnimate = true;
  $('#lock').hidden = true;
  $('#appShell').hidden = false;
  load().then(fetchHistory);
}

function lockApp(message = '') {
  vault.lock();
  state.data = null;
  state.errors = [];
  chart = null;
  for (const d of $$('dialog[open]')) d.close();
  for (const id of ['#summaryCards', '#donut', '#allocLegend', '#historyChart', '#chartLegend', '#tableWrap', '#alerts', '#heroMeta', '#toasts']) $(id).innerHTML = '';
  $('#netWorth').innerHTML = '<span class="skeleton w-200 h-40"></span>';
  $('#goldRate').hidden = true;
  $('#chartTip').hidden = true;
  showLock(message);
}

$('#lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('#lockPass').value;
  const btn = $('#lockSubmit');
  $('#lockError').textContent = '';
  if (!pass) { $('#lockError').textContent = 'Enter your passphrase.'; $('#lockPass').focus(); return; }
  if (lockMode === 'create') {
    if (pass.length < 8) { $('#lockError').textContent = 'Use at least 8 characters.'; return; }
    if (pass !== $('#lockConfirm').value) { $('#lockError').textContent = 'Passphrases do not match.'; return; }
  }
  if (lockMode === 'restore' && vault.exists() && !(await confirmDialog({ title: 'Replace current data?', text: 'Restoring replaces the portfolio currently saved in this browser.', ok: 'Restore' }))) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = lockMode === 'create' ? 'Encrypting…' : 'Decrypting…';
  try {
    if (lockMode === 'create') await vault.create(pass);
    else if (lockMode === 'restore') await vault.importBackup(restoreText, pass);
    else await vault.unlock(pass);
    enterApp();
  } catch (err) {
    $('#lockError').textContent = err.message;
    $('#lockPass').select();
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('#restoreBtn').addEventListener('click', () => $('#restoreFile').click());
$('#restoreFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  restoreText = await file.text();
  showLock();
  $('#lockFile').innerHTML = `${icon('upload')}<span>${esc(file.name)}</span>`;
});
$('#cancelRestoreBtn').addEventListener('click', () => { restoreText = null; showLock(); });
$('#resetBtn').addEventListener('click', async () => {
  if (!(await confirmDialog({ title: 'Erase all data?', text: 'This deletes the encrypted portfolio saved in this browser. It cannot be undone.', ok: 'Continue' }))) return;
  if (!(await confirmDialog({ title: 'Are you absolutely sure?', text: 'Without your passphrase or a backup, the data is gone for good.', ok: 'Erase everything' }))) return;
  vault.reset();
  showLock();
  toast('All data erased. Create a new vault to start again.');
});

$('#lockBtn').addEventListener('click', () => lockApp());

function exportBackup() {
  try {
    const blob = new Blob([vault.exportBackup()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `asset-tracker-backup-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Encrypted backup downloaded', 'success');
  } catch (err) { toast(err.message, 'error'); }
}
$('#exportBtn').addEventListener('click', exportBackup);
$('#footBackup').addEventListener('click', exportBackup);

const passDialog = $('#passDialog');
$('#passBtn').addEventListener('click', () => {
  $('#passForm').reset();
  $('#passError').textContent = '';
  passDialog.showModal();
  $('#pCurrent').focus();
});
$('#passCancel').addEventListener('click', () => passDialog.close());
$('#passForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = $('#pCurrent').value, next = $('#pNew').value;
  if (next !== $('#pConfirm').value) { $('#passError').textContent = 'New passphrases do not match.'; return; }
  const btn = $('#passSave');
  btn.disabled = true;
  try {
    await vault.unlock(cur); // verifies the current passphrase
    await vault.changePassphrase(next);
    passDialog.close();
    toast('Passphrase changed. Download a new backup so it uses the new passphrase.', 'success', { label: 'Backup now', fn: exportBackup });
  } catch (err) {
    $('#passError').textContent = err.message;
  } finally { btn.disabled = false; }
});

// Another tab saved or erased the data: pick it up, or lock if it can no longer be opened.
window.addEventListener('storage', (e) => {
  if (e.key !== VAULT_KEY && e.key !== null) return;
  if (!vault.unlocked) {
    if (!restoreText && lockMode !== (vault.exists() ? 'unlock' : 'create')) showLock();
    return;
  }
  vault.reload().then(() => { version++; render(); }).catch(() => lockApp('Your data was changed in another tab. Unlock again.'));
});

// Auto-lock after inactivity; otherwise keep prices fresh while the tab is visible.
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true });
setInterval(() => {
  if (!vault.unlocked) return;
  if (Date.now() - lastActivity > IDLE_LOCK_MS) { lockApp('Locked after 15 minutes of inactivity.'); return; }
  if (!dialog.open && document.visibilityState === 'visible') load();
}, 60000);
setInterval(() => { if (vault.unlocked) renderStatus(); }, 20000);
// Mobile browsers pause timers in the background: check on return so an idle vault locks straight away.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !vault.unlocked) return;
  if (Date.now() - lastActivity > IDLE_LOCK_MS) lockApp('Locked after 15 minutes of inactivity.');
  else if (!dialog.open) load();
});

if (!globalThis.crypto?.subtle) {
  $('#lock').hidden = false;
  $('#lockForm').innerHTML = '<h1>Encryption unavailable</h1><p class="lock-intro">This browser can only encrypt data on a secure address. Open the app at <b>http://localhost</b> or over HTTPS.</p>';
} else {
  showLock();
}
