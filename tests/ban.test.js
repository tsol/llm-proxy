#!/usr/bin/env node
/**
 * Unit test for the temporary provider/model ban module.
 * Records ban signals and verifies a model trips the configured threshold and
 * becomes banned (excluded), then is unban-able.
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
else process.exit(2);

const assert = require('node:assert');
const ban = require('../dist/services/ban.js');
const { appConfig } = require('../dist/config.js');

assert.strictEqual(appConfig.banEnabled, true, 'ban should be enabled in test env');

const KEY = 'ban-test/fake-model';

// Should not be banned before any signals.
assert.strictEqual(ban.isModelBanned(KEY), false, 'not banned before signals');

// Not enough signals -> still not banned.
for (let i = 0; i < appConfig.banFailCount - 1; i++) ban.recordBanSignal(KEY, 'fail');
assert.strictEqual(ban.isModelBanned(KEY), false, `still not banned at < ${appConfig.banFailCount} fails`);

// Reach the FAIL threshold -> banned.
ban.recordBanSignal(KEY, 'fail');
assert.strictEqual(ban.isModelBanned(KEY), true, `banned at ${appConfig.banFailCount} fails`);
assert.ok(ban.banRemainingSec(KEY) > 0, 'ban has remaining time');
assert.ok(ban.bannedKeys().includes(KEY), 'banned key is listed');

// clearBan -> unbanned and clean.
ban.clearBan(KEY);
assert.strictEqual(ban.isModelBanned(KEY), false, 'unbanned after clearBan');

// zero-byte criterion also trips the ban (silent hanger case).
const ZK = 'ban-test/zero-byte-model';
for (let i = 0; i <= appConfig.banZeroByteCount; i++) ban.recordBanSignal(ZK, 'zero-byte');
assert.strictEqual(ban.isModelBanned(ZK), true, 'zero-byte count bans the silent hanger');

console.log('PASS  ban module: fail-count + zero-byte criteria ban, clearBan unbans');