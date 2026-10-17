import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/server.js';
import { loadConfig } from '../dist/lib/config.js';

async function connect(t, overrides = {}) {
  let calls = 0;
  const api = { config: { ...loadConfig({}), ...overrides }, listAdAccounts: async () => { calls++; return []; } };
  const server = createMcpServer({ getTokenExpirationInfo: () => null }, api);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, api, calls: () => calls };
}

test('MCP initialization and tool discovery advertise every tool with annotations', async t => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 28);
  assert.equal(new Set(tools.map(tool => tool.name)).size, 28);
  assert.equal(tools.find(tool => tool.name === 'get_analytics').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'create_campaign').annotations.destructiveHint, true);
});

test('MCP status works without tokens and never returns credential material', async t => {
  const { client, calls } = await connect(t);
  const result = await client.callTool({ name: 'get_server_status', arguments: {} });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.authenticated, false);
  assert.equal(data.version, '1.1.0');
  assert.equal(calls(), 0);
  assert.ok(!result.content[0].text.includes('client_secret'));
});

test('MCP validates arguments before reaching API handlers and reports unknown tools', async t => {
  const { client, calls } = await connect(t);
  for (const request of [{ name: 'list_ad_accounts', arguments: { includeTest: 'yes' } }, { name: 'get_account_details', arguments: { accountId: '../escape' } }, { name: 'does_not_exist', arguments: {} }]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
  }
  assert.equal(calls(), 0);
  const valid = await client.callTool({ name: 'list_ad_accounts' });
  assert.equal(valid.isError, undefined);
  assert.equal(calls(), 1);
});

test('read-only mode hides all mutation tools and rejects calls by name', async t => {
  const { client, calls } = await connect(t, { readOnly: true });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 18);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
  const result = await client.callTool({ name: 'delete_campaign', arguments: { accountId: '1', campaignId: '2' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /disabled/);
  assert.equal(calls(), 0);
});

test('real stdio process completes handshake and discovery without credentials or stdout noise', async t => {
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: { ...process.env, LINKEDIN_READ_ONLY: 'true', TOKEN_STORAGE_PATH: 'test/nonexistent-tokens.json' }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 18);
  const result = await client.callTool({ name: 'get_server_status', arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).authenticated, false);
  await client.close();
  assert.ok(!stderr.includes('test-secret'));
});
