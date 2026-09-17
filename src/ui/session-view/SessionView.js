import { parseSession } from './parseSession.js';
import { UserMessage } from './UserMessage.js';
import { AssistantMessage } from './AssistantMessage.js';
import { SystemMessage } from './SystemMessage.js';
import { ToolCall } from './ToolCall.js';
import { ToolResult } from './ToolResult.js';

function turnEl(turn) {
  switch (turn.kind) {
    case 'system': return SystemMessage(turn);
    case 'user': return UserMessage(turn);
    case 'assistant': return AssistantMessage(turn);
    case 'tool_call': return ToolCall(turn);
    case 'tool': return ToolResult(turn);
    default: return AssistantMessage({ content: JSON.stringify(turn) });
  }
}

/**
 * Reusable session inspector: RAW (request/response text) or PRETTY (bubbles).
 * @param {HTMLElement} root
 * @param {{ initialMode?: 'raw'|'pretty' }} [opts]
 */
export function createSessionView(root, opts = {}) {
  const storageKey = 'proxy-session-view-mode';
  let mode = opts.initialMode
    || (typeof localStorage !== 'undefined' && localStorage.getItem(storageKey))
    || 'pretty';
  if (mode !== 'raw' && mode !== 'pretty') mode = 'pretty';
  let last = { requestText: '', responseText: '' };

  root.classList.add('sv-root');
  root.innerHTML = `
    <div class="sv-toolbar">
      <div class="sv-toggle" role="tablist">
        <button type="button" data-mode="raw">RAW</button>
        <button type="button" data-mode="pretty">PRETTY</button>
      </div>
    </div>
    <div class="sv-raw" hidden>
      <div class="sv-raw-col">
        <h3>Request from client</h3>
        <textarea class="sv-req" readonly spellcheck="false"></textarea>
      </div>
      <div class="sv-raw-col">
        <h3>Response from model</h3>
        <textarea class="sv-resp" readonly spellcheck="false"></textarea>
      </div>
    </div>
    <div class="sv-pretty" hidden></div>
  `;

  const rawEl = root.querySelector('.sv-raw');
  const prettyEl = root.querySelector('.sv-pretty');
  const reqTa = root.querySelector('.sv-req');
  const respTa = root.querySelector('.sv-resp');
  const toggle = root.querySelector('.sv-toggle');

  function syncToggle() {
    toggle.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('on', btn.getAttribute('data-mode') === mode);
    });
    rawEl.hidden = mode !== 'raw';
    prettyEl.hidden = mode !== 'pretty';
  }

  function paintPretty() {
    prettyEl.replaceChildren();
    const parsed = parseSession(last.requestText, last.responseText);
    if (parsed.parseError) {
      const note = document.createElement('div');
      note.className = 'sv-note';
      note.textContent = parsed.parseError;
      prettyEl.appendChild(note);
    }
    if (parsed.model) {
      const meta = document.createElement('div');
      meta.className = 'sv-note';
      meta.textContent = 'model: ' + parsed.model;
      prettyEl.appendChild(meta);
    }
    if (!parsed.turns.length && !parsed.responseTurns.length) {
      const empty = document.createElement('div');
      empty.className = 'sv-note';
      empty.textContent = 'Nothing to render';
      prettyEl.appendChild(empty);
      return;
    }
    const hist = document.createElement('div');
    hist.className = 'sv-col';
    const h = document.createElement('h3');
    h.textContent = 'Request from client';
    hist.appendChild(h);
    if (!parsed.turns.length) {
      const pre = document.createElement('pre');
      pre.className = 'sv-fallback';
      pre.textContent = last.requestText || '(empty request)';
      hist.appendChild(pre);
    } else {
      for (const t of parsed.turns) hist.appendChild(turnEl(t));
    }
    prettyEl.appendChild(hist);

    const reply = document.createElement('div');
    reply.className = 'sv-col';
    const rh = document.createElement('h3');
    rh.textContent = 'Response from model';
    reply.appendChild(rh);
    if (!parsed.responseTurns.length) {
      const pre = document.createElement('pre');
      pre.className = 'sv-fallback';
      pre.textContent = last.responseText || '(empty response)';
      reply.appendChild(pre);
    } else {
      for (const t of parsed.responseTurns) reply.appendChild(turnEl(t));
    }
    prettyEl.appendChild(reply);
  }

  function paint() {
    reqTa.value = last.requestText || '(empty request)';
    respTa.value = last.responseText || '(empty response)';
    if (mode === 'pretty') paintPretty();
    syncToggle();
  }

  toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    mode = btn.getAttribute('data-mode');
    try { localStorage.setItem(storageKey, mode); } catch { /* ignore */ }
    paint();
  });

  function render({ requestText = '', responseText = '', mode: nextMode } = {}) {
    last = { requestText, responseText };
    if (nextMode === 'raw' || nextMode === 'pretty') mode = nextMode;
    paint();
  }

  function setMode(next) {
    if (next !== 'raw' && next !== 'pretty') return;
    mode = next;
    try { localStorage.setItem(storageKey, mode); } catch { /* ignore */ }
    paint();
  }

  syncToggle();
  return { render, setMode, getMode: () => mode };
}

export { parseSession };
export { createSessionView as SessionView };
