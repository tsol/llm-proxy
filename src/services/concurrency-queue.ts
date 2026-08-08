import type { ProviderAdapter } from '../types';
import { appConfig } from '../config';

/**
 * Per-key FIFO concurrency limiter.
 */

interface Waiter {
  resolve: (result: AcquireResult) => void;
  timer: NodeJS.Timeout;
  onClientClose: () => boolean;
  preview: string;
}

interface QueueState {
  limit: number;
  active: number;
  waiters: Waiter[];
}

type ReleaseFn = () => void;

export interface QueueHandle {
  release: ReleaseFn;
}

export type AcquireResult =
  | { ok: true; handle: QueueHandle }
  | { ok: false; reason: 'timeout' | 'client-closed' };

const queues = new Map<string, QueueState>();

// Per-model response stats
interface ModelStats {
  lastStatus: number;
  total: number;
  ok: number;
  fail: number;
}

const modelStats = new Map<string, ModelStats>();

// Rolling throughput windows per model (reply time + bytes/tokens returned)
const WINDOW_1H = 60 * 60 * 1000;
const WINDOW_24H = 24 * 60 * 60 * 1000;
const MAX_THROUGHPUT_SAMPLES = 5000;
interface ThroughputSample {
  ts: number; // timestamp ms
  durationMs: number;
  bytes: number;
  tokensOut?: number;
}
interface ThroughputWindow {
  count: number;
  durMs: number;
  bytes: number;
  tokensOut: number;
  tps: number;
}
const modelThroughput = new Map<string, ThroughputSample[]>();

function pushThroughput(key: string, sample: ThroughputSample): void {
  let arr = modelThroughput.get(key);
  if (!arr) {
    arr = [];
    modelThroughput.set(key, arr);
  }
  arr.push(sample);
  // Prune samples older than 24h; hard-cap to bound memory.
  const cutoff = Date.now() - WINDOW_24H;
  if (arr.length > MAX_THROUGHPUT_SAMPLES) {
    arr.splice(0, arr.length - MAX_THROUGHPUT_SAMPLES);
  } else if (arr.length > 1 && arr[0].ts < cutoff) {
    let i = 0;
    while (i < arr.length && arr[i].ts < cutoff) i++;
    if (i > 0) arr.splice(0, i);
  }
}

function aggregateThroughput(arr: ThroughputSample[], windowMs: number): ThroughputWindow {
  const cutoff = Date.now() - windowMs;
  let count = 0;
  let durMs = 0;
  let bytes = 0;
  let tokensOut = 0;
  for (const s of arr) {
    if (s.ts < cutoff) continue;
    count++;
    durMs += s.durationMs;
    bytes += s.bytes;
    tokensOut += s.tokensOut ?? 0;
  }
  const secs = durMs / 1000;
  const tps = secs > 0 ? (tokensOut > 0 ? tokensOut / secs : bytes / secs) : 0;
  return { count, durMs, bytes, tokensOut, tps };
}

// Live request tracking
interface LiveRequest {
  key: string;
  provider: string;
  model: string;
  reqPreview: string;
  reqSuffix: string;
  respPreview: string;
  startedAt: number;
  status: number | null;
}

interface IncomingRequest {
  preview: string;
  startedAt: number;
}

const liveRequests = new Map<string, LiveRequest>();
const recentRequests: LiveRequest[] = [];
const incomingRequests = new Map<string, IncomingRequest>();
let _incomingSeq = 0;
let _reqSeq = 0;
const MAX_RECENT = 20;

// Zombie reaper: track live requests and force-clean stale ones
const ZOMBIE_MAX_AGE_MS = 10 * 60 * 1000; // 10 min
const REAP_INTERVAL_MS = 30 * 1000; // every 30s
interface ReapableRequest {
  id: string;
  kind: 'incoming' | 'outgoing';
  startedAt: number;
  destroy?: () => void;
}
const reapable = new Map<string, ReapableRequest>();

export function registerReapable(req: ReapableRequest): void {
  reapable.set(req.id, req);
}

export function unregisterReapable(id: string): void {
  reapable.delete(id);
}

