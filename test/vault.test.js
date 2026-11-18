import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVault, VAULT_KEY } from '../public/vault.js';
import { summarize, addSnapshot, upsert } from '../public/portfolio.js';

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

test('data is stored encrypted and opens only with the right passphrase', async () => {
  const storage = memoryStorage();
  const v = createVault(storage);
  assert.equal(v.exists(), false);
  await v.create('correct horse');
  v.data.holdings.push({ _id: 'a', name: 'RELIANCE secret', investedValue: 123 });
  await v.save();

  const raw = storage.getItem(VAULT_KEY);
  assert.ok(!raw.includes('RELIANCE'), 'plaintext must not appear in storage');
  assert.equal(JSON.parse(raw).v, 1);

  const other = createVault(storage);
  await assert.rejects(other.unlock('wrong'), /Wrong passphrase/);
  assert.equal(other.unlocked, false);
  await other.unlock('correct horse');
  assert.equal(other.data.holdings[0].name, 'RELIANCE secret');
});

test('each save uses a fresh IV', async () => {
  const storage = memoryStorage();
  const v = createVault(storage);
  await v.create('pass1234');
  const a = JSON.parse(storage.getItem(VAULT_KEY)).iv;
  await v.save();
  assert.notEqual(JSON.parse(storage.getItem(VAULT_KEY)).iv, a);
});

test('a refresh can reopen from the exported session until the vault is locked', async () => {
  const storage = memoryStorage();
  const v = createVault(storage);
  await v.create('correct horse');
  v.data.holdings.push({ _id: 'a', name: 'TCS' });
  await v.save();
  const session = await v.exportSession();

  const refreshed = createVault(storage);
  assert.equal(refreshed.unlocked, false);
  await refreshed.resume(session);
  assert.equal(refreshed.data.holdings[0].name, 'TCS');

  await v.changePassphrase('different');
  await assert.rejects(refreshed.resume(session), /Passphrase changed|Wrong passphrase/);
});

test('change passphrase, backup and restore', async () => {
  const storage = memoryStorage();
  const v = createVault(storage);
  await v.create('old-pass');
  v.data.goldSips.push({ _id: 'g' });
  await v.save();
  const backup = v.exportBackup();

  await v.changePassphrase('new-pass');
  v.lock();
  await assert.rejects(v.unlock('old-pass'), /Wrong passphrase/);
  await v.unlock('new-pass');

  const fresh = createVault(memoryStorage());
  await assert.rejects(fresh.importBackup('{"nope":1}', 'x'), /Not a valid/);
  await assert.rejects(fresh.importBackup(backup, 'new-pass'), /Wrong passphrase/);
  await fresh.importBackup(backup, 'old-pass');
  assert.equal(fresh.data.goldSips[0]._id, 'g');
  assert.equal(fresh.exists(), true);

  v.reset();
  assert.equal(v.exists(), false);
  assert.throws(() => v.data, /locked/);
});

test('summary, daily snapshots and upsert', () => {
  const s = summarize(
    [{ assetType: 'stock', investedValue: 100, currentValue: 150 }, { assetType: 'crypto', investedValue: 50 }],
    [{ totalInvested: 200, currentValue: 180 }],
  );
  assert.deepEqual([s.stock.pnl, s.crypto.value, s.gold.pnl, s.total.value, s.total.count], [50, 50, -20, 380, 3]);

  let snaps = addSnapshot([], s, '2026-01-01T05:00:00Z');
  snaps = addSnapshot(snaps, s, '2026-01-01T09:00:00Z');
  snaps = addSnapshot(snaps, s, '2026-01-02T09:00:00Z');
  assert.deepEqual(snaps.map((x) => x.at.slice(0, 13)), ['2026-01-01T09', '2026-01-02T09']);

  assert.deepEqual(upsert([{ _id: 'a', n: 1 }], { _id: 'a', n: 2 }), [{ _id: 'a', n: 2 }]);
  assert.equal(upsert([{ _id: 'a' }], { _id: 'b' }).length, 2);
});
