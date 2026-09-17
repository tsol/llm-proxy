import { flattenContent } from './escape.js';

function asObject(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function parseSseAssistant(raw) {
  const text = String(raw || '');
  if (!text.includes('data:')) return null;
  let content = '';
  const tools = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let json;
    try { json = JSON.parse(payload); } catch { continue; }
    const choice = json?.choices?.[0];
    const delta = choice?.delta || choice?.message;
    if (!delta) continue;
    if (typeof delta.content === 'string') content += delta.content;
    const calls = delta.tool_calls;
    if (Array.isArray(calls)) {
      for (const c of calls) {
        const idx = c.index ?? tools.size;
        const prev = tools.get(idx) || { id: '', name: '', arguments: '' };
        if (c.id) prev.id = c.id;
        if (c.function?.name) prev.name = c.function.name;
        if (typeof c.function?.arguments === 'string') prev.arguments += c.function.arguments;
        tools.set(idx, prev);
      }
    }
  }
  const toolCalls = [...tools.values()].filter((t) => t.name || t.arguments);
  if (!content && !toolCalls.length) return null;
  return { content, toolCalls };
}

function messageTurns(msg) {
  const role = String(msg?.role || '');
  if (role === 'system') {
    return [{ kind: 'system', content: flattenContent(msg.content) }];
  }
  if (role === 'user') {
    return [{ kind: 'user', content: flattenContent(msg.content) }];
  }
  if (role === 'tool') {
    return [{
      kind: 'tool',
      name: msg.name || '',
      toolCallId: msg.tool_call_id || '',
      content: flattenContent(msg.content),
    }];
  }
  if (role === 'assistant') {
    const turns = [];
    const content = flattenContent(msg.content);
    const toolCalls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((c) => ({
          id: c.id || '',
          name: c.function?.name || c.name || '',
          arguments: typeof c.function?.arguments === 'string'
            ? c.function.arguments
            : prettyMaybe(c.function?.arguments ?? c.arguments),
        }))
      : [];
    if (content || !toolCalls.length) {
      turns.push({ kind: 'assistant', content, live: false });
    }
    for (const tc of toolCalls) {
      turns.push({ kind: 'tool_call', ...tc });
    }
    return turns;
  }
  return [{ kind: 'assistant', content: flattenContent(msg), live: false }];
}

function prettyMaybe(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function parseResponseTurn(raw) {
  const obj = asObject(raw);
  if (obj && obj.choices && Array.isArray(obj.choices)) {
    const msg = obj.choices[0]?.message || obj.choices[0]?.delta;
    if (msg) return messageTurns({ role: 'assistant', ...msg }).map((t) => (
      t.kind === 'assistant' ? { ...t, live: true } : t
    ));
  }
  const sse = parseSseAssistant(raw);
  if (sse) {
    const turns = [];
    if (sse.content) turns.push({ kind: 'assistant', content: sse.content, live: true });
    for (const tc of sse.toolCalls) turns.push({ kind: 'tool_call', ...tc });
    return turns;
  }
  const text = String(raw || '').trim();
  if (!text) return [];
  return [{ kind: 'assistant', content: text, live: true }];
}

/** Build a linear list of session turns from stored client request + model response. */
export function parseSession(requestText, responseText) {
  const requestRaw = requestText == null ? '' : String(requestText);
  const responseRaw = responseText == null ? '' : String(responseText);
  const req = asObject(requestRaw);
  const messages = Array.isArray(req?.messages) ? req.messages : [];
  const turns = [];
  for (const msg of messages) turns.push(...messageTurns(msg));
  const responseTurns = parseResponseTurn(responseRaw);
  return {
    turns,
    responseTurns,
    model: req?.model || '',
    parseError: messages.length === 0 && requestRaw.trim() && !req
      ? 'request is not JSON chat.completions'
      : '',
    requestRaw,
    responseRaw,
  };
}
