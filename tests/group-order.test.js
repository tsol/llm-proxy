#!/usr/bin/env node
/**
 * Validates the alias-group structure that the group-aware fallback relies on:
 * the "preferred" group (group[0]) holds the primary models, and escalation
 * groups (group[1]...) hold the paid backstop that must only be reached after
 * the preferred group is exhausted.
 */
const path = require('node:path');
const fs = require('node:fs');

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
const { getAliasGroups } = require('../dist/services/alias-store.js');

const groups = getAliasGroups('kimi');
assert.ok(groups && groups.length >= 2, `kimi should have >=2 groups, got ${groups && groups.length}`);

// Preferred group must hold the primary gonka members.
const g0 = groups[0];
assert.ok(['fastest', 'random', 'order'].includes(g0.strategy), `unexpected strategy ${g0.strategy}`);
assert.ok(g0.members.includes('gonka/moonshotai/Kimi-K2.6'), 'preferred group holds gonka Kimi');
assert.ok(g0.members.some((m) => m.startsWith('gonka-')), 'preferred group is all gonka family');
// Paid backstop lives in a LATER group (escalation) — must NOT be in group[0].
const paid = ['hyperfusion', 'openrouter/nvidia', 'deepseek/deepseek-v4-flash'];
for (const p of paid) {
  assert.ok(g0.members.every((m) => !m.includes(p)), `paid "${p}" must not be in preferred group[0]`);
}
const tail = groups.slice(1).flatMap((g) => g.members);
assert.ok(tail.some((m) => m.includes('hyperfusion/')), 'escalation group holds hyperfusion');
assert.ok(tail.some((m) => m.includes('deepseek/deepseek-v4-flash')), 'escalation group holds paid deepseek');

console.log('PASS  kimi groups: preferred = gonka family, paid backstop = later groups (escalation)');
console.log('PASS  group-aware fallback ordering is consistent with the store');
