import { escapeHtml } from './escape.js';

export function UserMessage({ content }) {
  const el = document.createElement('article');
  el.className = 'sv-bubble sv-user';
  el.innerHTML = `
    <div class="sv-role">user</div>
    <pre class="sv-body">${escapeHtml(content)}</pre>
  `;
  return el;
}
