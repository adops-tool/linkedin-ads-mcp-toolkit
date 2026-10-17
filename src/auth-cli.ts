#!/usr/bin/env node
import 'dotenv/config';
import { TokenStore } from './auth/token-store.js';
import { LinkedInOAuth } from './auth/oauth.js';
import { redact } from './lib/http.js';

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some(flag => !['--help', '--status', '--logout', '--force'].includes(flag))) throw new Error('Unknown flag. Use npm run auth -- --help');
  if (flags.has('--help')) {
    console.log('Usage: npm run auth -- [--force | --status | --logout | --help]');
    return;
  }
  if (flags.size > 1) throw new Error('Choose only one authentication flag');
  const store = new TokenStore();
  if (flags.has('--logout')) { await store.clearTokens(); console.log('Local tokens removed.'); return; }
  const expiration = store.getTokenExpirationInfo();
  if (flags.has('--status')) {
    console.log(JSON.stringify({ authenticated: Boolean(expiration && !expiration.isExpired), ...expiration }, null, 2));
    return;
  }
  if (!flags.has('--force') && await store.hasValidToken()) {
    console.log('Already authenticated. Use --force to authenticate again or --status to inspect expiration.');
    return;
  }
  const tokens = await new LinkedInOAuth(store).authenticate();
  console.log(`Authentication successful. Access token expires at ${new Date(tokens.expires_at * 1000).toISOString()}.`);
  console.log(tokens.refresh_token ? 'Automatic refresh is available until the refresh token expires.' : 'No refresh token was issued; authenticate again when the access token expires.');
}
main().catch(error => { console.error(redact(error instanceof Error ? error.message : 'Authentication failed')); process.exitCode = 1; });
