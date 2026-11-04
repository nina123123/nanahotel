import defaultFs from 'node:fs/promises';
import path from 'node:path';

export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.riv': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

const ASSET_MAX_AGE_S = 300;

export function contentTypeFor(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Maps a raw (still percent-encoded) URL path below the mount point to a path relative to the
 * public root, or null when it is unsafe or not a plain file path.
 * Rejects: undecodable escapes, NUL bytes, backslashes, '..' and '.' segments, hidden files.
 */
export function safeRelativePath(rawPath) {
  if (typeof rawPath !== 'string' || /%00|\0/i.test(rawPath)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((s) => s !== '');
  if (!segments.length) return null;
  for (const s of segments) {
    if (s === '.' || s === '..' || s.startsWith('.')) return null;
  }
  return segments.join('/');
}

function etagOf(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function sendNotFound(res, head) {
  const body = '404 Not found';
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(head ? undefined : body);
}

/**
 * Serves files from `root`: '/' → index.html, `${prefix}<file>` → `<root>/<file>`.
 * Only regular files whose real path stays inside root are served; no directory listing.
 *
 * @param {{ root: string, prefix?: string, index?: string, fs?: typeof defaultFs }} opts
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, rawPath: string) => Promise<boolean>}
 *   resolves false when the path is not under this handler's mount (caller decides what to do).
 */
export function createStaticHandler({ root, prefix = '/public/', index = 'index.html', fs = defaultFs }) {
  const rootDir = path.resolve(root);
  let realRootPromise = null;
  const realRoot = () => {
    realRootPromise ??= fs.realpath(rootDir).catch(() => rootDir);
    return realRootPromise;
  };

  async function resolveFile(rel) {
    const candidate = path.resolve(rootDir, rel);
    if (!candidate.startsWith(rootDir + path.sep)) return null;
    let real;
    try {
      real = await fs.realpath(candidate);
    } catch {
      return null;
    }
    // A symlink inside public/ must not expose files outside it.
    const base = await realRoot();
    if (!real.startsWith(base + path.sep)) return null;
    const stat = await fs.stat(real).catch(() => null);
    if (!stat || !stat.isFile()) return null;
    return { file: real, stat };
  }

  return async function serveStatic(req, res, rawPath) {
    let rel;
    if (rawPath === '/') rel = index;
    else if (rawPath.startsWith(prefix)) rel = safeRelativePath(rawPath.slice(prefix.length));
    else return false;

    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('405 Method not allowed');
      return true;
    }
    const found = rel ? await resolveFile(rel) : null;
    if (!found) {
      sendNotFound(res, head);
      return true;
    }

    const { file, stat } = found;
    const type = contentTypeFor(file);
    const etag = etagOf(stat);
    const headers = {
      'Content-Type': type,
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : `public, max-age=${ASSET_MAX_AGE_S}`,
      ETag: etag,
      'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const body = head ? null : await fs.readFile(file);
    res.writeHead(200, { ...headers, 'Content-Length': body ? body.length : stat.size });
    res.end(body ?? undefined);
    return true;
  };
}
