#!/usr/bin/env node
/**
 * Unit test for isRetryableUpstreamStatus — the policy that decides whether an
 * upstream HTTP status triggers a fallback along the alias chain.
 *
 * Maximal-resilience policy: ANY 4xx/5xx triggers fallback (>= 400), 1xx-3xx
 * do not. This prevents a single provider's 401 (rotated/paused key), 403,
 * 404 (missing model) or 5xx from being passed straight to the client and
 * killing a cron/agent while the chain could have absorbed it.
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
const { isRetryableUpstreamStatus } = require('../dist/services/forward.js');

// Should-Fallback statuses: all 4xx/5xx.
const shouldFallback = [400, 401, 402, 403, 404, 408, 409, 410, 413, 422, 425, 429, 500, 502, 503, 504];
for (const s of shouldFallback) {
  assert.ok(isRetryableUpstreamStatus(s), `status ${s} should trigger fallback`);
}

// Should-NOT-Fallback statuses: anything below 400 (redirects, client info).
const noFallback = [200, 301, 304, 399];
for (const s of noFallback) {
  assert.ok(!isRetryableUpstreamStatus(s), `status ${s} should NOT trigger fallback`);
}

// The concrete regression: the cron killer — provider auth error (401).
assert.ok(isRetryableUpstreamStatus(401), '401 (provider auth error) must trigger fallback');

console.log('PASS  isRetryableUpstreamStatus: all 4xx/5xx fallback, <400 passthrough');
console.log('\nAll fallback-status tests passed.');
