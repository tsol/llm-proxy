import type { OpenAIModel, ProviderId, ProviderPricing, ModelCapabilities, GonkaModelMeta } from './types';
import { appConfig } from './config';
import { getProvider, providerIds } from './providers';
import { resolveModelCapabilities } from './model-capabilities';
import {
  buildPrettyName,
  buildSafeModelId,
  displaySortKey,
  isGoogleDuplicate,
  resolveContextLength,
  shouldIncludeModel,
  shortAlias,
} from './model-display';

export interface CatalogModel extends OpenAIModel {
  provider: ProviderId;
  upstream_id: string;
  pricing: ProviderPricing;
  is_default: boolean;
}

interface CatalogEntry {
  provider: ProviderId;
  upstreamId: string;
  safeId: string;
  model: CatalogModel;
}

interface BuiltCatalog {
  byKey: Map<string, CatalogEntry>;
  entries: CatalogEntry[];
}

let entriesByKey = new Map<string, CatalogEntry>();
let catalogEntries: CatalogEntry[] = [];
let defaultUpstreamId = '';
let lastRefreshMs = 0;
let fullRefreshPromise: Promise<void> | null = null;
const providerRefreshAt = new Map<ProviderId, number>();
const providerRefreshPromises = new Map<ProviderId, Promise<void>>();

export type ProviderCatalogState = 'live' | 'stale' | 'fallback' | 'error' | 'unknown';

interface ProviderStateRecord {
  state: ProviderCatalogState;
  lastRefreshAt: number | null;
  lastLiveAt: number | null;
  lastError: string | null;
}

const providerStates = new Map<ProviderId, ProviderStateRecord>();

function defaultProviderState(): ProviderStateRecord {
  return {
    state: 'unknown',
    lastRefreshAt: null,
    lastLiveAt: null,
    lastError: null,
  };
}

function noteProviderState(
  providerId: ProviderId,
  patch: Partial<ProviderStateRecord>,
): void {
  const prev = providerStates.get(providerId) ?? defaultProviderState();
  providerStates.set(providerId, { ...prev, ...patch, lastRefreshAt: Date.now() });
}

export interface ProviderState {
  provider: ProviderId;
  state: ProviderCatalogState;
  model_count: number;
  last_refresh_at: string | null;
  last_live_at: string | null;
  last_error: string | null;
}

function isoOrNull(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

export function getProviderStates(): ProviderState[] {
  return providerIds().map((providerId) => {
    const record = providerStates.get(providerId) ?? defaultProviderState();
    return {
      provider: providerId,
      state: record.state,
      model_count: catalogEntries.filter((e) => e.provider === providerId).length,
      last_refresh_at: isoOrNull(record.lastRefreshAt),
      last_live_at: isoOrNull(record.lastLiveAt),
      last_error: record.lastError,
    };
  });
}

let catalogReadyResolve: (() => void) | null = null;
const catalogReadyPromise = new Promise<void>((resolve) => {
  catalogReadyResolve = resolve;
});

let catalogMergeChain: Promise<void> = Promise.resolve();

const REFRESH_TTL_MS = 60_000;
const STALE_REFRESH_TTL_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 20_000;

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

function norm(id: string): string {
  return id.trim().toLowerCase();
}

function resolveDefaultUpstreamId(): string {
  const provider = appConfig.defaultProvider;
  return getProvider(provider).config.defaultModel;
}

export function getDefaultModelId(): string {
  if (!defaultUpstreamId) {
    defaultUpstreamId = resolveDefaultUpstreamId();
  }
  return defaultUpstreamId;
}

export function setDefaultModelId(modelId: string): void {
  defaultUpstreamId = modelId.trim();
}

function registerLookup(map: Map<string, CatalogEntry>, key: string, entry: CatalogEntry): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  map.set(trimmed, entry);
  map.set(norm(trimmed), entry);
}

function registerEntry(map: Map<string, CatalogEntry>, entry: CatalogEntry): void {
  registerLookup(map, entry.safeId, entry);
  registerLookup(map, entry.upstreamId, entry);
  registerLookup(map, entry.model.id, entry);
  registerLookup(map, shortAlias(entry.upstreamId), entry);
}