let reaperStarted = false;
export function startZombieReaper(): void {
  if (reaperStarted) return;
  reaperStarted = true;
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, req] of [...reapable.entries()]) {
      if (now - req.startedAt <= ZOMBIE_MAX_AGE_MS) continue;
      try { req.destroy?.(); } catch { /* ignore */ }
      if (req.kind === 'incoming') incomingRequests.delete(id);
      else liveRequests.delete(id);
      reapable.delete(id);
      cleaned++;
    }
    if (cleaned > 0) {
      console.log(`[zombie-reaper] cleaned ${cleaned} stale ${cleaned === 1 ? 'request' : 'requests'}`);
    }
  }, REAP_INTERVAL_MS);
  reaperStarted = true;
}

export function recordIncomingStart(preview: string): string {
  const id = String(++_incomingSeq);
  incomingRequests.set(id, { preview: preview.slice(0, 60), startedAt: Date.now() });
  return id;
}

export function recordIncomingEnd(id: string): void {
  incomingRequests.delete(id);
  unregisterReapable(id);
}

export function recordRequestStart(key: string, provider: string, model: string, preview: string): string {
  const id = Math.random().toString(36).slice(2, 10);
  const clean = preview.replace(/\s+/g, ' ').trim();
  const lr: LiveRequest = {
    key, provider, model,
    reqPreview: clean.slice(0, 40),
    reqSuffix: clean.length > 40 ? clean.slice(-40) : '',
    respPreview: '',
    startedAt: Date.now(),
    status: null,
  };
  liveRequests.set(id, lr);
  return id;
}

export function recordRequestEnd(id: string, status: number, respPreview: string): void {
  const lr = liveRequests.get(id);
  if (!lr) return;
  lr.status = status;
  const clean = respPreview.replace(/\s+/g, ' ').trim();
  lr.respPreview = clean;
  liveRequests.delete(id);
  recentRequests.unshift(lr);
  if (recentRequests.length > MAX_RECENT) recentRequests.length = MAX_RECENT;
  unregisterReapable(id);
}

export function recordModelResponse(
  key: string,
  status: number,
  metrics?: { durationMs?: number; bytes?: number; tokensOut?: number },
): void {
  let s = modelStats.get(key);
  if (!s) {
    s = { lastStatus: status, total: 0, ok: 0, fail: 0 };
    modelStats.set(key, s);
  }
  s.lastStatus = status;
  s.total++;
  // status 0 = garbage; anything not 2xx-3xx is a failure.
  const ok = status >= 200 && status < 400;
  if (ok) s.ok++;
  else s.fail++;
  // Rolling throughput windows: only measurable successful replies count.
  if (
    ok &&
    metrics &&
    typeof metrics.durationMs === 'number' &&
    typeof metrics.bytes === 'number'
  ) {
    pushThroughput(key, {
      ts: Date.now(),
      durationMs: metrics.durationMs,
      bytes: metrics.bytes,
      tokensOut: metrics.tokensOut,
    });
  }
}

function stateFor(key: string, limit: number): QueueState {
  let state = queues.get(key);
  if (!state) {
    state = { limit, active: 0, waiters: [] };
    queues.set(key, state);
  }
  return state;
}

function cleanupIfEmpty(key: string): void {
  const state = queues.get(key);
  if (state && state.active === 0 && state.waiters.length === 0) {
    queues.delete(key);
  }
}

function tryDispatch(state: QueueState): void {
  while (state.waiters.length > 0 && state.active < state.limit) {
    const waiter = state.waiters.shift()!;
    clearTimeout(waiter.timer);
    if (waiter.onClientClose()) {
      waiter.resolve({ ok: false, reason: 'client-closed' });
      continue;
    }
    state.active++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      tryDispatch(state);
    };
    waiter.resolve({ ok: true, handle: { release } });
  }
}

export function acquireSlot(
  key: string,
  limit: number,
  timeoutMs: number,
  onClientClose: () => boolean,
  preview = '',
): Promise<AcquireResult> {
  if (limit <= 0) {
    return Promise.resolve({ ok: true, handle: { release: () => undefined } });
  }
  const state = stateFor(key, limit);
  if (state.active < limit) {
    state.active++;
    return Promise.resolve({
      ok: true,
      handle: {
        release: () => {
          state.active = Math.max(0, state.active - 1);
          tryDispatch(state);
          cleanupIfEmpty(key);
        },
      },
    });
  }
  return new Promise<AcquireResult>((resolve) => {
    const waiter: Waiter = {
      resolve, onClientClose, preview,
      timer: setTimeout(() => {
        const idx = state.waiters.indexOf(waiter);
        if (idx >= 0) state.waiters.splice(idx, 1);
        resolve({ ok: false, reason: 'timeout' });
        cleanupIfEmpty(key);
      }, timeoutMs),
    };
    state.waiters.push(waiter);
  });
}

