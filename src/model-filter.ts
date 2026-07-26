import type { ProviderId } from './types';

function parseRegexList(raw: string, label: string): RegExp[] {
  if (!raw.trim()) return [];
  const out: RegExp[] = [];
  for (const part of raw.split(',')) {
    const pattern = part.trim();
    if (!pattern) continue;
    try {
      out.push(new RegExp(pattern));
    } catch {
      console.warn(`[config] invalid ${label} regex: ${pattern}`);
    }
  }
  return out;
}

/** Default: Cursor catalog shows composer-2.5 non-fast only. */
const CURSOR_DEFAULT_MODEL_ALLOW = String.raw`^composer-2\.5@fast=false$`;

export function loadModelAllowPatterns(): Partial<Record<ProviderId, RegExp[]>> {
  const providerIds: ProviderId[] = [
    'local',
    'gonka',
    'google',
    'cursor',
    'deepseek',
    'groq',
    'cerebras',
    'openrouter',
  ];
  const global = parseRegexList(process.env.MODEL_ALLOW?.trim() ?? '', 'MODEL_ALLOW');
  const out: Partial<Record<ProviderId, RegExp[]>> = {};

  for (const provider of providerIds) {
    const envKey = `${provider.toUpperCase()}_MODEL_ALLOW`;
    const fallback =
      provider === 'cursor' ? CURSOR_DEFAULT_MODEL_ALLOW : '';
    const specific = parseRegexList(
      process.env[envKey]?.trim() ?? fallback,
      envKey,
    );
    const combined = [...global, ...specific];
    if (combined.length > 0) {
      out[provider] = combined;
    }
  }

  return out;
}

export function matchesModelAllow(
  patterns: RegExp[] | undefined,
  upstreamId: string,
): boolean {
  if (!patterns?.length) return true;
  return patterns.some((re) => re.test(upstreamId));
}
