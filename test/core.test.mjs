import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { loadConfig } from '../dist/lib/config.js';
import { HttpTransport, retryAfterMs, redact } from '../dist/lib/http.js';
import { parseDate, validateDateRange } from '../dist/lib/dates.js';
import { LinkedInApiClient } from '../dist/lib/linkedin-api.js';
import { createInputValidator } from '../dist/lib/validation.js';
import { serializeForScript, escapeHtml, safeUrl } from '../dist/lib/html.js';
import { generateHTML } from '../dist/scripts/generate-dashboard.js';
import { handleGetDailyTrends, handleComparePerformance } from '../dist/tools/analytics.js';
import { handleCreateCampaign, handleDeleteCampaign, handleUploadImage, uploadImageTool } from '../dist/tools/campaign-management.js';
import { calculateStandardMetrics } from '../dist/lib/metrics.js';
import { handleGetLeadGenPerformance, handleGetConversionPerformance } from '../dist/tools/conversions.js';
import { handleGetCreativePerformance } from '../dist/tools/performance.js';

const config = overrides => ({ ...loadConfig({}), retryBaseDelayMs: 1, retryMaxDelayMs: 20, ...overrides });
const json = (value, status = 200, headers) => new Response(JSON.stringify(value), { status, headers });
const tokenStore = { getAccessToken: async () => 'test-token' };
const api = (fetcher, overrides) => new LinkedInApiClient(tokenStore, { config: config(overrides), fetch: fetcher, sleep: async () => {} });

test('configuration rejects invalid values rather than silently applying defaults', () => {
  assert.equal(loadConfig({}).apiVersion, '202601');
  assert.equal(loadConfig({ LINKEDIN_READ_ONLY: 'true' }).readOnly, true);
  for (const env of [{ LINKEDIN_MAX_RETRIES: '-1' }, { LINKEDIN_MAX_CONCURRENCY: '0' }, { LINKEDIN_REQUEST_TIMEOUT_MS: '' }, { LINKEDIN_READ_ONLY: 'yes' }, { LINKEDIN_API_VERSION: '202613' }]) assert.throws(() => loadConfig(env));
});

test('calendar validation catches impossible dates and reversed ranges', () => {
  assert.deepEqual(parseDate('2024-02-29'), { year: 2024, month: 2, day: 29 });
  for (const date of ['2025-02-29', '2026-04-31', '2026-1-01', 'garbage']) assert.throws(() => parseDate(date));
  assert.throws(() => validateDateRange('2026-03-02', '2026-03-01'));
});

test('GET retries transient failures and respects Retry-After', async () => {
  let calls = 0;
  const waits = [];
  const transport = new HttpTransport(config(), async () => ++calls < 3 ? json({ message: 'Busy' }, 429, { 'retry-after': '0.01' }) : json({ ok: true }), async ms => waits.push(ms));
  assert.deepEqual(await transport.request('https://api.linkedin.com/rest/test'), { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 10]);
});

test('permanent HTTP failures are not retried and token values are redacted', async () => {
  let calls = 0;
  const transport = new HttpTransport(config(), async () => { calls++; return json({ message: 'Denied test-token' }, 401); });
  await assert.rejects(transport.request('https://api.linkedin.com/rest/test', { headers: { Authorization: 'Bearer test-token' } }), error => error.status === 401 && !error.message.includes('test-token'));
  assert.equal(calls, 1);
  assert.ok(!redact('access_token=secret&refresh_token=other Bearer hidden').includes('secret'));
});

test('mutation requests are never repeated after network or server failures', async () => {
  for (const failure of [() => json({ message: 'Busy' }, 503), () => { throw new TypeError('Connection reset'); }]) {
    let calls = 0;
    const transport = new HttpTransport(config(), async () => { calls++; return failure(); });
    await assert.rejects(transport.request('https://api.linkedin.com/rest/test', { method: 'POST', body: '{}' }));
    assert.equal(calls, 1);
  }
});

test('exhausted rate limits preserve HTTP status and excessive Retry-After is not ignored', async () => {
  let calls = 0;
  const transport = new HttpTransport(config(), async () => { calls++; return json({ message: 'Throttled' }, 429, { 'retry-after': '60' }); });
  await assert.rejects(transport.request('https://api.linkedin.com/rest/test'), error => error.status === 429);
  assert.equal(calls, 1);
  assert.equal(retryAfterMs('not a date'), undefined);
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('2026-10-21T07:27:59Z')), 1000);
});

