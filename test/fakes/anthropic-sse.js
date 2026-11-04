/**
 * Builders for Anthropic Messages API streams and responses, for fake-fetch scripts:
 *
 *   const body = anthropicSse(
 *     ev.start(),
 *     ...ev.text(0, 'On it!'),
 *     ...ev.tool(1, 'toolu_1', 'search_hotels', '{"city":"New York"}'),
 *     ev.delta('tool_use'),
 *     ev.stop(),
 *   );
 *   createFakeFetch([sseStep(body)]);
 */

const enc = new TextEncoder();

/** SSE text: each event object becomes `event: <type>\ndata: <json>\n\n`; strings pass through verbatim. */
export function anthropicSse(...events) {
  return events.flat().map((e) => (typeof e === 'string' ? e : `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)).join('');
}

/** A fake-fetch step that streams `text` in UTF-8 pieces of `size` bytes. */
export function sseStep(text, size = 11, headers = {}) {
  const bytes = enc.encode(text);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'request-id': 'req_test_1', ...headers }, chunks };
}

export const ev = {
  start(model = 'claude-opus-5-5', usage = { input_tokens: 25, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }) {
    return { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } };
  },
  /** content_block_start/delta…/stop for a text block; `text` may be an array of delta pieces. */
  text(index, text) {
    const pieces = Array.isArray(text) ? text : [text];
    return [
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      ...pieces.map((t) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } })),
      { type: 'content_block_stop', index },
    ];
  },
  /** A thinking block as Opus 5.5 streams it under the default display ("omitted"): empty text, then a signature. */
  thinking(index, signature = 'sig-abc', thinking = '') {
    return [
      { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
      ...(thinking ? [{ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } }] : []),
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
      { type: 'content_block_stop', index },
    ];
  },
  redacted(index, data = 'redacted-data') {
    return [
      { type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data } },
      { type: 'content_block_stop', index },
    ];
  },
  /** A tool_use block whose input arrives as input_json_delta pieces (`json` string or array of pieces). */
  tool(index, id, name, json, { stop = true } = {}) {
    const pieces = Array.isArray(json) ? json : [json];
    return [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
      ...pieces.filter((p) => p !== '').map((p) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: p } })),
      ...(stop ? [{ type: 'content_block_stop', index }] : []),
    ];
  },
  fallback(index, from = 'claude-opus-5-5', to = 'claude-opus-4-8') {
    return [
      { type: 'content_block_start', index, content_block: { type: 'fallback', from: { model: from }, to: { model: to } } },
      { type: 'content_block_stop', index },
    ];
  },
  delta(stopReason = 'end_turn', usage = { output_tokens: 42 }, stopDetails) {
    return { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, ...(stopDetails !== undefined ? { stop_details: stopDetails } : {}) }, usage };
  },
  stop() {
    return { type: 'message_stop' };
  },
  ping() {
    return { type: 'ping' };
  },
  error(type = 'overloaded_error', message = 'Overloaded') {
    return { type: 'error', error: { type, message } };
  },
};

/** A complete text answer as a stream. */
export function textAnswer(text, model) {
  return anthropicSse(ev.start(model), ev.text(0, text), ev.delta('end_turn'), ev.stop());
}

/** A non-streaming Messages API response body. */
export function anthropicMessage({ content = [], stop_reason = 'end_turn', model = 'claude-opus-5-5', usage = { input_tokens: 30, output_tokens: 12 }, stop_details } = {}) {
  return { id: 'msg_json', type: 'message', role: 'assistant', model, content, stop_reason, stop_sequence: null, ...(stop_details !== undefined ? { stop_details } : {}), usage };
}

/** An Anthropic error body. */
export function anthropicError(type, message) {
  return { type: 'error', error: { type, message }, request_id: 'req_err_1' };
}