function makeCatalogModel(
  id: string,
  name: string,
  opts: {
    provider: ProviderId;
    upstreamId: string;
    pricing: ProviderPricing;
    isDefault: boolean;
    created: number;
    contextLength?: number;
    maxContextLength?: number;
    maxTokens?: number;
    capabilities?: ModelCapabilities;
    gonka?: GonkaModelMeta;
  },
): CatalogModel {
  return {
    id,
    name,
    object: 'model',
    created: opts.created,
    owned_by: opts.provider,
    provider: opts.provider,
    upstream_id: opts.upstreamId,
    pricing: opts.pricing,
    is_default: opts.isDefault,
    ...(opts.contextLength ? { context_length: opts.contextLength } : {}),
    ...(opts.maxContextLength
      ? { max_context_length: opts.maxContextLength }
      : {}),
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    ...(opts.gonka ? { gonka: opts.gonka } : {}),
  };
}

function sortEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort((a, b) =>
    displaySortKey(a.safeId, a.provider).localeCompare(
      displaySortKey(b.safeId, b.provider),
    ),
  );
}

function signalCatalogReady(): void {
  if (catalogEntries.length > 0) {
    catalogReadyResolve?.();
    catalogReadyResolve = null;
  }
}

function commitCatalog(next: BuiltCatalog, reason: string): void {
  entriesByKey = next.byKey;
  catalogEntries = sortEntries(next.entries);
  lastRefreshMs = Date.now();
  signalCatalogReady();
  console.log(
    `[${ts()}] catalog swap (${reason}): ${catalogEntries.length} models`,
  );
}

function rebuildCatalogFromEntries(entries: CatalogEntry[]): BuiltCatalog {
  const byKey = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    registerEntry(byKey, entry);
  }
  return { byKey, entries };
}

function collectPeerUpstreamIds(excludeProvider?: ProviderId): Set<string> {
  const ids = new Set<string>();
  for (const entry of catalogEntries) {
    if (excludeProvider && entry.provider === excludeProvider) continue;
    ids.add(entry.upstreamId);
  }
  return ids;
}

function buildEntriesForProvider(
  providerId: ProviderId,
  models: OpenAIModel[],
  peerUpstreamIds: Set<string>,
): CatalogEntry[] {
  const adapter = getProvider(providerId);
  const activeDefault = getDefaultModelId();
  const entries: CatalogEntry[] = [];
  const seenUpstream = new Set<string>();

  for (const m of models) {
    const upstreamId = adapter.resolveModel(m.id);
    if (seenUpstream.has(upstreamId)) continue;

    const pricing = adapter.getPricing(upstreamId);
    const contextLength = resolveContextLength({
      provider: providerId,
      upstreamId,
      pricing,
      contextLength: m.context_length,
      modelType: m.model_type,
    });

    const displayInput = {
      provider: providerId,
      upstreamId,
      pricing,
      contextLength,
      modelType: m.model_type,
    };

    if (!shouldIncludeModel(displayInput)) continue;
    if (isGoogleDuplicate(upstreamId, peerUpstreamIds)) continue;

    const safeId = buildSafeModelId(displayInput);
    const prettyName = buildPrettyName(displayInput);
    const isDefault = upstreamId === activeDefault;
    const capabilities =
      m.capabilities ??
      resolveModelCapabilities(providerId, upstreamId, {
        modelType: m.model_type,
      });

    const entry: CatalogEntry = {
      provider: providerId,
      upstreamId,
      safeId,
      model: makeCatalogModel(safeId, prettyName, {
        provider: providerId,
        upstreamId,
        pricing,
        isDefault,
        created: m.created ?? 0,
        contextLength,
        maxContextLength: m.max_context_length,
        maxTokens: m.max_tokens,
        capabilities,
        ...(m.gonka ? { gonka: m.gonka } : {}),
      }),
    };

    entries.push(entry);
    seenUpstream.add(upstreamId);
    peerUpstreamIds.add(upstreamId);
  }

  return entries;
}

function mergeProviderEntries(
  providerId: ProviderId,
  newEntries: CatalogEntry[],
  reason: string,
): void {
  const other = catalogEntries.filter((e) => e.provider !== providerId);
  const combined = [...other, ...newEntries];
  if (combined.length === 0) return;
  commitCatalog(rebuildCatalogFromEntries(combined), reason);
}

async function mergeProviderEntriesLocked(
  providerId: ProviderId,
  newEntries: CatalogEntry[],
  reason: string,
): Promise<void> {
  const run = catalogMergeChain.then(() => {
    mergeProviderEntries(providerId, newEntries, reason);
  });
  catalogMergeChain = run.catch(() => undefined);
  await run;
}

async function keepStaleProviderEntries(
  providerId: ProviderId,
  previous: CatalogEntry[],
  reason: string,
): Promise<number> {
  const stale = previous.filter((e) => e.provider === providerId);
  if (stale.length === 0) return 0;
  await mergeProviderEntriesLocked(providerId, stale, reason);
  return stale.length;
}

