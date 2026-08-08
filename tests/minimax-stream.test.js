#!/usr/bin/env node
/**
 * Unit test for the MiniMax agentic tool-call → standard OpenAI tool_calls
 * conversion, run against the compiled dist build.
 *
 * Regressions covered:
 *   1. Narration + `<minimax:tool_call>...</minimax:tool_call>` (the exact
 *      shape the user reported leaking through) is rewritten into a stream
 *      carrying a `tool_calls` delta + `finish_reason:"tool_calls"`, and the
 *      raw XML is stripped from content.
 *   2. Streams with NO minimax marker pass through byte-for-byte untouched.
 *   3. Non-MiniMax model + no marker → untouched (no accidental rewriting).
 */
const path = require('node:path');
const fs = require('node:fs');

// The dist module loads the app config at import time, which requires an env
// file. Point it at the repo's proxy env so the compiled helpers can load.
const candidates = [
  process.env.PROXY_ENV_FILE,
  path.resolve(__dirname, '../../../../.env-proxy'),
  path.resolve(__dirname, '../.env'),
].filter(Boolean);
const envFile = candidates.find((p) => fs.existsSync(p));
if (envFile) process.env.PROXY_ENV_FILE = envFile;
else {
  console.error('No proxy env file found; set PROXY_ENV_FILE to run this test.');
  process.exit(1);
}

const assert = require('node:assert');
const { rewriteStreamForMiniMax } = require('../dist/services/forward.js');

const NARRATION =
  'Понял. Контейнер с network_mode: host, а LLM_BASE_URL указывает на host.docker.internal — резолвится в пустоту. Правильный host из контейнера = 127.0.0.1. Меняю:';

const XML_TOOL_CALL = `<minimax:tool_call>
<invoke name="terminal">
<parameter name="command">ssh -i /opt/data/home/.ssh/id_ed25519 -o StrictHostKeyChecking=no root@37.60.235.35 \\
  "docker exec madisson-public sed -i 's|http://host.docker.internal:5001|http://127.0.0.1:5001|g' /opt/data/bot.py && \\
   docker exec madisson-public grep 'LLM_BASE_URL\\|127.0.0.1:5001\\|host.docker.internal' /opt/data/bot.py | head -5"</parameter>
<parameter name="timeout">15</parameter>
</invoke>
</minimax:tool_call>`;

const completionText = `${NARRATION}\n${XML_TOOL_CALL}`;
// Simulate the gonka buffered-stream chunks the proxy collects.
const chunks = [
  Buffer.from(
    'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"MiniMaxAI/MiniMax-M2.7","choices":[{"index":0,"delta":{"role":"assistant","content":"Понял. Контейнер"},"finish_reason":null}]}\n\n',
  ),
  Buffer.from(
    'data: {"choices":[{"index":0,"delta":{"content":" с network_mode: host"},"finish_reason":null}]}\n\n',
  ),
  ...XML_TOOL_CALL.split('\n').map((line, i) =>
    Buffer.from(
      `data: {"choices":[{"index":0,"delta":{"content":"${line}\\n"},"finish_reason":null}]}\n\n`,
    ),
  ),
  Buffer.from(
    'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"MiniMaxAI/MiniMax-M2.7","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
  ),
  Buffer.from('data: [DONE]\n\n', 'utf8'),
];

// ── Case 1: minimax model + embedded XML → rewritten stream ──
{
  const out = rewriteStreamForMiniMax(chunks, completionText, 'MiniMaxAI/MiniMax-M2.7');
  const joined = Buffer.concat(out).toString('utf8');

  // No raw agentic XML may survive in the rewritten stream.
  assert.ok(
    !joined.includes('<invoke') && !joined.includes('<minimax:tool_call>'),
    'raw minimax XML must be stripped from the rewritten stream',
  );
  // Narration survives in a content delta.
  assert.ok(joined.includes('Понял. Контейнер'), 'narration preserved');
  assert.ok(
    !joined.includes('network_mode: host') || joined.includes('host.docker.internal — резолвится'),
    'narration tail present',
  );
  // The tool call becomes a proper function call delta.
  const tcLine = joined.split('\n').find((l) => l.includes('"tool_calls"'));
  assert.ok(tcLine, 'rewritten stream contains a tool_calls delta');
  const tcBody = JSON.parse(tcLine.slice(5));
  const call = tcBody.choices[0].delta.tool_calls[0];
  assert.strictEqual(call.type, 'function');
  assert.strictEqual(call.function.name, 'terminal');
  const args = JSON.parse(call.function.arguments);
  assert.ok(args.command.includes('ssh -i /opt/data/home/.ssh/id_ed25519'));
  assert.strictEqual(args.timeout, '15');
  // finish_reason tool_calls frame present.
  assert.ok(joined.includes('"finish_reason":"tool_calls"'));
  // [DONE] still terminates.
  assert.ok(joined.includes('data: [DONE]'));
  // usage frame preserved.
  assert.ok(joined.includes('"usage"'), 'usage frame preserved');
  console.log('PASS  minimax tool_call XML → standard tool_calls stream');
}

// ── Case 2: no minimax marker → byte-for-byte passthrough ──
{
  const plainText = 'Просто текст без вызовов инструментов.';
  const plainChunks = [Buffer.from(`data: {"choices":[{"index":0,"delta":{"content":"${plainText}"},"finish_reason":null}]}\n\n`)];
  const out = rewriteStreamForMiniMax(plainChunks, plainText, 'MiniMaxAI/MiniMax-M2.7');
  assert.strictEqual(Buffer.concat(out).toString('utf8'), Buffer.concat(plainChunks).toString('utf8'));
  console.log('PASS  plain stream with minimax model passes through untouched');
}

// ── Case 3: non-minimax model, no marker → untouched ──
{
  const plainText = 'Скажи привет';
  const plainChunks = [Buffer.from(`data: {"choices":[{"index":0,"delta":{"content":"${plainText}"},"finish_reason":null}]}\n\n`)];
  const out = rewriteStreamForMiniMax(plainChunks, plainText, 'moonshotai/Kimi-K2.6');
  assert.strictEqual(Buffer.concat(out).toString('utf8'), Buffer.concat(plainChunks).toString('utf8'));
  console.log('PASS  non-minimax plain stream passes through untouched');
}

console.log('\nAll minimax streaming-conversion tests passed.');
