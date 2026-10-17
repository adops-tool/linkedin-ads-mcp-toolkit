export interface StandardMetrics {
    spend: number;
    impressions: number;
    clicks: number;
    reach: number | null;
    frequency: number | null;
    engagements: number;
    engagementRate: number | null;
    ctr: number | null;
    cpm: number | null;
    cpc: number | null;
    conversions: number;
    conversionRate: number | null;
    costPerConversion: number | null;
    audiencePenetration: number | null;
    averageDwellTime: number | null;
}
/** Preserve missing reach as null; never infer audience size from impression counts. */
export declare function calculateStandardMetrics(record: Record<string, unknown>): StandardMetrics;
//# sourceMappingURL=metrics.d.ts.map