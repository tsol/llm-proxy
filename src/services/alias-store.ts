import fs from 'fs';
import path from 'path';

// ------- Types -------

export interface AliasDef {
  /** Friendly display name (the "alias") */
  alias: string;
  /** Ordered fallback chain: provider/model,provider/model,... */
  chain: string[];
  /** Whether this alias is locked (from .env) — cannot be modified via API */
  locked: boolean;
  /** ISO timestamp of last modification (only for user aliases) */
  updatedAt?: string;
}

interface StoreData {
  version: 1;
  aliases: Record<string, string[]>;
}

// ------- Paths -------

const STORE_DIR = path.resolve(__dirname, '..', '..', 'store');
const STORE_PATH = path.join(STORE_DIR, 'aliases.json');

// ------- In-memory state -------

let storeAliases = new Map<string, string[]>();
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
      const data: StoreData = JSON.parse(raw);
      if (data && data.version === 1 && data.aliases) {
        for (const [alias, chain] of Object.entries(data.aliases)) {
          if (Array.isArray(chain) && chain.length > 0) {
            storeAliases.set(alias, chain);
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

  const data: StoreData = {
    version: 1,
    aliases: Object.fromEntries(storeAliases),
  };

  try {
    // Atomic write: write to temp, then rename
    const tmpPath = STORE_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, STORE_PATH);
    storeDirty = false;
    console.log(`[alias-store] Saved ${storeAliases.size} user aliases to ${STORE_PATH}`);
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

  // Store aliases first (lower priority)
  for (const [alias, chain] of storeAliases) {
    merged.set(alias, chain);
  }

  // Env aliases override (higher priority, locked)
  for (const [alias, chain] of envAliases) {
    merged.set(alias, chain);
  }

  return merged;
}

/** List all aliases (both locked from env and user-managed from store). */
export function listAliases(): AliasDef[] {
  loadStore();

  const result: AliasDef[] = [];
  const seen = new Set<string>();

  // Env aliases first (locked)
  for (const [alias, chain] of envAliases) {
    seen.add(alias);
    result.push({
      alias,
      chain,
      locked: true,
    });
  }

  // Store aliases (user-managed, skip if already defined in env)
  for (const [alias, chain] of storeAliases) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    result.push({
      alias,
      chain,
      locked: false,
    });
  }

  // Sort: locked first, then alphabetical
  result.sort((a, b) => {
    if (a.locked !== b.locked) return a.locked ? -1 : 1;
    return a.alias.localeCompare(b.alias);
  });

  return result;
}

/** Get a single alias by name. Returns undefined if not found. */
export function getAlias(name: string): AliasDef | undefined {
  const aliases = listAliases();
  return aliases.find((a) => a.alias === name);
}

/** Create a new user alias. Throws if name conflicts with env alias. */
export function createAlias(name: string, chain: string[]): AliasDef {
  loadStore();

  const trimmed = name.trim();
  if (!trimmed) throw new Error('Alias name is required');
  if (envAliases.has(trimmed)) {
    throw new Error(`Alias "${trimmed}" is locked (defined in .env) and cannot be overwritten`);
  }
  if (storeAliases.has(trimmed)) {
    throw new Error(`Alias "${trimmed}" already exists in store; use PUT to update`);
  }
  if (chain.length === 0) {
    throw new Error('Alias chain must have at least one entry');
  }

  storeAliases.set(trimmed, chain);
  markDirty();

  return {
    alias: trimmed,
    chain,
    locked: false,
    updatedAt: new Date().toISOString(),
  };
}

/** Update an existing user alias. Throws if alias doesn't exist or is locked. */
export function updateAlias(name: string, chain: string[]): AliasDef {
  loadStore();

  const trimmed = name.trim();
  if (!trimmed) throw new Error('Alias name is required');
  if (envAliases.has(trimmed)) {
    throw new Error(`Alias "${trimmed}" is locked (defined in .env) and cannot be modified`);
  }
  if (!storeAliases.has(trimmed)) {
    throw new Error(`Alias "${trimmed}" not found in store`);
  }
  if (chain.length === 0) {
    throw new Error('Alias chain must have at least one entry');
  }

  storeAliases.set(trimmed, chain);
  markDirty();

  return {
    alias: trimmed,
    chain,
    locked: false,
    updatedAt: new Date().toISOString(),
  };
}

/** Delete a user alias. Throws if alias is locked or doesn't exist. */
export function deleteAlias(name: string): void {
  loadStore();

  const trimmed = name.trim();
  if (!trimmed) throw new Error('Alias name is required');
  if (envAliases.has(trimmed)) {
    throw new Error(`Alias "${trimmed}" is locked (defined in .env) and cannot be deleted`);
  }
  if (!storeAliases.has(trimmed)) {
    throw new Error(`Alias "${trimmed}" not found in store`);
  }

  storeAliases.delete(trimmed);
  markDirty();
}