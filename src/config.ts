import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import type { ProviderConfig, ProviderId, ProviderPricing, ProviderRateLimits, ModelQuirkOverrides } from './types';
import { loadModelAllowPatterns } from './model-filter';
import { getMetadataRateLimits, getMetadataModelQuirks } from './providers/metadata';
import { setEnvAliases, getMergedAliases } from './services/alias-store';

// Load .env BEFORE any config values are computed.
// Default: ../.env (relative to dist/, i.e. workspace/code/proxy/.env)
// Override: set PROXY_ENV_FILE env var before launching node.
const envPath = path.resolve(__dirname, '..', process.env.PROXY_ENV_FILE ?? '.env');
if (!fs.existsSync(envPath)) {
  console.error(`❌ .env file not found: ${envPath}`);
  console.error(`   Set PROXY_ENV_FILE env var to specify a custom path.`);
  console.error(`   Example: PROXY_ENV_FILE=~/hermes/.env-proxy node dist/index.js`);
  process.exit(1);
}
dotenv.config({ path: envPath });
console.log(`📄 Loaded config: ${envPath}`);

function env(key: string, fallback = ''): string {
  return process.env[key]?.trim() ?? fallback;
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function mergeRateLimits(
  metadata: ProviderRateLimits,
  envPrefix: string,
  hardcoded: ProviderRateLimits,
): ProviderRateLimits {
  const result: ProviderRateLimits = { ...metadata, ...hardcoded };
  // Env vars override everything
  const tpm = envNum(`${envPrefix}_TPM`, result.tokensPerMinute ?? 0);
  const rpm = envNum(`${envPrefix}_RPM`, result.requestsPerMinute ?? 0);
  const rph = envNum(`${envPrefix}_RPH`, result.requestsPerHour ?? 0);
  const rpd = envNum(`${envPrefix}_RPD`, result.requestsPerDay ?? 0);
  if (tpm > 0) result.tokensPerMinute = tpm;
  if (rpm > 0) result.requestsPerMinute = rpm;
  if (rph > 0) result.requestsPerHour = rph;
  if (rpd > 0) result.requestsPerDay = rpd;
  return result;
}

function envRateLimit(prefix: string, defaults: ProviderRateLimits = {}): ProviderRateLimits {
  const out: ProviderRateLimits = {};
  const tpm = envNum(`${prefix}_TPM`, defaults.tokensPerMinute ?? 0);
  const rpm = envNum(`${prefix}_RPM`, defaults.requestsPerMinute ?? 0);
  const rph = envNum(`${prefix}_RPH`, defaults.requestsPerHour ?? 0);
  const rpd = envNum(`${prefix}_RPD`, defaults.requestsPerDay ?? 0);
  if (tpm > 0) out.tokensPerMinute = tpm;
  if (rpm > 0) out.requestsPerMinute = rpm;
  if (rph > 0) out.requestsPerHour = rph;
  if (rpd > 0) out.requestsPerDay = rpd;
  return Object.keys(out).length > 0 ? out : {};
}

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const logsDir = path.resolve(repoRoot, env('LOGS_DIR', 'logs'));

export const appConfig = {
  port: envNum('PORT', 5001),
  host: env('HOST', '0.0.0.0'),
  defaultProvider: env('DEFAULT_PROVIDER', 'local') as ProviderId,
  fallbackCharsPerToken: envNum('FALLBACK_CHARS_PER_TOKEN', 4),
  fallbackPricing: {
    inputPerMillion: envNum('FALLBACK_INPUT_PRICE_PER_M', 0.3),
    outputPerMillion: envNum('FALLBACK_OUTPUT_PRICE_PER_M', 2.5),
  },
  logsDir,
  costLogPath: env('COST_LOG_PATH')
    ? path.resolve(repoRoot, env('COST_LOG_PATH'))
    : path.join(logsDir, 'costs.log'),
  reqLogDir: path.join(logsDir, 'req'),
  reqOldDir: path.join(logsDir, 'req-old'),
  modelAllow: loadModelAllowPatterns(),
  rateLimitFallbackModel: env('RATE_LIMIT_FALLBACK_MODEL'),
  generalFallbackModel: env('GENERAL_FALLBACK_MODEL', 'gonka/Kimi-K2.6'),
  /** Named model aliases with fallback chains.
   *  Sources (merged, env overrides store):
   *    .env — MODEL{n}_ALIAS / MODEL{n}_TRY
   *    store/aliases.json — user-managed via /v1/aliases API
   *  On failure, the proxy tries each chain entry in order.
   *  Per-provider endpoints (/deepseek/v1/...) have no fallback — only the root /v1 does. */
  modelAliases: (() => {
    const envMap = new Map<string, string[]>();
    for (let i = 1; ; i++) {
      const alias = env(`MODEL${i}_ALIAS`);
      const tryChain = env(`MODEL${i}_TRY`);
      if (!alias) break;
      if (!tryChain) continue;
      const chain = tryChain.split(',').map((s) => s.trim()).filter(Boolean);
      if (chain.length > 0) envMap.set(alias, chain);
    }
    setEnvAliases(envMap);
    return getMergedAliases();
  })(),
  /** Backward-compat: global fallback chain for any model not in modelAliases above. */
  modelFallbackChain: env('MODEL_FALLBACK_CHAIN')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** When true, a 429 from upstream is passed through to the client
   *  (with Retry-After headers) instead of trying the fallback chain.
   *  The client (Hermes) handles the backoff itself. */
  doNotFallbackOn429: env('DO_NOT_FALLBACK_ON_429') === 'true',
  /** How long a request waits in the concurrent-request queue (per model
   *  with a CONCURRENT limit) before giving up and falling back / 429. */
  retryQueueWaitTimeout: envNum('RETRY_QUEUE_WAIT_TIMEOUT', 45),
  /** How many times a request may re-queue after a queue timeout or a
   *  "too many concurrent requests" 429 before giving up. After the
   *  last attempt it proceeds to the normal fallback/429 path. */
  retryLoopCounter: envNum('RETRY_LOOP_COUNTER', 1),
  /** When true, the preferred-group pool picks a random free member
   *  instead of the first one in chain order. Spreads load across all
   *  providers in the pool (e.g. gonka + gonka-dahl) instead of
   *  pinning every request on the single lowest-display-order provider. */
  preferredGroupRandom: env('PREFERRED_GROUP_RANDOM') === 'true',
  systemPrompt: env('SYSTEM_PROMPT'),
  systemPromptSuffix: env('SYSTEM_PROMPT_SUFFIX'),
  gpu: {
    lmStudioNativeUrl: env('LOCAL_NATIVE_URL', 'http://localhost:1234'),
    lmStudioCli: env(
      'LM_STUDIO_CLI',
      path.join(os.homedir(), '.lmstudio', 'bin', 'lms'),
    ),
    lmLoadContextLength: process.env.LOCAL_DEFAULT_CONTEXT_LENGTH !== undefined
      ? envNum('LOCAL_DEFAULT_CONTEXT_LENGTH', 0)
      : undefined,
    comfyApiUrl: env('COMFY_API_URL', 'http://127.0.0.1:8188'),
    comfyRunScript: (() => {
      const raw = env('COMFY_RUN_SCRIPT', '');
      if (raw) return path.resolve(repoRoot, raw);
      return path.join(os.homedir(), 'hermes', 'ComfyUI', 'run.sh');
    })(),
    comfyPidFile: (() => {
      const raw = env('COMFY_PID_FILE', '');
      if (raw) return path.resolve(repoRoot, raw);
      return path.join(os.homedir(), 'hermes', 'ComfyUI', 'comfyui.pid');
    })(),
  },
  android: {
    adbPath: env('ANDROID_ADB_PATH', 'adb'),
    tcpipPort: envNum('ANDROID_TCPIP_PORT', 5555),
    targetVid: env('ANDROID_DEVICE_VID', ''),
    targetPid: env('ANDROID_DEVICE_PID', ''),
  },
};

function buildPricing(
  prefix: string,
  defaults?: Partial<ProviderPricing>,
): ProviderPricing {
  const pricing: ProviderPricing = {
    inputPerMillion: envNum(`${prefix}_INPUT_PRICE_PER_M`, defaults?.inputPerMillion ?? 0),
    outputPerMillion: envNum(`${prefix}_OUTPUT_PRICE_PER_M`, defaults?.outputPerMillion ?? 0),
  };
  const cacheDefault = defaults?.cacheReadPerMillion;
  if (cacheDefault !== undefined || process.env[`${prefix}_CACHE_READ_PRICE_PER_M`] !== undefined) {
    pricing.cacheReadPerMillion = envNum(`${prefix}_CACHE_READ_PRICE_PER_M`, cacheDefault ?? 0);
  }
  return pricing;
}

// ---- Provider configurations (data-driven) ----

// Load curated metadata from JSON (context lengths, rate limits per model & provider)
const metaRateLimits = Object.fromEntries(
  (['local', 'gonka', 'gonka-dahl', 'gonka-api', 'joingonka', 'gonka-mingles', 'gonka-router-io', 'gonkabroker', 'hyperfusion', 'google', 'cursor', 'deepseek', 'groq', 'cerebras', 'openrouter'] as ProviderId[])
    .map((id) => [id, getMetadataRateLimits(id)] as const),
);
const metaModelQuirks = Object.fromEntries(
  (['local', 'gonka', 'gonka-dahl', 'gonka-api', 'joingonka', 'gonka-mingles', 'gonka-router-io', 'gonkabroker', 'hyperfusion', 'google', 'cursor', 'deepseek', 'groq', 'cerebras', 'openrouter'] as ProviderId[])
    .map((id) => [id, getMetadataModelQuirks(id)] as const),
);

export const providerConfigs: Record<ProviderId, ProviderConfig> = {
  local: {
    id: 'local',
    displayOrder: 0,
    baseUrl: env('LOCAL_BASE_URL', 'http://localhost:1234/v1'),
    apiKey: env('LOCAL_API_KEY', 'lm-studio'),
    defaultModel: env('LOCAL_DEFAULT_MODEL', 'google/gemma-4-12b-qat'),
    pricing: buildPricing('LOCAL', { inputPerMillion: 0, outputPerMillion: 0 }),
    ownedBy: 'lm-studio',
    defaultContextLength: 128_000,
    modelQuirks: {},
  },

  gonka: {
    id: 'gonka',
    displayOrder: 1,
    baseUrl: env('GONKA_BASE_URL', 'https://proxy.gonka.gg/v1'),
    apiKey: env('GONKA_API_KEY'),
    defaultModel: env('GONKA_DEFAULT_MODEL', 'MiniMaxAI/MiniMax-M2.7'),
    pricing: buildPricing('GONKA', { inputPerMillion: 0, outputPerMillion: 0 }),
    ownedBy: 'gonka',
    rateLimits: mergeRateLimits(metaRateLimits.gonka, 'GONKA', {}),
    modelQuirks: { ...metaModelQuirks.gonka },
  },

  'gonka-dahl': {
    id: 'gonka-dahl',
    displayOrder: 1,
    baseUrl: env('GONKA_DAHL_BASE_URL', 'https://inference.dahl.global/v1'),
    apiKey: env('GONKA_DAHL_API_KEY'),
    defaultModel: env('GONKA_DAHL_DEFAULT_MODEL', 'MiniMaxAI/MiniMax-M2.7'),
    pricing: buildPricing('GONKA_DAHL', { inputPerMillion: 0, outputPerMillion: 0 }),
    ownedBy: 'gonka-dahl',
    rateLimits: mergeRateLimits(metaRateLimits['gonka-dahl'], 'GONKA_DAHL', {}),
    modelQuirks: { ...metaModelQuirks['gonka-dahl'] },
  },

  'gonka-api': {
    id: 'gonka-api',
    displayOrder: 1,
    baseUrl: env('GONKA_API_ORG_BASE_URL', 'https://hskyauefqcgbvgvxkluj.supabase.co/functions/v1/gonka/v1'),
    apiKey: env('GONKA_API_ORG_API_KEY'),
    defaultModel: env('GONKA_API_ORG_DEFAULT_MODEL', 'MiniMaxAI/MiniMax-M2.7'),
    pricing: buildPricing('GONKA_API_ORG', { inputPerMillion: 0, outputPerMillion: 0 }),
    ownedBy: 'gonka-api',
    rateLimits: mergeRateLimits(metaRateLimits['gonka-api'], 'GONKA_API_ORG', {}),
    modelQuirks: { ...metaModelQuirks['gonka-api'] },
  },

  joingonka: {
    id: 'joingonka',
    displayOrder: 1,
    baseUrl: env('JOINGONKA_BASE_URL', 'https://gate.joingonka.ai/v1'),
    apiKey: env('JOINGONKA_API_KEY'),
    defaultModel: env('JOINGONKA_DEFAULT_MODEL', 'MiniMaxAI/MiniMax-M2.7'),
    pricing: buildPricing('JOINGONKA', { inputPerMillion: 0, outputPerMillion: 0 }),
    ownedBy: 'joingonka',
    rateLimits: mergeRateLimits(metaRateLimits.joingonka, 'JOINGONKA', {}),
    modelQuirks: { ...metaModelQuirks.joingonka },
  },

  'gonka-mingles': {
    id: 'gonka-mingles',
    displayOrder: 1,
    baseUrl: env('GONKA_MINGLES_BASE_URL', 'https://router.mingles.ai/v1'),
    apiKey: env('GONKA_MINGLES_API_KEY'),
    defaultModel: env('GONKA_MINGLES_DEFAULT_MODEL', 'MiniMaxAI/MiniMax-M2.7'),
    pricing: buildPricing('GONKA_MINGLES', { inputPerMillion: 0, outputPerMillion: 0 }),
    ownedBy: 'gonka-mingles',
    rateLimits: mergeRateLimits(metaRateLimits['gonka-mingles'], 'GONKA_MINGLES', {}),
    modelQuirks: { ...metaModelQuirks['gonka-mingles'] },
  },

  'gonka-router-io': {
    id: 'gonka-router-io',
    displayOrder: 1,
    baseUrl: env('GONKA_ROUTER_IO_BASE_URL', 'https://api.gonkarouter.io/v1'),
    apiKey: env('GONKA_ROUTER_IO_API_KEY'),
    defaultModel: env('GONKA_ROUTER_IO_DEFAULT_MODEL', 'MiniMaxAI/MiniMax-M2.7'),
    pricing: buildPricing('GONKA_ROUTER_IO', { inputPerMillion: 0, outputPerMillion: 0 }),
    ownedBy: 'gonka-router-io',
    rateLimits: mergeRateLimits(metaRateLimits['gonka-router-io'], 'GONKA_ROUTER_IO', {}),
    modelQuirks: { ...metaModelQuirks['gonka-router-io'] },
  },

  gonkabroker: {
    id: 'gonkabroker',
    displayOrder: 1,
    baseUrl: env('GONKABROKER_BASE_URL', 'https://proxy.gonkabroker.com/v1'),
    apiKey: env('GONKABROKER_API_KEY'),
    defaultModel: env('GONKABROKER_DEFAULT_MODEL', 'MiniMaxAI/MiniMax-M2.7'),
    pricing: buildPricing('GONKABROKER', { inputPerMillion: 0, outputPerMillion: 0 }),
    ownedBy: 'gonkabroker',
    rateLimits: mergeRateLimits(metaRateLimits.gonkabroker, 'GONKABROKER', {}),
    modelQuirks: { ...metaModelQuirks.gonkabroker },
  },

  hyperfusion: {
    id: 'hyperfusion',
    displayOrder: 1,
    baseUrl: env('HYPERFUSION_BASE_URL', 'https://api.hyperfusion.io/v1'),
    apiKey: env('HYPERFUSION_API_KEY'),
    defaultModel: env('HYPERFUSION_DEFAULT_MODEL', 'MiniMaxAI/MiniMax-M2.7'),
    pricing: buildPricing('HYPERFUSION', { inputPerMillion: 0, outputPerMillion: 0 }),
    ownedBy: 'hyperfusion',
    rateLimits: mergeRateLimits(metaRateLimits.hyperfusion, 'HYPERFUSION', {}),
    modelQuirks: { ...metaModelQuirks.hyperfusion },
  },

  google: {
    id: 'google',
    displayOrder: 2,
    baseUrl: env('GOOGLE_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai'),
    apiKey: env('GOOGLE_API_KEY'),
    defaultModel: env('GOOGLE_DEFAULT_MODEL', 'gemini-flash-latest'),
    pricing: buildPricing('GOOGLE', { inputPerMillion: 0.30, outputPerMillion: 2.50 }),
    ownedBy: 'google',
    rateLimits: mergeRateLimits(metaRateLimits.google, 'GOOGLE', { requestsPerMinute: 15 }),
    modelQuirks: { ...metaModelQuirks.google },
  },

  cursor: {
    id: 'cursor',
    displayOrder: 3,
    baseUrl: env('CURSOR_BASE_URL', ''),
    apiKey: env('CURSOR_API_KEY'),
    defaultModel: env('CURSOR_DEFAULT_MODEL', 'composer-2.5@fast=false'),
    pricing: buildPricing('CURSOR', { inputPerMillion: 0.50, outputPerMillion: 2.50, cacheReadPerMillion: 0.20 }),
    ownedBy: 'cursor',
    cwd: env('CURSOR_CWD', repoRoot),
    defaultContextLength: envNum('CURSOR_DEFAULT_CONTEXT', 200_000),
    rateLimits: envRateLimit('CURSOR', { requestsPerMinute: 30 }),
    modelQuirks: {
      'composer': { contextLength: 200_000 },
    },
  },

  deepseek: {
    id: 'deepseek',
    displayOrder: 4,
    baseUrl: env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
    apiKey: env('DEEPSEEK_API_KEY'),
    defaultModel: env('DEEPSEEK_DEFAULT_MODEL', 'deepseek-v4-flash'),
    pricing: buildPricing('DEEPSEEK', { inputPerMillion: 0.14, outputPerMillion: 0.28, cacheReadPerMillion: 0.0028 }),
    ownedBy: 'deepseek',
    rateLimits: mergeRateLimits(metaRateLimits.deepseek, 'DEEPSEEK', {}),
    modelQuirks: {
      ...metaModelQuirks.deepseek,
      'deepseek-chat': { contextLength: 128_000 },
      'deepseek-reasoner': { contextLength: 128_000 },
      'deepseek-v4-flash': { contextLength: 1_000_000 },
      'deepseek-v4-pro': { contextLength: 1_000_000 },
      'deepseek': { contextLength: 1_000_000 },
    },
  },

  groq: {
    id: 'groq',
    displayOrder: 5,
    baseUrl: env('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
    apiKey: env('GROQ_API_KEY'),
    defaultModel: env('GROQ_DEFAULT_MODEL', 'llama-4-maverick-17b-instruct'),
    pricing: buildPricing('GROQ', { inputPerMillion: 0, outputPerMillion: 0 }),
    ownedBy: 'groq',
    rateLimits: mergeRateLimits(metaRateLimits.groq, 'GROQ', { tokensPerMinute: 50_000, requestsPerMinute: 30 }),
    modelQuirks: { ...metaModelQuirks.groq },
  },

  cerebras: {
    id: 'cerebras',
    displayOrder: 6,
    baseUrl: env('CEREBRAS_BASE_URL', 'https://api.cerebras.ai/v1'),
    apiKey: env('CEREBRAS_API_KEY'),
    defaultModel: env('CEREBRAS_DEFAULT_MODEL', 'gpt-oss-120b'),
    pricing: buildPricing('CEREBRAS', { inputPerMillion: 0.60, outputPerMillion: 0.90 }),
    ownedBy: 'cerebras',
    defaultContextLength: 131000,
    rateLimits: mergeRateLimits(metaRateLimits.cerebras, 'CEREBRAS', {}),
    modelQuirks: {
      ...metaModelQuirks.cerebras,
      'gpt-oss-120b': { contextLength: 131000 },
    },
  },

  openrouter: {
    id: 'openrouter',
    displayOrder: 7,
    baseUrl: env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    apiKey: env('OPENROUTER_API_KEY'),
    defaultModel: env('OPENROUTER_DEFAULT_MODEL', 'openai/gpt-4o'),
    pricing: buildPricing('OPENROUTER', { inputPerMillion: 0, outputPerMillion: 0 }),
    ownedBy: 'openrouter',
    defaultContextLength: 128_000,
    rateLimits: mergeRateLimits(metaRateLimits.openrouter, 'OPENROUTER', {}),
    extraHeaders: {
      'HTTP-Referer': env('OPENROUTER_HTTP_REFERER', 'http://localhost:5001'),
      'X-Title': env('OPENROUTER_X_TITLE', 'LLM Proxy'),
    },
    modelQuirks: {
      ...metaModelQuirks.openrouter,
      'openai/gpt-4o': { contextLength: 128_000 },
    },
  },
};

// ---- Legacy normalizeTarget (used by switch-model.sh / admin routes) ----

const VALID_TARGETS = new Set(Object.keys(providerConfigs));

export function normalizeTarget(target: string): ProviderId {
  if (target === 'remote') return 'gonka';
  if (VALID_TARGETS.has(target)) return target as ProviderId;
  throw new Error(`Unknown provider target: ${target}`);
}