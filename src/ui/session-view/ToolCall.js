import { escapeHtml, prettyJson } from './escape.js';

export function ToolCall({ name, arguments: args, id }) {
  const el = document.createElement('article');
  el.className = 'sv-bubble sv-toolcall';
  const argText = prettyJson(args);
  el.innerHTML = `
    <div class="sv-role">tool call${id ? ` · ${escapeHtml(id)}` : ''}</div>
    <div class="sv-toolname">${escapeHtml(name || 'unknown')}</div>
    <pre class="sv-body">${escapeHtml(argText)}</pre>
  `;
  return el;
}
