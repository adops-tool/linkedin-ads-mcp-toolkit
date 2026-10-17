#!/usr/bin/env node


import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { LinkedInApiClient } from "./lib/linkedin-api.js";
import { TokenStore } from "./auth/token-store.js";
import {
  listAdAccountsTool,
  getAccountDetailsTool,
  handleListAdAccounts,
  handleGetAccountDetails,
} from "./tools/accounts.js";
import {
  getCampaignPerformanceTool,
  getCreativePerformanceTool,
  getCampaignGroupsTool,
  handleGetCampaignPerformance,
  handleGetCreativePerformance,
  handleGetCampaignGroups,
} from "./tools/performance.js";
import {
  getAudienceDemographicsTool,
  getAudienceReachTool,
  listSavedAudiencesTool,
  handleGetAudienceDemographics,
  handleGetAudienceReach,
  handleListSavedAudiences,
} from "./tools/demographics.js";
import {
  getConversionPerformanceTool,
  listConversionsTool,
  getLeadGenPerformanceTool,
  listLeadFormsTool,
  handleGetConversionPerformance,
  handleListConversions,
  handleGetLeadGenPerformance,
  handleListLeadForms,
} from "./tools/conversions.js";
import {
  comparePerformanceTool,
  getDailyTrendsTool,
  handleComparePerformance,
  handleGetDailyTrends,
} from "./tools/analytics.js";
import {
  createCampaignGroupTool,
  updateCampaignGroupTool,
  deleteCampaignGroupTool,
  createCampaignTool,
  updateCampaignTool,
  deleteCampaignTool,
  updateCreativeStatusTool,
  createCreativeTool,
  handleCreateCampaignGroup,
  handleUpdateCampaignGroup,
  handleDeleteCampaignGroup,
  handleCreateCampaign,
  handleUpdateCampaign,
  handleDeleteCampaign,
  handleUpdateCreativeStatus,
  handleCreateCreative,
  createInlineAdTool,
  handleCreateInlineAd,
  listCampaignsTool,
  handleListCampaigns,
  uploadImageTool,
  handleUploadImage,
} from "./tools/campaign-management.js";
import {
  searchAdLibraryTool,
  handleSearchAdLibrary,
} from "./tools/ad-library.js";

import { createInputValidator } from './lib/validation.js';
import { LinkedInRequestError, redact } from './lib/http.js';

const registrations: Array<[Tool, (client: LinkedInApiClient, args: unknown) => Promise<unknown>]> = [
  [listAdAccountsTool, handleListAdAccounts], [getAccountDetailsTool, handleGetAccountDetails],
  [getCampaignPerformanceTool, handleGetCampaignPerformance], [getCreativePerformanceTool, handleGetCreativePerformance],
  [getCampaignGroupsTool, handleGetCampaignGroups], [getAudienceDemographicsTool, handleGetAudienceDemographics],
  [getAudienceReachTool, handleGetAudienceReach], [listSavedAudiencesTool, handleListSavedAudiences],
  [getConversionPerformanceTool, handleGetConversionPerformance], [listConversionsTool, handleListConversions],
  [getLeadGenPerformanceTool, handleGetLeadGenPerformance], [listLeadFormsTool, handleListLeadForms],
  [comparePerformanceTool, handleComparePerformance], [getDailyTrendsTool, handleGetDailyTrends],
  [createCampaignGroupTool, handleCreateCampaignGroup], [updateCampaignGroupTool, handleUpdateCampaignGroup],
  [deleteCampaignGroupTool, handleDeleteCampaignGroup], [createCampaignTool, handleCreateCampaign],
  [updateCampaignTool, handleUpdateCampaign], [deleteCampaignTool, handleDeleteCampaign],
  [updateCreativeStatusTool, handleUpdateCreativeStatus], [createCreativeTool, handleCreateCreative],
  [createInlineAdTool, handleCreateInlineAd], [listCampaignsTool, handleListCampaigns],
  [uploadImageTool, handleUploadImage], [searchAdLibraryTool, handleSearchAdLibrary],
];

