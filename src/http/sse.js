const EVENT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform keeps compressing proxies from buffering the stream.
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // nginx buffers proxied responses unless told otherwise.
  'X-Accel-Buffering': 'no',
});

/** `event: x` + one `data:` line per line of JSON (JSON.stringify never emits raw newlines, but be strict). */
export function formatSseEvent(event, data) {
  if (!EVENT_RE.test(event)) throw new Error(`invalid SSE event name: ${event}`);
  const json = JSON.stringify(data ?? {}) ?? '{}';
  const lines = json.split(/\r\n|\r|\n/).map((l) => `data: ${l}`).join('\n');
  return `event: ${event}\n${lines}\n\n`;
}

/**
 * Server-sent events writer over an http.ServerResponse.
 * Writes are no-ops once the client has gone away, so callers never need to guard.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ heartbeatMs?: number, status?: number }} [opts]
 */
export function createSseWriter(res, { heartbeatMs = 15000, status = 200 } = {}) {
  let closed = false;
  let timer = null;
  const listeners = [];

  function markClosed() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    for (const fn of listeners.splice(0)) {
      try {
        fn();
      } catch {
        // a failing listener must not break the others
      }
    }
  }

  function write(chunk) {
    if (closed || res.writableEnded || res.destroyed) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      markClosed();
      return false;
    }
  }

  // Listen before writing so an early disconnect can never surface as an unhandled 'error'.
  res.on('close', markClosed);
  res.on('error', markClosed);
  // The client may already be gone, in which case 'close' fired before we listened.
  if (res.destroyed || res.socket?.destroyed) markClosed();

  if (!closed) {
    res.writeHead(status, SSE_HEADERS);
    res.socket?.setNoDelay?.(true);
    // An initial comment flushes headers through proxies and lets fetch() resolve immediately.
    write(': stream\n\n');
  }
  if (!closed && heartbeatMs > 0) {
    timer = setInterval(() => write(': ping\n\n'), heartbeatMs);
    timer.unref?.();
  }

  return {
    /** @returns {boolean} false when the client is gone */
    send(event, data) {
      return write(formatSseEvent(event, data));
    },
    comment(text = '') {
      return write(`: ${String(text).replace(/[\r\n]+/g, ' ')}\n\n`);
    },
    /** Runs `fn` once when the connection closes (client disconnect or end()). */
    onClose(fn) {
      if (closed) fn();
      else listeners.push(fn);
    },
    end() {
      if (timer) clearInterval(timer);
      if (!closed && !res.writableEnded) res.end();
      markClosed();
    },
    get closed() {
      return closed;
    },
  };
}
