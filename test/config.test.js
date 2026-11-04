import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDotEnv, loadDotEnv, loadConfig, ROOT_DIR } from '../src/config.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hotel-agent-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('parseDotEnv: comments, export, quotes, inline comments and escapes', () => {
  const text = [
    '\uFEFF# 注释',
    'APP_NAME=小宿',
    '  export PORT = 9000  ',
    'EMPTY=',
    'SINGLE=\'a # not a comment \\n\'',
    'DOUBLE="line1\\nline2 \\"q\\"" # trailing comment',
    'INLINE=value # comment',
    'HASHY=sk-abc#123',
    'URL=https://example.com/v1?a=b=c',
    'BAD KEY=x',
    '1BAD=x',
    'NOEQUALS',
    'CRLF=yes\r',
  ].join('\n');
  assert.deepEqual(parseDotEnv(text), {
    APP_NAME: '小宿',
    PORT: '9000',
    EMPTY: '',
    SINGLE: 'a # not a comment \\n',
    DOUBLE: 'line1\nline2 "q"',
    INLINE: 'value',
    HASHY: 'sk-abc#123',
    URL: 'https://example.com/v1?a=b=c',
    CRLF: 'yes',
  });
});

test('parseDotEnv: an unterminated quote is kept literally', () => {
  assert.deepEqual(parseDotEnv('A="abc'), { A: '"abc' });
});

test('loadDotEnv never overrides keys that are already set, and a missing file is fine', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, '.env');
  await writeFile(file, 'A=from-file\nB=from-file\n');
  const target = { A: 'from-env', C: '' };
  assert.deepEqual(loadDotEnv(file, target), ['B']);
  assert.deepEqual(target, { A: 'from-env', B: 'from-file', C: '' });
  assert.deepEqual(loadDotEnv(path.join(dir, 'missing.env'), target), []);
});

test('loadConfig: defaults without any env', () => {
  const config = loadConfig({ env: {}, envFile: null });
  assert.equal(config.appName, '小宿');
  assert.equal(config.port, 8787);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.rootDir, ROOT_DIR);
  assert.equal(config.publicDir, path.join(ROOT_DIR, 'public'));
  assert.equal(config.dataDir, path.join(ROOT_DIR, 'data'));
  assert.equal(config.llm.provider, 'deepseek');
  assert.equal(config.llm.model, 'deepseek-v4-flash');
  assert.equal(config.llm.configured, false);
  assert.deepEqual(config.webSearch, { provider: 'bocha', apiKey: '', enabled: false });
  assert.equal(config.limits.maxBodyBytes, 32 * 1024);
  assert.equal(config.limits.maxMessageChars, 2000);
  assert.equal(config.limits.writesPerIpPerWindow, 600);
  assert.equal(config.limits.chatTurnsPerWindow, 30);
  assert.equal(config.limits.maxConcurrentTurns, 20);
  assert.equal(config.limits.maxTurnsPerUser, 2);
  assert.equal(config.limits.maxSessionsPerUser, 20);
  assert.equal(config.trustProxy, false);
});

test('loadConfig: TRUST_PROXY turns on X-Forwarded-For only for explicit true values', () => {
  for (const v of ['1', 'true', 'ON', 'yes']) assert.equal(loadConfig({ env: { TRUST_PROXY: v }, envFile: null }).trustProxy, true, v);
  for (const v of ['', '0', 'false', 'no', 'maybe']) assert.equal(loadConfig({ env: { TRUST_PROXY: v }, envFile: null }).trustProxy, false, v);
});

test('loadConfig: reads the .env file, real env wins, empty values mean "use the default"', async (t) => {
  const dir = await tempDir(t);
  const envFile = path.join(dir, '.env');
  await writeFile(envFile, [
    'APP_NAME="旅行小助手"',
    'PORT=9100',
    'HOST=0.0.0.0',
    'DATA_DIR=var/db',
    'LLM_PROVIDER=qwen',
    'LLM_MODEL=',
    'DASHSCOPE_API_KEY=sk-file',
    'BOCHA_API_KEY=bocha-file',
  ].join('\n'));
  const env = { PORT: '9200', DASHSCOPE_API_KEY: 'sk-env' };
  const config = loadConfig({ env, envFile, rootDir: dir });
  assert.equal(config.appName, '旅行小助手');
  assert.equal(config.port, 9200);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.dataDir, path.join(dir, 'var', 'db'));
  assert.equal(config.llm.provider, 'qwen');
  assert.equal(config.llm.model, 'qwen-flash');
  assert.equal(config.llm.apiKey, 'sk-env');
  assert.equal(config.llm.configured, true);
  assert.equal(config.webSearch.enabled, true);
  assert.equal(config.webSearch.apiKey, 'bocha-file');
  assert.deepEqual(env, { PORT: '9200', DASHSCOPE_API_KEY: 'sk-env' }, 'the caller\'s env object is not mutated');
});

