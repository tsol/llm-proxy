import type { ProviderId, ProviderPricing } from './types';
import { appConfig } from './config';
import { matchesModelAllow } from './model-filter';

export interface DisplayInput {
  provider: ProviderId;
  upstreamId: string;
  pricing: ProviderPricing;
  contextLength?: number;
  modelType?: string;
}

const EXCLUDE_ID_PATTERNS = [
  /embed/i,
  /\btts\b/i,
  /speech/i,
  /transcribe/i,
  /native-audio/i,
  /\baudio(?!.*flash)/i,
  /\bvideo\b/i,
  /\bveo-/i,
  /\bimagen-/i,
  /image-generation/i,
  /robotics/i,
  /deep-research/i,
  /computer-use/i,
  /\baqa\b/i,
  /-live-/i,
  /\blive-preview/i,
  /\brealtime\b/i,
  /\blyria-/i,
  /\bchirp\b/i,
  /generate-preview/i,
  /fast-generate/i,
  /ultra-generate/i,
];

/** Drop version-suffixed Google duplicates when a canonical sibling exists. */
const GOOGLE_DEDUP_SUFFIX = /-(001|002|latest)$/i;

const GOOGLE_CONTEXT: Array<{ match: RegExp; ctx: number }> = [
  { match: /flash-lite|flash_lite/i, ctx: 1_000_000 },
  { match: /gemini-3\.5-flash/i, ctx: 1_000_000 },
  { match: /gemini-.*-flash/i, ctx: 1_000_000 },
  { match: /gemini-.*-pro/i, ctx: 1_000_000 },
  { match: /gemini-flash/i, ctx: 1_000_000 },
  { match: /gemini-pro/i, ctx: 1_000_000 },
  { match: /antigravity/i, ctx: 1_000_000 },
  { match: /gemma/i, ctx: 128_000 },
];

export function shortAlias(upstreamId: string): string {
  const bare = upstreamId.replace(/^models\//, '').trim();
  const slash = bare.lastIndexOf('/');
  return slash >= 0 ? bare.slice(slash + 1) : bare;
}

export function shouldIncludeModel(input: DisplayInput): boolean {
  if (input.modelType?.toLowerCase() === 'embedding') return false;

  const id = input.upstreamId.toLowerCase();
  if (EXCLUDE_ID_PATTERNS.some((re) => re.test(id))) return false;

  if (
    !matchesModelAllow(
      appConfig.modelAllow[input.provider],
      input.upstreamId,
    )
  ) {
    return false;
  }

  return true;
}

export function isGoogleDuplicate(
  upstreamId: string,
  allUpstreamIds: Set<string>,
): boolean {
  if (!upstreamId.startsWith('models/')) return false;
  const bare = upstreamId.replace(/^models\//, '');
  if (!GOOGLE_DEDUP_SUFFIX.test(bare)) return false;

  const canonical = bare.replace(GOOGLE_DEDUP_SUFFIX, '');
  if (canonical === bare) return false;

  const canonicalId = `models/${canonical}`;
  return allUpstreamIds.has(canonicalId);
}

/** Values above this are LM Studio max_context_length leaks, not allocated VRAM context. */
const LOCAL_MAX_CONTEXT_LEAK_THRESHOLD = 200_000;

export function resolveContextLength(input: DisplayInput): number | undefined {
  if (input.contextLength && input.contextLength > 0) {
    if (
      input.provider === 'local' &&
      input.contextLength > LOCAL_MAX_CONTEXT_LEAK_THRESHOLD
    ) {
      return undefined;
    }
    return input.contextLength;
  }

  if (input.provider === 'google') {
    const bare = input.upstreamId.replace(/^models\//, '');
    for (const rule of GOOGLE_CONTEXT) {
      if (rule.match.test(bare)) return rule.ctx;
    }
  }

  if (input.provider === 'deepseek') {
    if (/deepseek-chat|deepseek-reasoner/.test(input.upstreamId)) return 128_000;
    if (/deepseek-v4|deepseek/.test(input.upstreamId)) return 1_000_000;
  }

  if (input.provider === 'cursor') {
    if (/composer/i.test(input.upstreamId)) return 200_000;
  }

  return undefined;
}

export function buildPrettyName(input: DisplayInput): string {
  return shortAlias(input.upstreamId);
}

export function buildSafeModelId(input: DisplayInput): string {
  return shortAlias(input.upstreamId);
}

export function displaySortKey(safeId: string, provider: ProviderId): string {
  const order =
    provider === 'local'
      ? '0'
      : provider === 'gonka'
        ? '1'
        : provider === 'google'
          ? '2'
          : provider === 'cursor'
            ? '3'
            : '4';
  return `${order}:${safeId}`;
}