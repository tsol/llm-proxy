import { escapeHtml } from './escape.js';

export function AssistantMessage({ content, live = false }) {
  const el = document.createElement('article');
  el.className = 'sv-bubble sv-assistant' + (live ? ' sv-live' : '');
  el.innerHTML = `
    <div class="sv-role">${live ? 'model reply' : 'assistant'}</div>
    <pre class="sv-body">${escapeHtml(content || '(empty)')}</pre>
  `;
  return el;
}