async function refreshProviderCatalog(
  providerId: ProviderId,
  reason: string,
): Promise<void> {
  const adapter = getProvider(providerId);
  const previous = catalogEntries;
  const staleCount = previous.filter((e) => e.provider === providerId).length;

  const result = await adapter.listModelsDetailed();

  if (result.source === 'fallback' && staleCount > 0) {
    const kept = await keepStaleProviderEntries(providerId, previous, `${reason}:stale`);
    noteProviderState(providerId, {
      state: 'stale',
      lastError: 'upstream model list unreachable; serving cached catalog',
    });
    console.warn(
      `[${ts()}] catalog: kept ${kept} stale ${providerId} model(s) after live fetch failed`,
    );
    return;
  }

  if (result.models.length === 0 && staleCount > 0) {
    const kept = await keepStaleProviderEntries(providerId, previous, `${reason}:stale`);
    noteProviderState(providerId, {
      state: 'stale',
      lastError: 'upstream returned empty model list; serving cached catalog',
    });
    console.warn(
      `[${ts()}] catalog: kept ${kept} stale ${providerId} model(s) after empty live list`,
    );
    return;
  }

  const peerUpstreamIds = collectPeerUpstreamIds(providerId);
  const entries = buildEntriesForProvider(
    providerId,
    result.models,
    peerUpstreamIds,
  );

  if (entries.length === 0 && staleCount > 0) {
    const kept = await keepStaleProviderEntries(providerId, previous, `${reason}:stale`);
    noteProviderState(providerId, {
      state: 'stale',
      lastError: 'filters removed all models; serving cached catalog',
    });
    console.warn(
      `[${ts()}] catalog: kept ${kept} stale ${providerId} model(s) after filter produced 0`,
    );
    return;
  }

  const now = Date.now();
  if (result.source === 'live') {
    noteProviderState(providerId, {
      state: 'live',
      lastLiveAt: now,
      lastError: null,
    });
  } else {
    noteProviderState(providerId, {
      state: 'fallback',
      lastError: null,
    });
  }

  await mergeProviderEntriesLocked(providerId, entries, `${reason}:${providerId}`);
}

function refreshProvider(providerId: ProviderId, reason: string): Promise<void> {
  const inFlight = providerRefreshPromises.get(providerId);
  if (inFlight) return inFlight;

  const promise = refreshProviderCatalog(providerId, reason)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const hasModels = catalogEntries.some((e) => e.provider === providerId);
      noteProviderState(providerId, {
        state: hasModels ? 'stale' : 'error',
        lastError: message,
      });
      console.error(
        `[${ts()}] catalog: ${providerId} refresh failed:`,
        message,
      );
    })
    .finally(() => {
      providerRefreshPromises.delete(providerId);
      providerRefreshAt.set(providerId, Date.now());
    });

  providerRefreshPromises.set(providerId, promise);
  return promise;
}

async function runFullCatalogRefresh(reason: string): Promise<void> {
  await Promise.allSettled(
    providerIds().map((providerId) => refreshProvider(providerId, reason)),
  );

  if (catalogEntries.length === 0) {
    throw new Error('model catalog refresh produced an empty catalog');
  }
}

/** Fire-and-forget: each provider loads independently and swaps in when ready. */
export function startCatalogRefresh(reason: string): void {
  for (const providerId of providerIds()) {
    void refreshProvider(providerId, reason);
  }

  void Promise.allSettled(
    providerIds().map((providerId) => providerRefreshPromises.get(providerId)!),
  ).then(() => {
    if (catalogEntries.length === 0) {
      console.error(`[${ts()}] catalog: no models loaded from any provider`);
    }
  });
}

function providerRefreshTtl(providerId: ProviderId): number {
  const state = providerStates.get(providerId)?.state;
  return state === 'stale' || state === 'error'
    ? STALE_REFRESH_TTL_MS
    : REFRESH_TTL_MS;
}

function startBackgroundRefresh(): void {
  const now = Date.now();
  for (const providerId of providerIds()) {
    const last = providerRefreshAt.get(providerId) ?? 0;
    if (now - last >= providerRefreshTtl(providerId)) {
      void refreshProvider(providerId, 'background');
    }
  }
}

/** Periodic upstream probes — faster when providers are stale/error. */
export function startConnectivityWatchdog(): void {
  setInterval(() => {
    startBackgroundRefresh();
  }, WATCHDOG_INTERVAL_MS);
}

/** Stale-while-revalidate: never block requests on upstream model-list fetches. */
function ensureCatalogFresh(): void {
  if (catalogEntries.length === 0) return;
  startBackgroundRefresh();
}

