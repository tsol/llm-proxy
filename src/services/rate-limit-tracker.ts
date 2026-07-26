// Rate-limit tracker — reads X-RateLimit-* headers from upstream responses.
// Exposes per-provider live quota state for display in run.sh and /router/providers.

import type { ProviderId } from '../types';

interface Quota {
  requestsRemaining?: number;
  requestsLimit?: number;
  requestsResetSec?: number;
  tokensRemaining?: number;
  tokensLimit?: number;
  tokensResetSec?: number;
  lastUpdated: number;
  provider: ProviderId;
}

const quotas = new Map<ProviderId, Quota>();

function extractNumber(headers: Record<string, string>, key: string): number | undefined {
  for (const [h, v] of Object.entries(headers)) {
    if (h.toLowerCase() === key.toLowerCase()) {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

/** Call this with upstream response headers after every chat completion. */
export function trackUpstreamHeaders(
  provider: ProviderId,
  responseHeaders: Record<string, string>,
): void {
  const requestsRemaining = extractNumber(responseHeaders, 'x-ratelimit-remaining-requests')
    ?? extractNumber(responseHeaders, 'x-ratelimit-remaining');
  const requestsLimit = extractNumber(responseHeaders, 'x-ratelimit-limit-requests')
    ?? extractNumber(responseHeaders, 'x-ratelimit-limit');
  const requestsResetSec = extractNumber(responseHeaders, 'x-ratelimit-reset-requests')
    ?? extractNumber(responseHeaders, 'x-ratelimit-reset');

  const tokensRemaining = extractNumber(responseHeaders, 'x-ratelimit-remaining-tokens');
  const tokensLimit = extractNumber(responseHeaders, 'x-ratelimit-limit-tokens');
  const tokensResetSec = extractNumber(responseHeaders, 'x-ratelimit-reset-tokens');

  if (requestsRemaining == null && tokensRemaining == null) return;

  const prev = quotas.get(provider);
  quotas.set(provider, {
    requestsRemaining: requestsRemaining ?? prev?.requestsRemaining,
    requestsLimit: requestsLimit ?? prev?.requestsLimit,
    requestsResetSec: requestsResetSec ?? prev?.requestsResetSec,
    tokensRemaining: tokensRemaining ?? prev?.tokensRemaining,
    tokensLimit: tokensLimit ?? prev?.tokensLimit,
    tokensResetSec: tokensResetSec ?? prev?.tokensResetSec,
    lastUpdated: Date.now(),
    provider,
  });
}

export interface LiveQuota {
  provider: string;
  requestsRemaining?: number;
  requestsLimit?: number;
  requestsResetSec?: number;
  tokensRemaining?: number;
  tokensLimit?: number;
  tokensResetSec?: number;
  lastUpdated: string | null;
}

export function getLiveQuota(provider: ProviderId): LiveQuota | null {
  const q = quotas.get(provider);
  if (!q) return null;
  return {
    provider: q.provider,
    requestsRemaining: q.requestsRemaining,
    requestsLimit: q.requestsLimit,
    requestsResetSec: q.requestsResetSec,
    tokensRemaining: q.tokensRemaining,
    tokensLimit: q.tokensLimit,
    tokensResetSec: q.tokensResetSec,
    lastUpdated: q.lastUpdated ? new Date(q.lastUpdated).toISOString() : null,
  };
}

export function getAllLiveQuotas(): LiveQuota[] {
  return [...quotas.values()].map((q) => ({
    provider: q.provider,
    requestsRemaining: q.requestsRemaining,
    requestsLimit: q.requestsLimit,
    requestsResetSec: q.requestsResetSec,
    tokensRemaining: q.tokensRemaining,
    tokensLimit: q.tokensLimit,
    tokensResetSec: q.tokensResetSec,
    lastUpdated: q.lastUpdated ? new Date(q.lastUpdated).toISOString() : null,
  }));
}