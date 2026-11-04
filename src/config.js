import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLlmConfig } from './llm/providers.js';
import { canonicalTimeZone, DEFAULT_TIME_ZONE } from './util/dates.js';

// The only module that reads process.env; everything else receives this config object.

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

export const DEFAULTS = Object.freeze({
  appName: 'NanaHotel',
  port: 8787,
  host: '127.0.0.1',
  dataDir: 'data',
  // "Today" and "tonight" for a request whose X-Time-Zone header is missing or not a real zone.
  timeZone: DEFAULT_TIME_ZONE,
});

export const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: 32 * 1024,
  maxMessageChars: 2000,
  // Per user: enough for a real booking conversation, low enough to cap LLM spend from one browser.
  chatTurnsPerWindow: 30,
  rateWindowMs: 10 * 60 * 1000,
  // X-User-Id is client-chosen, so writes (new sessions, chat turns, profile saves) are also capped per
  // client address. Behind a reverse proxy set TRUST_PROXY=1, or every user shares the proxy's bucket. 0 = off.
  // High enough for an office NAT or mobile CGNAT full of users; the per-user and in-flight caps still apply.
  writesPerIpPerWindow: 600,
  // Turns in flight: server-wide (independent of identity) and per user (a user can open many sessions).
  maxConcurrentTurns: 20,
  maxTurnsPerUser: 2,
  // Starting a new session drops that user's oldest ones beyond this.
  maxSessionsPerUser: 20,
});

const TRUE_RE = /^(1|true|yes|on)$/i;

function parseValue(raw) {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    let out = '';
    for (let i = 1; i < v.length; i++) {
      const ch = v[i];
      if (ch === q) return out;
      if (q === '"' && ch === '\\' && i + 1 < v.length) {
        const next = v[i + 1];
        out += ESCAPES[next] ?? `\\${next}`;
        i++;
      } else {
        out += ch;
      }
    }
    // Unterminated quote: keep the text literally rather than guessing.
    return v;
  }
  // Only " #" starts an inline comment, so API keys or URLs containing '#' survive.
  const hash = v.search(/\s#/);
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

/**
 * Parses .env text: `KEY=value`, optional `export `, '#' comment lines, inline ` # comments`
 * for unquoted values, 'single' (literal) and "double" (\n \t \" escapes) quoted values.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotEnv(text) {
  const out = {};
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    out[key] = parseValue(body.slice(eq + 1));
  }
  return out;
}

/**
 * Copies variables from a .env file into `target` without overriding keys that are already set.
 * A missing file is not an error (the .env file is optional).
 * @returns {string[]} the keys that were applied
 */
export function loadDotEnv(file, target) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const applied = [];
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (Object.hasOwn(target, key)) continue;
    target[key] = value;
    applied.push(key);
  }
  return applied;
}

function intIn(env, key, min, max, fallback) {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`The setting ${key} is invalid: "${raw}"; it should be a whole number from ${min} to ${max}`);
  }
  return n;
}

/**
 * Builds the app config from process env + optional .env file.
 * Empty values count as unset, so `LLM_MODEL=` in .env falls back to the provider default.
 *
 * @param {{ env?: Record<string, string|undefined>, envFile?: string|null, rootDir?: string }} [opts]
 */
export function loadConfig({ env = process.env, envFile, rootDir = ROOT_DIR } = {}) {
  const merged = { ...env };
  const file = envFile === undefined ? path.join(rootDir, '.env') : envFile;
  if (file) loadDotEnv(file, merged);
  const vars = {};
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string' && value.trim() !== '') vars[key] = value.trim();
  }

  const appName = (vars.APP_NAME || DEFAULTS.appName).slice(0, 20);
  const timeZone = vars.DEFAULT_TIME_ZONE ? canonicalTimeZone(vars.DEFAULT_TIME_ZONE) : DEFAULTS.timeZone;
  if (!timeZone) throw new Error(`The setting DEFAULT_TIME_ZONE is invalid: "${vars.DEFAULT_TIME_ZONE}"; it should be an IANA time zone like America/New_York`);
  const bochaKey = vars.BOCHA_API_KEY || '';
  return {
    appName,
    port: intIn(vars, 'PORT', 0, 65535, DEFAULTS.port),
    host: vars.HOST || DEFAULTS.host,
    rootDir,
    publicDir: path.join(rootDir, 'public'),
    dataDir: path.resolve(rootDir, vars.DATA_DIR || DEFAULTS.dataDir),
    timeZone,
    llm: resolveLlmConfig(vars),
    webSearch: { provider: 'bocha', apiKey: bochaKey, enabled: Boolean(bochaKey) },
    // Only behind a reverse proxy that sets X-Forwarded-For; otherwise clients could pick their own address.
    trustProxy: TRUE_RE.test(vars.TRUST_PROXY || ''),
    limits: {
      ...DEFAULT_LIMITS,
      chatTurnsPerWindow: intIn(vars, 'CHAT_TURNS_PER_WINDOW', 1, 100000, DEFAULT_LIMITS.chatTurnsPerWindow),
      writesPerIpPerWindow: intIn(vars, 'WRITES_PER_IP_PER_WINDOW', 0, 100000, DEFAULT_LIMITS.writesPerIpPerWindow),
    },
  };
}