const statusTool: Tool = {
  name: 'get_server_status',
  description: 'Returns local configuration and token expiration status without exposing secrets or making API calls.',
  inputSchema: { type: 'object', properties: {} },
};
const analyticsTool: Tool = {
  name: 'get_analytics',
  description: 'Query raw LinkedIn analytics with custom metrics, entity or demographic pivots, filters, and time granularity. Large metric selections are split and merged automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string' },
      pivot: { type: 'string', enum: ['ACCOUNT', 'CAMPAIGN_GROUP', 'CAMPAIGN', 'CREATIVE', 'CONVERSION', 'MEMBER_JOB_FUNCTION', 'MEMBER_SENIORITY', 'MEMBER_INDUSTRY', 'MEMBER_COMPANY_SIZE', 'MEMBER_JOB_TITLE', 'MEMBER_COMPANY', 'MEMBER_COUNTRY_V2', 'MEMBER_REGION_V2'] },
      startDate: { type: 'string' }, endDate: { type: 'string' },
      timeGranularity: { type: 'string', enum: ['ALL', 'DAILY', 'MONTHLY', 'YEARLY'] },
      campaigns: { type: 'array', items: { type: 'string', pattern: '^[1-9][0-9]*$' }, maxItems: 500 },
      campaignGroups: { type: 'array', items: { type: 'string', pattern: '^[1-9][0-9]*$' }, maxItems: 500 },
      creatives: { type: 'array', items: { type: 'string', pattern: '^[1-9][0-9]*$' }, maxItems: 500 },
      metrics: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]*$' }, minItems: 1, maxItems: 100, uniqueItems: true },
    },
    required: ['accountId', 'pivot', 'startDate'],
  },
};
registrations.push([analyticsTool, (client, args) => client.getAnalytics(args as Parameters<LinkedInApiClient['getAnalytics']>[0])]);

export function createMcpServer(tokenStore = new TokenStore(), apiClient = new LinkedInApiClient(tokenStore)): Server {
  const server = new Server({ name: 'linkedin-ads-mcp', version: '1.1.0' }, { capabilities: { tools: {} } });
  const tools = new Map(registrations.map(([tool, handler]) => {
    const readOnly = /^(list_|get_|compare_|search_)/.test(tool.name);
    return [tool.name, { tool: { ...tool, inputSchema: { ...tool.inputSchema, additionalProperties: false }, annotations: {
      readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true,
    } }, handler, readOnly, validate: createInputValidator(tool) }];
  }));
  const validateStatus = createInputValidator(statusTool);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { ...statusTool, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    ...[...tools.values()].filter(entry => !apiClient.config.readOnly || entry.readOnly).map(entry => entry.tool),
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const { name, arguments: args } = request.params;
      if (name === statusTool.name) {
        validateStatus(args);
        const expiration = tokenStore.getTokenExpirationInfo();
        return { content: [{ type: 'text', text: JSON.stringify({ name: 'linkedin-ads-mcp', version: '1.1.0',
          authenticated: Boolean(expiration && !expiration.isExpired), expiresAt: expiration?.expiresAt.toISOString() ?? null,
          config: apiClient.config, tools: 1 + [...tools.values()].filter(entry => !apiClient.config.readOnly || entry.readOnly).length,
        }, null, 2) }] };
      }
      const entry = tools.get(name);
      if (!entry) throw new Error(`Unknown tool: ${name}`);
      if (apiClient.config.readOnly && !entry.readOnly) throw new Error('Write operations are disabled by LINKEDIN_READ_ONLY');
      const input = entry.validate(args);
      const result = await entry.handler(apiClient, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({
        error: redact(error instanceof Error ? error.message : 'Unknown error'),
        ...(error instanceof LinkedInRequestError ? { status: error.status, requestId: error.requestId } : {}),
      }) }], isError: true };
    }
  });
  return server;
}
