import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { LinkedInTokens } from '../lib/types.js';
import { loadConfig } from '../lib/config.js';

const DEFAULT_TOKEN_PATH = path.join(os.homedir(), '.linkedin-ads-mcp', 'tokens.json');

export function normalizeTokens(value: unknown, now = Math.floor(Date.now() / 1000)): LinkedInTokens {
  if (!value || typeof value !== 'object') throw new Error('Invalid token response');
  const data = value as Record<string, unknown>;
  if (typeof data.access_token !== 'string' || !data.access_token.trim()
    || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw new Error('Token response requires access_token and a positive expires_in');
  }
  for (const key of ['expires_at', 'refresh_token_expires_in', 'refresh_token_expires_at']) {
    if (data[key] !== undefined && (typeof data[key] !== 'number' || !Number.isFinite(data[key]) || (data[key] as number) <= 0)) {
      throw new Error(`Invalid token ${key}`);
    }
  }
  if (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token.trim())) {
    throw new Error('Invalid refresh token');
  }
  return {
    access_token: data.access_token,
    expires_in: data.expires_in,
    expires_at: typeof data.expires_at === 'number' ? data.expires_at : now + data.expires_in,
    scope: typeof data.scope === 'string' ? data.scope : '',
    token_type: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
    ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}),
    ...(typeof data.refresh_token_expires_in === 'number' ? { refresh_token_expires_in: data.refresh_token_expires_in } : {}),
    ...(typeof data.refresh_token_expires_at === 'number' ? { refresh_token_expires_at: data.refresh_token_expires_at }
      : typeof data.refresh_token_expires_in === 'number' ? { refresh_token_expires_at: now + data.refresh_token_expires_in } : {}),
  };
}

export class TokenStore {
  private readonly tokenPath: string;
  private tokens: LinkedInTokens | null = null;
  private refreshPromise?: Promise<boolean>;
  private nextRefreshAttemptAt = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(tokenPath?: string, private readonly fetcher: typeof fetch = fetch) {
    this.tokenPath = path.resolve(tokenPath ?? process.env.TOKEN_STORAGE_PATH ?? DEFAULT_TOKEN_PATH);
    try {
      const stored = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
      if (typeof stored.expires_at !== 'number') throw new Error('Missing token expiration');
      this.tokens = normalizeTokens(stored);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not load token file. Run npm run auth to authenticate again.');
    }
  }

  async saveTokens(tokens: LinkedInTokens): Promise<void> {
    const normalized = normalizeTokens(tokens);
    const operation = this.writes.then(async () => {
      await fsp.mkdir(path.dirname(this.tokenPath), { recursive: true, mode: 0o700 });
      const temporary = `${this.tokenPath}.${randomUUID()}.tmp`;
      try {
        const file = await fsp.open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(normalized, null, 2)); await file.sync(); }
        finally { await file.close(); }
        await fsp.rename(temporary, this.tokenPath);
        this.tokens = normalized;
      } finally { await fsp.rm(temporary, { force: true }); }
    });
    this.writes = operation.catch(() => {});
    return operation;
  }

  async getTokens(): Promise<LinkedInTokens | null> { return this.tokens ? { ...this.tokens } : null; }

  async getAccessToken(): Promise<string | null> {
    const tokens = this.tokens;
    if (!tokens) return null;
    const now = Math.floor(Date.now() / 1000);
    if (tokens.expires_at > now + 300) return tokens.access_token;
    if (Date.now() >= this.nextRefreshAttemptAt && tokens.refresh_token && (!tokens.refresh_token_expires_at || tokens.refresh_token_expires_at > now)) {
      if (!this.refreshPromise) {
        this.refreshPromise = this.refreshAccessToken().then(success => {
          this.nextRefreshAttemptAt = success ? 0 : Date.now() + 30000;
          return success;
        }).finally(() => { this.refreshPromise = undefined; });
      }
      if (await this.refreshPromise) return this.tokens?.access_token ?? null;
    }
    return this.tokens && this.tokens.expires_at > Math.floor(Date.now() / 1000) ? this.tokens.access_token : null;
  }

  async hasValidToken(): Promise<boolean> { return (await this.getAccessToken()) !== null; }

  private async refreshAccessToken(): Promise<boolean> {
    const previous = this.tokens;
    if (!previous?.refresh_token) return false;
    const clientId = process.env.LINKEDIN_CLIENT_ID, clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    if (!clientId || !clientSecret) return false;
    try {
      const response = await this.fetcher('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(loadConfig().requestTimeoutMs),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: previous.refresh_token, client_id: clientId, client_secret: clientSecret }),
      });
      if (!response.ok) { console.error(`Token refresh failed (HTTP ${response.status})`); return false; }
      const value = await response.json() as Record<string, unknown>;
      const tokens = normalizeTokens({
        ...value,
        refresh_token: value.refresh_token ?? previous.refresh_token,
        scope: value.scope ?? previous.scope,
        refresh_token_expires_at: value.refresh_token_expires_in === undefined ? previous.refresh_token_expires_at : undefined,
      });
      if (this.tokens !== previous) return false;
      await this.saveTokens(tokens);
      return true;
    } catch { console.error('Token refresh failed. Check connectivity and OAuth credentials.'); return false; }
  }

  async clearTokens(): Promise<void> {
    this.tokens = null;
    const operation = this.writes.then(async () => { await fsp.rm(this.tokenPath, { force: true }); this.tokens = null; });
    this.writes = operation.catch(() => {});
    return operation;
  }

  getTokenExpirationInfo(): { expiresAt: Date; isExpired: boolean; expiresInMinutes: number } | null {
    if (!this.tokens) return null;
    const expiresAt = new Date(this.tokens.expires_at * 1000);
    return { expiresAt, isExpired: expiresAt.getTime() <= Date.now(), expiresInMinutes: Math.floor((expiresAt.getTime() - Date.now()) / 60000) };
  }
}
