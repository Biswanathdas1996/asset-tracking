import { toDateKey, todayIST } from '../services/dates.js';

export class BadRequest extends Error { constructor(m) { super(m); this.status = 400; } }

export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function positiveNumber(v, field, { optional = false } = {}) {
  if (optional && (v === undefined || v === null || v === '')) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new BadRequest(`${field} must be a positive number`);
  return n;
}

export function nonNegativeNumber(v, field) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new BadRequest(`${field} cannot be negative`);
  return n;
}

export function pastOrTodayDate(v, field) {
  if (!v) throw new BadRequest(`${field} is required`);
  let key;
  try { key = toDateKey(v); } catch { throw new BadRequest(`${field} is not a valid date`); }
  if (key > todayIST()) throw new BadRequest(`${field} cannot be in the future`);
  return key;
}

/** "reliance" -> "RELIANCE.NS"; keeps explicit .NS / .BO suffixes. */
export function normalizeStockSymbol(s) {
  if (!s || typeof s !== 'string') throw new BadRequest('symbol is required');
  const sym = s.trim().toUpperCase();
  return /\.(NS|BO)$/.test(sym) ? sym : `${sym}.NS`;
}
