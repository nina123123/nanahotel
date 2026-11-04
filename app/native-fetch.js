// Calls to the model provider (and web search) leave the phone from here.
// In the Android app they go through the native bridge (XiaosuNative), which is not subject to the browser's
// cross-origin rules; in a browser (the iPhone home-screen version) they use the page's own fetch.

const bridge = globalThis.XiaosuNative && typeof globalThis.XiaosuNative.start === 'function' ? globalThis.XiaosuNative : null;
const pageFetch = globalThis.fetch.bind(globalThis);

export const hasNativeHttp = Boolean(bridge);

/** True when the APK was built with a DeepSeek key, which the bridge adds to requests itself. */
export const hasBuiltInModel = Boolean(bridge && typeof bridge.hasBuiltInModel === 'function' && bridge.hasBuiltInModel());

const pending = new Map();
let seq = 0;

const NULL_BODY = new Set([101, 204, 205, 304]);

function abortError(signal) {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function decodeBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Called by MainActivity through evaluateJavascript, always on the UI thread.
globalThis.__xiaosuHttp = {
  head(id, status, headersJson) {
    const entry = pending.get(id);
    if (!entry || entry.resolved) return;
    entry.resolved = true;
    let headers = {};
    try {
      headers = JSON.parse(headersJson) || {};
    } catch {
      // keep going without headers
    }
    if (!(status >= 200 && status <= 599)) {
      pending.delete(id);
      entry.reject(new TypeError(`网络请求失败（状态 ${status}）`));
      return;
    }
    entry.resolve(new Response(NULL_BODY.has(status) ? null : entry.stream, { status, headers }));
  },
  chunk(id, b64) {
    const entry = pending.get(id);
    if (!entry) return;
    try {
      entry.controller.enqueue(decodeBase64(b64));
    } catch {
      // the reader went away
    }
  },
  end(id) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    try {
      entry.controller.close();
    } catch {
      // already closed or errored
    }
  },
  fail(id, message) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    const err = new TypeError(message || '网络请求失败');
    if (!entry.resolved) entry.reject(err);
    else {
      try {
        entry.controller.error(err);
      } catch {
        // already closed
      }
    }
  },
};

function nativeFetch(input, init = {}) {
  const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
  const signal = init.signal;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const id = `h${++seq}`;
  return new Promise((resolve, reject) => {
    let controller;
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
      cancel() {
        pending.delete(id);
        bridge.cancel(id);
      },
    });
    const entry = { resolve, reject, stream, controller, resolved: false };
    pending.set(id, entry);
    signal?.addEventListener('abort', () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      bridge.cancel(id);
      const err = abortError(signal);
      if (!entry.resolved) reject(err);
      else {
        try {
          controller.error(err);
        } catch {
          // already closed
        }
      }
    }, { once: true });
    const headers = {};
    new Headers(init.headers || {}).forEach((value, key) => {
      headers[key] = value;
    });
    const body = init.body == null ? '' : String(init.body);
    bridge.start(id, url, String(init.method || 'GET').toUpperCase(), JSON.stringify(headers), body);
  });
}

/** fetch for requests that leave the phone (model provider, web search). */
export const outboundFetch = bridge ? nativeFetch : pageFetch;

/** The page's own fetch, before local-server.js routes /api/* to the in-page server. */
export const originalFetch = pageFetch;
