import { escapeHtml } from './escape.js';

export function SystemMessage({ content }) {
  const el = document.createElement('article');
  el.className = 'sv-bubble sv-system';
  el.innerHTML = `
    <div class="sv-role">system</div>
    <pre class="sv-body">${escapeHtml(content)}</pre>
  `;
  return el;
}
