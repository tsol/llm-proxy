import { escapeHtml, prettyJson } from './escape.js';

export function ToolResult({ name, content, toolCallId }) {
  const el = document.createElement('article');
  el.className = 'sv-bubble sv-toolresult';
  el.innerHTML = `
    <div class="sv-role">tool result${toolCallId ? ` · ${escapeHtml(toolCallId)}` : ''}</div>
    <div class="sv-toolname">${escapeHtml(name || 'tool')}</div>
    <pre class="sv-body">${escapeHtml(prettyJson(content))}</pre>
  `;
  return el;
}
