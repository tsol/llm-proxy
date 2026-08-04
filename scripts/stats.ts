import fs from 'fs';
import path from 'path';

const LOGS = path.resolve(__dirname, '..', '..', '..', '..', 'logs');
const COSTS = path.join(LOGS, 'costs.log');
const PROXY = path.join(LOGS, 'proxy.log');
const RL = path.join(LOGS, 'rate-limit.log');

function read(f: string): string[] {
  try { return fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean); } catch { return []; }
}
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
function parseLocal(s: string): Date {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error('bad ts: ' + s);
  return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
}

function args(): { since: Date; until: Date } {
  const until = new Date();
  let since: Date;
  if (process.argv.includes('--since')) since = parseLocal(process.argv[process.argv.indexOf('--since')+1]);
  else if (process.argv.includes('--last')) {
    const m = process.argv[process.argv.indexOf('--last')+1].match(/^(\d+)(s|m|h|d)$/);
    const mult: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    since = new Date(until.getTime() - +m![1] * mult[m![2]]);
  } else if (process.argv.includes('--today')) since = new Date(until.getFullYear(), until.getMonth(), until.getDate());
  else since = new Date(until.getTime() - 3600000);
  return { since, until };
}

const { since, until } = args();

// costs: col1=ts local, col2=model, col3=provider, last3=tokens_in,tokens_out,dollars
const perModel = new Map<string, { c: number; in: number; out: number; $: number }>();
for (const l of read(COSTS)) {
  const p = l.split('\t');
  if (p.length < 8) continue;
  if (!/^\d{4}-\d{2}-\d{2}/.test(p[0])) continue; // skip header
  const at = parseLocal(p[0]);
  if (at < since || at > until) continue;
  const k = `${p[2]}.${p[1]}`;
  const e = perModel.get(k) ?? { c: 0, in: 0, out: 0, $: 0 };
  e.c++; e.in += +p[p.length-3] || 0; e.out += +p[p.length-2] || 0; e.$ += +p[p.length-1] || 0;
  perModel.set(k, e);
}
const totalCost = [...perModel.values()].reduce((s, e) => s + e.$, 0);

// proxy.log: [queue] markers + fallback ERR lines
const queueTotal = read(PROXY).filter((l) => l.includes('[queue]')).length;
const fallbacks: { reason: string; target: string }[] = [];
for (const l of read(PROXY)) {
  const m = l.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) MSK\].*?ERR.*?\| .*\| ([^,]+), falling back to ([^ ]+)/);
  if (!m) continue;
  const at = parseLocal(m[1]);
  if (at >= since && at <= until) fallbacks.push({ reason: m[2].trim(), target: m[3].trim() });
}
const byTarget = new Map<string, number>();
const byReason = new Map<string, number>();
for (const f of fallbacks) {
  byTarget.set(f.target, (byTarget.get(f.target) ?? 0) + 1);
  byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
}
const sortDesc = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);

// rate-limit.log: "--- <ISO-Z> ---" headers; ISO-Z is UTC
let rl429 = 0;
for (const l of read(RL)) {
  const m = l.match(/^--- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) ---$/);
  if (!m) continue;
  const d = new Date(m[1]);
  if (Number.isNaN(d.getTime())) continue;
  if (d >= since && d <= until) rl429++;
}

console.log('=== Hermes proxy stats ===');
console.log(`Period: ${fmt(since)} -> ${fmt(until)}`);
console.log('');
console.log('Requests (costs.log): ' + [...perModel.values()].reduce((s, e) => s + e.c, 0));
for (const [k, e] of [...perModel.entries()].sort((a, b) => b[1].c - a[1].c)) {
  console.log('  ' + k + ': ' + e.c + ' (in ' + e.in + ' / out ' + e.out + ' / $' + e.$.toFixed(6) + ')');
}
console.log('  total spend: $' + totalCost.toFixed(6));
console.log('');
console.log('Queue events ([queue] markers): ' + queueTotal);
console.log('  queue-timeout fallbacks: ' + (byReason.get('queue-timeout') ?? 0));
console.log('');
console.log('Fallbacks in period: ' + fallbacks.length);
console.log('  by target:');
for (const [t, n] of sortDesc(byTarget)) console.log('    ' + t + ': ' + n);
console.log('  by reason:');
for (const [r, n] of sortDesc(byReason)) console.log('    ' + r + ': ' + n);
console.log('');
console.log('Upstream 429 (rate-limit.log): ' + rl429);