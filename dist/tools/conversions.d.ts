import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { LinkedInApiClient } from '../lib/linkedin-api.js';
export declare const getConversionPerformanceTool: Tool;
export declare const listConversionsTool: Tool;
export declare const getLeadGenPerformanceTool: Tool;
export declare const listLeadFormsTool: Tool;
export declare function handleGetConversionPerformance(client: LinkedInApiClient, args: unknown): Promise<unknown>;
export declare function handleListConversions(client: LinkedInApiClient, args: unknown): Promise<unknown>;
export declare function handleGetLeadGenPerformance(client: LinkedInApiClient, args: unknown): Promise<unknown>;
export declare function handleListLeadForms(client: LinkedInApiClient, args: unknown): Promise<unknown>;
//# sourceMappingURL=conversions.d.ts.map