test('JSON bodies, create IDs, no-content responses, and malformed JSON are handled correctly', async () => {
  const transport = new HttpTransport(config(), async url => {
    if (url.endsWith('create')) return json({ name: 'Created' }, 201, { 'x-restli-id': '123' });
    if (url.endsWith('empty')) return new Response(null, { status: 204 });
    return new Response('<html>upstream failure</html>');
  });
  assert.deepEqual(await transport.request('https://example.test/create', { method: 'POST' }), { name: 'Created', id: '123' });
  assert.deepEqual(await transport.request('https://example.test/empty'), {});
  await assert.rejects(transport.request('https://example.test/invalid'), /invalid JSON/);
});

test('network timeout aborts a stalled real HTTP request', async t => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const transport = new HttpTransport(config({ requestTimeoutMs: 30, maxRetries: 0 }));
  await assert.rejects(transport.request(`http://127.0.0.1:${server.address().port}/stall`), /timed out/);
});

test('concurrency limits apply to downloads and release slots on failure', async () => {
  let active = 0, peak = 0;
  const transport = new HttpTransport(config({ maxConcurrency: 2, maxRetries: 0 }), async () => {
    active++; peak = Math.max(peak, active);
    await delay(5); active--;
    return json({ ok: true });
  });
  await Promise.all(Array.from({ length: 12 }, (_, i) => transport.request(`https://example.test/${i}`)));
  assert.equal(peak, 2);
});

test('concurrent identical GETs share a request, completed reads are fresh', async () => {
  let calls = 0;
  const client = api(async () => { calls++; await delay(5); return json({ id: '1' }); });
  await Promise.all([client.getAccountDetails('1'), client.getAccountDetails('1')]);
  assert.equal(calls, 1);
  await client.getAccountDetails('1');
  assert.equal(calls, 2);
});

test('cursor pagination retrieves all pages before applying account filters', async () => {
  const urls = [];
  const client = api(async url => {
    urls.push(new URL(url));
    return urls.length === 1 ? json({ elements: [{ id: '1', test: true }], metadata: { nextPageToken: 'a+b/c=' } }) : json({ elements: [{ id: '2', test: false }] });
  });
  assert.deepEqual((await client.listAdAccounts()).map(a => a.id), ['2']);
  assert.equal(urls[1].searchParams.get('pageToken'), 'a+b/c=');
  assert.equal(urls[1].searchParams.get('pageSize'), '100');
});

test('pagination detects cursor loops and maximum-page exhaustion', async () => {
  const fetcher = async () => json({ elements: [{ id: '1' }], metadata: { nextPageToken: 'same' } });
  await assert.rejects(api(fetcher).listCampaigns('1'), /repeated/);
  await assert.rejects(api(fetcher, { maxPages: 1 }).listCampaigns('1'), /MAX_PAGES/);
});

test('offset pagination reads remaining pages and rejects credential-leaking next links', async () => {
  let calls = 0;
  const client = api(async () => json({ elements: [{ id: String(++calls) }], paging: { count: 1, start: calls - 1, total: 2 } }));
  assert.equal((await client.listConversions('1')).length, 2);
  const unsafe = api(async () => json({ elements: [], paging: { count: 1, start: 0, links: [{ rel: 'next', href: 'https://attacker.invalid/rest/conversions' }] } }));
  await assert.rejects(unsafe.listConversions('1'), /invalid pagination link/);
});

test('collection and entity permission errors propagate; only 404 means missing', async () => {
  const denied = api(async () => json({ message: 'Forbidden' }, 403));
  await assert.rejects(denied.listCampaigns('1'), error => error.status === 403);
  await assert.rejects(denied.listCreatives('1'), error => error.status === 403);
  await assert.rejects(denied.getCampaign('1', '2'), error => error.status === 403);
  assert.equal(await api(async () => json({ message: 'Missing' }, 404)).getCampaign('1', '2'), null);
});

