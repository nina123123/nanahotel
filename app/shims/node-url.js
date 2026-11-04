// node:url subset. Module URLs here are https:// (app assets or GitHub Pages), so a "file path" is the URL path.
export function fileURLToPath(url) {
  return decodeURIComponent(new URL(String(url)).pathname);
}

export function pathToFileURL(p) {
  return new URL(`file://${encodeURI(String(p))}`);
}

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export default { fileURLToPath, pathToFileURL, URL, URLSearchParams };
