/**
 * Encrypted storage for all portfolio data in the browser's localStorage.
 *
 * - Key: PBKDF2-SHA256 (600k iterations, random 16-byte salt) from the user's passphrase -> AES-GCM 256.
 * - Every save uses a fresh random 12-byte IV.
 * - localStorage holds only ciphertext. The key stays in memory, and can be exported
 *   for a tab session so a refresh stays unlocked until the user locks.
 */
export const VAULT_KEY = 'assetTracker.vault.v1';
const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const emptyData = () => ({ holdings: [], goldSips: [], snapshots: [], meta: {} });

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

function parseBlob(text) {
  let b;
  try { b = JSON.parse(text); } catch { throw new Error('Not a valid Asset Tracker backup'); }
  if (!b || b.v !== 1 || typeof b.salt !== 'string' || typeof b.iv !== 'string' || typeof b.ct !== 'string' || !Number.isInteger(b.iter)) {
    throw new Error('Not a valid Asset Tracker backup');
  }
  return b;
}

async function decryptBlob(key, b) {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(b.iv) }, key, fromB64(b.ct));
    return { ...emptyData(), ...JSON.parse(dec.decode(plain)) };
  } catch {
    throw new Error('Wrong passphrase');
  }
}

export function createVault(storage = globalThis.localStorage) {
  let key = null;
  let salt = null;
  let iter = ITERATIONS;
  let data = null;

  const vault = {
    exists: () => !!storage.getItem(VAULT_KEY),
    get unlocked() { return !!key; },
    get data() {
      if (!data) throw new Error('Vault is locked');
      return data;
    },

    /** First run: create a new, empty vault protected by `passphrase`. */
    async create(passphrase) {
      if (!passphrase) throw new Error('Passphrase is required');
      salt = random(16);
      iter = ITERATIONS;
      key = await deriveKey(passphrase, salt, iter);
      data = emptyData();
      await vault.save();
    },

    async unlock(passphrase) {
      const raw = storage.getItem(VAULT_KEY);
      if (!raw) throw new Error('No saved data found');
      const b = parseBlob(raw);
      const s = fromB64(b.salt);
      const k = await deriveKey(passphrase, s, b.iter);
      data = await decryptBlob(k, b);
      key = k; salt = s; iter = b.iter;
    },

    /** Raw key material for this tab. Kept in sessionStorage so a refresh stays unlocked. */
    async exportSession() {
      if (!key || !salt) throw new Error('Vault is locked');
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
      return { k: toB64(raw), s: toB64(salt), i: iter };
    },

    /** Re-open from a previously exported session. Fails if the passphrase has since changed. */
    async resume(session) {
      if (!session || typeof session.k !== 'string' || typeof session.s !== 'string' || !Number.isInteger(session.i)) {
        throw new Error('No saved session');
      }
      const raw = storage.getItem(VAULT_KEY);
      if (!raw) throw new Error('No saved data found');
      const b = parseBlob(raw);
      if (b.salt !== session.s) throw new Error('Passphrase changed');
      const k = await crypto.subtle.importKey('raw', fromB64(session.k), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      data = await decryptBlob(k, b);
      key = k; salt = fromB64(session.s); iter = session.i;
    },

    /** Re-read storage (e.g. another tab saved). Locks if the data can no longer be decrypted. */
    async reload() {
      if (!key) return;
      const raw = storage.getItem(VAULT_KEY);
      try {
        const b = parseBlob(raw);
        if (b.salt !== toB64(salt)) throw new Error('Passphrase changed');
        data = await decryptBlob(key, b);
      } catch (e) {
        vault.lock();
        throw e;
      }
    },

    lock() { key = null; salt = null; data = null; },

    async save() {
      if (!key) throw new Error('Vault is locked');
      const iv = random(12);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data))));
      const blob = JSON.stringify({ v: 1, alg: 'AES-GCM-256/PBKDF2-SHA256', iter, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) });
      try { storage.setItem(VAULT_KEY, blob); } catch (e) { throw new Error(`Could not save to browser storage: ${e.message}`); }
    },

    async changePassphrase(newPassphrase) {
      if (!key) throw new Error('Vault is locked');
      if (!newPassphrase) throw new Error('Passphrase is required');
      salt = random(16);
      iter = ITERATIONS;
      key = await deriveKey(newPassphrase, salt, iter);
      await vault.save();
    },

    /** The encrypted blob, safe to keep as a backup file (useless without the passphrase). */
    exportBackup() {
      const raw = storage.getItem(VAULT_KEY);
      if (!raw) throw new Error('Nothing to export');
      return raw;
    },

    /** Replace the stored vault with a backup. It must open with `passphrase`. */
    async importBackup(text, passphrase) {
      const b = parseBlob(text);
      const s = fromB64(b.salt);
      const k = await deriveKey(passphrase, s, b.iter);
      const d = await decryptBlob(k, b);
      storage.setItem(VAULT_KEY, JSON.stringify(b));
      key = k; salt = s; iter = b.iter; data = d;
    },

    /** Permanently delete all saved data. */
    reset() {
      storage.removeItem(VAULT_KEY);
      vault.lock();
    },
  };
  return vault;
}
