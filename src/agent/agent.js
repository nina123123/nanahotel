import { randomUUID } from 'node:crypto';
import { LlmError } from '../llm/client.js';
import { neutralizeText, maskPhonesInText, closeDanglingBold } from './text.js';

/**
 * Tool-calling loop for one user turn: stream text deltas, run the requested tools (read-only ones
 * concurrently, then the ones that change something one at a time), emit status/cards, and repeat until the
 * model answers in text or maxSteps is reached. History handed back to the caller is always provider-valid:
 * every assistant tool_call message is followed by exactly one tool message per call, even when the
 * user stops or the LLM fails mid-turn.
 */

export const MAX_STEPS_TEXT = '这个问题有点复杂，我先停在这里…可以把需求说得更具体一点（城市、日期、预算），我接着帮你办。';
const EMPTY_REPLY_TEXT = '抱歉，我刚才没想好怎么回答，可以换个说法再问我一次吗？';
// Not every tool result has a card (web search, saving the profile), so this must not point at "the cards above".
const EMPTY_AFTER_TOOLS_TEXT = '查好了，不过我刚才没整理好回复。你想先看哪部分？';
const GENERIC_ERROR_TEXT = '出了点问题，请稍后再试。';
const HISTORY_LIMIT = 30;
const MAX_CALLS_PER_STEP = 8;
const MAX_TOOL_CONTENT_CHARS = 24000;
const MAX_USER_CHARS = 4000;
// Tools that write something: run after the reads of their step, in order, and skipped once the user stops.
const SEQUENTIAL_TOOLS = new Set([
  'prepare_booking', 'prepare_cancellation', 'save_profile',
  'quote_ride', 'request_early_checkin', 'check_in', 'request_service', 'reserve_dining', 'set_wakeup_call',
  'prepare_extension', 'check_out', 'request_invoice', 'draft_review',
]);
export const STOPPED_NOTICE = '（已停止）';
const INTERRUPTED_MARK = '…（回复被中断）';
const SKIPPED_AFTER_STOP = '用户已停止，本次调用未执行';

function isToolCallMessage(m) {
  return m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

/**
 * Repairs stored history: drops system messages (the prompt is rebuilt every turn), orphan tool messages,
 * and assistant tool_call messages whose results are incomplete (their text, if any, is kept).
 */
export function sanitizeHistory(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') continue;
    if (m.role === 'system' || m.role === 'tool') continue;
    if (!isToolCallMessage(m)) {
      if (m.role === 'user' || m.role === 'assistant') out.push(m);
      continue;
    }
    let j = i + 1;
    const results = [];
    while (j < list.length && list[j]?.role === 'tool') results.push(list[j++]);
    const ids = m.tool_calls.map((c) => c?.id);
    const complete = ids.every((id) => typeof id === 'string' && id && results.some((r) => r.tool_call_id === id)) && new Set(ids).size === ids.length;
    if (complete) {
      out.push(m);
      for (const id of ids) out.push(results.find((r) => r.tool_call_id === id));
    } else if (typeof m.content === 'string' && m.content.trim()) {
      out.push({ role: 'assistant', content: m.content });
    }
    i = j - 1;
  }
  return out;
}

/**
 * Keeps roughly the last `limit` messages. The window always starts on a user message, so it can never
 * open with a tool result or an assistant tool_call whose results were cut off.
 */
export function trimHistory(messages, limit = HISTORY_LIMIT) {
  const clean = sanitizeHistory(messages);
  if (clean.length <= limit) return clean;
  const start = clean.length - limit;
  let s = start;
  while (s < clean.length && clean[s].role !== 'user') s++;
  if (s >= clean.length) {
    s = start;
    while (s > 0 && clean[s].role !== 'user') s--;
  }
  return clean.slice(s);
}

/** The model's copy of a user message: no forged 【系统通知…】 prefix, bounded length. */
export function neutralizeUserText(text) {
  return neutralizeText(text).slice(0, MAX_USER_CHARS);
}

function historyOf(session) {
  if (Array.isArray(session)) return session;
  if (Array.isArray(session?.history)) return session.history;
  if (Array.isArray(session?.messages)) return session.messages;
  return [];
}

