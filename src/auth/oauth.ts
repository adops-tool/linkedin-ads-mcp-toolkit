import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import open from 'open';
import { TokenStore, normalizeTokens } from './token-store.js';
import type { LinkedInTokens } from '../lib/types.js';
import { loadConfig } from '../lib/config.js';

interface OAuthOptions {
  openBrowser?: (url: string) => Promise<unknown>;
  onAuthorizationUrl?: (url: string) => void;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class LinkedInOAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUrl: URL;
  private readonly scopes: string[];

  constructor(private readonly tokenStore: TokenStore, private readonly options: OAuthOptions = {}) {
    this.clientId = process.env.LINKEDIN_CLIENT_ID ?? '';
    this.clientSecret = process.env.LINKEDIN_CLIENT_SECRET ?? '';
    if (!this.clientId || !this.clientSecret) throw new Error('Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET before authenticating');
    this.redirectUrl = new URL(process.env.LINKEDIN_REDIRECT_URI ?? 'http://localhost:3000/callback');
    if (this.redirectUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(this.redirectUrl.hostname)
      || this.redirectUrl.port === '0' || this.redirectUrl.username || this.redirectUrl.password || this.redirectUrl.search || this.redirectUrl.hash) {
      throw new Error('LINKEDIN_REDIRECT_URI must be an HTTP loopback URL without credentials, query, or fragment');
    }
    this.scopes = (process.env.LINKEDIN_SCOPES ?? 'rw_ads r_ads_reporting r_organization_social w_organization_social').trim().split(/\s+/);
    if (this.scopes.some(scope => !/^[a-z_]+$/.test(scope))) throw new Error('LINKEDIN_SCOPES must contain space-separated OAuth scope names');
  }

  async authenticate(): Promise<LinkedInTokens> {
    const timeoutMs = this.options.timeoutMs ?? Number(process.env.LINKEDIN_OAUTH_TIMEOUT_MS ?? 300000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) throw new Error('LINKEDIN_OAUTH_TIMEOUT_MS must be between 1 and 1800000');
    return new Promise((resolve, reject) => {
      const state = randomBytes(32).toString('hex');
      const controller = new AbortController();
      let settled = false, exchanging = false;
      const finish = (error?: Error, tokens?: LinkedInTokens) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        controller.abort();
        server.close();
        server.closeIdleConnections();
        if (error) reject(error); else resolve(tokens!);
      };
      const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        res.setHeader('X-Content-Type-Options', 'nosniff');
        let url: URL;
        try { url = new URL(req.url ?? '/', this.redirectUrl.origin); }
        catch { res.writeHead(400).end('Invalid callback URL'); return; }
        if (req.method !== 'GET' || url.pathname !== this.redirectUrl.pathname || req.headers.host !== this.redirectUrl.host) {
          res.writeHead(404).end('Not found'); return;
        }
        const returned = url.searchParams.get('state') ?? '';
        if (url.searchParams.getAll('state').length !== 1 || Buffer.byteLength(returned) !== Buffer.byteLength(state)
          || !timingSafeEqual(Buffer.from(returned), Buffer.from(state))) {
          res.writeHead(400).end('Invalid OAuth state. Return to the original authorization URL.'); return;
        }
        if (settled || exchanging) { res.writeHead(409).end('Authorization is already being processed'); return; }
        if (url.searchParams.has('error')) {
          res.writeHead(400).end('Authorization was declined. Return to your terminal.');
          finish(new Error('LinkedIn authorization was declined')); return;
        }
        const code = url.searchParams.get('code');
        if (!code || url.searchParams.getAll('code').length !== 1) { res.writeHead(400).end('Missing authorization code'); return; }
        exchanging = true;
        try {
          const response = await (this.options.fetch ?? fetch)('https://www.linkedin.com/oauth/v2/accessToken', {
            method: 'POST', redirect: 'error',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(loadConfig().requestTimeoutMs)]),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.clientId,
              client_secret: this.clientSecret, redirect_uri: this.redirectUrl.toString() }),
          });
          if (!response.ok) throw new Error(`Token exchange failed (HTTP ${response.status})`);
          const tokens = normalizeTokens(await response.json());
          if (settled) return;
          await this.tokenStore.saveTokens(tokens);
          res.end('Authentication successful. You can close this window and return to your terminal.');
          finish(undefined, tokens);
        } catch {
          res.writeHead(400).end('Authentication failed. Return to your terminal and try again.');
          finish(new Error('OAuth token exchange or token storage failed'));
        }
      });
      const timeout = setTimeout(() => {
        finish(new Error('OAuth flow timed out. Run npm run auth to try again.'));
        server.closeAllConnections();
      }, timeoutMs);
      server.once('error', error => finish(new Error(`OAuth callback server failed: ${error.message}`)));
      const hostname = this.redirectUrl.hostname === '[::1]' ? '::1' : this.redirectUrl.hostname;
      server.listen(Number(this.redirectUrl.port || 80), hostname, () => {
        const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
        url.search = new URLSearchParams({ response_type: 'code', client_id: this.clientId,
          redirect_uri: this.redirectUrl.toString(), state, scope: this.scopes.join(' ') }).toString();
        console.error(`Open this URL to authorize LinkedIn:\n${url}`);
        this.options.onAuthorizationUrl?.(url.toString());
        const opener = this.options.openBrowser ?? (process.env.LINKEDIN_AUTH_NO_BROWSER === 'true' ? async () => {} : open);
        Promise.resolve().then(() => opener(url.toString())).catch(() => console.error('Open the authorization URL manually in your browser.'));
      });
    });
  }
}
