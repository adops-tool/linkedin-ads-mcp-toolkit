import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { LinkedInApiClient } from '../lib/linkedin-api.js';
import {
  GetCampaignPerformanceInput,
  GetCreativePerformanceInput,
  GetCampaignGroupsInput,
} from '../lib/types.js';

import { calculateStandardMetrics, type StandardMetrics } from '../lib/metrics.js';

// Tool definitions
export const getCampaignPerformanceTool: Tool = {
  name: 'get_campaign_performance',
  description: 'Retrieves performance metrics for campaigns within a specified date range. Returns key metrics like impressions, clicks, spend, CTR, conversions, audience penetration, and average dwell time. The primary tool for daily campaign monitoring and optimization decisions.',
  inputSchema: {
    type: 'object',
    properties: {
      metrics: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, description: 'Optional LinkedIn metric names. Missing standard metrics are not available in the response; use get_analytics for raw custom metrics.' },
      accountId: {
        type: 'string',
        description: 'The LinkedIn Ad Account ID',
      },
      campaignIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific campaign IDs to filter. If omitted, returns all campaigns.',
      },
      campaignGroupIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by campaign group IDs',
      },
      startDate: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format',
      },
      endDate: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format. Default: today',
      },
      timeGranularity: {
        type: 'string',
        enum: ['ALL', 'DAILY', 'MONTHLY'],
        description: 'Time granularity for the data. Default: ALL',
      },
    },
    required: ['accountId', 'startDate'],
  },
};

export const getCreativePerformanceTool: Tool = {
  name: 'get_creative_performance',
  description: 'Retrieves performance metrics for individual ad creatives. Shows which specific ads are performing best, including engagement metrics (likes, comments, shares), video metrics, and average dwell time. Essential for creative optimization.',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: {
        type: 'string',
        description: 'The LinkedIn Ad Account ID',
      },
      campaignIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter creatives by campaign IDs',
      },
      creativeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific creative IDs to fetch',
      },
      startDate: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format',
      },
      endDate: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format. Default: today',
      },
      timeGranularity: {
        type: 'string',
        enum: ['ALL', 'DAILY'],
        description: 'Time granularity. Default: ALL',
      },
      includeVideoMetrics: {
        type: 'boolean',
        description: 'Include video-specific metrics. Default: true',
      },
    },
    required: ['accountId', 'startDate'],
  },
};

export const getCampaignGroupsTool: Tool = {
  name: 'get_campaign_groups',
  description: 'Lists all campaign groups for an account with their configuration and optionally aggregated performance. Campaign groups help organize campaigns and control budget at a higher level.',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: {
        type: 'string',
        description: 'The LinkedIn Ad Account ID',
      },
      status: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DRAFT'],
        },
        description: 'Filter by status',
      },
      includePerformance: {
        type: 'boolean',
        description: 'Include performance metrics. Default: true',
      },
      startDate: {
        type: 'string',
        description: 'Start date for performance (if included)',
      },
      endDate: {
        type: 'string',
        description: 'End date for performance (if included)',
      },
    },
    required: ['accountId'],
  },
};

