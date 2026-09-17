import type { ProviderAdapter } from '../types';
import { appConfig } from '../config';
import { recordBanSignal, isModelBanned, getBanInfo, bannedDetailed } from './ban';
import { resolveModelQuirk } from '../providers/metadata';
import type { AliasGroupDef, NodataTryParallel } from './alias-store';
import { parseNodataTryParallel } from './alias-store';

/**
 * Per-key FIFO concurrency limiter.
 */

/** First N … last N chars. Middle dropped so two long strings with the same
 *  prefix (same last user message) still show a distinct tail. */
export function clipEnds(s: string, n = 40): string {
  const clean = (s || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= n * 2 + 3) return clean;
  return `${clean.slice(0, n)} … ${clean.slice(-n)}`;
}

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

// Rolling outcome timestamps per model key — used by "fastest" (failures)
// and "safest" (ok vs fail ratio) over the last hour.
const modelFailures = new Map<string, number[]>();
const modelSuccesses = new Map<string, number[]>();

function pushHourly(map: Map<string, number[]>, key: string, ts = Date.now()): void {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(ts);
  const cutoff = ts - WINDOW_1H;
  if (arr.length > 1 && arr[0] < cutoff) {
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    if (i > 0) arr.splice(0, i);
  }
}

function countHourly(map: Map<string, number[]>, key: string): number {
  const arr = map.get(key);
  if (!arr || arr.length === 0) return 0;
  const cutoff = Date.now() - WINDOW_1H;
  let count = 0;
  for (const ts of arr) {
    if (ts >= cutoff) count++;
  }
  return count;
}

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

function recordFailure(key: string, ts = Date.now()): void {
  pushHourly(modelFailures, key, ts);
}

function recordSuccess(key: string, ts = Date.now()): void {
  pushHourly(modelSuccesses, key, ts);
}

/** Count of failures for a model key in the last hour (for fastest / safest). */
export function memberFailures(key: string): number {
  return countHourly(modelFailures, key);
}

/** Count of successful completions in the last hour (for the safest strategy). */
export function memberSuccesses(key: string): number {
  return countHourly(modelSuccesses, key);
}

/** ok / (ok + fail) over the last hour, or -1 when there are no completions. */
export function memberStability(key: string): number {
  const ok = memberSuccesses(key);
  const fail = memberFailures(key);
  const total = ok + fail;
  return total > 0 ? ok / total : -1;
}

interface SafestScore {
  /** 0 = proven no-fail, 1 = untried, 2 = has at least one fail. */
  tier: number;
  ratio: number;
  n: number;
}

function safestScoreFromCounts(ok: number, fail: number): SafestScore {
  const n = ok + fail;
  if (n === 0) return { tier: 1, ratio: 0, n: 0 };
  if (fail === 0) return { tier: 0, ratio: 1, n };
  return { tier: 2, ratio: ok / n, n };
}

function safestScore(key: string): SafestScore {
  return safestScoreFromCounts(memberSuccesses(key), memberFailures(key));
}

function compareSafestScore(a: SafestScore, b: SafestScore): number {
  return a.tier - b.tier || b.ratio - a.ratio || b.n - a.n;
}

// Live request tracking
interface LiveRequest {
  id: string;
  key: string;
  provider: string;
  model: string;
  reqPreview: string;
  reqSuffix: string;
  respPreview: string;
  startedAt: number;
  status: number | null;
  /** Last time a stream chunk (or sync response) arrived from upstream. */
  lastChunkAt: number;
  /** Cumulative upstream bytes received so far. */
  bytes: number;
  /** Rolling tail of the provider's response so far (last ~80 chars) — lets
   *  the dashboard show live streaming progress (not the user prompt). */
  respHint: string;
  /** Path basename under logs/req — inspector reads the file, not RAM. */
  dumpFile?: string;
}

interface IncomingRequest {
  id: string;
  preview: string;
  lastRole: string;
  lastClip: string;
  msgCount: number;
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
  /** Concurrency slot release — must run even if the request never completes. */
  release?: () => void;
}
const reapable = new Map<string, ReapableRequest>();

export function registerReapable(req: ReapableRequest): void {
  reapable.set(req.id, req);
}

export function unregisterReapable(id: string): void {
  reapable.delete(id);
}