async function awaitCatalogReady(): Promise<void> {
  if (catalogEntries.length > 0) {
    ensureCatalogFresh();
    return;
  }

  startCatalogRefresh('initial');
  await Promise.race([
    catalogReadyPromise,
    Promise.allSettled(
      providerIds().map((providerId) => refreshProvider(providerId, 'initial')),
    ),
  ]);

  if (catalogEntries.length === 0) {
    throw new Error('model catalog is empty — no provider returned models');
  }
}

async function refreshCatalogInternal(blocking: boolean, reason: string): Promise<void> {
  if (fullRefreshPromise) {
    await fullRefreshPromise;
    return;
  }

  fullRefreshPromise = runFullCatalogRefresh(reason)
    .catch((err) => {
      if (catalogEntries.length === 0) throw err;
      console.error(`[${ts()}] catalog: refresh failed; serving stale catalog:`, err);
    })
    .finally(() => {
      fullRefreshPromise = null;
    });

  if (blocking) {
    await fullRefreshPromise;
  }
}

export async function refreshCatalog(force = false): Promise<void> {
  const now = Date.now();
  if (!force && catalogEntries.length > 0 && now - lastRefreshMs < REFRESH_TTL_MS) {
    return;
  }
  await refreshCatalogInternal(true, force ? 'forced' : 'ttl');
}

/** Re-fetch one provider's model list (e.g. LM Studio loaded context). */
export async function refreshProviderLive(providerId: ProviderId): Promise<void> {
  await refreshProvider(providerId, 'live');
}

export async function listCatalogModels(opts?: {
  freshLocal?: boolean;
}): Promise<CatalogModel[]> {
  await awaitCatalogReady();
  if (opts?.freshLocal) {
    await refreshProviderLive('local');
  } else {
    // Stale-while-revalidate: never block /v1/models on a live local upstream
    // probe. Hermes's Telegram /model picker calls fetch_api_models with a
    // 5s timeout and shows an empty provider row when this endpoint is slow.
    void refreshProviderLive('local');
  }
  ensureCatalogFresh();
  const activeDefault = getDefaultModelId();
  return catalogEntries.map((e) => ({
    ...e.model,
    is_default: e.upstreamId === activeDefault,
  }));
}

export interface ResolvedRoute {
  provider: ProviderId;
  upstreamModel: string;
  displayModel: string;
  capabilities: ModelCapabilities;
}

function findEntry(requested: string): CatalogEntry | undefined {
  const raw = requested.trim();
  if (!raw) return undefined;

  const direct = entriesByKey.get(raw) ?? entriesByKey.get(norm(raw));
  if (direct) return direct;

  // Support "provider/model" format (e.g. "gonka/Kimi-K2.6")
  const slashIdx = raw.indexOf('/');
  if (slashIdx > 0) {
    const providerPart = norm(raw.slice(0, slashIdx));
    const modelPart = norm(raw.slice(slashIdx + 1));
    const byProvider = catalogEntries.find(
      (e) =>
        e.provider === providerPart &&
        (norm(e.safeId) === modelPart ||
         norm(e.model.id) === modelPart ||
         norm(e.upstreamId) === modelPart ||
         norm(shortAlias(e.upstreamId)) === modelPart ||
         norm(e.upstreamId).endsWith(`/${modelPart}`)),
    );
    if (byProvider) return byProvider;
  }

  const lower = norm(raw);
  const exact = catalogEntries.find(
    (e) =>
      norm(e.safeId) === lower ||
      norm(e.model.id) === lower ||
      norm(e.upstreamId) === lower ||
      norm(shortAlias(e.upstreamId)) === lower ||
      norm(e.upstreamId).endsWith(`/${lower}`),
  );
  if (exact) return exact;

  const partialMatches = catalogEntries.filter(
    (e) =>
      e.safeId.toLowerCase().includes(lower) ||
      e.model.name?.toLowerCase().includes(lower),
  );
  if (partialMatches.length === 1) return partialMatches[0];

  return undefined;
}

export async function resolveModelRoute(
  requestedModel?: string,
): Promise<ResolvedRoute | null> {
  await awaitCatalogReady();

  const entry = requestedModel ? findEntry(requestedModel) : undefined;
  if (!entry) return null;

  return {
    provider: entry.provider,
    upstreamModel: entry.upstreamId,
    displayModel: entry.safeId,
    capabilities:
      entry.model.capabilities ??
      resolveModelCapabilities(entry.provider, entry.upstreamId, {
        modelType: entry.model.model_type,
      }),
  };
}

export async function supportedModelIds(): Promise<string[]> {
  await awaitCatalogReady();
  return catalogEntries.map((e) => e.model.id).sort();
}
