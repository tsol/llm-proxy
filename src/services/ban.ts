import { appConfig } from '../config';

/**
 * Temporary ban of misbehaving providers/models.
 *
 * A provider:model accumulates "ban signals" (failures, 429s, garbage streams,
 * zero-byte hangs) in a sliding window. When ANY BAN_FROM_GROUP_WHEN_* threshold
 * is reached, the model is banned for BAN_DURATION_HOURS — excluded from the
 * preferred-group pool and the fallback walk until the ban expires (then it
 * returns with a clean slate).
 *
 * Config (see .env.example / .env-proxy):
 *   BAN_ENABLED, BAN_DURATION_HOURS, BAN_WINDOW_MINUTES,
 *   BAN_FROM_GROUP_WHEN_FAIL_COUNT / _429_COUNT / _GARBAGE_COUNT /
 *   _ZERO_BYTE_SECONDS / _ZERO_BYTE_COUNT
 */

export type BanKind = 'fail' | '429' | 'garbage' | 'zero-byte' | 'timeout';

interface BanState {
  events: Array<{ ts: number; kind: BanKind }>;
  banUntil: number; // epoch ms; 0 = not banned
}

const banStates = new Map<string, BanState>();

/** The group-pool / fallback skip key for a model = "provider:model". */
export const banKey = (provider: string, model: string): string =>
  `${provider}:${model}`;

export function isModelBanned(key: string): boolean {
  const s = banStates.get(key);
  return !!s && s.banUntil > Date.now();
}

export function banRemainingSec(key: string): number {
  const s = banStates.get(key);
  if (!s || s.banUntil <= Date.now()) return 0;
  return Math.round((s.banUntil - Date.now()) / 1000);
}

/** List of currently banned keys (provider:model). */
export function bannedKeys(): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (const [k, s] of banStates) {
    if (s.banUntil > now) out.push(k);
  }
  return out;
}

/**
 * Record one ban signal of the given kind for the model. Evaluates the sliding
 * window thresholds and, if any is crossed (and the model isn't already banned),
 * applies a BAN_DURATION_HOURS ban.
 */
export function recordBanSignal(key: string, kind: BanKind): void {
  if (!appConfig.banEnabled) return;
  const winMs = appConfig.banWindowMinutes * 60_000;
  const now = Date.now();

  // Lazily expire any completed ban so the model gets a clean slate.
  const existing = banStates.get(key);
  if (existing && existing.banUntil > 0 && existing.banUntil <= now) {
    console.log(`[ban] ${key} unbanned (ban expired)`);
    existing.events = [];
    existing.banUntil = 0;
  }

  let s = banStates.get(key);
  if (!s) {
    s = { events: [], banUntil: 0 };
    banStates.set(key, s);
  }
  s.events = s.events.filter((e) => now - e.ts <= winMs);
  s.events.push({ ts: now, kind });

  const cnt = (k: BanKind) => s.events.filter((e) => e.kind === k).length;
  const B = appConfig;
  const reasons: string[] = [];
  if (B.banFailCount > 0 && cnt('fail') >= B.banFailCount) reasons.push(`fail=${cnt('fail')}`);
  if (B.ban429Count > 0 && cnt('429') >= B.ban429Count) reasons.push(`429=${cnt('429')}`);
  if (B.banGarbageCount > 0 && cnt('garbage') >= B.banGarbageCount) reasons.push(`garbage=${cnt('garbage')}`);
  if (B.banTimeoutCount > 0 && cnt('timeout') >= B.banTimeoutCount) reasons.push(`timeout=${cnt('timeout')}`);
  if (B.banZeroByteCount > 0 && cnt('zero-byte') >= B.banZeroByteCount) reasons.push(`zero-byte=${cnt('zero-byte')}`);

  if (reasons.length === 0) return;
  if (s.banUntil <= now) {
    s.banUntil = now + B.banDurationHours * 3_600_000;
    console.log(
      `[ban] ${key} banned for ${B.banDurationHours}h (${reasons.join(', ')})`,
    );
  }
}

/** Forcibly unban a model now (e.g. on restart or manual). */
export function clearBan(key: string): void {
  const s = banStates.get(key);
  if (s) {
    s.events = [];
    s.banUntil = 0;
    console.log(`[ban] ${key} manually unbanned`);
  }
}