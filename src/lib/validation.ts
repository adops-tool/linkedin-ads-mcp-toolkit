import { Ajv } from 'ajv';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { parseDate, validateDateRange } from './dates.js';
import { isAbsolute } from 'node:path';

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, useDefaults: false });
const idTypes: Record<string, string> = {
  accountId: 'sponsoredAccount', campaignId: 'sponsoredCampaign', campaignGroupId: 'sponsoredCampaignGroup',
  creativeId: 'sponsoredCreative', organizationId: 'organization',
};

export function createInputValidator(tool: Tool): (args: unknown) => Record<string, unknown> {
  const schema = structuredClone(tool.inputSchema);
  schema.additionalProperties = false;
  const validate = ajv.compile(schema);
  return (args: unknown) => {
    const value = args ?? {};
    if (!validate(value)) throw new Error(`Invalid arguments for ${tool.name}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
    const input = structuredClone(value) as Record<string, unknown>;
    for (const [key, item] of Object.entries(input)) {
      if (typeof item === 'string' && !item.trim()) throw new Error(`${key} must not be empty`);
      const singular = key.endsWith('Ids') ? key.slice(0, -1) : key;
      const type = idTypes[singular];
      if (tool.name === 'upload_image' && key === 'organizationId' && typeof item === 'string' && /^urn:li:sponsoredAccount:[1-9]\d*$/.test(item)) continue;
      if (type) {
        const normalize = (id: unknown) => {
          if (typeof id !== 'string') throw new Error(`${key} must contain string IDs`);
          const numeric = id.startsWith(`urn:li:${type}:`) ? id.slice(`urn:li:${type}:`.length) : id;
          if (!/^[1-9]\d*$/.test(numeric)) throw new Error(`${key} must contain positive numeric IDs or matching LinkedIn URNs`);
          return numeric;
        };
        input[key] = Array.isArray(item) ? [...new Set(item.map(normalize))] : normalize(item);
      }
      if (/Date$/.test(key) && typeof item === 'string') parseDate(item);
      if (/Amount$/.test(key) && (typeof item !== 'string' || !/^\d+(\.\d{1,6})?$/.test(item) || !Number.isFinite(Number(item)) || Number(item) <= 0)) {
        throw new Error(`${key} must be a positive decimal string with up to six decimal places`);
      }
      if (/Currency$/.test(key) && (typeof item !== 'string' || !/^[A-Z]{3}$/.test(item))) throw new Error(`${key} must be an uppercase three-letter currency code`);
      if (typeof item === 'number' && (!Number.isFinite(item) || !Number.isInteger(item))) throw new Error(`${key} must be a finite integer`);
      if (Array.isArray(item) && (item.length > 500 || item.some(v => typeof v === 'string' && !v.trim()))) throw new Error(`${key} contains too many or empty values`);
    }
    if (typeof input.startDate === 'string' && typeof input.endDate === 'string') validateDateRange(input.startDate, input.endDate);
    for (const key of ['periodA', 'periodB']) {
      const period = input[key] as { startDate?: string; endDate?: string } | undefined;
      if (period?.startDate) validateDateRange(period.startDate, period.endDate);
    }
    if (typeof input.endDate === 'number' && input.endDate <= 0) throw new Error('endDate must be a positive Unix timestamp in milliseconds');
    if (typeof input.name === 'string' && input.name.length > (tool.name.includes('campaign_group') ? 100 : 200)) throw new Error('name exceeds the supported length');
    if (tool.name === 'create_campaign_group' && input.totalBudgetAmount && !input.endDate) throw new Error('endDate is required with totalBudgetAmount');
    if (input.comparisonType) {
      for (const key of ['periodA', 'periodB']) {
        const period = input[key] as { startDate?: string; entityIds?: string[] } | undefined;
        if (input.comparisonType === 'TIME_PERIOD' && !period?.startDate) throw new Error(`${key}.startDate is required for TIME_PERIOD comparisons`);
        if (input.comparisonType !== 'TIME_PERIOD' && (!period?.entityIds?.length || period.entityIds.some(id => !/^[1-9]\d*$/.test(id)))) throw new Error(`${key}.entityIds must contain positive numeric IDs`);
      }
    }
    if (tool.name === 'search_ad_library') {
      if (input.count !== undefined && (Number(input.count) < 1 || Number(input.count) > 25)) throw new Error('count must be between 1 and 25');
      if (input.start !== undefined && Number(input.start) < 0) throw new Error('start must be nonnegative');
      const from = input.totalImpressionsRangeFrom, to = input.totalImpressionsRangeTo;
      if ((from !== undefined && Number(from) < 0) || (to !== undefined && Number(to) < 0) || (from !== undefined && to !== undefined && Number(from) > Number(to))) throw new Error('Invalid impressions range');
    }
    if (input.limit !== undefined && (Number(input.limit) < 1 || Number(input.limit) > 10000)) throw new Error('limit must be between 1 and 10000');
    if (tool.name === 'upload_image') {
      if (!isAbsolute(String(input.filePath))) throw new Error('filePath must be an absolute local path');
      if (Boolean(input.accountId) !== Boolean(input.assetName)) throw new Error('Provide both accountId and assetName for media library registration');
    }
    if (input.landingPageUrl !== undefined) {
      const url = new URL(String(input.landingPageUrl));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('landingPageUrl must be an HTTP(S) URL without credentials');
    }
    return input;
  };
}
