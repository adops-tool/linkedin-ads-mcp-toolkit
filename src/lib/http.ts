import { setTimeout as delay } from 'node:timers/promises';
import type { ClientConfig } from './config.js';

export class LinkedInRequestError extends Error {
  constructor(message: string, public readonly status?: number, public readonly requestId?: string) {
    super(message);
    this.name = 'LinkedInRequestError';
  }
}

export function redact(message: string): string {
  let result = message.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|client_secret)["'\s]*[:=]["'\s]*)[^\s"'&,<>]+/gi, '$1[REDACTED]');
  for (const value of [process.env.LINKEDIN_CLIENT_SECRET, process.env.LINKEDIN_ACCESS_TOKEN]) {
    if (value) result = result.split(value).join('[REDACTED]');
  }
  return result;
}

export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

/** Limits entire fetch/body lifetimes, rather than only request creation. */
export class HttpTransport {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(
    private readonly config: ClientConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<unknown> = delay,
  ) {}

  private async acquire(): Promise<void> {
    if (this.active < this.config.maxConcurrency) { this.active++; return; }
    await new Promise<void>(resolve => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next(); else this.active--;
  }

  async request<T>(url: string, init: RequestInit = {}, rawResponse = false): Promise<T> {
    const method = init.method ?? 'GET';
    const attempts = method === 'GET' ? this.config.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let waitMs: number | undefined;
      await this.acquire();
      try {
        const response = await this.fetcher(url, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!response.ok) {
          const body = await response.text();
          let message = response.statusText || 'Request rejected';
          try {
            const data = JSON.parse(body) as { message?: unknown };
            if (typeof data.message === 'string') message = data.message;
          } catch { /* Unstructured upstream error bodies may contain credentials. */ }
          const authorization = new Headers(init.headers).get('authorization')?.replace(/^Bearer\s+/i, '');
          const sanitized = authorization ? redact(message).split(authorization).join('[REDACTED]') : redact(message);
          const error = new LinkedInRequestError(
            `LinkedIn API error (${response.status}): ${sanitized.slice(0, 1000)}`,
            response.status,
            response.headers.get('x-li-uuid') ?? undefined,
          );
          const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          if (!retryable || attempt === attempts - 1) throw error;
          const serverDelay = retryAfterMs(response.headers.get('retry-after'));
          // Do not retry before a server's Retry-After when it exceeds our wait budget.
          if (serverDelay !== undefined && serverDelay > this.config.retryMaxDelayMs) throw error;
          waitMs = serverDelay ?? Math.min(this.config.retryMaxDelayMs,
            this.config.retryBaseDelayMs * 2 ** attempt * (0.5 + Math.random() * 0.5));
        } else {
          // Consume bodies before returning, so timeouts and concurrency cover downloads too.
          const text = await response.text();
          if (rawResponse) return new Response(text || null, {
            status: response.status, statusText: response.statusText, headers: response.headers,
          }) as T;
          if (!text.trim()) {
            const id = response.headers.get('x-restli-id');
            return (id ? { id } : {}) as T;
          }
          try {
            const data = JSON.parse(text);
            const id = response.headers.get('x-restli-id');
            return (id && data && typeof data === 'object' && !Array.isArray(data) ? { ...data, id } : data) as T;
          }
          catch { throw new LinkedInRequestError('LinkedIn returned invalid JSON', response.status); }
        }
      } catch (error) {
        if (error instanceof LinkedInRequestError) throw error;
        if (attempt === attempts - 1) {
          throw new LinkedInRequestError(`LinkedIn ${method} request failed or timed out. ${method === 'GET' ? 'Try again later.' : 'Check the remote state before repeating this operation.'}`);
        }
        waitMs = Math.min(this.config.retryMaxDelayMs, this.config.retryBaseDelayMs * 2 ** attempt);
      } finally { this.release(); }
      await this.sleep(waitMs ?? this.config.retryBaseDelayMs);
    }
    throw new LinkedInRequestError('Request failed after retries');
  }
}