export function bindReapableRelease(id: string, release?: () => void): void {
  const req = reapable.get(id);
  if (!req) return;
  req.release = release;
}

let reaperStarted = false;
/** Ban models whose live request is silently hanging: present in the pool with
 *  ZERO bytes received for >= BAN_FROM_GROUP_WHEN_ZERO_BYTE_SECONDS. These never
 *  complete, so they'd never reach recordModelResponse() — this is what catches
 *  the "silent hanger" case (e.g. gonka-mingles). */
function checkZeroByteBans(): void {
  if (!appConfig.banEnabled) return;
  const idleMs = appConfig.banZeroByteSeconds * 1000;
  if (idleMs <= 0) return;
  const now = Date.now();
  for (const lr of liveRequests.values()) {
    if (lr.bytes === 0 && now - (lr.lastChunkAt || lr.startedAt) >= idleMs) {
      recordBanSignal(lr.key, 'zero-byte');
    }
  }
}

export function startZombieReaper(): void {
  if (reaperStarted) return;
  reaperStarted = true;
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    checkZeroByteBans();
    for (const [id, req] of [...reapable.entries()]) {
      if (now - req.startedAt <= ZOMBIE_MAX_AGE_MS) continue;
      try { req.destroy?.(); } catch { /* ignore */ }
      try { req.release?.(); } catch { /* ignore */ }
      if (req.kind === 'incoming') incomingRequests.delete(id);
      else finishLiveRequest(id, 0, 'zombie-reaped');
      reapable.delete(id);
      cleaned++;
    }
    if (cleaned > 0) {
      console.log(`[zombie-reaper] cleaned ${cleaned} stale ${cleaned === 1 ? 'request' : 'requests'}`);
    }
  }, REAP_INTERVAL_MS);
  reaperStarted = true;
}

export function recordIncomingStart(info: {
  preview: string;
  lastRole?: string;
  lastClip?: string;
  msgCount?: number;
}): string {
  const id = String(++_incomingSeq);
  incomingRequests.set(id, {
    id,
    preview: clipEnds(info.preview, 40),
    lastRole: info.lastRole || '',
    lastClip: clipEnds(info.lastClip || '', 40),
    msgCount: info.msgCount ?? 0,
    startedAt: Date.now(),
  });
  return id;
}

export function recordIncomingEnd(id: string): void {
  incomingRequests.delete(id);
  unregisterReapable(id);
}

export function recordRequestStart(
  key: string,
  provider: string,
  model: string,
  preview: string,
): string {
  const id = Math.random().toString(36).slice(2, 10);
  const clipped = clipEnds(preview, 40);
  const splitAt = clipped.indexOf(' … ');
  const lr: LiveRequest = {
    id,
    key, provider, model,
    reqPreview: splitAt >= 0 ? clipped.slice(0, splitAt) : clipped,
    reqSuffix: splitAt >= 0 ? clipped.slice(splitAt + 3) : '',
    respPreview: '',
    startedAt: Date.now(),
    lastChunkAt: Date.now(),
    bytes: 0,
    respHint: '',
    status: null,
  };
  liveRequests.set(id, lr);
  return id;
}

/** Record upstream activity (bytes received) for a live request and refresh
 *  its last-activity timestamp. Used by idle-timeout monitoring. */
export function touchLiveRequest(id: string, bytesDelta: number): void {
  const lr = liveRequests.get(id);
  if (!lr) return;
  lr.lastChunkAt = Date.now();
  if (bytesDelta > 0) lr.bytes += bytesDelta;
}

/** Record a live upstream DATA chunk: refresh last-activity, add bytes, and
 *  keep a rolling tail of the provider's response (respHint) so the dashboard
 *  can show live streaming progress. */
export function touchLiveResponse(id: string, text: string, bytesDelta: number): void {
  const lr = liveRequests.get(id);
  if (!lr) return;
  lr.lastChunkAt = Date.now();
  if (bytesDelta > 0) lr.bytes += bytesDelta;
  if (text) {
    lr.respHint = (lr.respHint + text).slice(-80);
  }
}

export function recordRequestEnd(id: string, status: number, respPreview: string): void {
  const lr = liveRequests.get(id);
  if (!lr) return;
  lr.status = status;
  lr.respPreview = clipEnds(respPreview, 40);
  liveRequests.delete(id);
  recentRequests.unshift(lr);
  if (recentRequests.length > MAX_RECENT) recentRequests.length = MAX_RECENT;
  unregisterReapable(id);
}

