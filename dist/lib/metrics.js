function numeric(value) {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
}
function ratio(numerator, denominator, multiplier = 1) {
    return denominator > 0 ? Number((numerator / denominator * multiplier).toFixed(2)) : null;
}
/** Preserve missing reach as null; never infer audience size from impression counts. */
export function calculateStandardMetrics(record) {
    const impressions = numeric(record.impressions), clicks = numeric(record.clicks);
    const spend = numeric(record.costInUsd), conversions = numeric(record.externalWebsiteConversions);
    const engagements = numeric(record.totalEngagements);
    const reach = record.approximateUniqueImpressions == null ? null : numeric(record.approximateUniqueImpressions);
    return {
        spend, impressions, clicks, conversions, engagements, reach,
        frequency: reach === null ? null : ratio(impressions, reach),
        engagementRate: ratio(engagements, impressions, 100),
        ctr: ratio(clicks, impressions, 100), cpm: ratio(spend, impressions, 1000), cpc: ratio(spend, clicks),
        conversionRate: ratio(conversions, clicks, 100), costPerConversion: ratio(spend, conversions),
        audiencePenetration: record.audiencePenetration == null ? null : Number((numeric(record.audiencePenetration) * 100).toFixed(2)),
        averageDwellTime: record.averageDwellTime == null ? null : numeric(record.averageDwellTime),
    };
}
//# sourceMappingURL=metrics.js.map