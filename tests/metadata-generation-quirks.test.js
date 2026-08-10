#!/usr/bin/env node
/**
 * Unit test for per-model generation-param quirks loaded from
 * model-metadata.json and applied in adaptForModel().
 *
 * Covers:
 *   1. MiniMax models on gonka get temperature/frequency_penalty/
 *      presence_penalty filled in when the client omits them.
 *   2. reasoning_effort from the specific M2.7 entry is still applied and
 *      MERGED with the MiniMaxAI/ prefix base (exact > prefix).
 *   3. Any MiniMax variant (prefix match) inherits the same generation knobs.
 *   4. Explicit client values are NOT overridden.
 *   5. Non-MiniMax models (Kimi) do NOT get MiniMax generation params.
 */
const path = require('node:path');
const fs = require('node:fs');

// The dist module loads the app config at import time, which requires an env
// file. Point it at the repo's proxy env so the compiled helpers can load.
const candidates = [
  process.env.PROXY_ENV_FILE,
  path.resolve(__dirname, '../../../../.env-proxy'),
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../../.env-proxy'),
].filter(Boolean);
const envFile = candidates.find((p) => fs.existsSync(p));
if (envFile) process.env.PROXY_ENV_FILE = envFile;
else {
  console.error('No proxy env file found; set PROXY_ENV_FILE to run this test.');
  process.exit(1);
}

const assert = require('node:assert');
const { adaptForModel } = require('../dist/services/forward.js');
const { getMetadataModelQuirks } = require('../dist/providers/metadata.js');

const gonkaQuirks = getMetadataModelQuirks('gonka');

function body(model, extra) {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  };
}

// 1. MiniMax M2.7 gets generation params (client did not set them)
{
  const out = adaptForModel(body('MiniMaxAI/MiniMax-M2.7'), 'gonka', 'MiniMaxAI/MiniMax-M2.7', gonkaQuirks);
  assert.strictEqual(out.temperature, 0.4, 'temperature applied');
  assert.strictEqual(out.frequency_penalty, 0.5, 'frequency_penalty applied');
  assert.strictEqual(out.presence_penalty, 0.3, 'presence_penalty applied');
}

// 2. reasoning_effort from the specific M2.7 entry is merged with prefix base
{
  const out = adaptForModel(body('MiniMaxAI/MiniMax-M2.7'), 'gonka', 'MiniMaxAI/MiniMax-M2.7', gonkaQuirks);
  assert.strictEqual(out.temperature, 0.4, 'prefix generation base still applied under M2.7');
  assert.strictEqual(out.reasoning_effort, 'low', 'M2.7 reasoning_effort merged (exact overrides prefix)');
}

// 3. Any MiniMax variant inherits the prefix generation knobs
{
  const out = adaptForModel(body('MiniMaxAI/MiniMax-M3'), 'gonka', 'MiniMaxAI/MiniMax-M3', gonkaQuirks);
  assert.strictEqual(out.temperature, 0.4, 'unknown MiniMax variant inherits temperature');
  assert.strictEqual(out.frequency_penalty, 0.5, 'unknown MiniMax variant inherits frequency_penalty');
  assert.strictEqual(out.presence_penalty, 0.3, 'unknown MiniMax variant inherits presence_penalty');
}

// 4. Explicit client value is NOT overridden
{
  const out = adaptForModel(
    body('MiniMaxAI/MiniMax-M2.7', { temperature: 0.9 }),
    'gonka',
    'MiniMaxAI/MiniMax-M2.7',
    gonkaQuirks,
  );
  assert.strictEqual(out.temperature, 0.9, 'client temperature preserved');
  assert.strictEqual(out.frequency_penalty, 0.5, 'gap still filled for frequency');
}

// 5. Non-MiniMax (Kimi) does NOT get MiniMax generation params
{
  const out = adaptForModel(body('moonshotai/Kimi-K2.6'), 'gonka', 'moonshotai/Kimi-K2.6', gonkaQuirks);
  assert.strictEqual(out.temperature, undefined, 'kimi has no temperature override');
  assert.strictEqual(out.frequency_penalty, undefined, 'kimi has no frequency_penalty override');
  assert.strictEqual(out.presence_penalty, undefined, 'kimi has no presence_penalty override');
}

console.log('✓ metadata-generation-quirks: all assertions passed');
