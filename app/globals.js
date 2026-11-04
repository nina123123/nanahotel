// Node globals and newer Web APIs the shared server code expects, for the app's WebView and iPhone Safari.
// Imported first by boot.js, before any module from src/ is evaluated.

if (typeof globalThis.process === 'undefined') {
  const started = performance.now();
  globalThis.process = {
    argv: [],
    env: {},
    platform: 'browser',
    versions: {},
    hrtime: { bigint: () => BigInt(Math.round((performance.now() - started) * 1e6)) },
    on() {},
    exit() {},
  };
}

if (typeof globalThis.Buffer === 'undefined') {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const withToString = (bytes) => Object.assign(bytes, { toString: () => decoder.decode(bytes) });
  globalThis.Buffer = {
    byteLength: (value) => (typeof value === 'string' ? encoder.encode(value).length : value?.byteLength ?? 0),
    from: (value) => withToString(typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value)),
    concat(chunks) {
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return withToString(out);
    },
  };
}

// Safari before 17.4 and older Android WebViews lack these.
if (typeof AbortSignal.any !== 'function') {
  AbortSignal.any = (signals) => {
    const ac = new AbortController();
    for (const s of signals) {
      if (s.aborted) {
        ac.abort(s.reason);
        break;
      }
      s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
    }
    return ac.signal;
  };
}

if (typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return ac.signal;
  };
}
