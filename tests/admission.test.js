#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const candidates = [
  process.env.PROXY_ENV_FILE,
  path.resolve(__dirname, '../../../../.env-proxy'),
  path.resolve(__dirname, '../.env'),
].filter(Boolean);
const envFile = candidates.find((p) => fs.existsSync(p));
if (envFile) process.env.PROXY_ENV_FILE = envFile;
const { admit } = require('../dist/jobs/admission.js');

const cap = { vram_mb: 8000, ram_mb: 32000, cpu: 8 };

function run(name, input, expectOk, check) {
  const d = admit(input);
  if (expectOk) {
    assert.equal(d.ok, true, `${name}: expected ok`);
    if (check) check(d);
  } else {
    assert.equal(d.ok, false, `${name}: expected fail`);
    if (check) check(d);
  }
  console.log('PASS', name);
}

run(
  'empty 6gb job',
  {
    capacity: cap,
    running: [],
    residents: [],
    job: { resources: { vram_mb: 6000, ram_mb: 4000, cpu: 1 }, requires: ['comfyui'], evicts: ['*'], shared: false },
  },
  true,
);

run(
  'evict comfy for lmstudio',
  {
    capacity: cap,
    running: [],
    residents: [{ key: 'comfyui', family: 'comfyui', up: true, idle_vram_mb: 3500, idle_ram_mb: 6000, last_used_at: 0 }],
    job: { resources: { vram_mb: 6500, ram_mb: 2000, cpu: 1 }, requires: ['lmstudio:m'], evicts: ['*'], shared: false },
  },
  true,
  (d) => assert.ok(d.evict.includes('comfyui')),
);

run(
  'video blocks llm',
  {
    capacity: cap,
    running: [{ key: 'j1', resources: { vram_mb: 7500, ram_mb: 8000, cpu: 2 }, holds: ['comfyui'], shared: false, gpu: true, etaAt: Date.now() + 600000 }],
    residents: [{ key: 'comfyui', family: 'comfyui', up: true, idle_vram_mb: 3500, idle_ram_mb: 6000, last_used_at: 0 }],
    job: { resources: { vram_mb: 6500, ram_mb: 2000, cpu: 1 }, requires: ['lmstudio:m'], evicts: ['*'], shared: true },
  },
  false,
);

run(
  'shared llm absorbed',
  {
    capacity: cap,
    running: [{ key: 'llm_1', resources: { vram_mb: 6500, ram_mb: 2000, cpu: 1 }, holds: ['lmstudio:m'], shared: true, gpu: true, etaAt: Date.now() + 60000 }],
    residents: [{ key: 'lmstudio:m', family: 'lmstudio', up: true, idle_vram_mb: 6500, idle_ram_mb: 2000, last_used_at: 0 }],
    job: { resources: { vram_mb: 6500, ram_mb: 2000, cpu: 1 }, requires: ['lmstudio:m'], evicts: ['*'], shared: true },
  },
  true,
  (d) => assert.equal(d.absorbed, true),
);

run(
  'lmstudio model conflict',
  {
    capacity: cap,
    running: [{ key: 'llm_1', resources: { vram_mb: 6500, ram_mb: 2000, cpu: 1 }, holds: ['lmstudio:a'], shared: true, gpu: true, etaAt: Date.now() + 60000 }],
    residents: [{ key: 'lmstudio:a', family: 'lmstudio', up: true, idle_vram_mb: 6500, idle_ram_mb: 2000, last_used_at: 0 }],
    job: { resources: { vram_mb: 6500, ram_mb: 2000, cpu: 1 }, requires: ['lmstudio:b'], evicts: ['*'], shared: false },
  },
  false,
);

run(
  'cpu with gpu running',
  {
    capacity: cap,
    running: [{ key: 'j1', resources: { vram_mb: 7500, ram_mb: 8000, cpu: 2 }, holds: ['comfyui'], shared: false, gpu: true, etaAt: Date.now() + 600000 }],
    residents: [{ key: 'comfyui', family: 'comfyui', up: true, idle_vram_mb: 3500, idle_ram_mb: 6000, last_used_at: 0 }],
    job: { resources: { vram_mb: 0, ram_mb: 500, cpu: 1 }, requires: [], evicts: [], shared: false },
  },
  true,
);

console.log('All admission tests passed');
