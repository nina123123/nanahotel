// No-API-key demo and e2e target: the real app with a scripted LLM, simulated hotels and an in-memory store.
//   node test/e2e/run-server.js        (PORT / HOST / APP_NAME from env or .env; default http://localhost:8787)
import { loadConfig } from '../../src/config.js';
import { startServer } from '../../src/server.js';
import { createScriptedLlm, demoScript } from '../../src/llm/scripted-llm.js';

// A bare `node --test` treats every file under test/ as a test; a server that never exits would hang it.
if (process.env.NODE_TEST_CONTEXT) {
  console.log('[demo] 跳过：这是演示服务启动脚本，不是测试（用 npm run demo 运行）。');
  process.exit(0);
}

const base = loadConfig();
const config = {
  ...base,
  dataDir: null,
  llm: { provider: 'scripted', label: '脚本演示', model: 'demo-script', configured: true, keyEnv: '' },
  webSearch: { provider: 'bocha', apiKey: '', enabled: false },
};

const running = await startServer({
  config,
  // A small per-chunk delay so the demo visibly streams like a real model.
  llm: createScriptedLlm(demoScript, { delayMs: 10 }),
  webSearch: { enabled: false },
});
console.log(`[demo] ${config.appName} 脚本演示版已启动：${running.url}`);
console.log('[demo] 不需要 API Key；大模型回复是预先写好的脚本，酒店、价格、订单与支付均为模拟，重启后数据清空。');

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  running.close().then(() => process.exit(0), () => process.exit(1));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