function isAbortError(err) {
  return err?.name === 'AbortError';
}

function isLlmError(err) {
  return err instanceof LlmError || (err?.name === 'LlmError' && typeof err.userMessage === 'string');
}

function phoneVaultOf(session) {
  try {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return {};
    const v = session.phoneVault;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    session.phoneVault = {};
    return session.phoneVault;
  } catch {
    return {};
  }
}

function createDisplay(now) {
  const items = [];
  let cur = null;
  const open = () => {
    cur = { role: 'assistant', text: '', cards: [], at: now().toISOString() };
    items.push(cur);
  };
  return {
    addText(t) {
      if (!t) return;
      if (!cur || cur.cards.length) open();
      cur.text += t;
    },
    addCard(card) {
      if (!cur) open();
      cur.cards.push(card);
    },
    addNotice(text) {
      items.push({ role: 'notice', text, at: now().toISOString() });
      cur = null;
    },
    /** True when new text would run straight on from earlier text with no card in between. */
    needsBreak: () => Boolean(cur && !cur.cards.length && cur.text.trim()),
    items: () => items
      .map((i) => (i.role === 'notice' ? { ...i } : { ...i, text: i.text.trim() }))
      .filter((i) => i.role === 'notice' || i.text || i.cards.length),
  };
}

function toolContentString(content) {
  let s;
  try {
    s = JSON.stringify(content ?? {});
  } catch {
    s = JSON.stringify({ error: '工具结果无法序列化' });
  }
  return s.length > MAX_TOOL_CONTENT_CHARS ? JSON.stringify({ error: '工具结果过长，已省略，请缩小查询范围' }) : s;
}

/**
 * Never throws. A user stop or an LLM error keeps the turn: `messages` holds the user message, every
 * completed step and, when text of the unfinished step reached the user, that text as a plain assistant
 * message; `display` ends with a notice item. Only content_filter drops the whole turn: it emits
 * `retract` ({}) so the client clears everything this turn showed (text and cards), then the canned
 * text as one `delta`.
 *
 * @param {{ llm: { chat: Function }, tools: { definitions: Function, execute: Function, statusText?: Function, discard?: Function },
 *           session: object|object[], userText: string, ctx?: { userId?: string, sessionId?: string },
 *           systemPrompt: string, emit?: (event: string, data: object) => void, signal?: AbortSignal,
 *           maxSteps?: number, historyLimit?: number, now?: () => Date, logger?: (err: unknown) => void }} opts
 *   session.phoneVault is created/updated in place: masked phone → full number for numbers typed in this session.
 * @returns {Promise<{ messages: object[], aborted: boolean, error: { code: string, message: string } | null,
 *   display: Array<{ role: 'assistant', text: string, cards: object[], at: string } | { role: 'notice', text: string, at: string }> }>}
 *   messages: the new history messages for this turn, always starting with the (masked) user message;
 *   [] only after content_filter. aborted: the user stopped. error: why the turn ended early (null otherwise).
 */
