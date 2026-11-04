/**
 * Scripted `fetch` for unit tests (no network). Each call consumes the next step of the script:
 *
 *   const fetch = createFakeFetch([
 *     { match: { method: 'POST', url: /bochaai/ }, status: 200, json: { code: 200, data: {} } },
 *     { status: 429, json: { code: 429 } },
 *     { error: new TypeError('fetch failed') },          // network failure
 *     { chunks: ['data: {"a":1}\n\n', 'data: [DONE]\n\n'], headers: { 'content-type': 'text/event-stream' } },
 *     (req) => new Response('ok'),                         // full control
 *   ]);
 *   fetch.calls  // [{ url, method, headers, body, json, signal }]
 *
 * A step may also set `delayMs` (respects AbortSignal) and `chunkDelayMs` for streamed bodies.
 * Passing a function instead of an array answers every call with `fn(req, index)`.
 */
export function createFakeFetch(script = []) {
  const steps = Array.isArray(script) ? [...script] : null;
  const calls = [];

  async function fakeFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const body = typeof init.body === 'string' ? init.body : init.body === undefined ? undefined : String(init.body);
    let json;
    try {
      json = body === undefined ? undefined : JSON.parse(body);
    } catch {
      json = undefined;
    }
    const req = { url, method, headers, body, json, signal: init.signal };
    const index = calls.length;
    calls.push(req);

    let step;
    if (steps) {
      if (!steps.length) throw new Error(`fake-fetch: unexpected request #${index + 1} ${method} ${url}`);
      step = steps.shift();
    } else {
      step = script;
    }
    if (typeof step === 'function') step = await step(req, index);
    if (step instanceof Response) return step;
    step = step || {};

    if (step.match) assertMatch(step.match, req, index);
    if (step.delayMs) await wait(step.delayMs, init.signal);
    if (init.signal?.aborted) throw abortError(init.signal);
    if (step.error) throw step.error;
    return buildResponse(step, init.signal);
  }

  fakeFetch.calls = calls;
  fakeFetch.pending = () => (steps ? steps.length : Infinity);
  return fakeFetch;
}

/** JSON response helper. */
export function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function assertMatch(match, req, index) {
  const problems = [];
  if (match.method && match.method.toUpperCase() !== req.method) problems.push(`method ${req.method} ≠ ${match.method}`);
  if (match.url instanceof RegExp ? !match.url.test(req.url) : match.url && match.url !== req.url) problems.push(`url ${req.url} ≠ ${match.url}`);
  if (problems.length) throw new Error(`fake-fetch: request #${index + 1} did not match: ${problems.join('; ')}`);
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('This operation was aborted', 'AbortError');
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function buildResponse(step, signal) {
  const status = step.status ?? 200;
  const headers = { ...(step.headers || {}) };
  let body = null;
  if (step.json !== undefined) {
    body = JSON.stringify(step.json);
    headers['content-type'] ??= 'application/json';
  } else if (step.chunks) {
    body = streamOf(step.chunks, step.chunkDelayMs || 0, signal);
  } else if (step.body !== undefined) {
    body = step.body;
  }
  return new Response(body, { status, statusText: step.statusText || '', headers });
}

function streamOf(chunks, delayMs, signal) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(abortError(signal));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (delayMs) {
        try {
          await wait(delayMs, signal);
        } catch (err) {
          controller.error(err);
          return;
        }
      }
      const c = chunks[i++];
      controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
    },
  });
}
