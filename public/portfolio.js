/** Pure portfolio maths used by the dashboard (no DOM, no storage) so it can be unit tested in Node. */
const round = (n) => Math.round(n * 100) / 100;
const MAX_SNAPSHOT_DAYS = 3650;

export function summarize(holdings, sips) {
  const empty = () => ({ invested: 0, value: 0, pnl: 0, count: 0 });
  const s = { stock: empty(), crypto: empty(), gold: empty() };
  for (const h of holdings) {
    const b = s[h.assetType];
    if (!b) continue;
    b.invested += h.investedValue || 0;
    b.value += h.currentValue ?? h.investedValue ?? 0;
    b.count++;
  }
  for (const g of sips) {
    s.gold.invested += g.totalInvested || 0;
    s.gold.value += g.currentValue ?? g.totalInvested ?? 0;
    s.gold.count++;
  }
  const total = empty();
  for (const k of Object.keys(s)) {
    const b = s[k];
    b.invested = round(b.invested); b.value = round(b.value); b.pnl = round(b.value - b.invested);
    b.pnlPercent = b.invested ? round((b.pnl / b.invested) * 100) : 0;
    total.invested += b.invested; total.value += b.value; total.count += b.count;
  }
  total.invested = round(total.invested); total.value = round(total.value); total.pnl = round(total.value - total.invested);
  total.pnlPercent = total.invested ? round((total.pnl / total.invested) * 100) : 0;
  return { ...s, total };
}

/** Record today's valuation, keeping one snapshot per calendar day (the latest). Returns the new list. */
export function addSnapshot(snapshots, summary, at = new Date()) {
  const iso = new Date(at).toISOString();
  const day = iso.slice(0, 10);
  const pick = ({ invested, value, pnl }) => ({ invested, value, pnl });
  const snap = { at: iso, stock: pick(summary.stock), crypto: pick(summary.crypto), gold: pick(summary.gold), total: pick(summary.total) };
  const out = snapshots.filter((s) => s.at.slice(0, 10) !== day);
  out.push(snap);
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out.slice(-MAX_SNAPSHOT_DAYS);
}

/** Insert or replace a record by `_id`. */
export function upsert(list, record) {
  const i = list.findIndex((x) => x._id === record._id);
  if (i === -1) return [...list, record];
  const copy = [...list];
  copy[i] = record;
  return copy;
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
