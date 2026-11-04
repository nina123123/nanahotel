// The phone apps have no backend: the same server code (src/server.js) runs inside the page. Requests the chat
// UI makes to /api/* are handed to createApp's handler through minimal stand-ins for Node's request/response
// objects; data lives in IndexedDB (shims/node-fs-promises.js).
import { createApp, buildDeps } from '../src/server.js';
import { DEFAULTS, DEFAULT_LIMITS } from '../src/config.js';
import { resolveLlmConfig } from '../src/llm/providers.js';
import { createLlmClient } from '../src/llm/client.js';
import { createScriptedLlm, demoScript } from '../src/llm/scripted-llm.js';
import { outboundFetch, originalFetch, hasBuiltInModel } from './native-fetch.js';

const DEMO_LLM = Object.freeze({ provider: 'scripted', label: '演示模式', model: 'demo-script', configured: true, keyEnv: '' });
// The Android app's native bridge adds the real key (built into the APK) to DeepSeek requests; the page never has it.
const BUILT_IN_KEY_PLACEHOLDER = 'built-in';

const quietLogger = { info() {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };

// DeepSeek renames models now and then; nobody using the app can change a setting, so try the next name instead.
const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-chat'];
const MODEL_KEY = 'xiaosu-model';

/**
 * An LLM client that moves on to the next model id when the provider says the current one doesn't exist,
 * and remembers the one that worked (onModel) so later launches start there.
 */
export function withModelFallback(makeClient, models, { start = 0, onModel = () => {} } = {}) {
  let index = Math.min(Math.max(start, 0), models.length - 1);
  let client = makeClient(models[index]);
  return {
    get provider() { return client.provider; },
    get model() { return models[index]; },
    async chat(args) {
      for (;;) {
        try {
          const out = await client.chat(args);
          onModel(models[index]);
          return out;
        } catch (err) {
          if (err?.reason !== 'model_not_found' || index >= models.length - 1) throw err;
          index += 1;
          client = makeClient(models[index]);
        }
      }
    },
  };
}

function savedModelIndex() {
  try {
    return Math.max(0, DEEPSEEK_MODELS.indexOf(localStorage.getItem(MODEL_KEY)));
  } catch {
    return 0;
  }
}

/** DeepSeek through the native bridge when the APK has a key built in; otherwise the scripted demo. */
function createLlm() {
  if (!hasBuiltInModel) return { config: DEMO_LLM, client: createScriptedLlm(demoScript, { delayMs: 12 }) };
  const config = resolveLlmConfig({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: BUILT_IN_KEY_PLACEHOLDER });
  const client = withModelFallback((model) => createLlmClient({ ...config, model, fetch: outboundFetch }), DEEPSEEK_MODELS, {
    start: savedModelIndex(),
    onModel: (model) => {
      try {
        localStorage.setItem(MODEL_KEY, model);
      } catch {
        // not remembered; the fallback just runs again next launch
      }
    },
  });
  return { config, client };
}

// ---------------------------------------------------------------------------------------------------------
// Node request/response stand-ins
// ---------------------------------------------------------------------------------------------------------

class Emitter {
  #listeners = new Map();

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push({ fn, once: false });
    this.listening?.(event);
    return this;
  }

  once(event, fn) {
    this.on(event, fn);
    this.#listeners.get(event).at(-1).once = true;
    return this;
  }

  off(event, fn) {
    const list = this.#listeners.get(event);
    if (list) this.#listeners.set(event, list.filter((l) => l.fn !== fn));
    return this;
  }

  emit(event, ...args) {
    const list = [...(this.#listeners.get(event) || [])];
    for (const l of list) {
      if (l.once) this.off(event, l.fn);
      l.fn(...args);
    }
    return list.length > 0;
  }
}
Emitter.prototype.addListener = Emitter.prototype.on;
Emitter.prototype.removeListener = Emitter.prototype.off;

class LocalRequest extends Emitter {
  #body;
  #flowing = false;

  constructor({ method, url, headers, body }) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.socket = { remoteAddress: '127.0.0.1' };
    this.complete = false;
    this.#body = body;
  }

  // The body is delivered once something starts reading it, like a paused Node stream.
  listening(event) {
    if (this.#flowing || (event !== 'data' && event !== 'end')) return;
    this.#flowing = true;
    queueMicrotask(() => {
      if (this.#body?.length) this.emit('data', this.#body);
      this.complete = true;
      this.emit('end');
    });
  }

  destroy() {}
}

class LocalResponse extends Emitter {
  #headers = {};
  #controller = null;
  #onHead;

  constructor(onHead) {
    super();
    this.#onHead = onHead;
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this.writableFinished = false;
    this.destroyed = false;
    this.socket = { destroyed: false, setNoDelay() {} };
  }

  setHeader(name, value) {
    this.#headers[String(name).toLowerCase()] = String(value);
  }

  getHeader(name) {
    return this.#headers[String(name).toLowerCase()];
  }

  hasHeader(name) {
    return String(name).toLowerCase() in this.#headers;
  }

  removeHeader(name) {
    delete this.#headers[String(name).toLowerCase()];
  }

  writeHead(status, ...rest) {
    if (this.headersSent) return this;
    const headers = rest.find((r) => r && typeof r === 'object');
    this.statusCode = status;
    if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    if (!this.hasHeader('date')) this.setHeader('date', new Date().toUTCString());
    this.headersSent = true;
    const stream = new ReadableStream({
      start: (c) => {
        this.#controller = c;
      },
      // The page stopped reading (e.g. it navigated away): same as a client disconnecting.
      cancel: () => this.disconnect(),
    });
    const body = [204, 304].includes(status) || this.req?.method === 'HEAD' ? null : stream;
    this.#onHead(new Response(body, { status, headers: this.#headers }));
    return this;
  }

  flushHeaders() {
    if (!this.headersSent) this.writeHead(this.statusCode);
  }

  write(chunk) {
    if (this.writableEnded || this.destroyed) return false;
    if (!this.headersSent) this.writeHead(this.statusCode);
    if (chunk != null && chunk !== '') {
      try {
        this.#controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      } catch {
        // the reader is gone
      }
    }
    return true;
  }

  end(chunk) {
    if (this.writableEnded) return this;
    if (chunk != null) this.write(chunk);
    else if (!this.headersSent) this.writeHead(this.statusCode);
    this.writableEnded = true;
    this.writableFinished = true;
    try {
      this.#controller?.close();
    } catch {
      // already closed
    }
    queueMicrotask(() => {
      this.emit('finish');
      this.emit('close');
    });
    return this;
  }

  /** The page aborted the request: the server sees a closed connection (e.g. 停止 during a reply). */
  disconnect(reason) {
    if (this.destroyed || this.writableFinished) return;
    this.destroyed = true;
    this.socket.destroyed = true;
    try {
      this.#controller?.error(reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    } catch {
      // already closed
    }
    this.req?.emit('close');
    this.emit('close');
  }
}

// ---------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------

let app = null;

function config(llm) {
  return {
    appName: DEFAULTS.appName,
    dataDir: '/xiaosu-data',
    publicDir: '/public',
    trustProxy: false,
    // Every copy of the app shares one DeepSeek key, so each phone gets a modest number of turns per 10 minutes.
    limits: { ...DEFAULT_LIMITS, chatTurnsPerWindow: 20, writesPerIpPerWindow: 0 },
    llm,
    webSearch: { provider: 'bocha', apiKey: '', enabled: false },
  };
}

function handleApi(url, init) {
  const method = String(init.method || 'GET').toUpperCase();
  const headers = {};
  new Headers(init.headers || {}).forEach((value, key) => {
    headers[key] = value;
  });
  let body = null;
  if (init.body != null && method !== 'GET' && method !== 'HEAD') {
    body = new TextEncoder().encode(String(init.body));
    headers['content-length'] = String(body.length);
  }
  const signal = init.signal;
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const req = new LocalRequest({ method, url: url.pathname + url.search, headers, body });
    const res = new LocalResponse(resolve);
    res.req = req;
    signal?.addEventListener('abort', () => {
      if (!res.headersSent) reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      res.disconnect(signal.reason);
    }, { once: true });
    app.handler(req, res).catch((err) => {
      console.error('[xiaosu] 本地服务出错', err);
      if (!res.headersSent) reject(new TypeError('本地服务出错'));
    });
  });
}

export async function startLocalServer() {
  const llm = createLlm();
  const deps = await buildDeps(config(llm.config), { llm: null, webSearch: { enabled: false }, fetch: outboundFetch, logger: quietLogger });
  app = createApp({ ...deps, config: config(llm.config), llm: llm.client, logger: quietLogger });

  globalThis.fetch = (input, init = {}) => {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(href, location.href);
    if (url.origin === location.origin && (url.pathname === '/api' || url.pathname.startsWith('/api/'))) {
      return handleApi(url, init);
    }
    return originalFetch(input, init);
  };

  // Read by the page: demo mode gets one quiet line saying the replies are scripted.
  globalThis.xiaosuApp = Object.freeze({ mode: hasBuiltInModel ? 'ai' : 'demo' });
}