export async function runAgentTurn({
  llm,
  tools,
  session,
  userText,
  ctx = {},
  systemPrompt,
  emit,
  signal,
  maxSteps = 8,
  historyLimit = HISTORY_LIMIT,
  now = () => new Date(),
  logger = (err) => console.error('[agent]', err),
} = {}) {
  const send = (event, data) => {
    try {
      emit?.(event, data);
    } catch (err) {
      logger(err);
    }
  };
  const display = createDisplay(now);
  const vault = phoneVaultOf(session);
  // Phone numbers typed in chat reach the model only masked; tools resolve them through the vault.
  const turn = [{ role: 'user', content: maskPhonesInText(neutralizeText(userText), vault).slice(0, MAX_USER_CHARS) }];
  const toolCtx = { ...ctx, phoneVault: vault };
  // Text streamed in the step that is still running (not yet part of `turn`).
  let callText = '';
  let callTextShown = false;

  const say = (text) => {
    const piece = display.needsBreak() ? `\n\n${text}` : text;
    display.addText(piece);
    send('delta', { text: piece });
  };
  const done = () => ({ messages: turn, display: display.items(), aborted: false, error: null });
  const interrupted = ({ aborted = false, error = null }) => {
    // Text cut mid-stream may end inside **bold**; a finished step's text is kept as the model wrote it.
    const cut = callTextShown ? callText : closeDanglingBold(callText);
    const partial = cut.trim();
    if (partial) {
      if (!callTextShown) display.addText(cut);
      // The model should know what the user saw, and that it was cut off.
      turn.push({ role: 'assistant', content: `${partial}${INTERRUPTED_MARK}` });
    }
    display.addNotice(aborted ? STOPPED_NOTICE : `（回复中断：${error.message}）`);
    return { messages: turn, display: display.items(), aborted, error };
  };

  async function loop() {
    const history = sanitizeHistory(historyOf(session));
    let recent = trimHistory(history, historyLimit);
    let usedTools = false;
    let shrunk = false;
    let defs = [];
    try {
      defs = typeof tools?.definitions === 'function' ? tools.definitions(ctx) || [] : [];
    } catch (err) {
      logger(err);
    }

    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) return interrupted({ aborted: true });
      const messages = [{ role: 'system', content: String(systemPrompt ?? '') }, ...recent, ...turn];
      callText = '';
      callTextShown = false;
      let res;
      try {
        res = await llm.chat({
          messages,
          tools: defs,
          signal,
          onTextDelta: (t) => {
            if (typeof t !== 'string' || !t) return;
            const piece = !callText && display.needsBreak() ? `\n\n${t}` : t;
            callText += piece;
            send('delta', { text: piece });
          },
        });
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) return interrupted({ aborted: true });
        if (isLlmError(err) && err.code === 'content_filter') {
          // Neither the filtered user turn nor any partial answer is persisted, and flagged output must
          // not stay on screen either: the client drops this turn's text and cards before the canned reply.
          const text = err.userMessage;
          send('retract', {});
          send('delta', { text });
          return { messages: [], display: [{ role: 'assistant', text, cards: [], at: now().toISOString() }], aborted: false, error: { code: err.code, message: text } };
        }
        if (isLlmError(err) && err.reason === 'context_length' && !shrunk && !callText && recent.length) {
          shrunk = true;
          recent = trimHistory(history, 6);
          step--;
          continue;
        }
        if (!isLlmError(err)) logger(err);
        const error = isLlmError(err) ? { code: err.code, message: err.userMessage } : { code: 'internal', message: GENERIC_ERROR_TEXT };
        send('error', { message: error.message });
        return interrupted({ error });
      }

      const text = typeof res?.content === 'string' ? res.content : '';
      // A client that returned text without streaming it still has to reach the user.
      if (!callText && text) {
        callText = display.needsBreak() ? `\n\n${text}` : text;
        send('delta', { text: callText });
      }
      display.addText(callText);
      callTextShown = true;
      const calls = Array.isArray(res?.toolCalls) ? res.toolCalls.filter((c) => c && typeof c.name === 'string' && c.name) : [];

      if (!calls.length) {
        let finalText = text;
        if (!finalText.trim()) {
          finalText = usedTools ? EMPTY_AFTER_TOOLS_TEXT : EMPTY_REPLY_TEXT;
          say(finalText);
        }
        const msg = { role: 'assistant', content: finalText };
        if (res.reasoningContent) msg.reasoning_content = res.reasoningContent;
        if (res.encryptedContent) msg.encrypted_content = res.encryptedContent;
        turn.push(msg);
        return done();
      }

      usedTools = true;
      const used = new Set();
      const normalized = calls.map((c) => {
        let id = typeof c.id === 'string' && c.id.trim() ? c.id : '';
        if (!id || used.has(id)) id = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        used.add(id);
        return { id, name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}), invalid: Boolean(c.invalidArguments) };
      });
      const assistantMsg = {
        role: 'assistant',
        content: text || null,
        tool_calls: normalized.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.invalid ? '{}' : c.arguments } })),
      };
      if (res.reasoningContent) assistantMsg.reasoning_content = res.reasoningContent;
      if (res.encryptedContent) assistantMsg.encrypted_content = res.encryptedContent;

      const outcomes = await runTools(normalized, { tools, ctx: toolCtx, signal, send, logger });
      if (signal?.aborted) {
        // A stopped step never completes: its results stay out of history, its cards are not shown,
        // and a quote it prepared is withdrawn so it cannot be confirmed later.
        await discardOutcomes(normalized, outcomes, { tools, ctx: toolCtx, logger });
        return interrupted({ aborted: true });
      }
      const stepMessages = [assistantMsg];
      outcomes.forEach((o, i) => {
        if (o.card && typeof o.card === 'object') {
          display.addCard(o.card);
          send('card', { card: o.card });
        }
        stepMessages.push({ role: 'tool', tool_call_id: normalized[i].id, content: toolContentString(o.content) });
      });
      turn.push(...stepMessages);
      callText = '';
    }

    say(MAX_STEPS_TEXT);
    turn.push({ role: 'assistant', content: MAX_STEPS_TEXT });
    return done();
  }

  try {
    return await loop();
  } catch (err) {
    logger(err);
    if (signal?.aborted) return interrupted({ aborted: true });
    const error = { code: 'internal', message: GENERIC_ERROR_TEXT };
    send('error', { message: error.message });
    return interrupted({ error });
  }
}