test('large metric selections merge by dimension rather than upstream row order', async () => {
  let calls = 0;
  const client = api(async url => {
    const fields = new URL(url).searchParams.get('fields').split(',');
    assert.ok(fields.length <= 20);
    const ids = ++calls === 1 ? ['1', '2'] : ['2', '1'];
    return json({ elements: ids.map(id => ({ pivotValues: [`urn:li:sponsoredCampaign:${id}`], dateRange: { start: { year: 2026, month: 1, day: 1 } }, ...Object.fromEntries(fields.filter(f => f.startsWith('metric')).map(f => [f, Number(id)])) })) });
  });
  const records = await client.getAnalytics({ accountId: '1', pivot: 'CAMPAIGN', startDate: '2026-01-01', endDate: '2026-01-02', timeGranularity: 'DAILY', metrics: Array.from({ length: 23 }, (_, i) => `metric${i}`) });
  assert.equal(calls, 2);
  assert.equal(records[0].metric22, 1);
  assert.equal(records[1].metric22, 2);
});

test('metric batch dimension changes fail explicitly', async () => {
  let calls = 0;
  const client = api(async () => json({ elements: [{ pivotValues: [String(++calls)] }] }));
  await assert.rejects(client.getAnalytics({ accountId: '1', pivot: 'ACCOUNT', startDate: '2026-01-01', endDate: '2026-01-01', metrics: Array.from({ length: 21 }, (_, i) => `m${i}`) }), /dimensions changed/);
});

test('creative filtering is sent to the API and video metrics fit the field budget', async () => {
  let calls = 0;
  const client = api(async url => {
    calls++;
    const query = new URL(url).searchParams;
    assert.equal(query.get('creatives'), 'List(urn:li:sponsoredCreative:7)');
    assert.ok(query.get('fields').split(',').length <= 20);
    return json({ elements: [] });
  });
  await client.getCreativePerformance({ accountId: '1', creativeIds: ['7'], startDate: '2026-01-01', endDate: '2026-01-01', timeGranularity: 'DAILY' });
  assert.equal(calls, 2);
});

test('read-only mode blocks low-level writes and uploads before any network or file access', async () => {
  const client = api(async () => assert.fail('unexpected network call'), { readOnly: true });
  await assert.rejects(client.createCampaignGroup('1', {}), /disabled/);
  await assert.rejects(client.uploadImage({ owner: '1', filePath: '/missing.png' }), /disabled/);
});

test('oversized and disguised image files are rejected before upload initialization', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'linkedin-image-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'image.png');
  await writeFile(filePath, 'this is not an image');
  const client = api(async () => assert.fail('unexpected upload initialization'));
  await assert.rejects(client.uploadImage({ owner: '1', filePath }), /content does not match/);
  await assert.rejects(api(async () => assert.fail(), { maxUploadBytes: 4 }).uploadImage({ owner: '1', filePath }), /no larger/);
});

test('schema validation rejects unknown fields, invalid types, budgets, dates, and paths', () => {
  const validate = createInputValidator({ name: 'example', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, startDate: { type: 'string' }, dailyBudgetAmount: { type: 'string' } }, required: ['accountId'] } });
  assert.deepEqual(validate({ accountId: 'urn:li:sponsoredAccount:123' }), { accountId: '123' });
  for (const value of [null, { accountId: 123 }, { accountId: '../test' }, { accountId: '1', unknown: true }, { accountId: '1', startDate: '2026-02-30' }, { accountId: '1', dailyBudgetAmount: '-10' }]) assert.throws(() => validate(value));
  const upload = createInputValidator(uploadImageTool);
  assert.equal(upload({ organizationId: 'urn:li:sponsoredAccount:1', filePath: path.resolve('example.png') }).organizationId, 'urn:li:sponsoredAccount:1');
});

test('zero-impression days remain the lowest day and weekdays use UTC', async () => {
  const client = { getAnalytics: async () => [0, 10, 20].map((impressions, i) => ({ dateRange: { start: { year: 2026, month: 1, day: i + 4 } }, impressions, clicks: 0, costInUsd: '0' })) };
  const result = await handleGetDailyTrends(client, { accountId: '1', startDate: '2026-01-04', endDate: '2026-01-06' });
  assert.equal(result.summary.lowestDay.date, '2026-01-04');
  assert.equal(result.summary.weekdayAverages.sunday.avgImpressions, 0);
});

test('percentage growth from a zero baseline is undefined rather than 100 percent', async () => {
  let calls = 0;
  const result = await handleComparePerformance({ getAnalytics: async () => [{ impressions: calls++ ? 20 : 0 }] }, { accountId: '1', comparisonType: 'TIME_PERIOD', periodA: { startDate: '2026-01-01', endDate: '2026-01-01' }, periodB: { startDate: '2026-01-02', endDate: '2026-01-02' } });
  assert.equal(result.changes.impressions.percentage, null);
});

