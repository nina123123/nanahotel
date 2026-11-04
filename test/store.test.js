import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createJsonStore } from '../src/store/json-store.js';

const SCRATCH = process.env.HOTEL_AGENT_TEST_TMP || path.join(os.tmpdir(), 'hotel-agent-tests');

const created = [];

async function tempDir() {
  await fs.mkdir(SCRATCH, { recursive: true });
  const dir = await fs.mkdtemp(path.join(SCRATCH, 'store-'));
  created.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(created.map((d) => fs.rm(d, { recursive: true, force: true })));
});

test('in-memory store (dir: null) supports get/set/delete/values/find', async () => {
  const store = createJsonStore({ dir: null });
  await store.load();
  const users = store.collection('profiles');
  assert.equal(users.get('u1'), null);
  users.set('u1', { name: 'Sarah Miller', age: 30 });
  users.set('u2', { name: 'David Chen', age: 20 });
  assert.deepEqual(users.get('u1'), { name: 'Sarah Miller', age: 30 });
  assert.equal(users.has('u2'), true);
  assert.equal(users.size, 2);
  assert.deepEqual(users.find((u) => u.age > 25).map((u) => u.name), ['Sarah Miller']);
  assert.deepEqual(users.find(() => false), []);
  assert.equal(users.findOne((u) => u.age < 25).name, 'David Chen');
  assert.equal(users.findOne(() => false), null);
  assert.equal(users.values().length, 2);
  assert.equal(users.delete('u2'), true);
  assert.equal(users.delete('u2'), false);
  assert.equal(store.collection('profiles'), users, 'collection handles are cached');
  await store.flush();
  await store.close();
});

test('rejects unsafe collection names', () => {
  const store = createJsonStore({ dir: null });
  assert.throws(() => store.collection('../etc'));
  assert.throws(() => store.collection('a/b'));
});

test('persists to disk atomically and reloads', async () => {
  const dir = await tempDir();
  const store = createJsonStore({ dir, debounceMs: 20 });
  await store.load();
  store.collection('orders').set('HA1', { id: 'HA1', totalPrice: 598 });
  store.collection('sessions').set('s1', { items: [1, 2, 3] });
  await store.flush();

  const files = (await fs.readdir(dir)).sort();
  assert.deepEqual(files, ['orders.json', 'sessions.json'], 'no leftover .tmp files');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'orders.json'), 'utf8')), { HA1: { id: 'HA1', totalPrice: 598 } });

  const again = createJsonStore({ dir });
  await again.load();
  assert.deepEqual(again.collection('orders').get('HA1'), { id: 'HA1', totalPrice: 598 });
  assert.deepEqual(again.collection('sessions').get('s1'), { items: [1, 2, 3] });
  await store.close();
  await again.close();
});

test('debounces bursts of writes into one write per collection', async () => {
  const dir = await tempDir();
  const writes = [];
  const spyFs = {
    ...fs,
    writeFile: async (file, data, enc) => {
      writes.push(path.basename(file));
      return fs.writeFile(file, data, enc);
    },
  };
  const store = createJsonStore({ dir, fs: spyFs, debounceMs: 30 });
  await store.load();
  const c = store.collection('quotes');
  for (let i = 0; i < 50; i++) c.set(`q${i}`, { i });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(writes, ['quotes.json.tmp']);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'quotes.json'), 'utf8'));
  assert.equal(Object.keys(saved).length, 50);
  await store.close();
});

test('writes work without load() and create the directory', async () => {
  const dir = path.join(await tempDir(), 'nested', 'data');
  const store = createJsonStore({ dir });
  store.collection('sessions').set('s1', { ok: true });
  await store.close();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'sessions.json'), 'utf8')), { s1: { ok: true } });
});

test('close() flushes pending writes immediately', async () => {
  const dir = await tempDir();
  const store = createJsonStore({ dir, debounceMs: 10_000 });
  await store.load();
  store.collection('profiles').set('u1', { firstName: 'Maria' });
  await store.close();
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'profiles.json'), 'utf8'));
  assert.deepEqual(saved, { u1: { firstName: 'Maria' } });
});

test('a corrupt file is moved aside instead of crashing load()', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'orders.json'), '{"HA1": {"id": "HA1"', 'utf8');
  await fs.writeFile(path.join(dir, 'quotes.json.tmp'), 'garbage', 'utf8');
  const errors = [];
  const store = createJsonStore({ dir, onError: (e) => errors.push(e.message) });
  await store.load();
  assert.equal(store.collection('orders').size, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /orders\.json/);
  const files = await fs.readdir(dir);
  assert.ok(files.some((f) => f.startsWith('orders.json.corrupt-')));
  await store.close();
});

test('write failures are reported and retried on the next flush', async () => {
  const dir = await tempDir();
  let fail = true;
  const flakyFs = {
    ...fs,
    rename: async (a, b) => {
      if (fail) throw new Error('disk full');
      return fs.rename(a, b);
    },
  };
  const store = createJsonStore({ dir, fs: flakyFs, debounceMs: 10_000 });
  await store.load();
  store.collection('orders').set('HA1', { id: 'HA1' });
  await assert.rejects(store.flush(), /disk full/);
  fail = false;
  await store.flush();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'orders.json'), 'utf8')), { HA1: { id: 'HA1' } });
  await store.close();
});

test('data directory and files are owner-only (0700 / 0600), also when they already existed', { skip: process.platform === 'win32' }, async () => {
  const mode = async (p) => (await fs.stat(p)).mode & 0o777;
  const dir = path.join(await tempDir(), 'data');
  const store = createJsonStore({ dir, debounceMs: 10_000 });
  await store.load();
  store.collection('profiles').set('u1', { contactPhone: '13812345678' });
  await store.flush();
  assert.equal(await mode(dir), 0o700);
  assert.equal(await mode(path.join(dir, 'profiles.json')), 0o600);
  await store.close();

  // Files written before this fix (umask 022), plus a .tmp left over from a crash.
  const old = await tempDir();
  await fs.chmod(old, 0o755);
  await fs.writeFile(path.join(old, 'profiles.json'), '{"u1":{"firstName":"Sarah"}}', { mode: 0o644 });
  await fs.writeFile(path.join(old, 'orders.json'), '{}', { mode: 0o644 });
  await fs.writeFile(path.join(old, 'profiles.json.tmp'), 'stale', { mode: 0o644 });
  const again = createJsonStore({ dir: old, debounceMs: 10_000 });
  await again.load();
  assert.equal(await mode(old), 0o700);
  assert.equal(await mode(path.join(old, 'orders.json')), 0o600, 'files that are never rewritten are tightened on load');
  again.collection('profiles').set('u2', { firstName: 'David' });
  await again.flush();
  assert.equal(await mode(path.join(old, 'profiles.json')), 0o600);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(old, 'profiles.json'), 'utf8'))), ['u1', 'u2']);
  assert.ok(!(await fs.readdir(old)).includes('profiles.json.tmp'));
  await again.close();
});