async function runOne(call, { tools, ctx, logger }) {
  if (call.invalid) return { content: { error: '工具参数不是合法的 JSON（可能被截断），请检查后重新调用' } };
  try {
    const out = await tools.execute(call.name, call.arguments, ctx);
    return out && typeof out === 'object' ? out : { content: { error: '工具没有返回结果' } };
  } catch (err) {
    logger(err);
    return { content: { error: '工具执行失败，请稍后再试' } };
  }
}

function skipped() {
  return { content: { error: SKIPPED_AFTER_STOP }, skipped: true };
}

/**
 * Read-only tools start first and run concurrently; side-effecting ones run after all of them settled,
 * one at a time in their original order. The calls of one step were emitted together, so none depends on
 * another's result; running side effects last means a stop during a slow read (web_search) skips them
 * instead of leaving a quote that the stop then has to withdraw. Nothing new starts once the signal has
 * aborted. Outcomes keep the calls' original indexes.
 */
async function runTools(calls, { tools, ctx, signal, send, logger }) {
  const outcomes = new Array(calls.length);
  const pending = [];
  const sequential = [];
  const execCtx = { ...ctx, signal };
  const status = (call) => {
    if (call.invalid) return;
    let text = '';
    try {
      text = typeof tools.statusText === 'function' ? tools.statusText(call.name, call.arguments) : '';
    } catch {
      text = '';
    }
    send('status', { text: text || '正在处理…' });
  };
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (i >= MAX_CALLS_PER_STEP) {
      outcomes[i] = { content: { error: `一次最多调用${MAX_CALLS_PER_STEP}个工具，这个调用被跳过了，需要的话请再调用一次` } };
      continue;
    }
    if (SEQUENTIAL_TOOLS.has(call.name)) {
      sequential.push(i);
      continue;
    }
    if (signal?.aborted) {
      outcomes[i] = skipped();
      continue;
    }
    status(call);
    pending.push(runOne(call, { tools, ctx: execCtx, logger }).then((o) => {
      outcomes[i] = o;
    }));
  }
  await Promise.all(pending);
  for (const i of sequential) {
    if (signal?.aborted) {
      outcomes[i] = skipped();
      continue;
    }
    status(calls[i]);
    outcomes[i] = await runOne(calls[i], { tools, ctx: execCtx, logger });
  }
  return outcomes;
}

async function discardOutcomes(calls, outcomes, { tools, ctx, logger }) {
  if (typeof tools?.discard !== 'function') return;
  for (let i = 0; i < calls.length; i++) {
    const o = outcomes[i];
    if (!o || o.skipped) continue;
    try {
      await tools.discard(calls[i].name, o, ctx);
    } catch (err) {
      logger(err);
    }
  }
}
