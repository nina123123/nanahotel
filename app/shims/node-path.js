// POSIX subset of node:path, enough for the server modules when they run in the app's WebView.
export const sep = '/';
export const delimiter = ':';

export function normalize(p) {
  const abs = String(p).startsWith('/');
  const out = [];
  for (const part of String(p).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(part);
  }
  const joined = out.join('/');
  return abs ? `/${joined}` : joined || '.';
}

export function join(...parts) {
  return normalize(parts.filter((x) => x !== '').join('/') || '.');
}

export function resolve(...parts) {
  let p = '';
  for (let i = parts.length - 1; i >= 0 && !p.startsWith('/'); i--) {
    if (parts[i]) p = p ? `${parts[i]}/${p}` : String(parts[i]);
  }
  return normalize(p.startsWith('/') ? p : `/${p}`);
}

export function isAbsolute(p) {
  return String(p).startsWith('/');
}

export function dirname(p) {
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  return i === 0 ? '/' : s.slice(0, i);
}

export function basename(p, ext = '') {
  const b = String(p).replace(/\/+$/, '').split('/').pop() || '';
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}

export function relative(from, to) {
  const a = resolve(from).split('/').filter(Boolean);
  const b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

const path = { sep, delimiter, normalize, join, resolve, isAbsolute, dirname, basename, extname, relative };
path.posix = path;
export const posix = path;
export default path;
