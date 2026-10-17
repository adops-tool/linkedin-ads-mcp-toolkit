import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { TokenStore, normalizeTokens } from '../dist/auth/token-store.js';
import { LinkedInOAuth } from '../dist/auth/oauth.js';

const token = extra => ({ access_token: 'old-access', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, scope: 'rw_ads', token_type: 'Bearer', ...extra });
const json = value => new Response(JSON.stringify(value));

async function storeFor(t, fetcher) {
  const directory = await mkdtemp(path.join(tmpdir(), 'linkedin-token-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'tokens.json');
  return { store: new TokenStore(filePath, fetcher), filePath, directory };
}

function env(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('token normalization validates upstream responses and calculates expirations', () => {
  const result = normalizeTokens({ access_token: 'a', expires_in: 10, refresh_token: 'r', refresh_token_expires_in: 30 }, 1000);
  assert.equal(result.expires_at, 1010);
  assert.equal(result.refresh_token_expires_at, 1030);
  for (const value of [{}, { access_token: '', expires_in: 10 }, { access_token: 'a', expires_in: '10' }, { access_token: 'a', expires_in: 0 }]) assert.throws(() => normalizeTokens(value));
});

test('token writes are atomic, survive restart, and do not expose mutable state', async t => {
  const { store, filePath, directory } = await storeFor(t);
  await store.saveTokens(token());
  assert.equal((await new TokenStore(filePath).getTokens()).access_token, 'old-access');
  const copy = await store.getTokens(); copy.access_token = 'tampered';
  assert.equal(await store.getAccessToken(), 'old-access');
  assert.deepEqual(await readdir(directory), ['tokens.json']);
  await store.clearTokens();
  assert.equal(await store.getAccessToken(), null);
  assert.deepEqual(await readdir(directory), []);
});

test('corrupt token files and missing persisted expiration are not treated as authenticated', async t => {
  const { filePath } = await storeFor(t);
  await writeFile(filePath, '{broken');
  assert.equal(await new TokenStore(filePath).hasValidToken(), false);
  await writeFile(filePath, JSON.stringify({ access_token: 'a', expires_in: 300 }));
  assert.equal(await new TokenStore(filePath).hasValidToken(), false);
});

test('concurrent refreshes share one request and preserve refresh tokens omitted by LinkedIn', async t => {
  env(t, { LINKEDIN_CLIENT_ID: 'test-client', LINKEDIN_CLIENT_SECRET: 'test-secret' });
  let calls = 0;
  const { store, filePath } = await storeFor(t, async () => { calls++; await delay(10); return json({ access_token: 'new-access', expires_in: 3600 }); });
  await store.saveTokens(token({ expires_at: 1, refresh_token: 'refresh-original', refresh_token_expires_at: Math.floor(Date.now() / 1000) + 86400 }));
  const access = await Promise.all(Array.from({ length: 20 }, () => store.getAccessToken()));
  assert.ok(access.every(value => value === 'new-access'));
  assert.equal(calls, 1);
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(saved.refresh_token, 'refresh-original');
  assert.equal(saved.scope, 'rw_ads');
  assert.ok(saved.refresh_token_expires_at > Date.now() / 1000);
});

test('tokens remain usable until actual expiry when refresh is unavailable', async t => {
  env(t, { LINKEDIN_CLIENT_ID: undefined, LINKEDIN_CLIENT_SECRET: undefined });
  const { store } = await storeFor(t);
  await store.saveTokens(token({ expires_at: Math.floor(Date.now() / 1000) + 60 }));
  assert.equal(await store.getAccessToken(), 'old-access');
  await store.saveTokens(token({ expires_at: 1 }));
  assert.equal(await store.getAccessToken(), null);
});

test('logout during an in-flight refresh cannot restore credentials', async t => {
  env(t, { LINKEDIN_CLIENT_ID: 'test-client', LINKEDIN_CLIENT_SECRET: 'test-secret' });
  let complete;
  const response = new Promise(resolve => { complete = resolve; });
  const { store, directory } = await storeFor(t, async () => response);
  await store.saveTokens(token({ expires_at: 1, refresh_token: 'refresh-original' }));
  const refresh = store.getAccessToken();
  await store.clearTokens();
  complete(json({ access_token: 'new-access', expires_in: 3600 }));
  assert.equal(await refresh, null);
  assert.deepEqual(await readdir(directory), []);
});

test('OAuth rejects remote callback URLs', async t => {
  env(t, { LINKEDIN_CLIENT_ID: 'test-client', LINKEDIN_CLIENT_SECRET: 'test-secret', LINKEDIN_REDIRECT_URI: 'https://example.com/callback' });
  const { store } = await storeFor(t);
  assert.throws(() => new LinkedInOAuth(store), /loopback/);
});

test('OAuth uses configured callback path, rejects forged state, and exchanges a valid code once', async t => {
  const port = await freePort();
  const redirect = `http://127.0.0.1:${port}/custom/callback`;
  env(t, { LINKEDIN_CLIENT_ID: 'test-client', LINKEDIN_CLIENT_SECRET: 'test-secret', LINKEDIN_REDIRECT_URI: redirect });
  const { store } = await storeFor(t);
  let notify, exchanges = 0;
  const ready = new Promise(resolve => { notify = resolve; });
  const oauth = new LinkedInOAuth(store, {
    timeoutMs: 3000, openBrowser: async () => {}, onAuthorizationUrl: notify,
    fetch: async (_, init) => {
      exchanges++;
      assert.equal(init.body.get('code'), 'valid-code');
      assert.equal(init.body.get('redirect_uri'), redirect);
      return json({ access_token: 'oauth-access', expires_in: 3600 });
    },
  });
  const result = oauth.authenticate();
  const authUrl = new URL(await ready);
  const wrong = await fetch(`${redirect}?code=forged&state=wrong`);
  assert.equal(wrong.status, 400);
  assert.equal(exchanges, 0);
  const response = await fetch(`${redirect}?code=valid-code&state=${authUrl.searchParams.get('state')}`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Authentication successful/);
  assert.equal((await result).access_token, 'oauth-access');
  assert.equal(await store.getAccessToken(), 'oauth-access');
  assert.equal(exchanges, 1);
});

test('OAuth port conflicts reject promptly without opening a browser', async t => {
  const occupied = createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => occupied.close());
  env(t, { LINKEDIN_CLIENT_ID: 'test-client', LINKEDIN_CLIENT_SECRET: 'test-secret', LINKEDIN_REDIRECT_URI: `http://127.0.0.1:${occupied.address().port}/callback` });
  const { store } = await storeFor(t);
  await assert.rejects(new LinkedInOAuth(store, { timeoutMs: 1000, openBrowser: () => assert.fail('browser should not open') }).authenticate(), /EADDRINUSE/);
});

test('OAuth times out and releases its callback port', async t => {
  const port = await freePort();
  env(t, { LINKEDIN_CLIENT_ID: 'test-client', LINKEDIN_CLIENT_SECRET: 'test-secret', LINKEDIN_REDIRECT_URI: `http://127.0.0.1:${port}/callback` });
  const { store } = await storeFor(t);
  await assert.rejects(new LinkedInOAuth(store, { timeoutMs: 30, openBrowser: async () => {} }).authenticate(), /timed out/);
  const probe = createServer(); probe.listen(port, '127.0.0.1'); await once(probe, 'listening');
  await new Promise(resolve => probe.close(resolve));
});
