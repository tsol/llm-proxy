#!/usr/bin/env node
/**
 * Smoke-check malformedToolCallReason against the 2026-08-19 gonka-api dump.
 */
const assert = require('node:assert');
const path = require('node:path');

async function main() {
  const mod = await import(
    path.resolve(__dirname, '../src/services/garbage-detector.ts')
  );
  const malformedToolCallReason = mod.malformedToolCallReason ?? mod.default?.malformedToolCallReason;
  const isMalformedToolCalls = mod.isMalformedToolCalls ?? mod.default?.isMalformedToolCalls;

  const fromLog = [
    {
      function: {
        arguments: 'command": "/opt/data/workspace/madisson/content/run-approval.sh"} ',
        name: 'terminal',
      },
      id: 'functions.terminal:0',
      index: 0,
      type: 'function',
    },
    {
      function: { arguments: ' {"' },
      index: 0,
    },
  ];

  assert.strictEqual(malformedToolCallReason(fromLog), 'invalid_arguments_json');
  assert.ok(isMalformedToolCalls(fromLog));

  const missingName = [{ function: { arguments: '{}' }, index: 0 }];
  assert.strictEqual(malformedToolCallReason(missingName), 'missing_name');

  const ok = [{
    id: 'call_1',
    type: 'function',
    function: { name: 'terminal', arguments: '{"command":"ls"}' },
  }];
  assert.strictEqual(malformedToolCallReason(ok), null);
  assert.strictEqual(malformedToolCallReason(undefined), null);

  console.log('PASS  malformed tool_calls detector (001 garbage)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