export function attachDumpFile(id: string, filename: string): void {
  if (!id || !filename) return;
  const live = liveRequests.get(id);
  if (live) {
    live.dumpFile = filename;
    return;
  }
  const recent = recentRequests.find((r) => r.id === id);
  if (recent) recent.dumpFile = filename;
}

export function getRecentRecord(id: string): {
  id: string;
  provider: string;
  model: string;
  status: number;
  startedAt: number;
  dumpFile?: string;
} | undefined {
  const lr = recentRequests.find((r) => r.id === id);
  if (!lr) return undefined;
  return {
    id: lr.id,
    provider: lr.provider,
    model: lr.model,
    status: lr.status ?? 0,
    startedAt: lr.startedAt,
    dumpFile: lr.dumpFile,
  };
}

/** Move a live row to recent if it is still open. Idempotent. */
export function finishLiveRequest(id: string, status?: number, respPreview?: string): void {
  const lr = liveRequests.get(id);
  if (!lr) return;
  recordRequestEnd(
    id,
    status ?? lr.status ?? 0,
    respPreview || lr.respHint || lr.respPreview || 'ended',
  );
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
  // status 0 = text garbage; 1 = malformed tool_calls; anything not 2xx-3xx is a failure.
  const ok = status >= 200 && status < 400;
  if (ok) {
    s.ok++;
    recordSuccess(key);
  } else {
    s.fail++;
    recordFailure(key);
    const kind = status === 429 ? '429' : (status === 0 || status === 1 ? 'garbage' : 'fail');
    recordBanSignal(key, kind);
  }
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
  const quirk = resolveModelQuirk(upstreamModel, adapter.config.modelQuirks);
  if (quirk?.concurrent !== undefined && quirk.concurrent > 0) {
    return quirk.concurrent;
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

export type GroupStrategy = 'random' | 'order' | 'fastest' | 'safest';

export interface AliasGroupSpec {
  key: string;
  alias: string;
  strategy: GroupStrategy;
  members: AliasGroupMember[];
  nodataTryParallel?: NodataTryParallel;
}

export interface OccupyExclude {
  providers?: Set<string>;
  keys?: Set<string>;
}

function parseGroupStrategy(s: string): GroupStrategy {
  if (s === 'order' || s === 'fastest' || s === 'safest') return s;
  return 'random';
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
  strategy: GroupStrategy,
  exclude?: OccupyExclude,
): AliasGroupMember | null {
  const free = state.members.filter((m) => {
    if (exclude?.providers?.has(m.provider)) return false;
    if (exclude?.keys?.has(m.key)) return false;
    if (isModelBanned(m.key)) return false;
    // limit <= 0 means unlimited — same contract as acquireSlot().
    // Store aliases whose members have no modelQuirks.concurrent were
    // treated as capacity 0 and immediately returned "all-busy".
    if (m.limit <= 0) return true;
    return (state.activeByKey.get(m.key) ?? 0) < m.limit;
  });
  if (free.length === 0) return null;
  if (strategy === 'random') return free[Math.floor(Math.random() * free.length)];
  if (strategy === 'fastest') {
    // Highest priority: fewest failures in the last hour. Among those, pick
    // the fastest by measured throughput (1h window preferred, 24h fallback).
    // Ties are broken randomly.
    const minFail = Math.min(...free.map(m => memberFailures(m.key)));
    const healthy = free.filter(m => memberFailures(m.key) === minFail);
    const known = healthy.filter(m => memberTps(m) > 0);
    if (known.length > 0) {
      const best = Math.max(...known.map(memberTps));
      const tied = known.filter(m => memberTps(m) === best);
      return tied[Math.floor(Math.random() * tied.length)];
    }
    return healthy[Math.floor(Math.random() * healthy.length)];
  }
  if (strategy === 'safest') {
    // Untried (0 completions) ranks above anyone with a fail. Proven
    // fail=0 still beats untried. Failing members sort by ok/(ok+fail),
    // then more samples, then random.
    const scored = free.map(m => ({ m, ...safestScore(m.key) }));
    scored.sort((a, b) => compareSafestScore(a, b));
    const best = scored[0];
    const tied = scored.filter(s => compareSafestScore(s, best) === 0);
    return tied[Math.floor(Math.random() * tied.length)].m;
  }
  return free[0];
}

function occupyAliasGroupMember(state: AliasGroupState, member: AliasGroupMember): void {
  state.activeByKey.set(member.key, (state.activeByKey.get(member.key) ?? 0) + 1);
  state.totalActive++;
}

function dispatchAliasGroupWaiters(state: AliasGroupState, groupKey: string, strategy: GroupStrategy): void {
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

function occupyAndHandle(
  spec: AliasGroupSpec,
  state: AliasGroupState,
  member: AliasGroupMember,
): Extract<AliasGroupAcquireResult, { ok: true }> {
  occupyAliasGroupMember(state, member);
  let released = false;
  const key = member.key;
  const release = (): void => {
    if (released) return;
    released = true;
    state.activeByKey.set(key, Math.max(0, (state.activeByKey.get(key) ?? 0) - 1));
    state.totalActive = Math.max(0, state.totalActive - 1);
    if (spec.strategy !== 'order') {
      dispatchAliasGroupWaiters(state, spec.key, spec.strategy);
    }
  };
  return { ok: true, provider: member.provider, model: member.model, handle: { release } };
}

/** Fail-fast occupy (no waiter queue). Used by nodata hedge extras. */
export function tryOccupyAliasGroupMemberNow(
  spec: AliasGroupSpec,
  exclude?: OccupyExclude,
): AliasGroupAcquireResult {
  const state = aliasGroupStateFor(spec);
  const free = findFreeAliasGroupMember(state, spec.strategy, exclude);
  if (!free) return { ok: false, reason: 'all-busy' };
  return occupyAndHandle(spec, state, free);
}

/** Walk groups from startIdx; first free eligible member wins. No queue wait. */
export function tryOccupyHedgeSlot(
  groups: AliasGroupSpec[],
  startIdx: number,
  exclude: OccupyExclude,
): { groupIdx: number; acquired: Extract<AliasGroupAcquireResult, { ok: true }> } | null {
  for (let i = Math.max(0, startIdx); i < groups.length; i++) {
    const acquired = tryOccupyAliasGroupMemberNow(groups[i], exclude);
    if (acquired.ok) return { groupIdx: i, acquired };
  }
  return null;
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
  groups: AliasGroupDef[],
  adapters: Array<{ id: string; config: { modelQuirks?: Record<string, { concurrent?: number }> } }>,
  alias: string,
): AliasGroupSpec[] {
  const specs: AliasGroupSpec[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const strategy = parseGroupStrategy(g.strategy);
    const members: AliasGroupMember[] = [];
    for (const entry of g.members) {
      const parts = entry.split('/');
      if (parts.length < 2) continue;
      const provider = parts[0];
      const model = parts.slice(1).join('/');
      const quirks = adapters.find(a => a.id === provider)?.config.modelQuirks ?? {};
      const quirk = resolveModelQuirk(model, quirks);
      const limit =
        quirk?.concurrent !== undefined && quirk.concurrent > 0
          ? quirk.concurrent
          : 0;
      members.push({ provider, model, limit, key: `${provider}:${model}` });
    }
    const nodataTryParallel = parseNodataTryParallel(g.nodata_try_parallel);
    specs.push({ key: `${alias}:g${gi}`, alias, strategy, members, nodataTryParallel });
  }
  return specs;
}

// Cached complete alias group specs for dashboard (incl. idle groups with zero counters)
let cachedAliasGroupSpecs: AliasGroupSpec[] = [];
// Cached flat alias chain config for dashboard
let cachedAliasChain: Array<{ provider: string; model: string; limit: number; group: number; strategy: string }> = [];

export function updateAliasChainConfig(
  aliasGroups: Array<{ alias: string; groups: AliasGroupDef[] }>,
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
    nodataTryParallel?: NodataTryParallel;
    active: number; limit: number;
    members: Array<{
      provider: string; model: string; active: number; limit: number;
      /** True when this provider:model is temporarily banned. */
      banned: boolean;
      /** Seconds until the ban lifts (0 when not banned). */
      banRemainingSec: number;
      /** 1-based selection order per the group strategy (1 = chosen first). */
      rank?: number;
      /** Failures in the last hour. */
      failH1?: number;
      /** Successful completions in the last hour. */
      okH1?: number;
      /** ok / (ok + fail) over the last hour; 0 when no completions. */
      stabilityH1?: number;
      /** Measured tokens/sec over the last hour. */
      tpsH1?: number;
    }>;
    waiters: Array<{ preview: string }>;
  }>;
  groupConfig: Array<{ provider: string; model: string; limit: number; group: number; strategy: string }>;
  stats: Record<string, { lastStatus: number; total: number; ok: number; fail: number }>;
  throughput: Record<string, { h1: ThroughputWindow; h24: ThroughputWindow }>;
  /** Currently banned provider:model keys with remaining seconds. */
  bans: Array<{ key: string; remainingSec: number }>;
  incoming: Array<{
    id: string;
    preview: string;
    lastRole: string;
    lastClip: string;
    msgCount: number;
    startedAt: number;
  }>;
  active: Array<{ key: string; provider: string; model: string; reqPreview: string; reqSuffix: string; respHint: string; startedAt: number; lastChunkAt: number; bytes: number }>;
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
    const members: ConcurrencySnapshot['aliasGroups'][number]['members'] = spec.members.map(
      (m): ConcurrencySnapshot['aliasGroups'][number]['members'][number] => {
        const samples = modelThroughput.get(m.key);
        const h1 = samples ? aggregateThroughput(samples, WINDOW_1H) : undefined;
        const ban = getBanInfo(m.key);
        return {
          provider: m.provider,
          model: m.model,
          active: state ? (state.activeByKey.get(m.key) ?? 0) : 0,
          limit: m.limit,
          banned: ban.banned,
          banRemainingSec: ban.remainingSec,
          failH1: memberFailures(m.key),
          okH1: memberSuccesses(m.key),
          stabilityH1: Math.max(0, memberStability(m.key)),
          tpsH1: h1?.tps ?? 0,
        };
      });
    // Assign a 1-based selection rank mirroring the group strategy so the UI
    // can order members the same way the router would choose them.
    if (spec.strategy === 'fastest') {
      const ranked = [...members].sort((a, b) => (a.failH1 ?? 0) - (b.failH1 ?? 0) || (b.tpsH1 ?? 0) - (a.tpsH1 ?? 0));
      const rankByIdx = new Map<number, number>();
      ranked.forEach((m, i) => rankByIdx.set(members.indexOf(m), i + 1));
      members.forEach((m, i) => { m.rank = rankByIdx.get(i)!; });
    } else if (spec.strategy === 'safest') {
      const ranked = [...members].sort((a, b) =>
        compareSafestScore(
          safestScoreFromCounts(a.okH1 ?? 0, a.failH1 ?? 0),
          safestScoreFromCounts(b.okH1 ?? 0, b.failH1 ?? 0),
        ));
      const rankByIdx = new Map<number, number>();
      ranked.forEach((m, i) => rankByIdx.set(members.indexOf(m), i + 1));
      members.forEach((m, i) => { m.rank = rankByIdx.get(i)!; });
    } else {
      members.forEach((m, i) => { m.rank = i + 1; });
    }
    return {
      key: spec.key,
      alias: spec.alias,
      strategy: spec.strategy,
      nodataTryParallel: spec.nodataTryParallel,
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
    bans: bannedDetailed().map(b => ({ key: b.key, remainingSec: b.remainingSec })),
    incoming: [...incomingRequests.values()].map(ir => ({
      id: ir.id,
      preview: ir.preview,
      lastRole: ir.lastRole,
      lastClip: ir.lastClip,
      msgCount: ir.msgCount,
      startedAt: ir.startedAt,
    })),
    active: [...liveRequests.values()].map(lr => ({
      key: lr.key, provider: lr.provider, model: lr.model,
      reqPreview: lr.reqPreview, reqSuffix: lr.reqSuffix, respHint: lr.respHint,
      startedAt: lr.startedAt,
      lastChunkAt: lr.lastChunkAt, bytes: lr.bytes,
    })),
    recent: [...recentRequests]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(lr => ({
        id: lr.id,
        key: lr.key, provider: lr.provider, model: lr.model,
        reqPreview: lr.reqPreview, reqSuffix: lr.reqSuffix,
        respPreview: lr.respPreview,
        status: lr.status ?? 0, startedAt: lr.startedAt,
      })),
  };
}