// Tool handlers
export async function handleGetCampaignPerformance(
  client: LinkedInApiClient,
  args: unknown
): Promise<unknown> {
  const input = args as GetCampaignPerformanceInput;

  if (!input.accountId || !input.startDate) {
    throw new Error('accountId and startDate are required');
  }

  const analytics = await client.getCampaignPerformance({
    accountId: input.accountId,
    campaignIds: input.campaignIds,
    campaignGroupIds: input.campaignGroupIds,
    startDate: input.startDate,
    endDate: input.endDate,
    timeGranularity: input.timeGranularity,
    metrics: input.metrics,
  });

  // Extract campaign IDs from analytics results and fetch them directly
  const campaignIds = analytics
    .map((record: any) => record.pivotValues?.[0]?.split(':').pop())
    .filter((id): id is string => Boolean(id));

  // Get campaign details by IDs (this handles pagination correctly)
  const campaignMap = await client.getCampaignsByIds(input.accountId, campaignIds);

  const results = analytics.map((record: any) => {
    const campaignUrn = record.pivotValues?.[0] || '';
    const campaignId = campaignUrn.split(':').pop() || '';
    const campaign = campaignMap.get(campaignId);
    const standardMetrics = calculateStandardMetrics(record);

    return {
      campaignId,
      campaignName: campaign?.name || 'Unknown',
      dateRange: record.dateRange,
      campaignGroupId: campaign?.campaignGroup?.split(':').pop() || null,
      status: campaign?.status || 'Unknown',
      metrics: {
        ...standardMetrics,
        landingPageClicks: record.landingPageClicks || 0,
        costInLocalCurrency: parseFloat(record.costInLocalCurrency) || 0,
      },
    };
  });

  // Calculate totals with standard metrics
  const totalRecord = results.reduce(
    (acc, r) => ({
      impressions: acc.impressions + r.metrics.impressions,
      clicks: acc.clicks + r.metrics.clicks,
      costInUsd: acc.costInUsd + r.metrics.spend,
      totalEngagements: acc.totalEngagements + r.metrics.engagements,
      externalWebsiteConversions: acc.externalWebsiteConversions + r.metrics.conversions,
      approximateUniqueImpressions: acc.approximateUniqueImpressions + (r.metrics.reach ?? 0),
    }),
    {
      impressions: 0, clicks: 0, costInUsd: 0, totalEngagements: 0,
      externalWebsiteConversions: 0, approximateUniqueImpressions: 0
    }
  );

  return {
    campaigns: results,
    totals: calculateStandardMetrics({ ...totalRecord, approximateUniqueImpressions: results.every(result => result.metrics.reach !== null) ? totalRecord.approximateUniqueImpressions : null }),
    dateRange: {
      start: input.startDate,
      end: input.endDate || new Date().toISOString().split('T')[0],
    },
  };
}

