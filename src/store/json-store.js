import defaultFs from 'node:fs/promises';
import path from 'node:path';

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
// Files hold phones, guest names and chat transcripts: owner-only, whatever the umask.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Persistent JSON collections: each collection is one `<dir>/<name>.json` file holding `{ [id]: value }`.
 * Writes are debounced (one write per collection per `debounceMs`) and atomic (tmp file + rename),
 * so a crash mid-write never leaves a truncated file. `dir: null` keeps everything in memory (tests).
 *
 * Values are held by reference; always call `set()` after changing one so the change is persisted.
 *
 * @param {{ dir: string|null, fs?: typeof defaultFs, debounceMs?: number, onError?: (err: Error) => void }} opts
 */
export function createJsonStore({ dir = null, fs = defaultFs, debounceMs = 200, onError } = {}) {
  const data = new Map();
  const handles = new Map();
  const dirty = new Set();
  const reportError = onError || ((err) => console.error('[json-store]', err.message));
  let timer = null;
  let chain = Promise.resolve();
  let closed = false;
  let dirReady = false;

  function mapFor(name) {
    if (!NAME_RE.test(name)) throw new Error(`invalid collection name: ${name}`);
    let map = data.get(name);
    if (!map) {
      map = new Map();
      data.set(name, map);
    }
    return map;
  }

  function markDirty(name) {
    if (!dir) return;
    dirty.add(name);
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      writeDirty().catch(reportError);
    }, debounceMs);
    // Do not keep the process alive just for a pending write; close()/flush() persist explicitly.
    timer.unref?.();
  }

  async function writeOne(name) {
    const map = data.get(name) || new Map();
    const file = path.join(dir, `${name}.json`);
    const tmp = `${file}.tmp`;
    // writeFile's mode only applies to a new file, so a .tmp left by a crash must not be reused.
    await fs.rm(tmp, { force: true });
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(map)), { encoding: 'utf8', mode: FILE_MODE });
    await fs.rename(tmp, file);
  }

  function writeDirty() {
    const names = [...dirty];
    dirty.clear();
    // Serialize writes so two flushes never race on the same tmp file.
    const run = chain.then(async () => {
      if (!dirReady) {
        await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
        dirReady = true;
      }
      for (const name of names) {
        try {
          await writeOne(name);
        } catch (err) {
          dirty.add(name);
          throw err;
        }
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  async function load() {
    if (!dir) return;
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    // mkdir's mode only applies to directories it creates; tighten an existing one (best effort).
    await fs.chmod(dir, DIR_MODE).catch(() => {});
    dirReady = true;
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const name = entry.slice(0, -5);
      if (!NAME_RE.test(name)) continue;
      const file = path.join(dir, entry);
      await fs.chmod(file, FILE_MODE).catch(() => {});
      const text = await fs.readFile(file, 'utf8');
      let obj;
      try {
        obj = JSON.parse(text);
      } catch (err) {
        // Keep the unreadable file for inspection instead of crashing the demo server on start.
        const aside = `${file}.corrupt-${Date.now()}`;
        await fs.rename(file, aside);
        reportError(new Error(`${entry} 无法解析，已移到 ${path.basename(aside)}：${err.message}`));
        obj = {};
      }
      const map = mapFor(name);
      map.clear();
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [id, value] of Object.entries(obj)) map.set(id, value);
      }
    }
  }

  function collection(name) {
    let handle = handles.get(name);
    if (handle) return handle;
    const map = mapFor(name);
    handle = {
      get: (id) => (map.has(String(id)) ? map.get(String(id)) : null),
      has: (id) => map.has(String(id)),
      set(id, value) {
        map.set(String(id), value);
        markDirty(name);
        return value;
      },
      delete(id) {
        const existed = map.delete(String(id));
        if (existed) markDirty(name);
        return existed;
      },
      values: () => [...map.values()],
      /** All values matching `pred` (an array, possibly empty). */
      find: (pred) => [...map.values()].filter(pred),
      /** First value matching `pred`, or null. */
      findOne(pred) {
        for (const v of map.values()) if (pred(v)) return v;
        return null;
      },
      get size() {
        return map.size;
      },
    };
    handles.set(name, handle);
    return handle;
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dir) return;
    if (dirty.size) await writeDirty();
    else await chain;
  }

  async function close() {
    closed = true;
    await flush();
  }

  return { load, collection, flush, close, dir };
}