export function resolveConcurrentLimit(
  adapter: ProviderAdapter,
  upstreamModel: string,
): number | undefined {
  const quirks = adapter.config.modelQuirks;
  if (!quirks) return undefined;
  const lower = upstreamModel.toLowerCase();
  for (const [key, quirk] of Object.entries(quirks)) {
    if (upstreamModel === key || lower.startsWith(key.toLowerCase())) {
      if (quirk.concurrent !== undefined && quirk.concurrent > 0) {
        return quirk.concurrent;
      }
    }
  }
  return undefined;
}

export function isTooManyConcurrentRequests(rawBody: unknown): boolean {
  if (typeof rawBody === 'string') {
    return rawBody.toLowerCase().includes('too many concurrent requests');
  }
  if (rawBody && typeof rawBody === 'object') {
    const obj = rawBody as { error?: { message?: unknown } };
    const msg = obj.error?.message;
    if (typeof msg === 'string') {
      return msg.toLowerCase().includes('too many concurrent requests');
    }
  }
  return false;
}

// ══════════════════════════════════════════════════════════════
// Alias Group Pool (v2.0)
// ══════════════════════════════════════════════════════════════

export interface AliasGroupMember {
  provider: string;
  model: string;
  limit: number;
  key: string;
}

export interface AliasGroupSpec {
  key: string;
  alias: string;
  strategy: 'random' | 'order' | 'fastest';
  members: AliasGroupMember[];
}

export type AliasGroupAcquireResult =
  | { ok: true; provider: string; model: string; handle: QueueHandle }
  | { ok: false; reason: 'timeout' | 'client-closed' | 'all-busy' };

interface AliasGroupState {
  members: AliasGroupMember[];
  activeByKey: Map<string, number>;
  totalLimit: number;
  totalActive: number;
  waiters: AliasGroupWaiter[];
}

interface AliasGroupWaiter {
  resolve: (result: AliasGroupAcquireResult) => void;
  timer: NodeJS.Timeout;
  onClientClose: () => boolean;
  preview: string;
}

const aliasGroupStates = new Map<string, AliasGroupState>();

function aliasGroupStateFor(spec: AliasGroupSpec): AliasGroupState {
  let state = aliasGroupStates.get(spec.key);
  if (!state) {
    state = {
      members: spec.members,
      activeByKey: new Map(spec.members.map(m => [m.key, 0] as const)),
      totalLimit: spec.members.reduce((s, m) => s + m.limit, 0),
      totalActive: 0,
      waiters: [],
    };
    aliasGroupStates.set(spec.key, state);
  }
  return state;
}

// Best available throughput estimate for a member: prefer the 1h window,
// fall back to 24h when there's no data in the last hour, else 0 (unknown).
function memberTps(m: AliasGroupMember): number {
  const samples = modelThroughput.get(m.key);
  if (!samples || samples.length === 0) return 0;
  const h1 = aggregateThroughput(samples, WINDOW_1H);
  if (h1.count > 0) return h1.tps;
  return aggregateThroughput(samples, WINDOW_24H).tps;
}

function findFreeAliasGroupMember(
  state: AliasGroupState,
  strategy: 'random' | 'order' | 'fastest',
): AliasGroupMember | null {
  const free = state.members.filter(m => (state.activeByKey.get(m.key) ?? 0) < m.limit);
  if (free.length === 0) return null;
  if (strategy === 'random') return free[Math.floor(Math.random() * free.length)];
  if (strategy === 'fastest') {
    // Rank by throughput: members with a measured tps first (highest wins),
    // unknown (tps 0) members last. Ties are broken randomly.
    const known = free.filter(m => memberTps(m) > 0);
    if (known.length > 0) {
      const best = Math.max(...known.map(memberTps));
      const tied = known.filter(m => memberTps(m) === best);
      return tied[Math.floor(Math.random() * tied.length)];
    }
    return free[Math.floor(Math.random() * free.length)];
  }
  return free[0];
}

function occupyAliasGroupMember(state: AliasGroupState, member: AliasGroupMember): void {
  state.activeByKey.set(member.key, (state.activeByKey.get(member.key) ?? 0) + 1);
  state.totalActive++;
}