export async function handleGetCreativePerformance(
  client: LinkedInApiClient,
  args: unknown
): Promise<unknown> {
  const input = args as GetCreativePerformanceInput;

  if (!input.accountId || !input.startDate) {
    throw new Error('accountId and startDate are required');
  }

  const analytics = await client.getCreativePerformance({
    accountId: input.accountId,
    campaignIds: input.campaignIds,
    creativeIds: input.creativeIds,
    startDate: input.startDate,
    endDate: input.endDate,
    timeGranularity: input.timeGranularity,
    includeVideoMetrics: input.includeVideoMetrics,
  });

  // Extract creative IDs from analytics results
  const creativeIds = analytics
    .map((record: any) => record.pivotValues?.[0]?.split(':').pop())
    .filter((id): id is string => Boolean(id));

  // Fetch creative details to get names
  const creativeMap = await client.getCreativesByIds(input.accountId, creativeIds);

  const results = analytics.map((record: any) => {
    const creativeUrn = record.pivotValues?.[0] || '';
    const creativeId = creativeUrn.split(':').pop() || '';
    const creative = creativeMap.get(creativeId);
    const standardMetrics = calculateStandardMetrics(record);

    // Extract creative name from the creative object
    const creativeName = creative?.name || creative?.content?.textAd?.text?.substring(0, 50) || `Creative ${creativeId}`;

    return {
      creativeId,
      creativeName,
      dateRange: record.dateRange,
      status: creative?.intendedStatus || creative?.status || 'Unknown',
      metrics: {
        // Standard metrics
        ...standardMetrics,
        // Landing page clicks
        landingPageClicks: record.landingPageClicks || 0,
        // Engagement breakdown
        likes: record.likes || 0,
        comments: record.comments || 0,
        shares: record.shares || 0,
        reactions: record.reactions || 0,
        follows: record.follows || 0,
        // Video metrics (if available)
        videoViews: record.videoViews || 0,
        videoCompletions: record.videoCompletions || 0,
        videoFirstQuartileCompletions: record.videoFirstQuartileCompletions || 0,
        videoMidpointCompletions: record.videoMidpointCompletions || 0,
        videoThirdQuartileCompletions: record.videoThirdQuartileCompletions || 0,
        videoCompletionRate: record.videoViews > 0
          ? Number(((record.videoCompletions || 0) / record.videoViews * 100).toFixed(2))
          : null,
      },
    };
  });

  // Calculate totals with standard metrics
  const totalRecord = results.reduce(
    (acc, r) => ({
      impressions: acc.impressions + r.metrics.impressions,
      clicks: acc.clicks + r.metrics.clicks,
      costInUsd: acc.costInUsd + r.metrics.spend,
      totalEngagements: acc.totalEngagements + r.metrics.engagements,
      externalWebsiteConversions: acc.externalWebsiteConversions + r.metrics.conversions,
      approximateUniqueImpressions: acc.approximateUniqueImpressions + (r.metrics.reach ?? 0),
      likes: acc.likes + r.metrics.likes,
      comments: acc.comments + r.metrics.comments,
      shares: acc.shares + r.metrics.shares,
      videoViews: acc.videoViews + r.metrics.videoViews,
      videoCompletions: acc.videoCompletions + r.metrics.videoCompletions,
    }),
    {
      impressions: 0, clicks: 0, costInUsd: 0, totalEngagements: 0,
      externalWebsiteConversions: 0, approximateUniqueImpressions: 0,
      likes: 0, comments: 0, shares: 0, videoViews: 0, videoCompletions: 0
    }
  );

  const totals = {
    ...calculateStandardMetrics({ ...totalRecord, approximateUniqueImpressions: results.every(result => result.metrics.reach !== null) ? totalRecord.approximateUniqueImpressions : null }),
    likes: totalRecord.likes,
    comments: totalRecord.comments,
    shares: totalRecord.shares,
    videoViews: totalRecord.videoViews,
    videoCompletions: totalRecord.videoCompletions,
    videoCompletionRate: totalRecord.videoViews > 0
      ? Number((totalRecord.videoCompletions / totalRecord.videoViews * 100).toFixed(2))
      : null,
  };

  return {
    creatives: results,
    totals,
    dateRange: {
      start: input.startDate,
      end: input.endDate || new Date().toISOString().split('T')[0],
    },
  };
}

export async function handleGetCampaignGroups(
  client: LinkedInApiClient,
  args: unknown
): Promise<unknown> {
  const input = args as GetCampaignGroupsInput;

  if (!input.accountId) {
    throw new Error('accountId is required');
  }

  const groups = await client.listCampaignGroups(input.accountId, {
    status: input.status,
  });

  // Get campaign counts per group
  const campaigns = await client.listCampaigns(input.accountId);
  const campaignCountByGroup = campaigns.reduce((acc, c) => {
    const groupId = c.campaignGroup?.split(':').pop() || '';
    acc[groupId] = (acc[groupId] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Get performance if requested
  let performanceByGroup: Record<string, StandardMetrics> = {};
  if (input.includePerformance !== false && input.startDate) {
    const analytics = await client.getCampaignGroupPerformance({
      accountId: input.accountId,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    performanceByGroup = analytics.reduce((acc, record: any) => {
      const groupUrn = record.pivotValues?.[0] || '';
      const groupId = groupUrn.split(':').pop() || '';
      acc[groupId] = calculateStandardMetrics(record);
      return acc;
    }, {} as Record<string, StandardMetrics>);
  }

  return {
    campaignGroups: groups.map(group => ({
      id: group.id,
      name: group.name,
      status: group.status,
      totalBudget: group.totalBudget,
      runSchedule: group.runSchedule
        ? {
            start: group.runSchedule.start
              ? new Date(group.runSchedule.start).toISOString()
              : null,
            end: group.runSchedule.end
              ? new Date(group.runSchedule.end).toISOString()
              : null,
          }
        : null,
      campaignCount: campaignCountByGroup[group.id] || 0,
      performance: performanceByGroup[group.id] || null,
    })),
  };
}