test('campaign budgets inherit account currency and mismatched currencies fail before writes', async () => {
  let writes = 0;
  const client = { getAccountDetails: async () => ({ currency: 'EUR' }), createCampaign: async (_, data) => { writes++; assert.equal(data.dailyBudget.currencyCode, 'EUR'); return { id: '2' }; } };
  const input = { accountId: '1', campaignGroupId: '2', name: 'Campaign', objectiveType: 'WEBSITE_VISIT', dailyBudgetAmount: '10', unitCostAmount: '1', targetingCriteria: {} };
  await handleCreateCampaign(client, input);
  await assert.rejects(handleCreateCampaign(client, { ...input, dailyBudgetCurrency: 'USD' }), /match account currency/);
  assert.equal(writes, 1);
});

test('missing campaigns cannot be deleted', async () => {
  await assert.rejects(handleDeleteCampaign({ getCampaign: async () => null, deleteCampaign: () => assert.fail() }, { accountId: '1', campaignId: '2' }), /not found/);
});

test('HTML helpers prevent script termination, attribute injection, and unsafe URL schemes', () => {
  const dangerous = '</script><script>alert(1)</script>\u2028';
  const serialized = serializeForScript({ name: dangerous });
  assert.ok(!serialized.includes('<'));
  assert.deepEqual(JSON.parse(serialized), { name: dangerous });
  assert.equal(escapeHtml('"<x>'), '&quot;&lt;x&gt;');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('https://user:pass@example.com'), '');
});

test('generated dashboard escapes account names and embedded records; client script parses', () => {
  const malicious = '</script><script>alert(1)</script>';
  const html = generateHTML(malicious, '2026-01-01', '2026-01-02', { impressions: 0, reach: 0, clicks: 0, engagements: 0, cost: 0, conversions: 0 }, [], [], [], { example: malicious }, [], [], [malicious]);
  assert.ok(!html.includes(malicious));
  assert.match(html, /Partial report/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0][1]);
});

test('missing reach stays unknown and reported zero reach is preserved', () => {
  const missing = calculateStandardMetrics({ impressions: 1000, clicks: 10, costInUsd: '12.34' });
  assert.equal(missing.reach, null);
  assert.equal(missing.frequency, null);
  assert.equal(missing.spend, 12.34);
  const zero = calculateStandardMetrics({ impressions: 1000, approximateUniqueImpressions: 0 });
  assert.equal(zero.reach, 0);
  assert.equal(zero.frequency, null);
});

test('conversion and lead totals retain spend from rows without results', async () => {
  const records = [
    { pivotValues: ['1'], costInUsd: '15.00', oneClickLeads: 0, externalWebsiteConversions: 0 },
    { pivotValues: ['2'], costInUsd: '10.00', oneClickLeads: 2, externalWebsiteConversions: 2 },
  ];
  const client = { getLeadGenPerformance: async () => records, getConversionPerformance: async () => records,
    getCampaignsByIds: async () => new Map(), listConversions: async () => [] };
  const input = { accountId: '1', startDate: '2026-01-01', endDate: '2026-01-02' };
  const leads = await handleGetLeadGenPerformance(client, input);
  const conversions = await handleGetConversionPerformance(client, input);
  assert.equal(leads.leadMetrics.totalCost, 25);
  assert.equal(leads.leadMetrics.overallCostPerLead, 12.5);
  assert.equal(conversions.totals.totalCost, 25);
  assert.equal(conversions.totals.overallCostPerConversion, 12.5);
});

test('creative reporting forwards creative filters and preserves reporting dates', async () => {
  const dateRange = { start: { year: 2026, month: 1, day: 1 }, end: { year: 2026, month: 1, day: 1 } };
  const client = { getCreativePerformance: async options => {
    assert.deepEqual(options.creativeIds, ['2']);
    return [{ pivotValues: ['urn:li:sponsoredCreative:2'], dateRange, impressions: 100 }];
  }, getCreativesByIds: async () => new Map([['2', { intendedStatus: 'DRAFT' }]]) };
  const result = await handleGetCreativePerformance(client, { accountId: '1', creativeIds: ['2'], startDate: '2026-01-01', endDate: '2026-01-01', timeGranularity: 'DAILY' });
  assert.deepEqual(result.creatives[0].dateRange, dateRange);
  assert.equal(result.creatives[0].status, 'DRAFT');
  assert.equal(result.creatives[0].metrics.reach, null);
  assert.equal(result.totals.reach, null);
});
