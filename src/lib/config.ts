export interface ClientConfig {
  apiVersion: string;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  maxConcurrency: number;
  pageSize: number;
  maxPages: number;
  readOnly: boolean;
  maxUploadBytes: number;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const apiVersion = env.LINKEDIN_API_VERSION ?? '202601';
  if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(apiVersion)) throw new Error('LINKEDIN_API_VERSION must use YYYYMM format');
  const readOnly = env.LINKEDIN_READ_ONLY ?? 'false';
  if (!['true', 'false'].includes(readOnly)) throw new Error('LINKEDIN_READ_ONLY must be true or false');
  const retryBaseDelayMs = integer(env, 'LINKEDIN_RETRY_BASE_DELAY_MS', 1000, 1, 60000);
  const retryMaxDelayMs = integer(env, 'LINKEDIN_RETRY_MAX_DELAY_MS', 30000, retryBaseDelayMs, 60000);
  return {
    apiVersion,
    requestTimeoutMs: integer(env, 'LINKEDIN_REQUEST_TIMEOUT_MS', 30000, 1, 300000),
    maxRetries: integer(env, 'LINKEDIN_MAX_RETRIES', 3, 0, 10),
    retryBaseDelayMs,
    retryMaxDelayMs,
    maxConcurrency: integer(env, 'LINKEDIN_MAX_CONCURRENCY', 5, 1, 50),
    pageSize: integer(env, 'LINKEDIN_PAGE_SIZE', 100, 1, 100),
    maxPages: integer(env, 'LINKEDIN_MAX_PAGES', 1000, 1, 10000),
    readOnly: readOnly === 'true',
    maxUploadBytes: integer(env, 'LINKEDIN_MAX_UPLOAD_BYTES', 20 * 1024 * 1024, 1, 100 * 1024 * 1024),
  };
}
