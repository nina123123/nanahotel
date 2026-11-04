// node:http stand-in. In the apps nothing listens on a port: local-server.js calls the app's handler directly.
export function createServer() {
  return {
    listening: false,
    listen(...args) {
      const cb = args.find((a) => typeof a === 'function');
      if (cb) queueMicrotask(cb);
      return this;
    },
    close(cb) {
      if (cb) queueMicrotask(cb);
      return this;
    },
    address: () => ({ port: 0 }),
    on() { return this; },
    once() { return this; },
    off() { return this; },
    closeAllConnections() {},
    closeIdleConnections() {},
  };
}

export default { createServer };
