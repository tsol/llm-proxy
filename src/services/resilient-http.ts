import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';

/** Transient DNS / network errors — safe to retry. */
const TRANSIENT_ERR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NODATA',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'ERR_NETWORK',
]);

const TRANSIENT_HTTP_STATUS = new Set([429, 502, 503, 504]);

const DEFAULT_ATTEMPTS = 4;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * 120);
  return exp + jitter;
}

export function isTransientHttpError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;

  if (err.code && TRANSIENT_ERR_CODES.has(err.code)) return true;

  const msg = err.message.toLowerCase();
  if (
    msg.includes('getaddrinfo') ||
    msg.includes('eai_again') ||
    msg.includes('socket hang up') ||
    msg.includes('network error')
  ) {
    return true;
  }

  const status = err.response?.status;
  return status !== undefined && TRANSIENT_HTTP_STATUS.has(status);
}

async function resilientRequest<T>(
  config: AxiosRequestConfig,
  attempts = DEFAULT_ATTEMPTS,
): Promise<AxiosResponse<T>> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await axios.request<T>(config);
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < attempts - 1 && isTransientHttpError(err);
      if (!canRetry) throw err;
      await sleep(retryDelay(attempt));
    }
  }

  throw lastErr;
}

export function resilientGet<T = unknown>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  return resilientRequest<T>({ ...config, method: 'GET', url });
}

export function resilientPost<T = unknown>(
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  return resilientRequest<T>({ ...config, method: 'POST', url, data });
}