function dispatchAliasGroupWaiters(state: AliasGroupState, groupKey: string, strategy: 'random' | 'order' | 'fastest'): void {
  while (state.waiters.length > 0) {
    const free = findFreeAliasGroupMember(state, strategy);
    if (!free) break;
    const waiter = state.waiters.shift()!;
    clearTimeout(waiter.timer);
    if (waiter.onClientClose()) {
      waiter.resolve({ ok: false, reason: 'client-closed' });
      continue;
    }
    occupyAliasGroupMember(state, free);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      state.activeByKey.set(free.key, Math.max(0, (state.activeByKey.get(free.key) ?? 0) - 1));
      state.totalActive = Math.max(0, state.totalActive - 1);
      dispatchAliasGroupWaiters(state, groupKey, strategy);
    };
    waiter.resolve({ ok: true, provider: free.provider, model: free.model, handle: { release } });
  }
}

export function acquireAliasGroupSlot(
  spec: AliasGroupSpec,
  timeoutMs: number,
  onClientClose: () => boolean,
  preview = '',
): Promise<AliasGroupAcquireResult> {
  if (spec.strategy === 'order') {
    const state = aliasGroupStateFor(spec);
    const free = findFreeAliasGroupMember(state, 'order');
    if (!free) return Promise.resolve({ ok: false, reason: 'all-busy' });
    occupyAliasGroupMember(state, free);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      state.activeByKey.set(free.key, Math.max(0, (state.activeByKey.get(free.key) ?? 0) - 1));
      state.totalActive = Math.max(0, state.totalActive - 1);
    };
    return Promise.resolve({ ok: true, provider: free.provider, model: free.model, handle: { release } });
  }
  const state = aliasGroupStateFor(spec);
  const strategy = spec.strategy;
  const immediate = findFreeAliasGroupMember(state, strategy);
  if (immediate) {
    occupyAliasGroupMember(state, immediate);
    let released = false;
    const key = immediate.key;
    const release = (): void => {
      if (released) return;
      released = true;
      state.activeByKey.set(key, Math.max(0, (state.activeByKey.get(key) ?? 0) - 1));
      state.totalActive = Math.max(0, state.totalActive - 1);
      dispatchAliasGroupWaiters(state, spec.key, strategy);
    };
    return Promise.resolve({ ok: true, provider: immediate.provider, model: immediate.model, handle: { release } });
  }
  return new Promise<AliasGroupAcquireResult>(resolve => {
    const waiter: AliasGroupWaiter = {
      resolve, onClientClose, preview,
      timer: setTimeout(() => {
        const idx = state.waiters.indexOf(waiter);
        if (idx >= 0) state.waiters.splice(idx, 1);
        resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs),
    };
    state.waiters.push(waiter);
  });
}

export function buildAliasGroupSpecs(
  groups: Array<{ strategy: string; members: string[] }>,
  adapters: Array<{ id: string; config: { modelQuirks?: Record<string, { concurrent?: number }> } }>,
  alias: string,
): AliasGroupSpec[] {
  const specs: AliasGroupSpec[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const strategy = g.strategy === 'order' ? 'order' as const : (g.strategy === 'fastest' ? 'fastest' as const : 'random' as const);
    const members: AliasGroupMember[] = [];
    for (const entry of g.members) {
      const parts = entry.split('/');
      if (parts.length < 2) continue;
      const provider = parts[0];
      const model = parts.slice(1).join('/');
      let limit = 0;
      const quirks = adapters.find(a => a.id === provider)?.config.modelQuirks ?? {};
      const exact = quirks[model];
      if (exact?.concurrent !== undefined && exact.concurrent > 0) {
        limit = exact.concurrent;
      } else {
        const shortModel = model.split('/').pop()!;
        for (const [qk, qv] of Object.entries(quirks)) {
          if (qk.endsWith('/' + shortModel) && qv.concurrent !== undefined && qv.concurrent > 0) {
            limit = qv.concurrent;
            break;
          }
        }
      }
      members.push({ provider, model, limit, key: `${provider}:${model}` });
    }
    specs.push({ key: `${alias}:g${gi}`, alias, strategy, members });
  }
  return specs;
}

// Cached complete alias group specs for dashboard (incl. idle groups with zero counters)
let cachedAliasGroupSpecs: AliasGroupSpec[] = [];
// Cached flat alias chain config for dashboard
let cachedAliasChain: Array<{ provider: string; model: string; limit: number; group: number; strategy: string }> = [];

