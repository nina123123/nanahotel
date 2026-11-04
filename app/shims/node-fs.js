// node:fs subset. The apps have no .env file; config.js only reads it when loadConfig() is called.
function enoent(p) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
}

export function readFileSync(p) {
  throw enoent(p);
}

export function existsSync() {
  return false;
}

export default { readFileSync, existsSync };
