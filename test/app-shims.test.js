import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shimPath from '../app/shims/node-path.js';
import { randomInt, randomUUID } from '../app/shims/node-crypto.js';
import { fileURLToPath as shimFileURLToPath } from '../app/shims/node-url.js';
import shimFs from '../app/shims/node-fs-promises.js';
import { createServer } from '../app/shims/node-http.js';

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = nodePath.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('every node:* module the server code imports has a stand-in in the app import map', () => {
  const html = fs.readFileSync(nodePath.join(ROOT, 'app/index.html'), 'utf8');
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
  const used = new Set();
  for (const file of walk(nodePath.join(ROOT, 'src'))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/from '(node:[^']+)'/g)) used.add(m[1]);
  }
  for (const spec of used) {
    assert.ok(map[spec], `${spec} is imported by src/ but missing from app/index.html's import map`);
    assert.ok(fs.existsSync(nodePath.join(ROOT, 'app', map[spec])), `${map[spec]} does not exist`);
  }
});

test('the shell and public/index.html only use relative asset paths, so the app works under a sub-path', () => {
  for (const file of ['app/index.html', 'public/index.html']) {
    const html = fs.readFileSync(nodePath.join(ROOT, file), 'utf8');
    assert.doesNotMatch(html, /(?:src|href)="\/(?!\/)/, `${file} has a root-absolute src/href`);
  }
  assert.doesNotMatch(fs.readFileSync(nodePath.join(ROOT, 'public/app.js'), 'utf8'), /'\/public\//);
});

test('path shim matches node:path for the calls the server makes', () => {
  for (const args of [['/a/b', '../c'], ['/a', 'b', 'c.json'], ['/a/b/']]) {
    assert.equal(shimPath.resolve(...args), nodePath.posix.resolve(...args));
  }
  for (const args of [['/data', 'sessions.json'], ['a', '..', 'b'], ['/x/', './y']]) {
    assert.equal(shimPath.join(...args), nodePath.posix.join(...args));
  }
  assert.equal(shimPath.dirname('/a/b/c.js'), '/a/b');
  assert.equal(shimPath.basename('/a/b/c.json', '.json'), 'c');
  assert.equal(shimPath.extname('/a/b.tmp.json'), '.json');
  assert.equal(shimPath.relative('/a/b', '/a/c/d'), '../c/d');
  assert.equal(shimFileURLToPath('https://appassets.androidplatform.net/web/src/config.js'), '/web/src/config.js');
});

test('crypto shim: randomInt covers the ranges ids.js uses, randomUUID is a v4 UUID', () => {
  for (const [min, max] of [[0, 1e6], [1e7, 1e8], [0, 1e10]]) {
    for (let i = 0; i < 200; i++) {
      const n = randomInt(min, max);
      assert.ok(Number.isInteger(n) && n >= min && n < max, `${n} not in [${min}, ${max})`);
    }
  }
  assert.throws(() => randomInt(0, 2 ** 48), RangeError);
  assert.match(randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('fs shim (memory fallback without IndexedDB) supports json-store\'s write-then-rename', async () => {
  await shimFs.mkdir('/d', { recursive: true });
  await shimFs.rm('/d/s.json.tmp', { force: true });
  await shimFs.writeFile('/d/s.json.tmp', '{"a":1}', { encoding: 'utf8', mode: 0o600 });
  await shimFs.rename('/d/s.json.tmp', '/d/s.json');
  assert.deepEqual(await shimFs.readdir('/d'), ['s.json']);
  assert.equal(await shimFs.readFile('/d/s.json', 'utf8'), '{"a":1}');
  await assert.rejects(shimFs.readFile('/d/missing.json'), { code: 'ENOENT' });
  await assert.rejects(shimFs.rm('/d/missing.json'), { code: 'ENOENT' });
});

test('http shim: createApp can create and close its server without a network', async () => {
  const server = createServer(() => {});
  assert.equal(server.listening, false);
  await new Promise((resolve) => server.close(resolve));
});

test('the Android bridge can reach every provider in providers.js (and Bocha), and nothing else', async () => {
  const { PROVIDERS } = await import('../src/llm/providers.js');
  const { BOCHA_ENDPOINT } = await import('../src/services/websearch.js');
  const kotlin = fs.readFileSync(nodePath.join(ROOT, 'android/app/src/main/java/com/nina/xiaosu/HttpBridge.kt'), 'utf8');
  const allowed = new Set([...kotlin.match(/ALLOWED_HOSTS = setOf\(([\s\S]*?)\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const needed = new Set([...Object.values(PROVIDERS).map((p) => new URL(p.baseUrl).host), new URL(BOCHA_ENDPOINT).host]);
  assert.deepEqual([...allowed].sort(), [...needed].sort());
});

test('the app moves to the next DeepSeek model id when the current one does not exist, and remembers it', async () => {
  const { withModelFallback } = await import('../app/local-server.js');
  const { classifyProviderError } = await import('../src/llm/client.js');
  const missing = classifyProviderError(400, { error: { message: 'Model Not Exist', type: 'invalid_request_error' } });
  assert.equal(missing.reason, 'model_not_found');
  const calls = [];
  let remembered = null;
  const llm = withModelFallback((model) => ({
    provider: 'deepseek',
    async chat() {
      calls.push(model);
      if (model !== 'b') throw missing;
      return { content: 'ok' };
    },
  }), ['a', 'b', 'c'], { onModel: (m) => { remembered = m; } });
  assert.equal((await llm.chat({})).content, 'ok');
  assert.equal((await llm.chat({})).content, 'ok');
  assert.deepEqual(calls, ['a', 'b', 'b']);
  assert.equal(llm.model, 'b');
  assert.equal(remembered, 'b');
  // Any other error is not a reason to switch models.
  const auth = classifyProviderError(401, { error: { message: 'Authentication Fails' } });
  const broken = withModelFallback(() => ({ chat: async () => { throw auth; } }), ['a', 'b']);
  await assert.rejects(broken.chat({}), (err) => err === auth);
  assert.equal(broken.model, 'a');
  // The last id's error reaches the user.
  const none = withModelFallback(() => ({ chat: async () => { throw missing; } }), ['a', 'b']);
  await assert.rejects(none.chat({}), (err) => err === missing);
});
