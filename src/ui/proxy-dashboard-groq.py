#!/usr/bin/env python3
"""
Proxy Dashboard UI — single-file self-server
Live monitoring for LLM proxy (queues, model stats, active connections).
"""

import http.server
import socketserver
import webbrowser
import threading
import time

PORT = 8080

HTML_CONTENT = r"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Proxy Dashboard</title>
<style>
  :root {
    --bg: #0f1419;
    --bg2: #1a2332;
    --bg3: #243044;
    --border: #2e3d52;
    --text: #f0f4f8;
    --muted: #9aabbf;
    --accent: #4d9fff;
    --accent2: #2ee6ff;
    --ok: #34d399;
    --fail: #f87171;
    --warn: #fbbf24;
    --stale: #7a8ba0;
    --ok-bg: rgba(52, 211, 153, 0.12);
    --ok-border: rgba(52, 211, 153, 0.35);
    --fail-bg: rgba(248, 113, 113, 0.12);
    --fail-border: rgba(248, 113, 113, 0.35);
    --radius: 12px;
    --font: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', ui-monospace, monospace;
    --maxw: 920px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 15px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  body {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    align-items: center;
  }

  /* Shell: constrained on desktop */
  .shell {
    width: 100%;
    max-width: var(--maxw);
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    flex: 1;
  }

  /* Header */
  header {
    position: sticky;
    top: 0;
    z-index: 40;
    background: rgba(15, 20, 25, 0.94);
    backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--border);
    padding: 14px 20px 0;
    width: 100%;
  }

  .header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 700;
    font-size: 17px;
    letter-spacing: -0.02em;
  }

  .logo-dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 12px var(--ok);
    animation: pulse 2s ease-in-out infinite;
  }

  .logo-dot.offline {
    background: var(--fail);
    box-shadow: 0 0 12px var(--fail);
    animation: none;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.55; transform: scale(0.85); }
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
  }

  .meta .pill {
    background: var(--bg3);
    border: 1px solid var(--border);
    padding: 4px 10px;
    border-radius: 999px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text);
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
    padding-bottom: 0;
  }
  .tabs::-webkit-scrollbar { display: none; }

  .tab {
    flex: 0 0 auto;
    padding: 11px 16px;
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
    white-space: nowrap;
  }
  .tab:hover { color: var(--text); }
  .tab.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .tab .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    margin-left: 6px;
    border-radius: 999px;
    background: var(--bg3);
    font-size: 11px;
    font-family: var(--mono);
    color: var(--muted);
  }
  .tab.active .badge {
    background: rgba(77, 159, 255, 0.25);
    color: var(--accent);
  }

  /* Main */
  main {
    flex: 1;
    overflow-y: auto;
    padding: 18px 20px 36px;
    width: 100%;
  }

  .panel { display: none; }
  .panel.active { display: block; }

  /* Cards */
  .section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin: 22px 0 12px;
  }
  .section-title:first-child { margin-top: 0; }

  .card {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    margin-bottom: 12px;
    transition: background 0.2s, border-color 0.2s;
  }
  .card.status-ok {
    background: var(--ok-bg);
    border-color: var(--ok-border);
  }
  .card.status-fail {
    background: var(--fail-bg);
    border-color: var(--fail-border);
  }

  .card-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }

  .model-name, .alias-name {
    font-weight: 600;
    font-size: 14px;
    word-break: break-all;
    color: var(--text);
  }

  .provider {
    font-size: 12px;
    color: var(--muted);
    font-family: var(--mono);
    margin-top: 3px;
  }

  .counters {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
  }

  .counter {
    text-align: center;
    min-width: 46px;
  }
  .counter .val {
    font-family: var(--mono);
    font-size: 16px;
    font-weight: 600;
  }
  .counter .lbl {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .counter.ok .val { color: var(--ok); }
  .counter.fail .val { color: var(--fail); }
  .counter.total .val { color: var(--text); }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-family: var(--mono);
    font-weight: 600;
  }
  .status-pill.ok { background: rgba(52, 211, 153, 0.22); color: var(--ok); }
  .status-pill.fail { background: rgba(248, 113, 113, 0.22); color: var(--fail); }
  .status-pill.neutral { background: var(--bg3); color: var(--muted); }
  .status-pill.garbage { background: rgba(251, 191, 36, 0.22); color: var(--warn); }

  /* Progress bar */
  .bar-wrap {
    height: 7px;
    background: var(--bg3);
    border-radius: 4px;
    overflow: hidden;
    margin-top: 10px;
  }
  .bar {
    height: 100%;
    border-radius: 4px;
    background: linear-gradient(90deg, var(--accent), var(--accent2));
    transition: width 0.35s ease;
  }
  .bar.full { background: linear-gradient(90deg, var(--warn), var(--fail)); }

  .slots {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text);
    margin-top: 4px;
    font-weight: 500;
  }

  /* Live */
  .live-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 14px;
  }
  @media (min-width: 720px) {
    .live-grid { grid-template-columns: 1fr 1fr; }
  }

  .live-col h3 {
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .req-item {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 10px;
    transition: opacity 0.2s;
  }
  .req-item.stale {
    opacity: 0.6;
    border-color: #3a4a60;
  }
  .req-item.zombie {
    opacity: 0.4;
    border-style: dashed;
  }
  .req-preview {
    font-size: 13px;
    color: var(--text);
    line-height: 1.4;
  }
  .resp-hint {
    margin-top: 5px;
    font-size: 12px;
    color: var(--accent, #7aa7ff);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-word;
    opacity: 0.92;
  }
  .stream-dots {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3ddc84;
    margin-right: 6px;
    vertical-align: middle;
    animation: streamPulse 1s ease-in-out infinite;
  }
  @keyframes streamPulse {
    0%, 100% { opacity: 0.25; }
    50% { opacity: 1; }
  }
  .req-meta {
    margin-top: 8px;
    font-size: 11px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
  }
  .req-meta .bytes-live {
    color: #3ddc84;
    font-weight: 600;
  }

  .req-preview {
    font-size: 13px;
    color: var(--text);
    word-break: break-word;
    line-height: 1.45;
    font-weight: 450;
  }
  .req-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 10px;
    font-size: 12px;
    color: var(--muted);
    font-family: var(--mono);
  }

  .filter-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
    font-size: 14px;
    color: var(--muted);
  }
  .toggle input {
    appearance: none;
    width: 40px;
    height: 22px;
    background: var(--bg3);
    border-radius: 999px;
    position: relative;
    cursor: pointer;
    border: 1px solid var(--border);
    transition: background 0.2s;
  }
  .toggle input:checked {
    background: var(--accent);
    border-color: var(--accent);
  }
  .toggle input::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    background: white;
    border-radius: 50%;
    transition: transform 0.2s;
  }
  .toggle input:checked::after {
    transform: translateX(18px);
  }

  /* Recent */
  .recent-item {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 10px;
    transition: background 0.2s, border-color 0.2s;
  }
  .recent-item.status-ok {
    background: var(--ok-bg);
    border-color: var(--ok-border);
  }
  .recent-item.status-fail {
    background: var(--fail-bg);
    border-color: var(--fail-border);
  }
  .recent-item.stale { opacity: 0.65; }

  .recent-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }

  .recent-key {
    font-weight: 600;
    font-size: 14px;
    word-break: break-all;
  }

  .duration {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }

  .preview-pair {
    font-size: 13px;
    font-family: var(--mono);
    line-height: 1.5;
  }
  .preview-pair span.req { color: #d0dce8; }
  .preview-pair span.resp { color: #b8c9dc; }

  /* Alias detail */
  .group-card {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    margin-bottom: 14px;
  }
  .group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .group-key {
    font-weight: 600;
    font-size: 15px;
  }
  .strategy {
    font-size: 12px;
    font-family: var(--mono);
    color: var(--accent2);
    background: rgba(46, 230, 255, 0.12);
    padding: 3px 10px;
    border-radius: 6px;
  }

  .rank-badge {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    background: rgba(77, 159, 255, 0.16);
    border: 1px solid rgba(77, 159, 255, 0.35);
    border-radius: 5px;
    padding: 1px 6px;
    flex-shrink: 0;
  }

  .member {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 0;
    border-top: 1px solid var(--border);
    font-size: 14px;
  }
  .member:first-of-type { border-top: none; }

  .member-bar {
    width: 90px;
    height: 7px;
    background: var(--bg3);
    border-radius: 4px;
    overflow: hidden;
  }
  .member-bar > div {
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
  }

  .waiters {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px dashed var(--border);
  }
  .waiter {
    font-size: 13px;
    color: var(--text);
    font-family: var(--mono);
    padding: 4px 0;
  }

  .empty {
    text-align: center;
    padding: 48px 16px;
    color: var(--muted);
    font-size: 15px;
  }

  /* Footer */
  footer {
    text-align: center;
    padding: 14px;
    font-size: 12px;
    color: var(--muted);
    border-top: 1px solid var(--border);
    width: 100%;
  }
  footer code {
    font-family: var(--mono);
    color: var(--text);
    font-size: 11px;
  }

  /* Skeleton */
  .skel {
    background: linear-gradient(90deg, var(--bg2) 25%, var(--bg3) 50%, var(--bg2) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.2s infinite;
    border-radius: 10px;
    height: 72px;
    margin-bottom: 12px;
  }
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* Mobile */
  @media (max-width: 480px) {
    header { padding: 12px 14px 0; }
    main { padding: 14px; }
    .counters { gap: 6px; }
    .counter { min-width: 40px; }
    .counter .val { font-size: 14px; }
    .logo { font-size: 15px; }
  }

  /* Desktop breathing room */
  @media (min-width: 960px) {
    body {
      background: #0a0e13;
    }
    .shell {
      box-shadow: 0 0 0 1px var(--border), 0 24px 64px rgba(0,0,0,0.45);
      background: var(--bg);
    }
  }
</style>
</head>
<body>
<div class="shell">
<header>
  <div class="header-top">
    <div class="logo">
      <div class="logo-dot" id="statusDot"></div>
      <span>Proxy Dashboard</span>
    </div>
    <div class="meta">
      <span class="pill" id="pollAge">—</span>
      <span class="pill" id="lastUpdate">—</span>
    </div>
  </div>
  <nav class="tabs" id="tabs"></nav>
</header>

<main id="main">
  <div class="skel"></div>
  <div class="skel"></div>
  <div class="skel"></div>
</main>

<footer>
  Polling <code>http://127.0.0.1:5001/v1/router/queue</code> · every 1s
</footer>
</div>

<script>
(() => {
  const API = 'http://127.0.0.1:5001/v1/router/queue';
  const POLL_MS = 1000;
  const STALE_MS = 60_000;
  const ZOMBIE_MS = 10 * 60_000;

  let data = null;
  let lastOk = 0;
  let activeTab = 'main';
  let showZombies = false;
  let aliasTabs = [];

  const $ = (sel, el = document) => el.querySelector(sel);

  function fmtDur(ms) {
    if (ms == null || isNaN(ms)) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  function age(ts) {
    if (!ts) return null;
    return Date.now() - ts;
  }

  function isStale(ts) {
    return age(ts) > STALE_MS;
  }

  function isZombie(ts) {
    return age(ts) > ZOMBIE_MS;
  }

  function statusClass(code) {
    if (code === 0) return 'garbage';
    if (code >= 200 && code < 300) return 'ok';
    if (code >= 400) return 'fail';
    return 'neutral';
  }

  function fmtBytes(b) {
    if (b == null || isNaN(b)) return '—';
    const kb = b / 1024;
    if (kb < 1024) return kb.toFixed(0) + ' KB';
    return (kb / 1024).toFixed(1) + ' MB';
  }

  function fmtTps(t) {
    if (t == null || !isFinite(t) || t <= 0) return '—';
    return (t >= 10 ? t.toFixed(0) : t.toFixed(1)) + ' tok/s';
  }

  function statusLabel(code) {
    if (code === 0) return '000 · garbage';
    return code ?? '—';
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function truncate(s, n = 60) {
    if (!s) return '';
    s = String(s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function renderTabs() {
    const tabsEl = $('#tabs');
    const aliases = (data && data.aliasGroups)
      ? [...new Set(data.aliasGroups.map(g => g.alias))]
      : [];
    aliasTabs = aliases;

    const items = [
      { id: 'main', label: 'Models' },
      { id: 'live', label: 'Live', badge: liveCount() },
      ...aliases.map(a => ({ id: 'alias:' + a, label: a })),
      { id: 'recent', label: 'Recent', badge: (data && data.recent) ? data.recent.length : 0 },
    ];

    tabsEl.innerHTML = items.map(t => `
      <button class="tab ${activeTab === t.id ? 'active' : ''}" data-tab="${t.id}">
        ${escapeHtml(t.label)}
        ${t.badge != null ? `<span class="badge">${t.badge}</span>` : ''}
      </button>
    `).join('');

    tabsEl.querySelectorAll('.tab').forEach(btn => {
      btn.onclick = () => {
        activeTab = btn.dataset.tab;
        renderTabs();
        renderPanel();
      };
    });
  }

  function liveCount() {
    if (!data) return 0;
    let incoming = data.incoming || [];
    let active = data.active || [];
    if (!showZombies) {
      incoming = incoming.filter(i => !isZombie(i.startedAt));
      active = active.filter(a => !isZombie(a.startedAt));
    }
    return incoming.length + active.length;
  }

  function renderMain() {
    const stats = data.stats || {};
    const models = Object.entries(stats).sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
    const groups = data.aliasGroups || [];

    const aliasMap = {};
    groups.forEach(g => {
      if (!aliasMap[g.alias]) {
        aliasMap[g.alias] = { active: 0, limit: 0, waiters: 0, groups: 0 };
      }
      const a = aliasMap[g.alias];
      a.active += g.active || 0;
      a.limit += g.limit || 0;
      a.waiters += (g.waiters || []).length;
      a.groups += 1;
    });
    const aliases = Object.entries(aliasMap);

    let html = '';

    html += `<div class="section-title">── models ──</div>`;
    if (!models.length) {
      html += `<div class="empty">Нет статистики моделей<br><small>Запросы ещё не проходили</small></div>`;
    } else {
      models.forEach(([key, s]) => {
        const [provider, ...rest] = key.split(':');
        const model = rest.join(':') || key;
        const st = statusClass(s.lastStatus);
        const cardStatus = st === 'ok' ? 'status-ok' : (st === 'fail' ? 'status-fail' : '');
        const tp = (data.throughput || {})[key];
        html += `
          <div class="card ${cardStatus}">
            <div class="card-row">
              <div style="min-width:0">
                <div class="model-name">${escapeHtml(model)}</div>
                <div class="provider">${escapeHtml(provider)}</div>
              </div>
              <div class="counters">
                <div class="counter total"><div class="val">${s.total || 0}</div><div class="lbl">total</div></div>
                <div class="counter ok"><div class="val">${s.ok || 0}</div><div class="lbl">ok</div></div>
                <div class="counter fail"><div class="val">${s.fail || 0}</div><div class="lbl">fail</div></div>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;gap:14px;margin-top:12px;flex-wrap:wrap;font-family:var(--mono);font-size:12px;color:var(--muted)">
              <span>1h: <b style="color:var(--accent2)">${tp ? fmtTps(tp.h1.tps) : '—'}</b> · ${tp ? fmtBytes(tp.h1.bytes) : '—'} · ${tp ? tp.h1.count : 0} req</span>
              <span>24h: <b style="color:var(--accent2)">${tp ? fmtTps(tp.h24.tps) : '—'}</b> · ${tp ? fmtBytes(tp.h24.bytes) : '—'} · ${tp ? tp.h24.count : 0} req</span>
            </div>
            <div style="margin-top:12px">
              <span class="status-pill ${st}">${statusLabel(s.lastStatus)}</span>
            </div>
          </div>`;
      });
    }

    html += `<div class="section-title">── aliases ──</div>`;
    if (!aliases.length) {
      html += `<div class="empty">Нет активных алиасов</div>`;
    } else {
      aliases.forEach(([name, a]) => {
        const pct = a.limit ? Math.min(100, (a.active / a.limit) * 100) : 0;
        const full = a.limit > 0 && a.active >= a.limit;
        html += `
          <div class="card">
            <div class="card-row">
              <div>
                <div class="alias-name">${escapeHtml(name)}</div>
                <div class="provider">${a.groups} group${a.groups !== 1 ? 's' : ''}${a.waiters ? ' · ' + a.waiters + ' waiting' : ''}</div>
              </div>
              <div class="slots">${a.active} / ${a.limit}</div>
            </div>
            <div class="bar-wrap"><div class="bar ${full ? 'full' : ''}" style="width:${pct}%"></div></div>
          </div>`;
      });
    }

    return html;
  }

  function renderLive() {
    let incoming = data.incoming || [];
    let active = data.active || [];

    if (!showZombies) {
      incoming = incoming.filter(i => !isZombie(i.startedAt));
      active = active.filter(a => !isZombie(a.startedAt));
    }

    return `
      <div class="filter-row">
        <label class="toggle">
          <input type="checkbox" id="zombieToggle" ${showZombies ? 'checked' : ''}>
          <span>Show zombies</span>
        </label>
        <span style="font-size:13px;color:var(--muted)">stale &gt;60s · zombie &gt;10m</span>
      </div>
      <div class="live-grid">
        <div class="live-col">
          <h3>← Incoming <span class="badge" style="background:var(--bg3);padding:2px 8px;border-radius:999px;font-size:12px;color:var(--text)">${incoming.length}</span></h3>
          ${incoming.length ? incoming.map(renderIncoming).join('') : '<div class="empty">Нет входящих</div>'}
        </div>
        <div class="live-col">
          <h3>→ Active upstream <span class="badge" style="background:var(--bg3);padding:2px 8px;border-radius:999px;font-size:12px;color:var(--text)">${active.length}</span></h3>
          ${active.length ? active.map(renderActive).join('') : '<div class="empty">Нет активных</div>'}
        </div>
      </div>`;
  }

  function renderIncoming(item) {
    const a = age(item.startedAt);
    const stale = isStale(item.startedAt);
    const zombie = isZombie(item.startedAt);
    return `
      <div class="req-item ${stale ? 'stale' : ''} ${zombie ? 'zombie' : ''}">
        <div class="req-preview">${escapeHtml(truncate(item.preview, 100))}</div>
        <div class="req-meta">
          <span>${fmtDur(a)}</span>
          ${stale ? '<span>stale</span>' : ''}
          ${zombie ? '<span>zombie</span>' : ''}
        </div>
      </div>`;
  }

  function renderActive(item) {
    const a = age(item.startedAt);
    const idle = item.lastChunkAt ? Date.now() - item.lastChunkAt : a;
    const stale = isStale(item.startedAt);
    const zombie = isZombie(item.startedAt);
    const preview = (item.reqPreview || '') + (item.reqSuffix ? ' … ' + item.reqSuffix : '');
    const hint = item.respHint || '';
    const bytes = item.bytes || 0;
    // "Streaming" = we've received bytes, or last byte was recent (<60s).
    const streaming = bytes > 0 || idle < STALE_MS;
    return `
      <div class="req-item ${stale ? 'stale' : ''} ${zombie ? 'zombie' : ''}">
        <div class="req-preview"><span class="stream-dots"></span>${escapeHtml(truncate(preview, 90))}</div>
        ${hint ? `<div class="resp-hint">… ${escapeHtml(truncate(hint, 120))}</div>` : ''}
        <div class="req-meta">
          <span>${escapeHtml(item.provider)}/${escapeHtml(item.model)}</span>
          <span>start ${fmtDur(a)}</span>
          <span>last byte ${fmtDur(idle)}</span>
          <span class="bytes-live">${fmtBytes(bytes)}</span>
          ${streaming ? '' : '<span>silent</span>'}
          ${stale ? '<span>stale</span>' : ''}
          ${zombie ? '<span>zombie</span>' : ''}
        </div>
      </div>`;
  }

  function renderAlias(aliasName) {
    const groups = (data.aliasGroups || []).filter(g => g.alias === aliasName);
    if (!groups.length) return `<div class="empty">Нет данных для ${escapeHtml(aliasName)}</div>`;

    let html = '';
    groups.forEach(g => {
      const pct = g.limit ? Math.min(100, (g.active / g.limit) * 100) : 0;
      const full = g.limit > 0 && g.active >= g.limit;
      html += `
        <div class="group-card">
          <div class="group-header">
            <div class="group-key">${escapeHtml(g.key)}</div>
            <span class="strategy">${escapeHtml(g.strategy || '—')} (${g.limit || 0})</span>
          </div>
          <div class="slots" style="margin-bottom:8px">${g.active || 0} / ${g.limit || 0} slots</div>
          <div class="bar-wrap"><div class="bar ${full ? 'full' : ''}" style="width:${pct}%"></div></div>
          ${(g.members || []).slice().sort((x, y) => (x.rank || 0) - (y.rank || 0)).map(m => {
            const mp = m.limit ? Math.min(100, (m.active / m.limit) * 100) : 0;
            const s = (data.stats || {})[`${m.provider}:${m.model}`];
            const stTotal = (s && s.total) || 0;
            const stOk = (s && s.ok) || 0;
            const stFail = (s && s.fail) || 0;
            const mtp = (data.throughput || {})[`${m.provider}:${m.model}`];
            const shownFail = (m.failH1 != null) ? m.failH1 : stFail;
            return `
              <div class="member">
                <div style="min-width:0">
                  <div style="display:flex;align-items:center;gap:6px">
                    ${m.rank ? `<span class="rank-badge">#${m.rank}</span>` : ''}
                    <div style="font-weight:600">${escapeHtml(m.model)}</div>
                  </div>
                  <div class="provider">${escapeHtml(m.provider)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:12px">
                  <span class="slots">${m.active}/${m.limit}</span>
                  <div class="member-bar"><div style="width:${mp}%"></div></div>
                  <span style="font-family:var(--mono);font-size:12px;color:var(--accent2)">${mtp ? fmtTps(mtp.h1.tps) : '—'}</span>
                </div>
                <div style="display:flex;gap:12px;margin-top:10px;font-family:var(--mono);font-size:12px">
                  <span style="color:var(--text)">${stTotal} total</span>
                  <span style="color:var(--ok)">${stOk} ok</span>
                  <span style="color:var(--fail)">${shownFail} fail<span style="color:var(--muted)">/h</span></span>
                </div>
              </div>`;
          }).join('')}
          ${(g.waiters && g.waiters.length) ? `
            <div class="waiters">
              <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Waiters (${g.waiters.length})</div>
              ${g.waiters.map(w => `<div class="waiter">${escapeHtml(typeof w === 'string' ? w : JSON.stringify(w))}</div>`).join('')}
            </div>` : ''}
        </div>`;
    });
    return html;
  }

  function renderRecent() {
    const recent = (data.recent || []).slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    if (!recent.length) return `<div class="empty">Нет завершённых запросов</div>`;

    return recent.map(r => {
      const a = age(r.startedAt);
      const stale = isStale(r.startedAt);
      const st = statusClass(r.status);
      const cardStatus = st === 'ok' ? 'status-ok' : (st === 'fail' ? 'status-fail' : '');
      return `
        <div class="recent-item ${cardStatus} ${stale ? 'stale' : ''}">
          <div class="recent-top">
            <div class="recent-key">${escapeHtml(r.provider)}/${escapeHtml(r.model)}</div>
            <span class="status-pill ${st}">${statusLabel(r.status)}</span>
          </div>
          <div class="preview-pair">
            <span class="req">${escapeHtml(truncate(r.reqPreview, 55))}</span>
            ${r.respPreview ? ` <span class="resp">→ ${escapeHtml(truncate(r.respPreview, 45))}</span>` : ''}
          </div>
          <div class="req-meta" style="margin-top:8px">
            <span class="duration">${fmtDur(a)} ago</span>
          </div>
        </div>`;
    }).join('');
  }

  function renderPanel() {
    const main = $('#main');
    if (!data) {
      main.innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
      return;
    }

    let content = '';
    if (activeTab === 'main') content = renderMain();
    else if (activeTab === 'live') content = renderLive();
    else if (activeTab === 'recent') content = renderRecent();
    else if (activeTab.startsWith('alias:')) content = renderAlias(activeTab.slice(6));
    else content = renderMain();

    main.innerHTML = `<div class="panel active">${content}</div>`;

    const tog = $('#zombieToggle');
    if (tog) {
      tog.onchange = () => {
        showZombies = tog.checked;
        renderTabs();
        renderPanel();
      };
    }
  }

  async function poll() {
    try {
      const res = await fetch(API, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
      lastOk = Date.now();
      $('#statusDot').classList.remove('offline');
    } catch (e) {
      $('#statusDot').classList.add('offline');
    }
    updateMeta();
    renderTabs();
    renderPanel();
  }

  function updateMeta() {
    const ageSec = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
    $('#pollAge').textContent = ageSec != null ? (ageSec < 3 ? 'live' : ageSec + 's ago') : 'offline';
    $('#lastUpdate').textContent = lastOk
      ? new Date(lastOk).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—';
  }

  poll();
  setInterval(poll, POLL_MS);
  setInterval(updateMeta, 1000);
})();
</script>
</body>
</html>
"""


class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(HTML_CONTENT.encode("utf-8"))

    def log_message(self, format, *args):
        return


def open_browser():
    time.sleep(0.6)
    webbrowser.open(f"http://localhost:{PORT}")


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), DashboardHandler) as httpd:
        print(f"🚀 Дашборд запущен: http://localhost:{PORT}")
        print("Нажмите Ctrl+C для остановки.")
        threading.Thread(target=open_browser, daemon=True).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nСервер остановлен.")
