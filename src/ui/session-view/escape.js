export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function flattenContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') {
        if (typeof p.text === 'string') return p.text;
        if (p.type === 'image_url' || p.image_url) return '[image]';
      }
      try { return JSON.stringify(p); } catch { return String(p); }
    }).join('\n');
  }
  if (typeof content === 'object') {
    try { return JSON.stringify(content, null, 2); } catch { return String(content); }
  }
  return String(content);
}

export function prettyJson(raw) {
  if (raw == null) return '';
  if (typeof raw === 'object') {
    try { return JSON.stringify(raw, null, 2); } catch { return String(raw); }
  }
  const s = String(raw);
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
