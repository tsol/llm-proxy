#!/usr/bin/env tsx
/**
 * Stress test for the preferred-group pool (in_prefered_group).
 *
 * Sends N concurrent requests to the alias `kimi`, staggered by INTERVAL_MS,
 * each with a long prompt and large max_tokens (so requests remain in flight
 * long enough to saturate the 5-slot group). Then tails logs/proxy.log to
 * report which provider+model served each request.
 *
 * Usage:
 *   cd workspace/code/proxy && npx tsx scripts/stress-group-pool.ts 6 --interval=300
 */
import http from 'http';
import fs from 'fs';
import path from 'path';

const PROXY = process.env.PROXY_URL ?? 'http://127.0.0.1:5001';
const ALIAS = process.env.TEST_ALIAS ?? 'kimi';
const LOG =
  process.env.PROXY_LOG ??
  path.resolve(__dirname, '..', '..', '..', '..', 'logs', 'proxy.log');

const CONCURRENCY = Number(process.argv[2] ?? 3);
const INTERVAL_MS = parseArgInt('--interval', 300);
const MAX_TOKENS = 2500;

function parseArgInt(key: string, def: number): number {
  const hit = process.argv.find((a) => a.startsWith(`${key}=`));
  if (hit) {
    const v = Number(hit.split('=')[1]);
    return Number.isFinite(v) ? v : def;
  }
  return def;
}

function longPrompt(index: number): string {
  return `Request #${index}: Please write a long, original, detailed essay about the history of distributed computing, the rise of large language models, the evolution of MoE architectures, the economics of decentralized GPU inference, and where open-weight AI is heading. Include unique examples specific to request #${index}, structured headings, and a conclusion. Write at least 800 words.`;
}

interface ReqResult {
  index: number;
  startedAt: number;
  finishedAt: number;
  status: number;
  model: string | null;
  preview: string;
  error?: string;
}

function sendRequest(index: number): Promise<ReqResult> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: ALIAS,
      messages: [
        { role: 'system', content: 'You are a helpful assistant who writes in detail.' },
        { role: 'user', content: longPrompt(index) },
      ],
      stream: false,
      max_tokens: MAX_TOKENS,
    });

    const u = new URL(`${PROXY}/v1/chat/completions`);
    const startedAt = Date.now();
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c.toString('utf8')));
        res.on('end', () => {
          let model: string | null = null;
          let preview = '';
          try {
            const parsed = JSON.parse(body);
            model = parsed.model ?? null;
            preview = (parsed.choices?.[0]?.message?.content ?? '').slice(0, 80);
          } catch {
            preview = body.slice(0, 80);
          }
          resolve({
            index,
            startedAt,
            finishedAt: Date.now(),
            status: res.statusCode ?? 0,
            model,
            preview,
          });
        });
      },
    );
    req.on('error', (err) =>
      resolve({
        index,
        startedAt,
        finishedAt: Date.now(),
        status: 0,
        model: null,
        preview: '',
        error: err.message,
      }),
    );
    req.end(payload);
  });
}

async function main(): Promise<void> {
  if (Number.isNaN(CONCURRENCY) || CONCURRENCY <= 0 || !Number.isFinite(CONCURRENCY)) {
    console.log('Usage: tsx scripts/stress-group-pool.ts <N> [--interval=MS]');
    process.exit(1);
  }

  console.log(
    `\n=== Stress test: ${CONCURRENCY} concurrent "${ALIAS}" requests, interval=${INTERVAL_MS}ms ==========`,
  );

  const logSizeBefore = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;

  const sends: Promise<ReqResult>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    console.log(`[${new Date().toISOString().slice(11, 23)}] #${i} SENDING`);
    sends.push(sendRequest(i));
    if (i < CONCURRENCY - 1) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  const results = await Promise.all(sends);

  console.log(`\n=== Responses =============================================`);
  let ok = 0;
  for (const r of results) {
    const dt = ((r.finishedAt - r.startedAt) / 1000).toFixed(1);
    const tag = r.status === 200 ? 'OK' : 'FAIL';
    if (r.status === 200) ok++;
    console.log(
      `#${r.index} ${tag}  ${r.status}  ${dt}s  model=${r.model ?? '?'}  preview="${r.preview}"${r.error ? ' err=' + r.error : ''}`,
    );
  }
  console.log(`\nSUCCESS ${ok}/${results.length}`);

  console.log(`\n=== Routing trace (from ${LOG}) ==========================`);
  let trace = '';
  if (fs.existsSync(LOG)) {
    const fd = fs.openSync(LOG, 'r');
    const stats = fs.fstatSync(fd);
    const start = Math.min(logSizeBefore, stats.size);
    const buf = Buffer.alloc(stats.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    trace = buf.toString('utf8');
  }
  const lines = trace.split('\n').filter((l) =>
    /→ OUT|← IN|fallback|OK {3}\[root\]|ERR {2}\[root\]|\[queue\]|preferred-group/i.test(l),
  );
  for (const line of lines.slice(-100)) console.log(line);

  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});