export function updateAliasChainConfig(
  aliasGroups: Array<{ alias: string; groups: Array<{ strategy: string; members: string[] }> }>,
  adapters: Array<{ id: string; config: { modelQuirks?: Record<string, { concurrent?: number }> } }>,
): void {
  const specs: AliasGroupSpec[] = [];
  const chain: Array<{ provider: string; model: string; limit: number; group: number; strategy: string }> = [];
  for (const ag of aliasGroups) {
    for (const spec of buildAliasGroupSpecs(ag.groups, adapters, ag.alias)) {
      specs.push(spec);
      for (const m of spec.members) {
        chain.push({
          provider: m.provider,
          model: m.model,
          limit: m.limit,
          group: chain.length,
          strategy: spec.strategy,
        });
      }
    }
  }
  cachedAliasGroupSpecs = specs;
  cachedAliasChain = chain;
}

// ═══════════════════════════════════════════════════════
// Snapshot for dashboard logging
// ═══════════════════════════════════════════════════════

export interface ConcurrencySnapshot {
  perModel: Array<{
    key: string;
    active: number;
    limit: number;
    waiters: Array<{ preview: string }>;
  }>;
  aliasGroups: Array<{
    key: string; alias: string; strategy: string;
    active: number; limit: number;
    members: Array<{ provider: string; model: string; active: number; limit: number }>;
    waiters: Array<{ preview: string }>;
  }>;
  groupConfig: Array<{ provider: string; model: string; limit: number; group: number; strategy: string }>;
  stats: Record<string, { lastStatus: number; total: number; ok: number; fail: number }>;
  throughput: Record<string, { h1: ThroughputWindow; h24: ThroughputWindow }>;
  incoming: Array<{ preview: string; startedAt: number }>;
  active: Array<{ key: string; provider: string; model: string; reqPreview: string; reqSuffix: string; startedAt: number }>;
  recent: Array<{ key: string; provider: string; model: string; reqPreview: string; respPreview: string; status: number; startedAt: number }>;
}

export function concurrencySnapshot(): ConcurrencySnapshot {
  const perModel: ConcurrencySnapshot['perModel'] = [];
  for (const [key, state] of queues.entries()) {
    if (state.active === 0 && state.waiters.length === 0) continue;
    perModel.push({
      key,
      active: state.active,
      limit: state.limit,
      waiters: state.waiters.map(w => ({ preview: w.preview })),
    });
  }

  // Alias groups: always emit the full configured chain (incl. idle groups with
  // zero counters), merging live state where a request has touched the group.
  const aliasGroups: ConcurrencySnapshot['aliasGroups'] = cachedAliasGroupSpecs.map(spec => {
    const state = aliasGroupStates.get(spec.key);
    const members = spec.members.map(m => ({
      provider: m.provider,
      model: m.model,
      active: state ? (state.activeByKey.get(m.key) ?? 0) : 0,
      limit: m.limit,
    }));
    return {
      key: spec.key,
      alias: spec.alias,
      strategy: spec.strategy,
      active: state?.totalActive ?? 0,
      limit: state?.totalLimit ?? spec.members.reduce((s, m) => s + m.limit, 0),
      members,
      waiters: state ? state.waiters.map(w => ({ preview: w.preview })) : [],
    };
  });

  return {
    perModel, aliasGroups,
    groupConfig: cachedAliasChain,
    stats: Object.fromEntries(modelStats),
    throughput: Object.fromEntries(
      [...modelThroughput.entries()].map(([key, arr]) => [
        key,
        { h1: aggregateThroughput(arr, WINDOW_1H), h24: aggregateThroughput(arr, WINDOW_24H) },
      ]),
    ),
    incoming: [...incomingRequests.values()].map(ir => ({
      preview: ir.preview, startedAt: ir.startedAt,
    })),
    active: [...liveRequests.values()].map(lr => ({
      key: lr.key, provider: lr.provider, model: lr.model,
      reqPreview: lr.reqPreview, reqSuffix: lr.reqSuffix, startedAt: lr.startedAt,
    })),
    recent: recentRequests.map(lr => ({
      key: lr.key, provider: lr.provider, model: lr.model,
      reqPreview: lr.reqPreview, respPreview: lr.respPreview,
      status: lr.status ?? 0, startedAt: lr.startedAt,
    })),
  };
}
