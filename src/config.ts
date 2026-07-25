import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import type { ProviderConfig, ProviderId, ProviderPricing } from './types';
import { loadModelAllowPatterns } from './model-filter';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function env(key: string, fallback = ''): string {
  return process.env[key]?.trim() ?? fallback;
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const repoRoot = path.resolve(__dirname, '..', '..');
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
  modelAllow: loadModelAllowPatterns(),
  /** When a provider returns 429 (rate limited), retry with this model alias.
   *  Example: "gonka/Kimi-K2.6".  Leave empty to disable rate-limit fallback. */
  rateLimitFallbackModel: env('RATE_LIMIT_FALLBACK_MODEL'),
  /** General fallback model for any upstream failure (timeout, 5xx, network error).
   *  Default: gonka/Kimi-K2.6.  Leave empty to disable. */
  generalFallbackModel: env('GENERAL_FALLBACK_MODEL', 'gonka/Kimi-K2.6'),
  /** Prepended to the system message of every outgoing chat completion. */
  systemPrompt: env('SYSTEM_PROMPT'),
  /** Appended to the last user message of every outgoing chat completion. */
  systemPromptSuffix: env('SYSTEM_PROMPT_SUFFIX'),
  gpu: {
    lmStudioNativeUrl: env('LOCAL_NATIVE_URL', 'http://localhost:1234'),
    lmStudioCli: env(
      'LM_STUDIO_CLI',
      path.join(os.homedir(), '.lmstudio', 'bin', 'lms'),
    ),
    /** Optional: force this context when calling LM Studio /models/load. Omit to use Studio defaults. */
    lmLoadContextLength: process.env.LOCAL_DEFAULT_CONTEXT_LENGTH !== undefined
      ? envNum('LOCAL_DEFAULT_CONTEXT_LENGTH', 0)
      : undefined,
    comfyApiUrl: env('COMFY_API_URL', 'http://127.0.0.1:8188'),
    comfyRunScript: path.resolve(
      repoRoot,
      env('COMFY_RUN_SCRIPT', 'ComfyUI/run.sh'),
    ),
    comfyPidFile: path.resolve(
      repoRoot,
      env('COMFY_PID_FILE', 'ComfyUI/comfyui.pid'),
    ),
  },
};

function providerConfig(
  id: ProviderId,
  prefix: string,
  ownedBy: string,
  extra?: Partial<Pick<ProviderConfig, 'cwd' | 'defaultContextLength'>>,
  pricingDefaults?: Partial<ProviderPricing>,
  defaults?: { baseUrl?: string; defaultModel?: string },
): ProviderConfig {
  const pricing: ProviderPricing = {
    inputPerMillion: envNum(
      `${prefix}_INPUT_PRICE_PER_M`,
      pricingDefaults?.inputPerMillion ?? 0,
    ),
    outputPerMillion: envNum(
      `${prefix}_OUTPUT_PRICE_PER_M`,
      pricingDefaults?.outputPerMillion ?? 0,
    ),
  };
  const cacheDefault = pricingDefaults?.cacheReadPerMillion;
  if (
    cacheDefault !== undefined ||
    process.env[`${prefix}_CACHE_READ_PRICE_PER_M`] !== undefined
  ) {
    pricing.cacheReadPerMillion = envNum(
      `${prefix}_CACHE_READ_PRICE_PER_M`,
      cacheDefault ?? 0,
    );
  }

  return {
    id,
    baseUrl: env(`${prefix}_BASE_URL`, defaults?.baseUrl ?? ''),
    apiKey: env(`${prefix}_API_KEY`),
    defaultModel: env(`${prefix}_DEFAULT_MODEL`, defaults?.defaultModel ?? ''),
    pricing,
    ownedBy,
    ...extra,
  };
}

export const providerConfigs: Record<ProviderId, ProviderConfig> = {
  local: providerConfig('local', 'LOCAL', 'lm-studio'),
  gonka: providerConfig('gonka', 'GONKA', 'gonka'),
  google: providerConfig('google', 'GOOGLE', 'google'),
  cursor: providerConfig('cursor', 'CURSOR', 'cursor', {
    cwd: env('CURSOR_CWD', repoRoot),
    defaultContextLength: envNum('CURSOR_DEFAULT_CONTEXT', 200_000),
  }, {
    inputPerMillion: 0.5,
    outputPerMillion: 2.5,
    cacheReadPerMillion: 0.2,
  }, {
    defaultModel: 'composer-2.5@fast=false',
  }),
  deepseek: providerConfig(
    'deepseek',
    'DEEPSEEK',
    'deepseek',
    undefined,
    {
      inputPerMillion: 0.14,
      outputPerMillion: 0.28,
      cacheReadPerMillion: 0.0028,
    },
    {
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-v4-flash',
    },
  ),
  groq: providerConfig(
    'groq',
    'GROQ',
    'groq',
    undefined,
    {
      inputPerMillion: 0,
      outputPerMillion: 0,
    },
    {
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'llama-4-maverick-17b-instruct',
    },
  ),
};

export function normalizeTarget(target: string): ProviderId {
  if (target === 'remote') return 'gonka';
  if (
    target === 'local' ||
    target === 'gonka' ||
    target === 'google' ||
    target === 'cursor' /    target === 'deepseek' ||
    target === 'groq'
  ) {
    return target;
  }
  throw new Error(`Unknown provider target: ${target}`);
}
