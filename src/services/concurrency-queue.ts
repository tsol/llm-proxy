import type { ProviderAdapter } from '../types';

/**
 * Per-key FIFO concurrency limiter.
 *
 * Keys are `provider:upstreamModel`. When a model has a `concurrent`
 * limit set (via model-metadata.json → modelQuirks), requests beyond
 * the limit are queued FIFO instead of being fired at the upstream
 * (whose 429 "too many concurrent requests" we've seen from gonka/Kimi).
 *
 * Models without a limit are not tracked at all — `acquireSlot` returns
 * a no-op handle immediately, so the rest of the proxy behaves exactly
 * as before.
 */

interface Waiter {
  resolve: (result: AcquireResult) => void;
  timer: NodeJS.Timeout;
  onClientClose: () => boolean;
}

interface GroupWaiter {
  resolve: (result: PreferredGroupAcquireResult) => void;
  timer: NodeJS.Timeout;
  onClientClose: () => boolean;
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
      // Client went away while waiting — drop this request.
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

/** Acquire a concurrency slot for `key`, waiting up to `timeoutMs` in FIFO order. */
export function acquireSlot(
  key: string,
  limit: number,
  timeoutMs: number,
  onClientClose: () => boolean,
): Promise<AcquireResult> {
  if (limit <= 0) {
    // No limit configured — immediate no-op handle.
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
      resolve,
      onClientClose,
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

/** Resolve the CONCURRENT limit for a provider+model, or undefined if unlimited.
 *  Uses the same exact-then-prefix modelQuirks lookup as model-display.ts. */
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

/** True when an upstream 429 body is the "too many concurrent requests" variant. */
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
// Preferred-group pool
//
// Models with `inPreferredGroup: true` form ONE shared FIFO pool.
// A request targeting any member of the group:
//   1. grabs the FIRST free slot among ALL group members (chain order);
//   2. if every slot is busy, waits in the group's FIFO queue up to
//      RETRY_QUEUE_WAIT_TIMEOUT for the next freed slot;
//   3. on timeout, the request exits the pool and falls through the
//      normal fallback chain (skipping remaining group members).
// ══════════════════════════════════════════════════════════════

export interface PreferredGroupMember {
  provider: string;
  model: string;
  limit: number;
  key: string;
}

export interface PreferredGroupSpec {
  key: string;
  members: PreferredGroupMember[];
}

export type PreferredGroupAcquireResult =
  | {
      ok: true;
      provider: string;
      model: string;
      handle: QueueHandle;
    }
  | { ok: false; reason: 'timeout' | 'client-closed' };

interface GroupState {
  members: PreferredGroupMember[];
  activeByKey: Map<string, number>;
  totalLimit: number;
  totalActive: number;
  waiters: GroupWaiter[];
}

const groupStates = new Map<string, GroupState>();

function groupStateFor(spec: PreferredGroupSpec): GroupState {
  let state = groupStates.get(spec.key);
  if (!state) {
    state = {
      members: spec.members,
      activeByKey: new Map(spec.members.map((m) => [m.key, 0])),
      totalLimit: spec.members.reduce((s, m) => s + m.limit, 0),
      totalActive: 0,
      waiters: [],
    };
    groupStates.set(spec.key, state);
  }
  return state;
}

function groupCleanupIfEmpty(key: string): void {
  const state = groupStates.get(key);
  if (state && state.totalActive === 0 && state.waiters.length === 0) {
    groupStates.delete(key);
  }
}

/** Find the first member (chain order) with a free slot, or null. */
function findFreeGroupMember(state: GroupState): PreferredGroupMember | null {
  for (const member of state.members) {
    const active = state.activeByKey.get(member.key) ?? 0;
    if (active < member.limit) return member;
  }
  return null;
}

function occupyGroupMember(state: GroupState, member: PreferredGroupMember): void {
  state.activeByKey.set(member.key, (state.activeByKey.get(member.key) ?? 0) + 1);
  state.totalActive++;
}

function dispatchGroupWaiters(state: GroupState, groupKey: string): void {
  while (state.waiters.length > 0 && state.totalActive < state.totalLimit) {
    const waiter = state.waiters.shift()!;
    clearTimeout(waiter.timer);
    if (waiter.onClientClose()) {
      waiter.resolve({ ok: false, reason: 'client-closed' });
      continue;
    }
    const member = findFreeGroupMember(state)!;
    occupyGroupMember(state, member);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      state.activeByKey.set(member.key, Math.max(0, (state.activeByKey.get(member.key) ?? 0) - 1));
      state.totalActive = Math.max(0, state.totalActive - 1);
      dispatchGroupWaiters(state, groupKey);
      groupCleanupIfEmpty(groupKey);
    };
    waiter.resolve({
      ok: true,
      provider: member.provider,
      model: member.model,
      handle: { release },
    });
  }
}

/**
 * Acquire a slot from the preferred group pool.
 * On success, returns the member (provider/model) that got the slot — the
 * caller must forward the request to THAT member, not the originally
 * requested one.
 */
export function acquirePreferredGroupSlot(
  spec: PreferredGroupSpec,
  timeoutMs: number,
  onClientClose: () => boolean,
): Promise<PreferredGroupAcquireResult> {
  const state = groupStateFor(spec);

  // Fast path: a member already has a free slot → take the first one in chain order.
  const immediate = findFreeGroupMember(state);
  if (immediate) {
    occupyGroupMember(state, immediate);
    let released = false;
    const key = immediate.key;
    const release = (): void => {
      if (released) return;
      released = true;
      state.activeByKey.set(key, Math.max(0, (state.activeByKey.get(key) ?? 0) - 1));
      state.totalActive = Math.max(0, state.totalActive - 1);
      dispatchGroupWaiters(state, spec.key);
      groupCleanupIfEmpty(spec.key);
    };
    return Promise.resolve({
      ok: true,
      provider: immediate.provider,
      model: immediate.model,
      handle: { release },
    });
  }

  // All members busy → FIFO wait for the first freed slot.
  return new Promise<PreferredGroupAcquireResult>((resolve) => {
    const waiter: GroupWaiter = {
      resolve,
      onClientClose,
      timer: setTimeout(() => {
        const idx = state.waiters.indexOf(waiter);
        if (idx >= 0) state.waiters.splice(idx, 1);
        resolve({ ok: false, reason: 'timeout' });
        groupCleanupIfEmpty(spec.key);
      }, timeoutMs),
    };
    state.waiters.push(waiter);
  });
}

/** True when provider+model is a member of the preferred group pool. */
export function isPreferredGroupMember(
  provider: string,
  model: string,
  quirks: { inPreferredGroup?: boolean } | undefined,
): boolean {
  return Boolean(quirks?.inPreferredGroup);
}

/**
 * Build the preferred-group spec from all registered provider adapters.
 * Members are sorted by provider display order, then model id — this is
 * the "chain order" used to pick the first free slot.
 */
export function buildPreferredGroupSpec(
  adapters: Array<{ id: string; config: { displayOrder?: number; modelQuirks?: Record<string, { inPreferredGroup?: boolean; concurrent?: number }> } }>,
): PreferredGroupSpec | null {
  const members: PreferredGroupMember[] = [];
  const sorted = [...adapters].sort(
    (a, b) => (a.config.displayOrder ?? 99) - (b.config.displayOrder ?? 99),
  );
  for (const adapter of sorted) {
    const quirks = adapter.config.modelQuirks ?? {};
    for (const [model, q] of Object.entries(quirks)) {
      if (q.inPreferredGroup && q.concurrent !== undefined && q.concurrent > 0) {
        members.push({
          provider: adapter.id,
          model,
          limit: q.concurrent,
          key: `${adapter.id}:${model}`,
        });
      }
    }
  }
  if (members.length === 0) return null;
  return { key: 'preferred-group', members };
}
