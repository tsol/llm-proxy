import fs from 'fs';
import path from 'path';

// ------- Types -------

export interface NodataTryParallel {
  on_sec: number;
  additional_requests: number;
}

export interface AliasGroupDef {
  strategy: string;
  members: string[];
  nodata_try_parallel?: NodataTryParallel;
}

export interface AliasDef {
  alias: string;
  chain: string[];
  locked: boolean;
  updatedAt?: string;
  /** v2: groups with strategies */
  groups?: AliasGroupDef[];
}

interface StoreDataV1 {
  version: 1;
  aliases: Record<string, string[]>;
}

interface StoreDataV2 {
  version: 2;
  aliases: Record<string, { groups: AliasGroupDef[] }>;
}

export function parseNodataTryParallel(raw: unknown): NodataTryParallel | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const onSec = Number(o.on_sec);
  const extra = Number(o.additional_requests);
  if (!Number.isFinite(onSec) || onSec <= 0) return undefined;
  if (!Number.isFinite(extra) || extra <= 0) return undefined;
  return { on_sec: Math.floor(onSec), additional_requests: Math.floor(extra) };
}

function normalizeGroup(raw: unknown): AliasGroupDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  if (!Array.isArray(g.members) || g.members.length === 0) return null;
  const members = g.members.filter((m): m is string => typeof m === 'string' && m.length > 0);
  if (!members.length) return null;
  const def: AliasGroupDef = {
    strategy: typeof g.strategy === 'string' ? g.strategy : 'order',
    members,
  };
  const nodata = parseNodataTryParallel(g.nodata_try_parallel);
  if (nodata) def.nodata_try_parallel = nodata;
  return def;
}

// ------- Paths -------

const STORE_DIR = path.resolve(__dirname, '..', '..', 'store');
const STORE_PATH = path.join(STORE_DIR, 'aliases.json');

// ------- JSON parsing (defensive) -------

/**
 * Parse the store JSON, tolerating trailing commas before `}` / `]` — the
 * classic mistake when someone edits aliases.json by hand. A broken store
 * must NEVER silently empty the alias map: that disables the fallback chain
 * entirely and turns any upstream 4xx/5xx into a hard client error.
 */
function repairedParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const fixed = raw.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(fixed);
  }
}

// ------- In-memory state -------

let storeAliases = new Map<string, { chain: string[]; groups?: AliasGroupDef[] }>();
let envAliases = new Map<string, string[]>();
let storeDirty = false;
let storeLoaded = false;

// ------- Persistence -------

function ensureStoreDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function loadStore(): void {
  if (storeLoaded) return;
  storeLoaded = true;

  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      const data = repairedParse(raw) as {
        version?: number;
        aliases?: Record<string, unknown>;
      };
      if (data && data.aliases) {
        if (data.version === 2) {
          // v2: groups format
          const v2 = data as StoreDataV2;
          for (const [alias, cfg] of Object.entries(v2.aliases)) {
            const groups = (cfg.groups ?? []).map(normalizeGroup).filter((g): g is AliasGroupDef => g !== null);
            const members = groups.flatMap(g => g.members);
            storeAliases.set(alias, { chain: members, groups });
          }
        } else if (data.version === 1) {
          // v1: flat chain
          const v1 = data as StoreDataV1;
          for (const [alias, chain] of Object.entries(v1.aliases)) {
            if (Array.isArray(chain) && chain.length > 0) {
              storeAliases.set(alias, { chain });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[alias-store] Failed to load store:', err);
  }
}

function saveStore(): void {
  if (!storeDirty) return;
  ensureStoreDir();

  const aliases: Record<string, { groups: AliasGroupDef[] }> = {};
  for (const [alias, cfg] of storeAliases) {
    aliases[alias] = {
      groups: cfg.groups ?? [{ strategy: 'order', members: cfg.chain }],
    };
  }

  const data: StoreDataV2 = { version: 2, aliases };

  try {
    const tmpPath = STORE_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, STORE_PATH);
    storeDirty = false;
  } catch (err) {
    console.error('[alias-store] Failed to save store:', err);
  }
}

function markDirty(): void {
  storeDirty = true;
  // Debounced save
  setImmediate(() => saveStore());
}

// ------- Public API -------

/**
 * Seed env alias definitions BEFORE calling getMergedAliases.
 * Call this from config.ts after parsing MODEL{n}_ALIAS / MODEL{n}_TRY.
 * Must be called exactly once at startup, before any alias operations.
 */
export function setEnvAliases(aliases: Map<string, string[]>): void {
  envAliases = aliases;
}

/** Merge env aliases (locked) + store aliases (user-managed) into a single Map.
 *  Env aliases take precedence — if a store alias has the same name as an env alias,
 *  the env version wins and the store alias is ignored. */
export function getMergedAliases(): Map<string, string[]> {
  loadStore();

  const merged = new Map<string, string[]>();

  for (const [alias, cfg] of storeAliases) {
    merged.set(alias, cfg.chain);
  }

  for (const [alias, chain] of envAliases) {
    merged.set(alias, chain);
  }

  return merged;
}

export function getAliasGroups(alias: string): AliasGroupDef[] | undefined {
  loadStore();
  // Check store first
  const storeCfg = storeAliases.get(alias);
  if (storeCfg?.groups) return storeCfg.groups;
  // Fallback: wrap flat chain in order group
  const chain = storeCfg?.chain;
  if (chain && chain.length > 0) return [{ strategy: 'order', members: chain }];
  return undefined;
}

export function listAliases(): AliasDef[] {
  loadStore();
  const seen = new Set<string>();
  const result: AliasDef[] = [];

  for (const [alias] of envAliases) {
    seen.add(alias);
    result.push({ alias, chain: [...(envAliases.get(alias) ?? [])], locked: true });
  }

  for (const [alias, cfg] of storeAliases) {
    if (seen.has(alias)) continue;
    result.push({ alias, chain: [...cfg.chain], locked: false });
  }

  return result;
}

export function getAlias(name: string): AliasDef | undefined {
  loadStore();
  if (envAliases.has(name)) {
    return { alias: name, chain: [...(envAliases.get(name) ?? [])], locked: true };
  }
  const cfg = storeAliases.get(name);
  if (cfg) {
    return { alias: name, chain: [...cfg.chain], locked: false };
  }
  return undefined;
}

export function createAlias(name: string, chain: string[]): { ok: boolean; error?: string } {
  loadStore();
  if (envAliases.has(name)) {
    return { ok: false, error: `Alias "${name}" is locked (defined in .env)` };
  }
  if (!Array.isArray(chain) || chain.length === 0) {
    return { ok: false, error: 'Chain must be a non-empty array' };
  }
  storeAliases.set(name, { chain: [...chain] });
  markDirty();
  return { ok: true };
}

export function updateAlias(name: string, chain: string[]): { ok: boolean; error?: string } {
  loadStore();
  if (envAliases.has(name)) {
    return { ok: false, error: `Alias "${name}" is locked (defined in .env)` };
  }
  if (!storeAliases.has(name)) {
    return { ok: false, error: `Alias "${name}" not found` };
  }
  if (!Array.isArray(chain) || chain.length === 0) {
    return { ok: false, error: 'Chain must be a non-empty array' };
  }
  storeAliases.set(name, { chain: [...chain] });
  markDirty();
  return { ok: true };
}

export function deleteAlias(name: string): { ok: boolean; error?: string } {
  loadStore();
  if (envAliases.has(name)) {
    return { ok: false, error: `Alias "${name}" is locked (defined in .env)` };
  }
  if (!storeAliases.has(name)) {
    return { ok: false, error: `Alias "${name}" not found` };
  }
  storeAliases.delete(name);
  markDirty();
  return { ok: true };
}
