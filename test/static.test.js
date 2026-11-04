import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStaticHandler, safeRelativePath, contentTypeFor } from '../src/http/static.js';

// Raw requests so paths reach the server exactly as written (fetch() would normalize '..' away).
function rawGet(port, rawPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hotel-agent-static-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'public');
  await mkdir(path.join(root, 'sub', 'dir'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>首页</title>');
  await writeFile(path.join(root, 'app.js'), 'console.log("app");');
  await writeFile(path.join(root, 'style.css'), 'body{}');
  await writeFile(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(root, 'site.webmanifest'), '{"name":"小宿"}');
  await writeFile(path.join(root, 'data.bin'), 'xx');
  await writeFile(path.join(root, '.hidden'), 'hidden');
  await writeFile(path.join(root, 'sub', 'dir', 'note.txt'), '你好');
  await writeFile(path.join(base, 'secret.txt'), 'TOP-SECRET');
  await symlink(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));

  const serve = createStaticHandler({ root });
  const server = http.createServer(async (req, res) => {
    const handled = await serve(req, res, req.url.split('?')[0]);
    if (!handled) {
      res.writeHead(418);
      res.end('not mine');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return server.address().port;
}

test('safeRelativePath rejects traversal, NUL bytes, backslashes, hidden files and bad escapes', () => {
  assert.equal(safeRelativePath('app.js'), 'app.js');
  assert.equal(safeRelativePath('sub/dir/note.txt'), 'sub/dir/note.txt');
  assert.equal(safeRelativePath('sub//dir/note.txt'), 'sub/dir/note.txt');
  assert.equal(safeRelativePath('%E4%BD%A0.txt'), '你.txt');
  for (const bad of ['', '/', '../secret.txt', 'sub/../../secret.txt', '%2e%2e/secret.txt', '%2E%2E%2Fsecret.txt',
    '..%2fsecret.txt', 'app.js%00.html', 'a\0b', '%5c..%5csecret.txt', '..\\secret.txt', '.hidden', 'sub/.git/config',
    './app.js', '%zz', '%']) {
    assert.equal(safeRelativePath(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('contentTypeFor knows the types the H5 needs', () => {
  assert.equal(contentTypeFor('a.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('a.JS'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('a.css'), 'text/css; charset=utf-8');
  assert.equal(contentTypeFor('a.svg'), 'image/svg+xml');
  assert.equal(contentTypeFor('a.webmanifest'), 'application/manifest+json; charset=utf-8');
  assert.equal(contentTypeFor('a.png'), 'image/png');
  assert.equal(contentTypeFor('a.woff2'), 'font/woff2');
  assert.equal(contentTypeFor('a.unknown'), 'application/octet-stream');
});

test('serves files with the right content type and cache headers', async (t) => {
  const port = await setup(t);
  const cases = [
    ['/', 'text/html; charset=utf-8', 'no-cache', '<!doctype html><title>首页</title>'],
    ['/public/index.html', 'text/html; charset=utf-8', 'no-cache', null],
    ['/public/app.js', 'text/javascript; charset=utf-8', 'public, max-age=300', 'console.log("app");'],
    ['/public/style.css', 'text/css; charset=utf-8', 'public, max-age=300', 'body{}'],
    ['/public/icon.svg', 'image/svg+xml', 'public, max-age=300', null],
    ['/public/site.webmanifest', 'application/manifest+json; charset=utf-8', 'public, max-age=300', null],
    ['/public/sub/dir/note.txt', 'text/plain; charset=utf-8', 'public, max-age=300', '你好'],
    ['/public/data.bin', 'application/octet-stream', 'public, max-age=300', null],
    ['/public/app.js?v=123', 'text/javascript; charset=utf-8', 'public, max-age=300', null],
  ];
  for (const [p, type, cache, body] of cases) {
    const res = await rawGet(port, p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers['content-type'], type, p);
    assert.equal(res.headers['cache-control'], cache, p);
    assert.ok(res.headers.etag, p);
    if (body !== null) assert.equal(res.body, body, p);
  }
});

test('blocks traversal, encoded traversal, NUL bytes, hidden files, directories and symlinks out of root', async (t) => {
  const port = await setup(t);
  const attempts = [
    '/public/../secret.txt',
    '/public/sub/../../secret.txt',
    '/public/%2e%2e/secret.txt',
    '/public/%2E%2E/secret.txt',
    '/public/%2e%2e%2fsecret.txt',
    '/public/..%2fsecret.txt',
    '/public/..%5csecret.txt',
    '/public/%252e%252e/secret.txt',
    '/public/app.js%00',
    '/public/app.js%00.html',
    '/public/%00',
    '/public/.hidden',
    '/public/link.txt',
    '/public/sub',
    '/public/sub/',
    '/public/',
    '/public/missing.js',
    '/public/%zz',
    '/public/%2fetc%2fpasswd',
  ];
  for (const p of attempts) {
    const res = await rawGet(port, p);
    assert.equal(res.status, 404, `${p} → ${res.status}`);
    assert.ok(!res.body.includes('TOP-SECRET'), p);
    assert.ok(!res.body.includes('hidden'), p);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8', p);
  }
});

test('paths outside the mount are left to the caller', async (t) => {
  const port = await setup(t);
  for (const p of ['/secret.txt', '/../secret.txt', '/publicx/app.js', '/index.html', '/api/health']) {
    assert.equal((await rawGet(port, p)).status, 418, p);
  }
});

test('HEAD, conditional GET and unsupported methods', async (t) => {
  const port = await setup(t);
  const head = await rawGet(port, '/public/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String(Buffer.byteLength('console.log("app");')));

  const first = await rawGet(port, '/public/app.js');
  const again = await rawGet(port, '/public/app.js', { headers: { 'If-None-Match': first.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body, '');

  const post = await rawGet(port, '/public/app.js', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});