test('loadConfig: the default .env location is <rootDir>/.env', async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, '.env'), 'DEEPSEEK_API_KEY=sk-x\nAPP_NAME=一个非常非常非常非常非常非常非常长的名字超过二十个字\n');
  const config = loadConfig({ env: {}, rootDir: dir });
  assert.equal(config.llm.configured, true);
  assert.equal(config.appName.length, 20);
});

test('loadConfig: an invalid PORT fails fast with a Chinese message', () => {
  assert.throws(() => loadConfig({ env: { PORT: 'abc' }, envFile: null }), /PORT 无效/);
  assert.throws(() => loadConfig({ env: { PORT: '70000' }, envFile: null }), /PORT 无效/);
  assert.equal(loadConfig({ env: { PORT: '0' }, envFile: null }).port, 0);
});

test('loadConfig: the per-user and per-address limits can be tuned (0 turns the address limit off)', () => {
  const tuned = loadConfig({ env: { WRITES_PER_IP_PER_WINDOW: '500', CHAT_TURNS_PER_WINDOW: '50' }, envFile: null });
  assert.equal(tuned.limits.writesPerIpPerWindow, 500);
  assert.equal(tuned.limits.chatTurnsPerWindow, 50);
  assert.equal(tuned.limits.maxConcurrentTurns, 20, 'the other limits keep their defaults');
  assert.equal(loadConfig({ env: { WRITES_PER_IP_PER_WINDOW: '0' }, envFile: null }).limits.writesPerIpPerWindow, 0);
  for (const [key, value] of [['WRITES_PER_IP_PER_WINDOW', '-1'], ['WRITES_PER_IP_PER_WINDOW', 'lots'], ['CHAT_TURNS_PER_WINDOW', '0'], ['CHAT_TURNS_PER_WINDOW', '1.5']]) {
    assert.throws(() => loadConfig({ env: { [key]: value }, envFile: null }), new RegExp(`${key} 无效`), `${key}=${value}`);
  }
});

test('.env.example documents every variable config/providers read', async () => {
  const example = parseDotEnv(await readFile(path.join(ROOT_DIR, '.env.example'), 'utf8'));
  for (const key of ['APP_NAME', 'PORT', 'HOST', 'DATA_DIR', 'TRUST_PROXY', 'CHAT_TURNS_PER_WINDOW', 'WRITES_PER_IP_PER_WINDOW', 'LLM_PROVIDER', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_API_KEY',
    'LLM_THINKING', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'MOONSHOT_API_KEY', 'ZHIPUAI_API_KEY', 'ARK_API_KEY', 'BOCHA_API_KEY']) {
    assert.ok(Object.hasOwn(example, key), `.env.example is missing ${key}`);
  }
  // Copying the example verbatim must give a working (if unconfigured) setup.
  const config = loadConfig({ env: {}, envFile: path.join(ROOT_DIR, '.env.example') });
  assert.equal(config.llm.provider, 'deepseek');
  assert.equal(config.llm.model, 'deepseek-v4-flash');
  assert.equal(config.llm.configured, false);
  assert.equal(config.trustProxy, false);
  assert.equal(config.limits.writesPerIpPerWindow, 600);
  assert.equal(config.limits.chatTurnsPerWindow, 30);
});

test('src/config.js is the only module under src/ that reads process.env', async () => {
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js') && full !== path.join(ROOT_DIR, 'src', 'config.js')) {
        const code = await readFile(full, 'utf8');
        if (/process\.env\b/.test(code)) offenders.push(path.relative(ROOT_DIR, full));
      }
    }
  }
  await walk(path.join(ROOT_DIR, 'src'));
  assert.deepEqual(offenders, []);
});
