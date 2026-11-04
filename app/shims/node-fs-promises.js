// node:fs/promises subset for json-store.js, persisted in IndexedDB so conversations and orders survive
// closing the app. Files are kept in memory and written through; directories are implicit.
const DB_NAME = 'xiaosu-files';
const STORE = 'files';

const files = new Map();
let db = null;
let ready = null;

function enoent(p) {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function open() {
  ready ??= (async () => {
    if (typeof indexedDB === 'undefined') return;
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      db = await request(req);
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      keys.forEach((k, i) => files.set(String(k), values[i]));
    } catch (err) {
      // Private browsing can refuse IndexedDB; the app still works, it just forgets on reload.
      console.warn('[xiaosu] 本地存储不可用，数据只保存在本次打开期间：', err);
      db = null;
    }
  })();
  return ready;
}

function persist(ops) {
  if (!db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const [op, key, value] of ops) {
      if (op === 'put') store.put(value, key);
      else store.delete(key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const clean = (p) => String(p).replace(/\/+$/, '');

export async function mkdir() {
  await open();
}

export async function chmod() {}

export async function readdir(dir) {
  await open();
  const prefix = `${clean(dir)}/`;
  const names = new Set();
  for (const key of files.keys()) {
    if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
  }
  return [...names];
}

export async function readFile(p) {
  await open();
  const key = clean(p);
  if (!files.has(key)) throw enoent(p);
  return files.get(key);
}

export async function writeFile(p, data) {
  await open();
  const key = clean(p);
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  files.set(key, text);
  await persist([['put', key, text]]);
}

export async function rename(from, to) {
  await open();
  const a = clean(from);
  const b = clean(to);
  if (!files.has(a)) throw enoent(from);
  const text = files.get(a);
  files.delete(a);
  files.set(b, text);
  await persist([['put', b, text], ['delete', a]]);
}

export async function rm(p, { force = false } = {}) {
  await open();
  const key = clean(p);
  if (!files.has(key)) {
    if (force) return;
    throw enoent(p);
  }
  files.delete(key);
  await persist([['delete', key]]);
}

export const unlink = (p) => rm(p);

export async function stat(p) {
  await open();
  const key = clean(p);
  if (!files.has(key)) throw enoent(p);
  return { size: files.get(key).length, isFile: () => true, isDirectory: () => false, mtimeMs: 0 };
}

export async function access(p) {
  await stat(p);
}

export default { mkdir, chmod, readdir, readFile, writeFile, rename, rm, unlink, stat, access };
