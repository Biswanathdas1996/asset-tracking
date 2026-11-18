import { createVault, VAULT_KEY } from './vault.js';
import { summarize, addSnapshot, upsert, newId } from './portfolio.js';

// ---------- formatting helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let privacy = false;
try { privacy = localStorage.getItem('privacy') === '1'; } catch { /* storage unavailable */ }
const MASK = '••••';
function money(options) {
  const fmt = new Intl.NumberFormat('en-IN', options);
  return { format: (n) => (privacy ? '₹••••' : fmt.format(n)) };
}
const inr = money({ style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const inr0 = money({ style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inrC = money({ style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 });
const _qty = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 8 });
const qty = { format: (n) => (privacy ? MASK : _qty.format(n)) };
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const fmtShort = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (n) => (n > 0 ? 'gain' : n < 0 ? 'loss' : '');
const chipCls = (n) => (n > 0 ? 'gain' : n < 0 ? 'loss' : 'flat');
const signed = (n, f = inr) => (n == null ? '—' : `${n > 0 ? '+' : ''}${f.format(n)}`);
const pct = (n) => (n == null ? '—' : privacy ? '••%' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);
const fixed = (n, digits) => (privacy ? MASK : Number(n).toFixed(digits));
const shareLabel = (n) => (privacy ? '••' : Number(n).toFixed(1));
/** Hide rupee amounts and percents inside free text (chat) while privacy is on. */
function redactNumbers(s) {
  if (!privacy || s == null) return s == null ? '' : String(s);
  return String(s)
    .replace(/₹\s*[\d,]+(?:\.\d+)?/g, '₹••••')
    .replace(/\b(?:rs\.?|inr)\s*[\d,]+(?:\.\d+)?/gi, '₹••••')
    .replace(/\b\d[\d,]*(?:\.\d+)?\s*%/g, '••%')
    .replace(/\b\d[\d,]*(?:\.\d+)?\s*(?:lakh|lakhs|crore|crores|cr|k)\b/gi, '••••');
}
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
const SESSION_KEY = 'assetTracker.session.v1';

const vault = createVault();
const DEFAULT_SORT = { stock: { key: 'currentValue', dir: -1 }, crypto: { key: 'currentValue', dir: -1 }, gold: { key: 'currentValue', dir: -1 } };
let state = { tab: 'stock', data: null, errors: [], q: '', range: 90, busy: false, sort: structuredClone(DEFAULT_SORT) };
let version = 0; // bumps on every local change so an in-flight refresh never overwrites newer edits
try {
  state.tab = localStorage.getItem('tab') || 'stock';
  const r = Number(localStorage.getItem('range'));
  if ([0, 1, 7, 30, 90, 180, 365].includes(r) && localStorage.getItem('range') !== null) state.range = r;
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

function applyPrivacy(on) {
  privacy = on;
  if (on) document.documentElement.dataset.privacy = 'on';
  else delete document.documentElement.dataset.privacy;
  const btn = $('#privacyBtn');
  btn.innerHTML = icon(on ? 'eye-off' : 'eye');
  btn.dataset.tip = on ? 'Show numbers (H)' : 'Hide numbers (H)';
  btn.setAttribute('aria-label', on ? 'Show numbers' : 'Hide numbers');
  btn.setAttribute('aria-pressed', String(on));
  try {
    if (on) localStorage.setItem('privacy', '1');
    else localStorage.removeItem('privacy');
  } catch { /* storage unavailable */ }
}
$('#privacyBtn').addEventListener('click', () => {
  applyPrivacy(!privacy);
  if (!vault.unlocked) return;
  render();
  if ($('#dialog').open) updatePreview();
  if (chat.messages.length) renderChat();
});
applyPrivacy(privacy);

// ---------- rendering ----------
const companyLogo = (symbol) => (symbol ? `/api/logo/${encodeURIComponent(symbol)}` : '');
const cryptoLogo = (r) => {
  if (typeof r.image === 'string' && /^https:\/\/(?:coin-images|assets)\.coingecko\.com\//.test(r.image)) return r.image;
  const id = r.coinId || r.id;
  return id && /^[a-z0-9-]{1,80}$/i.test(id) ? `/api/crypto-logo/${encodeURIComponent(id)}` : '';
};
const avatar = (text, color, src = '') => `<span class="avatar${src ? ' has-img' : ''}" style="--c:${color}">${src ? `<img src="${esc(src)}" alt="" decoding="async" referrerpolicy="no-referrer" onload="this.parentElement.classList.add('ready')" onerror="this.parentElement.classList.remove('has-img');this.remove()">` : ''}<span class="av-fb" aria-hidden="true">${esc(text)}</span></span>`;
const assetAvatar = (r, type) => avatar(assetInitials(r, type), META[type].color, type === 'stock' ? companyLogo(r.symbol) : type === 'crypto' ? cryptoLogo(r) : '');
const assetInitials = (r, type) => (type === 'gold' ? 'Au' : shortSym(r.symbol).replace(/[^A-Z0-9]/gi, '').slice(0, type === 'crypto' ? 3 : 2).toUpperCase() || '?');

let shownNet = null;
function setNetWorth(v) {
  const el = $('#netWorth');
  const html = (n) => {
    if (privacy) return '₹••••';
    const [a, b = '00'] = inr.format(n).split('.');
    return `${a}<span class="paise">.${b}</span>`;
  };
  const from = shownNet;
  shownNet = v;
  if (privacy || from == null || from === v || reducedMotion()) { el.innerHTML = html(v); return; }
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

function holdingCount(k, n) {
  return k === 'gold' ? `${n} SIP${n === 1 ? '' : 's'}` : `${n} holding${n === 1 ? '' : 's'}`;
}

function renderAlloc(s, goldPrice) {
  const total = s.total.value || 0;
  const share = (k) => (total ? (s[k].value / total) * 100 : 0);
  const r = 60, C = 2 * Math.PI * r;
  const keys = KEYS.filter((k) => s[k].value > 0);
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
    const on = state.tab === k;
    const classes = [on ? 'active' : '', b.value ? '' : 'none'].filter(Boolean).join(' ');
    const meta = [holdingCount(k, b.count), b.invested ? `Invested ${inrC.format(b.invested)}` : ''].filter(Boolean).join(' · ');
    return `<li data-k="${k}" style="--c:${m.color}" role="button" tabindex="0" aria-pressed="${on}"${classes ? ` class="${classes}"` : ''}>
      <span class="al-ic">${icon(m.icon)}</span>
      <span class="al-main">
        <span class="al-row"><span class="nm">${m.label}</span><span class="pc">${shareLabel(sh)}<small>%</small></span></span>
        <span class="al-row al-sub"><span class="vl">${inr0.format(b.value)}</span>${b.invested ? `<span class="mini-chip ${chipCls(b.pnl)}">${signed(b.pnl, inrC)} · ${pct(b.pnlPercent)}</span>` : ''}</span>
        <span class="al-meta">${meta}</span>
      </span>
    </li>`;
  }).join('');
  for (const k of KEYS) { const c = $(`[data-count="${k}"]`); if (c) c.textContent = s[k].count; }
  const gr = $('#goldRate');
  gr.hidden = !goldPrice;
  if (goldPrice) gr.innerHTML = `<span class="sw" style="width:8px;height:8px;border-radius:50%;background:var(--gold)"></span>24K ${inr0.format(goldPrice.pricePerGram)}/g`;
  allocData = { s, total };
  paintAlloc(null);
}

let allocData = null;
/** Hover previews one slice in the donut and the phone summary. The headline stays the portfolio total. */
function paintAlloc(hoverK) {
  if (!allocData) return;
  const { s, total } = allocData;
  const k = hoverK && s[hoverK]?.value ? hoverK : null;
  const card = $('.alloc-card');
  card.classList.toggle('focusing', !!k);
  $$('[data-k]', card).forEach((n) => n.classList.toggle('hot', !!k && n.dataset.k === k));
  const b = k ? s[k] : s.total;
  const label = k ? META[k].label : total ? 'Total value' : 'No assets yet';
  const hint = k && total ? `${shareLabel((b.value / total) * 100)}% of portfolio` : '';
  $('#donutCenter').innerHTML = `<span>${label}</span><b>${total ? inrC.format(b.value) : '₹0'}</b>${hint ? `<em>${hint}</em>` : ''}`;
  $('#allocSummary').innerHTML = `<div><span class="lbl">${label}</span><b>${inr0.format(b.value)}</b></div>
    ${total ? `<span class="mini-chip ${chipCls(b.pnl)}">${signed(b.pnl, inrC)} · ${pct(b.pnlPercent)}</span>` : ''}
    ${hint ? `<span class="alloc-hint">${hint}</span>` : ''}`;
}

// Allocation interactions: hover previews, tap/click/Enter pins a category
const allocCard = $('.alloc-card');
allocCard.addEventListener('mouseover', (e) => {
  if (!matchMedia('(hover: hover)').matches) return;
  paintAlloc(e.target.closest('[data-k]')?.dataset.k || null);
});
allocCard.addEventListener('mouseleave', () => paintAlloc(null));
const pickAlloc = (e) => {
  const n = e.target.closest('[data-k]');
  if (!n || n.classList.contains('none')) return;
  setTab(n.dataset.k);
  if (n.tagName === 'LI') $('.holdings').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
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
      <tr${type === 'stock' ? ' class="has-ledger"' : ''}>
        <td class="lead"><div class="asset">${assetAvatar(r, type)}<div>
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
      </tr>${type === 'stock' ? `<tr class="ledger-row shp-row"><td colspan="9">${shpLine(r.symbol)}</td></tr>` : ''}`).join('')}</tbody>
    <tfoot><tr><td>Total · ${rows.length}</td><td></td><td></td><td class="num hide-sm">${inr.format(tot.inv)}</td><td></td><td></td>
      <td class="num" data-label="Value">${inr.format(tot.val)}</td><td class="num ${cls(tpnl)}" data-label="P&amp;L">${signed(tpnl)}</td><td></td></tr></tfoot>
  </table>`;
}

// ---------- Promoter / FII / DII / retail holding trend (quarterly shareholding pattern) ----------
const shp = { data: {}, pending: new Set() };
function shpCard(label, t) {
  if (!t) return '';
  const ch = t.change;
  const tone = ch == null || ch === 0 ? 'flat' : ch > 0 ? 'gain' : 'loss';
  const width = Math.max(0, Math.min(100, t.pct));
  const flow = ch == null ? '' : ch === 0
    ? '<span class="shp-flow flat">Unchanged</span>'
    : `<span class="shp-flow ${tone}">${ch > 0 ? '▲' : '▼'} ${privacy ? '••' : Math.abs(ch).toFixed(2)}%<span class="shp-dir">${ch > 0 ? 'inflow' : 'outflow'}</span></span>`;
  return `<div class="shp-card ${tone}">
    <span class="shp-k">${label}</span>
    <span class="shp-pct">${privacy ? '••' : t.pct.toFixed(2)}<span class="shp-unit">%</span></span>
    ${flow}
    <span class="shp-bar" aria-hidden="true"><span style="width:${width.toFixed(2)}%"></span></span>
  </div>`;
}
function shpWhen(period) {
  if (!period) return '';
  const [from, to] = period.split(' → ');
  if (!to) return `<span class="shp-when">${esc(period)}</span>`;
  return `<span class="shp-when">${esc(from)}<span class="shp-to" aria-hidden="true">→</span>${esc(to)}</span>`;
}
function shpLine(symbol) {
  if (!(symbol in shp.data)) {
    if (!shp.pending.has(symbol)) return '<div class="shp"></div>';
    return `<div class="shp is-loading" aria-busy="true">${'<span class="shp-skel"></span>'.repeat(4)}</div>`;
  }
  const d = shp.data[symbol];
  const t = d && (d.promoter || d.fii || d.dii || d.retail);
  if (!t) return '<div class="shp is-empty">Shareholding data not available</div>';
  const period = t.prevQuarter ? `${t.prevQuarter} → ${t.quarter}` : (t.quarter || '');
  return `<div class="shp" title="Share of the company held by promoters, foreign (FII) and domestic (DII) institutions, and retail (public) investors, with the change over the last quarter. Source: Screener.in">
    ${shpCard('Promoter', d.promoter)}${shpCard('FII', d.fii)}${shpCard('DII', d.dii)}${shpCard('Retail', d.retail)}${shpWhen(period)}</div>`;
}
async function loadShareholding() {
  const want = [...new Set((state.data?.stocks || []).map((h) => h.symbol))].filter((s) => s && !(s in shp.data) && !shp.pending.has(s));
  if (!want.length) return;
  want.forEach((s) => shp.pending.add(s));
  if (state.tab === 'stock') renderTable();
  try {
    for (let i = 0; i < want.length; i += 60) {
      const part = want.slice(i, i + 60);
      Object.assign(shp.data, await api(`/shareholding?symbols=${encodeURIComponent(part.join(','))}`));
    }
  } catch { /* leave missing: retried on the next render */ }
  want.forEach((s) => shp.pending.delete(s));
  if (state.tab === 'stock') renderTable();
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
        <td class="num" data-label="Gold held">${fixed(s.totalGrams || 0, 4)} g<div class="sub">avg ${inr.format(s.avgCostPerGram || 0)}/g</div></td>
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
/**
 * Chart points by day, ending with today's live total. The history rebuilt from each asset's own
 * daily prices is the source of truth; recorded snapshots only stand in when it isn't available,
 * since they miss holdings added later with an earlier buy date.
 */
function chartSeries() {
  const d = vault.data;
  const byDay = new Map();
  const history = d.meta.history?.points || [];
  if (history.length) for (const p of history) byDay.set(p.date, { invested: p.invested, value: p.value, pnl: p.value - p.invested });
  else for (const s of d.snapshots) byDay.set(s.at.slice(0, 10), s.total);
  if (state.data && (d.holdings.length || d.goldSips.length)) byDay.set(today(), state.data.summary.total);
  return [...byDay].sort((a, b) => a[0].localeCompare(b[0])).map(([at, total]) => ({ at, total }));
}

const HISTORY_VERSION = 3; // bump when the server's history source changes, to drop cached points
const HISTORY_RETRY_MS = 15 * 60000; // re-fetch a partial history (some prices missing) after this long
const historyKey = (d) => `v${HISTORY_VERSION}|${today()}|${JSON.stringify([
  d.holdings.map((h) => [h._id, h.assetType, h.symbol, h.coinId, h.quantity, h.buyDate, h.buyPrice, h.investedValue]),
  d.goldSips.map((s) => [s._id, s.installmentCount, s.totalInvested, s.totalGrams]),
])}`;

/** Backfill the chart from historical prices once per day, or when holdings change. Cached in the vault. */
async function fetchHistory() {
  if (!vault.unlocked || state.historyLoading) return;
  const d = vault.data;
  if (!d.holdings.length && !d.goldSips.length) { if (d.meta.history) { delete d.meta.history; await vault.save(); renderHistory(); } return; }
  const key = historyKey(d);
  const cached = d.meta.history;
  if (cached?.key === key && (!cached.errors?.length || Date.now() - (cached.at || 0) < HISTORY_RETRY_MS)) return;
  state.historyLoading = true;
  renderHistory();
  const startVersion = version;
  try {
    const r = await api('/portfolio/history', {
      method: 'POST',
      body: {
        holdings: d.holdings.map(({ assetType, symbol, coinId, quantity, buyDate, buyPrice, investedValue, name }) => ({ assetType, symbol, coinId, quantity, buyDate, buyPrice, investedValue, name })),
        goldSips: d.goldSips.map(({ installments }) => ({ installments })),
      },
    });
    if (!vault.unlocked || version !== startVersion) return;
    vault.data.meta.history = { key, points: r.points, errors: r.errors || [], at: Date.now() };
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
    <g class="axis">${privacy ? '' : ticks.map((v) => `<text x="${P.l + 2}" y="${(y(v) - 5).toFixed(1)}">${inrC.format(v)}</text>`).join('')}
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
    ${vault.data.meta.history?.errors?.length ? `<span class="key partial" title="${esc(vault.data.meta.history.errors.join('\n'))}">${icon('alert')}Some past prices missing</span>` : ''}
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
  renderAlloc(d.summary, d.goldPrice);
  renderTable();
  renderStatus();
  $('#alerts').innerHTML = state.errors.length
    ? `<div class="alert">${icon('alert')}<div><b>Some prices could not be updated.</b> ${esc(state.errors.join('; '))}</div><button class="icon-btn sm x" data-dismiss aria-label="Dismiss">${icon('x')}</button></div>`
    : '';
  renderHistory();
  renderNews();
  loadShareholding();
}

/** Persist a change to the encrypted store and redraw. */
async function mutate(fn) {
  fn(vault.data);
  version++;
  await vault.save();
  render();
  fetchHistory();
  fetchNews();
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

// ---------- news & signals ----------
// The server's news agent scans headlines for each holding and flags stories that could move the price.
// Only names and symbols are sent (no quantities or amounts). The latest brief is kept in the encrypted vault.
const NEWS_REFRESH_MS = 15 * 60000;
const NEWS_PAGE = 12;
const news = { view: 'flagged', filter: 'all', loading: false, error: null, limit: NEWS_PAGE };
try { if (localStorage.getItem('newsView') === 'all') news.view = 'all'; } catch { /* ignore */ }
const IMPACT = {
  bullish: { label: 'Bullish', icon: 'arrow-up', cls: 'gain' },
  bearish: { label: 'Bearish', icon: 'arrow-down', cls: 'loss' },
  mixed: { label: 'Watch', icon: 'alert', cls: 'warn' },
};

/** One entry per distinct asset (several lots of the same stock count once), largest position first. */
function newsHoldings() {
  const d = vault.data;
  const byKey = new Map();
  for (const h of d.holdings) {
    const key = h.assetType === 'crypto' ? (h.coinId || h.symbol) : h.symbol;
    const e = byKey.get(key) || { key, assetType: h.assetType, symbol: h.symbol, coinId: h.coinId, name: h.name, dayChangePercent: h.dayChangePercent ?? null, value: 0 };
    e.value += h.currentValue ?? h.investedValue ?? 0;
    byKey.set(key, e);
  }
  const list = [...byKey.values()].sort((a, b) => b.value - a.value);
  if (d.goldSips.length) list.push({ key: 'gold', assetType: 'gold', symbol: 'GOLD', name: 'Gold', dayChangePercent: null });
  return list.map(({ value, ...h }) => h);
}
const newsSig = (list) => list.map((h) => h.key).join('|');

async function fetchNews(force = false) {
  if (!vault.unlocked || news.loading) return;
  const list = newsHoldings();
  const meta = vault.data.meta;
  if (!list.length) {
    if (meta.news) { delete meta.news; await vault.save(); }
    renderNews();
    return;
  }
  const sig = newsSig(list);
  const cached = meta.news;
  if (!force && cached?.sig === sig && Date.now() - Date.parse(cached.generatedAt) < NEWS_REFRESH_MS) return;
  news.loading = true;
  news.error = null;
  renderNews();
  const btn = $('#newsRefresh');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    const r = await api('/news/brief', { method: 'POST', body: { holdings: list } });
    if (!vault.unlocked) return;
    const seen = new Set(meta.newsSeen || []);
    const firstScan = !meta.newsSeen;
    const flagged = r.items.filter((i) => i.flagged);
    const fresh = flagged.filter((i) => !seen.has(i.id));
    for (const i of flagged) seen.add(i.id);
    meta.newsSeen = [...seen].slice(-600);
    meta.news = { sig, ...r, newIds: firstScan ? [] : fresh.map((i) => i.id) };
    await vault.save();
    const hot = firstScan ? [] : fresh.filter((i) => i.severity === 'high');
    if (hot.length) {
      toast(hot.length === 1 ? `High-impact story: ${hot[0].title}` : `${hot.length} new high-impact stories for your holdings`, 'info', {
        label: 'View', fn: () => { news.view = 'flagged'; news.filter = 'all'; renderNews(); $('#news').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); },
      });
    } else if (force) toast(`News rescanned · ${flagged.length} flagged`, 'success');
  } catch (e) {
    news.error = e.message;
  } finally {
    news.loading = false;
    btn.disabled = false;
    btn.classList.remove('spinning');
    if (vault.unlocked) renderNews();
  }
}

function newsLabels() {
  const map = new Map(newsHoldings().map((h) => [h.key, {
    label: h.assetType === 'gold' ? 'Gold' : shortSym(h.symbol) || h.name,
    name: h.name,
    avatar: assetAvatar(h, h.assetType),
  }]));
  map.set('market', { label: 'Market', name: 'Market-wide', avatar: `<span class="avatar" style="--c:var(--accent)">${icon('stock')}</span>` });
  return map;
}

function newsItem(i, labels, isNew) {
  const h = labels.get(i.holding) || labels.get('market');
  const imp = i.flagged ? IMPACT[i.impact] || IMPACT.mixed : null;
  const when = i.publishedAt ? ago(i.publishedAt) : '';
  return `<article class="news-item ${i.flagged ? `flagged sev-${esc(i.severity)} imp-${esc(i.impact)}` : ''}">
    ${h.avatar}
    <div class="news-body">
      <div class="news-meta"><b>${esc(h.label)}</b><span class="sep"></span><span>${esc(i.source)}</span>${when ? `<span class="sep"></span><time datetime="${esc(i.publishedAt)}">${when}</time>` : ''}${isNew ? '<span class="badge new">New</span>' : ''}</div>
      <a class="news-headline" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}${icon('external', 'ext')}</a>
      ${i.why ? `<p class="news-why">${esc(i.why)}</p>` : ''}
      ${imp ? `<div class="news-tags">
        <span class="mini-chip ${imp.cls}">${icon(imp.icon)}${imp.label}</span>
        <span class="sev sev-${esc(i.severity)}" title="Likely price impact">${esc(i.severity)} impact</span>
        ${(i.kpis || []).map((k) => `<span class="kpi">${esc(k)}</span>`).join('')}</div>` : ''}
    </div>
  </article>`;
}

function renderNews() {
  const el = $('#news');
  if (!vault.unlocked) return;
  const n = vault.data.meta.news;
  const labels = newsLabels();
  const has = vault.data.holdings.length || vault.data.goldSips.length;
  $$('#newsSeg button').forEach((b) => b.classList.toggle('active', b.dataset.view === news.view));

  // Status line + engine badge
  const st = $('#newsStatus');
  let detail = '';
  if (news.loading) st.textContent = n ? 'Rescanning…' : 'Scanning…';
  else if (news.error) st.innerHTML = `<span class="loss">${esc(news.error)}</span>`;
  else if (n) {
    st.textContent = `${n.items.length} · ${ago(n.generatedAt)}`;
    detail = `${n.items.length} headlines · updated ${ago(n.generatedAt)} · rescans every 15 min`;
  } else st.textContent = has ? 'Not scanned yet' : 'Watches price-moving stories';
  st.title = [detail, ...(n?.errors || [])].filter(Boolean).join('\n');
  const eng = $('#newsEngine');
  eng.hidden = !n;
  if (n) {
    eng.innerHTML = n.ai
      ? `${icon('sparkles')}<span>AI</span><span class="eng-model">${esc(n.ai.model)}</span>`
      : `${icon('search')}<span>Keywords</span>`;
    eng.title = n.ai ? `Stories analysed by ${n.ai.model}` : 'Set OLLAMA_API_KEY on the server to have an AI agent analyse the news';
    eng.classList.toggle('ai', !!n.ai);
  }

  if (!has) {
    $('#newsSummary').hidden = true;
    $('#newsFilter').innerHTML = '';
    $('#newsFlagCount').textContent = '';
    $('#newsList').innerHTML = `<div class="empty-state small"><span class="big-ic">${icon('news')}</span><h3>No news yet</h3><p>Add a holding and the agent will watch the news for stories that could move its price.</p></div>`;
    return;
  }
  if (!n) {
    $('#newsSummary').hidden = true;
    $('#newsFilter').innerHTML = '';
    $('#newsList').innerHTML = news.loading
      ? Array.from({ length: 3 }, () => '<div class="news-item"><span class="skeleton" style="width:36px;height:36px;border-radius:10px"></span><div class="news-body"><span class="skeleton w-160"></span><span class="skeleton" style="width:90%"></span><span class="skeleton" style="width:60%"></span></div></div>').join('')
      : `<div class="empty-state small"><span class="big-ic">${icon('news')}</span><h3>News unavailable</h3><p>${esc(news.error || 'Headlines could not be fetched.')}</p><button class="btn subtle" data-news-retry>${icon('refresh')}Try again</button></div>`;
    return;
  }

  const flagged = n.items.filter((i) => i.flagged);
  $('#newsFlagCount').textContent = flagged.length || '';
  const sentiment = new Map((n.holdings || []).map((h) => [h.holding, h]));

  // Summary + per-holding sentiment
  const sum = $('#newsSummary');
  const high = flagged.filter((i) => i.severity === 'high').length;
  sum.hidden = !n.summary && !high;
  const paras = String(n.summary || '').split(/\n+/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`).join('');
  sum.innerHTML = `${icon(n.ai ? 'sparkles' : 'flag')}<div>${paras}${high ? `<p class="hi">${icon('alert')}${high} high-impact ${high === 1 ? 'story' : 'stories'} flagged</p>` : ''}</div>`;

  // Holding filter chips (only holdings that have stories)
  const pool = news.view === 'flagged' ? flagged : n.items;
  const counts = new Map();
  for (const i of pool) counts.set(i.holding, (counts.get(i.holding) || 0) + 1);
  if (news.filter !== 'all' && !counts.has(news.filter)) news.filter = 'all';
  const order = [...labels.keys()].filter((k) => counts.has(k) || sentiment.has(k));
  const chip = (key, label, count, { dot = '', title = '' } = {}) => {
    const on = news.filter === key;
    const quiet = key !== 'all' && !count ? ' quiet' : '';
    return `<button type="button" class="nf${on ? ' active' : ''}${quiet}" data-nf="${esc(key)}" aria-pressed="${on}"${title ? ` title="${esc(title)}"` : ''}>${dot}<span class="nf-name">${esc(label)}</span><span class="nf-n">${count}</span></button>`;
  };
  $('#newsFilter').innerHTML = [chip('all', 'All', pool.length),
    ...order.map((k) => {
      const s = sentiment.get(k);
      return chip(k, labels.get(k).label, counts.get(k) || 0, {
        dot: s ? `<i class="dot ${esc(s.sentiment)}" aria-hidden="true"></i>` : '',
        title: s?.note ? `${s.sentiment}: ${s.note}` : '',
      });
    })].join('');
  placeNewsFilter();

  const shown = pool.filter((i) => news.filter === 'all' || i.holding === news.filter);
  const fresh = new Set(n.newIds || []);
  const note = news.filter !== 'all' ? sentiment.get(news.filter) : null;
  $('#newsList').innerHTML = (note?.note ? `<p class="news-note"><i class="dot ${note.sentiment}"></i><b>${esc(labels.get(news.filter)?.name)}</b> · ${esc(note.note)}</p>` : '')
    + (shown.length
      ? shown.slice(0, news.limit).map((i) => newsItem(i, labels, fresh.has(i.id))).join('')
        + (shown.length > news.limit ? `<button class="btn subtle block news-more" data-news-more>Show ${Math.min(NEWS_PAGE, shown.length - news.limit)} more</button>` : '')
      : `<div class="empty-state small"><span class="big-ic" style="--c:var(--gain)">${icon('check')}</span><h3>Nothing flagged right now</h3><p>No story in the last few days looks likely to move ${news.filter === 'all' ? 'your holdings' : esc(labels.get(news.filter)?.label)}.</p>${news.view === 'flagged' ? '<button class="btn subtle" data-news-view="all">Show all headlines</button>' : ''}</div>`);
}

function syncNewsFilterEdges() {
  const bar = $('#newsFilter');
  if (!bar) return;
  const max = bar.scrollWidth - bar.clientWidth;
  bar.classList.toggle('can-left', bar.scrollLeft > 6);
  bar.classList.toggle('can-right', max - bar.scrollLeft > 6);
}

function placeNewsFilter() {
  const bar = $('#newsFilter');
  const active = bar?.querySelector('.nf.active');
  if (bar && active && news.filter !== 'all') {
    const left = active.offsetLeft - (bar.clientWidth - active.offsetWidth) / 2;
    bar.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
  }
  syncNewsFilterEdges();
}

$('#newsFilter').addEventListener('scroll', syncNewsFilterEdges, { passive: true });
addEventListener('resize', syncNewsFilterEdges);

$('#newsSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  news.view = b.dataset.view;
  news.limit = NEWS_PAGE;
  try { localStorage.setItem('newsView', news.view); } catch { /* ignore */ }
  renderNews();
});
$('#news').addEventListener('click', (e) => {
  const f = e.target.closest('[data-nf]');
  if (f) { news.filter = f.dataset.nf; news.limit = NEWS_PAGE; renderNews(); return; }
  if (e.target.closest('[data-news-more]')) { news.limit += NEWS_PAGE; renderNews(); return; }
  const v = e.target.closest('[data-news-view]');
  if (v) { news.view = v.dataset.newsView; news.limit = NEWS_PAGE; renderNews(); return; }
  if (e.target.closest('[data-news-retry]')) fetchNews(true);
});
$('#newsRefresh').addEventListener('click', () => fetchNews(true));

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
      ? `<div class="picked">${assetAvatar(existing, type)}<div class="grow"><b>${esc(existing.name)}</b><span>${esc(shortSym(existing.symbol))}</span></div></div>`
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
          ? res.map((r, i) => `<button type="button" role="option" data-i="${i}" class="${i === 0 ? 'hl' : ''}">${assetAvatar(r, type)}<span class="grow">${esc(r.name)}</span><span class="muted">${esc(shortSym(r.symbol))}${r.exchange ? ` · ${esc(r.exchange)}` : ''}</span></button>`).join('')
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
    setPreview(`Each debit <b>${inr.format(incl ? amt : amt * (1 + g / 100))}</b> → <b>${inr.format(net)}</b> buys gold${rate ? ` ≈ <b>${fixed(net / rate, 4)} g</b> at today's rate` : ''}. Past installments are valued at each day's gold rate.`);
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
  $$('.alloc-list li').forEach((n) => {
    const on = n.dataset.k === tab;
    n.classList.toggle('active', on);
    n.setAttribute('aria-pressed', String(on));
  });
  renderTable();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
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
    <tbody>${[...(sip.installments || [])].reverse().map((i) => `<tr><td>${fmtDate(i.date)}</td><td class="num">${inr.format(i.amountPaid)}</td><td class="num">${inr.format(i.gst)}</td><td class="num">${inr.format(i.pricePerGram)}</td><td class="num">${fixed(i.grams, 4)}</td></tr>`).join('')}</tbody></table>`;
}, true);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (!vault.unlocked || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (e.target.closest('input, select, textarea, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (k === '/') { e.preventDefault(); $('#filter').focus(); }
  else if (k === 'n') { e.preventDefault(); openForm(state.tab); }
  else if (k === 'r') { e.preventDefault(); load(true); }
  else if (k === 'h') { e.preventDefault(); $('#privacyBtn').click(); }
  else if (['1', '2', '3'].includes(k)) setTab(KEYS[Number(k) - 1]);
});

// ---------- lock screen / encrypted vault ----------
let lockMode = 'unlock'; // 'create' | 'unlock' | 'restore'
let restoreText = null;

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ }
}
async function persistSession() {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(await vault.exportSession())); } catch { /* storage unavailable */ }
}

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
  shownNet = null;
  chartAnimate = true;
  $('#lock').hidden = true;
  $('#appShell').hidden = false;
  load().then(() => { fetchHistory(); fetchNews(); });
}

function lockApp(message = '') {
  clearSession();
  vault.lock();
  state.data = null;
  state.errors = [];
  chart = null;
  for (const d of $$('dialog[open]')) d.close();
  resetChat();
  if (chat.open) setChatOpen(false);
  for (const id of ['#donut', '#allocLegend', '#historyChart', '#chartLegend', '#tableWrap', '#alerts', '#heroMeta', '#toasts', '#newsList', '#newsFilter', '#newsSummary']) $(id).innerHTML = '';
  Object.assign(news, { filter: 'all', error: null, limit: NEWS_PAGE });
  $('#newsEngine').hidden = true;
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
    await persistSession();
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
  clearSession();
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
    await persistSession();
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

// Keep prices fresh while the tab is visible. The vault stays open across refresh until Lock is clicked.
setInterval(() => {
  if (!vault.unlocked || dialog.open || document.visibilityState !== 'visible') return;
  load().then(() => fetchNews());
}, 60000);
setInterval(() => { if (vault.unlocked) renderStatus(); }, 20000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !vault.unlocked || dialog.open) return;
  load().then(() => fetchNews());
});

async function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { saved = null; }
  if (saved && vault.exists()) {
    try {
      await vault.resume(saved);
      enterApp();
      return;
    } catch { clearSession(); }
  }
  showLock();
}

if (!globalThis.crypto?.subtle) {
  $('#lock').hidden = false;
  $('#lockForm').innerHTML = '<h1>Encryption unavailable</h1><p class="lock-intro">This browser can only encrypt data on a secure address. Open the app at <b>http://localhost</b> or over HTTPS.</p>';
} else {
  restoreSession();
}

// ---------- AI chat assistant ----------
// The server runs an agent with web search, page reading, live news and live prices, and streams
// its steps and answer back as NDJSON. Only holding names/symbols are shared, never amounts.
// The conversation lives in memory only and is wiped on lock.
const chat = { messages: [], busy: false, ctrl: null, open: false };
const CHAT_SUGGESTIONS = [
  'What is moving Nifty and Sensex today?',
  'Any important news on my holdings this week?',
  'Gold price in India today and the outlook',
  'Summarise the latest RBI policy decision',
];
const STEP_ICON = { web_search: 'globe', news_search: 'news', fetch_url: 'file', get_quote: 'stock' };

const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/** Small, safe markdown renderer: input is escaped first, then a few constructs are re-enabled. */
function mdInline(s) {
  const codes = [];
  return esc(s)
    .replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, p, u) => `${p}<a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(u.replace(/&amp;/g, '&')))}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/;
function md(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if (isTableRow(l) && /^[\s|:-]+$/.test(lines[i + 1] || '') && (lines[i + 1] || '').includes('-')) {
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^#{1,6}\s/.test(l)) {
      const n = Math.min(4, l.match(/^#+/)[0].length + 2);
      out.push(`<h${n}>${mdInline(l.replace(/^#+\s*/, ''))}</h${n}>`);
      i++;
    } else if (LIST_RE.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        let item = lines[i++].replace(LIST_RE, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_RE.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(`<li>${mdInline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
    } else if (/^\s*>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${mdInline(buf.join(' '))}</blockquote>`);
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {
      out.push('<hr>');
      i++;
    } else if (!l.trim()) {
      i++;
    } else {
      const buf = [l];
      i++;
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>)/.test(lines[i]) && !LIST_RE.test(lines[i]) && !isTableRow(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${buf.map(mdInline).join('<br>')}</p>`);
    }
  }
  return out.join('');
}

function chatStep(s) {
  return `<li class="chat-step ${esc(s.status)}"><span class="${s.status === 'running' ? 'spinning' : ''}">${icon(s.status === 'error' ? 'alert' : STEP_ICON[s.tool] || 'sparkles')}</span><span class="lbl">${esc(s.label)}</span>${s.detail ? `<span class="det">${esc(redactNumbers(s.detail))}</span>` : ''}</li>`;
}
function chatSources(list) {
  if (!list?.length) return '';
  return `<details class="chat-sources"><summary>${icon('globe')}${list.length} source${list.length === 1 ? '' : 's'}${icon('chevron', 'chev')}</summary><ol>${list.map((s) => `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer"><span class="t">${esc(s.title || hostOf(s.url))}</span><span class="h">${esc(s.source || hostOf(s.url))}${s.publishedAt ? ` · ${esc(ago(s.publishedAt))}` : ''}</span></a></li>`).join('')}</ol></details>`;
}
function chatBubble(m, idx) {
  if (m.role === 'user') return `<div class="chat-msg user"><div class="bubble">${esc(redactNumbers(m.content))}</div></div>`;
  const working = m.pending && !m.content;
  return `<div class="chat-msg bot" data-idx="${idx}">
    ${m.steps?.length ? `<ul class="chat-steps">${m.steps.map(chatStep).join('')}</ul>` : ''}
    ${working && !m.steps?.some((s) => s.status === 'running') ? '<div class="chat-typing" aria-label="Thinking"><span></span><span></span><span></span></div>' : ''}
    ${m.content ? `<div class="md">${md(redactNumbers(m.content))}${m.pending ? '<span class="caret"></span>' : ''}</div>` : ''}
    ${m.error ? `<p class="chat-error">${icon('alert')}<span>${esc(m.error)}</span>${m.retry ? '<button class="link" data-retry>Try again</button>' : ''}</p>` : ''}
    ${!m.pending && m.content ? `<div class="chat-actions">${chatSources(m.sources)}<button class="icon-btn sm" data-copy="${idx}" aria-label="Copy answer">${icon('copy')}</button></div>` : ''}
  </div>`;
}
function renderChat() {
  const log = $('#chatLog');
  if (!chat.messages.length) {
    log.innerHTML = `<div class="chat-empty">
      <span class="big-ic">${icon('sparkles')}</span>
      <h3>Ask me anything</h3>
      <p>I search the web, read pages, check live news and pull live prices, then answer with sources.</p>
      <div class="chat-suggest">${CHAT_SUGGESTIONS.map((s) => `<button type="button" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    </div>`;
  } else {
    log.innerHTML = chat.messages.map(chatBubble).join('');
  }
  const send = $('#chatSend');
  send.innerHTML = icon(chat.busy ? 'stop' : 'send');
  send.setAttribute('aria-label', chat.busy ? 'Stop' : 'Send');
  send.classList.toggle('stop', chat.busy);
  $('#chatClear').disabled = !chat.messages.length;
}
let chatFrame = 0;
function paintLast() {
  if (chatFrame) return;
  chatFrame = requestAnimationFrame(() => {
    chatFrame = 0;
    const log = $('#chatLog');
    const idx = chat.messages.length - 1;
    const el = log.querySelector(`.chat-msg.bot[data-idx="${idx}"]`);
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (el && chat.messages[idx]) el.outerHTML = chatBubble(chat.messages[idx], idx);
    else renderChat();
    if (stick) log.scrollTop = log.scrollHeight;
  });
}

function setChatOpen(open) {
  chat.open = open;
  $('#chat').hidden = !open;
  $('#chatFab').hidden = open;
  $('#chatFab').setAttribute('aria-expanded', String(open));
  document.documentElement.classList.toggle('chat-open', open);
  if (!open) { if (vault.unlocked) $('#chatFab').focus(); return; }
  renderChat();
  const log = $('#chatLog');
  log.scrollTop = log.scrollHeight;
  if (!matchMedia('(pointer: coarse)').matches) $('#chatInput').focus();
  api('/chat/status').then((s) => {
    $('#chatSub').textContent = s.enabled ? `Web search & live news · ${s.model}` : 'Not set up: add OLLAMA_API_KEY on the server';
  }).catch(() => {});
}

function sendChat(text) {
  const content = String(text || '').trim();
  if (!content || chat.busy) return;
  chat.messages.push({ role: 'user', content });
  runChat();
}

async function runChat() {
  const history = chat.messages.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content }));
  const bot = { role: 'assistant', content: '', steps: [], sources: [], pending: true };
  const session = chat.messages;
  chat.messages.push(bot);
  chat.busy = true;
  const ctrl = new AbortController();
  chat.ctrl = ctrl;
  renderChat();
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  const holdings = vault.unlocked ? newsHoldings().map(({ name, symbol, assetType }) => ({ name, symbol, assetType })) : [];
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, holdings }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finished = false;
    const handle = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'delta') bot.content += ev.text;
      else if (ev.type === 'reset') bot.content = '';
      else if (ev.type === 'step') {
        const s = bot.steps.find((x) => x.id === ev.id);
        if (s) Object.assign(s, ev); else bot.steps.push(ev);
      } else if (ev.type === 'done') { bot.sources = ev.sources || []; finished = true; }
      else if (ev.type === 'error') { bot.error = ev.message; bot.retry = true; finished = true; }
      else return;
      if (chat.messages === session) paintLast();
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    handle(buf + dec.decode());
    if (!finished && !bot.error) { bot.error = 'The connection closed before the answer finished.'; bot.retry = true; }
  } catch (err) {
    if (err.name === 'AbortError') { if (!bot.content) bot.error = 'Stopped.'; } else {
      bot.error = /fetch|network/i.test(err.message) ? 'Cannot reach the Asset Tracker server.' : err.message;
      bot.retry = true;
    }
  } finally {
    bot.pending = false;
    for (const s of bot.steps) if (s.status === 'running') s.status = 'error';
    if (chat.ctrl === ctrl) { chat.busy = false; chat.ctrl = null; }
    if (chat.messages === session && !$('#chat').hidden) {
      renderChat();
      const log = $('#chatLog');
      if (log.scrollHeight - log.scrollTop - log.clientHeight < 240) log.scrollTop = log.scrollHeight;
    }
  }
}

/** Forget the conversation (new chat, or the vault was locked). */
function resetChat() {
  chat.ctrl?.abort();
  chat.ctrl = null;
  chat.busy = false;
  chat.messages = [];
  if (!$('#chat').hidden) renderChat();
}

const chatInput = $('#chatInput');
const growInput = () => { chatInput.style.height = 'auto'; chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`; };
chatInput.addEventListener('input', growInput);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('#chatForm').requestSubmit(); }
});
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (chat.busy) { chat.ctrl?.abort(); return; }
  const text = chatInput.value;
  if (!text.trim()) return;
  chatInput.value = '';
  growInput();
  sendChat(text);
});
$('#chatFab').addEventListener('click', () => setChatOpen(true));
$('#chatClose').addEventListener('click', () => setChatOpen(false));
$('#chatClear').addEventListener('click', () => { resetChat(); chatInput.focus(); });
$('#chat').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setChatOpen(false); } });
$('#chatLog').addEventListener('click', async (e) => {
  const sug = e.target.closest('[data-suggest]');
  if (sug) { sendChat(sug.dataset.suggest); return; }
  if (e.target.closest('[data-retry]')) {
    if (chat.busy) return;
    while (chat.messages.length && chat.messages.at(-1).role === 'assistant') chat.messages.pop();
    if (chat.messages.length) runChat();
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    try { await navigator.clipboard.writeText(chat.messages[Number(copy.dataset.copy)]?.content || ''); toast('Answer copied', 'success'); } catch { toast('Could not copy', 'error'); }
  }
});
document.addEventListener('keydown', (e) => {
  if (!vault.unlocked || chat.open || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (e.target.closest('input, select, textarea, [contenteditable]')) return;
  if (e.key.toLowerCase() === 'a') { e.preventDefault(); setChatOpen(true); }
});
