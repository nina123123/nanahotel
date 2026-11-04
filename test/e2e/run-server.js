// No-API-key demo and e2e target: the real app with a scripted LLM, simulated hotels and an in-memory store.
//   node test/e2e/run-server.js        (PORT / HOST / APP_NAME from env or .env; default http://localhost:8787)
import { loadConfig } from '../../src/config.js';
import { startServer } from '../../src/server.js';
import { createScriptedLlm, demoScript } from '../../src/llm/scripted-llm.js';

// A bare `node --test` treats every file under test/ as a test; a server that never exits would hang it.
if (process.env.NODE_TEST_CONTEXT) {
  console.log('[demo] skipped: this starts the demo server, it is not a test (run it with npm run demo).');
  process.exit(0);
}

const base = loadConfig();
const config = {
  ...base,
  dataDir: null,
  llm: { provider: 'scripted', label: 'Scripted demo', model: 'demo-script', configured: true, keyEnv: '' },
  webSearch: { provider: 'bocha', apiKey: '', enabled: false },
  // Always the demo, even with live keys in the environment or .env.
  live: null,
};

const running = await startServer({
  config,
  // A small per-chunk delay so the demo visibly streams like a real model.
  llm: createScriptedLlm(demoScript, { delayMs: 10 }),
  webSearch: { enabled: false },
});
console.log(`[demo] ${config.appName} scripted demo is running: ${running.url}`);
console.log('[demo] No API key needed: the replies are scripted, and hotels, prices, bookings and payments are simulated. Data is cleared on restart.');

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  running.close().then(() => process.exit(0), () => process.exit(1));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
