const LINKEDIN_API_BASE = "https://api.linkedin.com";
import { loadConfig } from './config.js';
import { HttpTransport, LinkedInRequestError } from './http.js';
import { parseDate, validateDateRange } from './dates.js';
// Default metrics for different report types
const DEFAULT_PERFORMANCE_METRICS = [
    "impressions",
    "clicks",
    "landingPageClicks",
    "totalEngagements",
    "costInUsd",
    "costInLocalCurrency",
    "externalWebsiteConversions",
    "approximateUniqueImpressions",
    "averageDwellTime",
    "audiencePenetration",
];
const DEFAULT_CREATIVE_METRICS = [
    ...DEFAULT_PERFORMANCE_METRICS,
    "likes",
    "comments",
    "shares",
    "reactions",
    "follows",
];
const VIDEO_METRICS = [
    "videoViews",
    "videoStarts",
    "videoCompletions",
    "videoFirstQuartileCompletions",
    "videoMidpointCompletions",
    "videoThirdQuartileCompletions",
];
const LEAD_GEN_METRICS = [
    "oneClickLeads",
    "oneClickLeadFormOpens",
    "qualifiedLeads",
];
const REACH_METRICS = [
    "approximateMemberReach",
    "impressions",
    "audiencePenetration",
];
export class LinkedInApiClient {
    tokenStore;
    config;
    transport;
    pendingReads = new Map();
    constructor(tokenStore, options = {}) {
        this.tokenStore = tokenStore;
        this.config = options.config ?? loadConfig();
        this.transport = new HttpTransport(this.config, options.fetch, options.sleep);
    }
    async request(endpoint, options = {}) {
        if (!endpoint.startsWith('/rest/') || endpoint.startsWith('//'))
            throw new Error('Invalid LinkedIn endpoint');
        const method = options.method ?? 'GET';
        if (this.config.readOnly && method !== 'GET')
            throw new Error('Write operations are disabled by LINKEDIN_READ_ONLY');
        const accessToken = await this.tokenStore.getAccessToken();
        if (!accessToken)
            throw new Error('Not authenticated. Please run: npm run auth');
        let url = `${LINKEDIN_API_BASE}${endpoint}`;
        const queryParts = [];
        for (const [key, value] of Object.entries(options.params ?? {})) {
            if (value === undefined)
                continue;
            if (Array.isArray(value)) {
                queryParts.push(`${key}=List(${value.map(v => encodeURIComponent(v)).join(',')})`);
            }
            else if (key === 'fields' || key === 'dateRange') {
                queryParts.push(`${key}=${value}`);
            }
            else
                queryParts.push(`${key}=${encodeURIComponent(String(value))}`);
        }
        if (queryParts.length)
            url += (url.includes('?') ? '&' : '?') + queryParts.join('&');
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            'LinkedIn-Version': this.config.apiVersion,
            'X-Restli-Protocol-Version': '2.0.0',
        };
        if (options.restliMethod)
            headers['X-RestLi-Method'] = options.restliMethod;
        if (options.body !== undefined)
            headers['Content-Type'] = 'application/json';
        // Concurrent identical reads share their network request; completed reads are never cached.
        const key = JSON.stringify([url, headers]);
        if (method === 'GET' && !options.rawResponse && this.pendingReads.has(key)) {
            return this.pendingReads.get(key);
        }
        const pending = this.transport.request(url, {
            method, headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        }, options.rawResponse);
        if (method !== 'GET' || options.rawResponse)
            return pending;
        this.pendingReads.set(key, pending);
        try {
            return await pending;
        }
        finally {
            this.pendingReads.delete(key);
        }
    }
    async requestAll(endpoint, options = {}, cursor = false) {
        const elements = [];
        const seen = new Set();
        let nextEndpoint = endpoint;
        let params = { ...options.params, ...(cursor ? { pageSize: options.params?.pageSize ?? this.config.pageSize } : { count: this.config.pageSize, start: 0 }) };
        for (let page = 0; page < this.config.maxPages; page++) {
            const key = JSON.stringify([nextEndpoint, params]);
            if (seen.has(key))
                throw new Error('LinkedIn returned a repeated pagination cursor');
            seen.add(key);
            const response = await this.request(nextEndpoint, { ...options, params });
            if (!Array.isArray(response.elements))
                throw new Error('LinkedIn returned an invalid collection');
            elements.push(...response.elements);
            const token = response.metadata?.nextPageToken;
            if (cursor) {
                if (!token)
                    return elements;
                params = { ...params, pageToken: token };
                continue;
            }
            const next = response.paging?.links?.find(link => link.rel === 'next');
            if (next) {
                const url = new URL(next.href, LINKEDIN_API_BASE);
                if (url.origin !== LINKEDIN_API_BASE || url.pathname !== new URL(endpoint, LINKEDIN_API_BASE).pathname) {
                    throw new Error('LinkedIn returned an invalid pagination link');
                }
                nextEndpoint = url.pathname + url.search;
                params = {};
                continue;
            }
            const paging = response.paging;
            if (!paging || response.elements.length === 0 || (paging.total !== undefined
                ? paging.start + response.elements.length >= paging.total
                : response.elements.length < paging.count))
                return elements;
            if (!Number.isInteger(paging.count) || paging.count <= 0 || !Number.isInteger(paging.start)) {
                throw new Error('LinkedIn returned invalid pagination metadata');
            }
            nextEndpoint = endpoint;
            params = { ...options.params, count: paging.count, start: paging.start + response.elements.length };
        }
        throw new Error(`Pagination exceeded LINKEDIN_MAX_PAGES (${this.config.maxPages}); narrow your filters or raise the limit`);
    }
    formatDateRange(startDate, endDate = new Date().toISOString().slice(0, 10)) {
        validateDateRange(startDate, endDate);
        const start = parseDate(startDate), end = parseDate(endDate);
        return `(start:(year:${start.year},month:${start.month},day:${start.day}),end:(year:${end.year},month:${end.month},day:${end.day}))`;
    }
    parseDate = parseDate;
    // ==================== Account Management ====================
    /**
     * Lists all ad accounts accessible to the authenticated user.
     */
    async listAdAccounts(options = {}) {
        const params = {
            q: "search",
        };
        if (options.status?.length) {
            params["search.status.values"] = options.status;
        }
        if (options.type) {
            params["search.type.values"] = [options.type];
        }
        let accounts = await this.requestAll('/rest/adAccounts', { params }, true);
        // Filter out test accounts unless explicitly requested
        if (!options.includeTest) {
            accounts = accounts.filter((account) => !account.test);
        }
        return accounts;
    }
    /**
     * Gets details for a specific ad account.
     */
    async getAccountDetails(accountId) {
        return this.request(`/rest/adAccounts/${accountId}`);
    }
    // ==================== Campaign Management ====================
    /**
     * Lists campaigns for an account.
     */
    async listCampaigns(accountId, options = {}) {
        const params = {
            q: "search",
        };
        if (options.campaignGroupIds?.length) {
            params["search.campaignGroup.values"] = options.campaignGroupIds.map((id) => `urn:li:sponsoredCampaignGroup:${id}`);
        }
        if (options.status?.length) {
            params["search.status.values"] = options.status;
        }
        return this.requestAll(`/rest/adAccounts/${accountId}/adCampaigns`, { params }, true);
    }
    /**
     * Gets campaign by ID.
     */
    async getCampaign(accountId, campaignId) {
        try {
            return await this.request(`/rest/adAccounts/${accountId}/adCampaigns/${campaignId}`);
        }
        catch (error) {
            if (error instanceof LinkedInRequestError && error.status === 404)
                return null;
            throw error;
        }
    }
    /**
     * Gets multiple campaigns by IDs.
     */
    async getCampaignsByIds(accountId, campaignIds) {
        const campaignMap = new Map();
        campaignIds = [...new Set(campaignIds)];
        // Fetch campaigns in parallel batches
        const batchSize = 10;
        for (let i = 0; i < campaignIds.length; i += batchSize) {
            const batch = campaignIds.slice(i, i + batchSize);
            const results = await Promise.all(batch.map((id) => this.getCampaign(accountId, id)));
            results.forEach((campaign, idx) => {
                if (campaign) {
                    campaignMap.set(batch[idx], campaign);
                }
            });
        }
        return campaignMap;
    }
    /**
     * Lists campaign groups for an account.
     */
    async listCampaignGroups(accountId, options = {}) {
        const params = {
            q: "search",
        };
        if (options.status?.length) {
            params["search.status.values"] = options.status;
        }
        return this.requestAll(`/rest/adAccounts/${accountId}/adCampaignGroups`, { params }, true);
    }
    /**
     * Lists creatives for campaigns.
     */
    async listCreatives(accountId, options = {}) {
        const params = {
            q: "criteria",
            pageSize: String(options.pageSize ?? this.config.pageSize),
        };
        if (options.campaignIds?.length) {
            params.campaigns = options.campaignIds.map((id) => `urn:li:sponsoredCampaign:${id}`);
        }
        if (options.creativeIds?.length) {
            params.creatives = options.creativeIds.map((id) => `urn:li:sponsoredCreative:${id}`);
        }
        if (options.isTestAccount !== undefined) {
            params.isTestAccount = String(options.isTestAccount);
        }
        return this.requestAll(`/rest/adAccounts/${accountId}/creatives`, { params, restliMethod: 'FINDER' }, true);
    }
    /**
     * Gets a single creative with full content details.
     */
    async getCreative(accountId, creativeId) {
        try {
            // Use the creatives endpoint with URN-encoded creative ID
            const encodedId = encodeURIComponent(`urn:li:sponsoredCreative:${creativeId}`);
            return await this.request(`/rest/adAccounts/${accountId}/creatives/${encodedId}`);
        }
        catch (error) {
            if (error instanceof LinkedInRequestError && error.status === 404)
                return null;
            throw error;
        }
    }
    /**
     * Gets multiple creatives with full content by IDs using batch lookup.
     * Uses the search API for more efficient batch retrieval.
     */
    async getCreativesByIds(accountId, creativeIds) {
        const creativeMap = new Map();
        creativeIds = [...new Set(creativeIds)];
        // Fetch creatives in batches of 50 to avoid URL length limits
        const batchSize = 50;
        for (let i = 0; i < creativeIds.length; i += batchSize) {
            const batchIds = creativeIds.slice(i, i + batchSize);
            try {
                const creatives = await this.listCreatives(accountId, {
                    creativeIds: batchIds,
                    pageSize: 100,
                });
                for (const creative of creatives) {
                    // Extract numeric ID from URN (format: urn:li:sponsoredCreative:123)
                    const idMatch = String(creative.id).match(/(?:urn:li:sponsoredCreative:)?(\d+)$/);
                    if (idMatch) {
                        const id = idMatch[1];
                        creativeMap.set(id, creative);
                    }
                }
            }
            catch (error) {
                throw error;
            }
        }
        return creativeMap;
    }
    // ==================== Content (Posts & Images) ====================
    /**
     * Fetches a post/share by URN to get the content including image references.
     */
    async getPost(postUrn) {
        try {
            const encodedUrn = encodeURIComponent(postUrn);
            return await this.request(`/rest/posts/${encodedUrn}`);
        }
        catch (error) {
            if (error instanceof LinkedInRequestError && error.status === 404)
                return null;
            throw error;
        }
    }
    /**
     * Fetches an image by URN to get the download URL.
     */
    async getImage(imageUrn) {
        try {
            const encodedUrn = encodeURIComponent(imageUrn);
            return await this.request(`/rest/images/${encodedUrn}`);
        }
        catch (error) {
            if (error instanceof LinkedInRequestError && error.status === 404)
                return null;
            throw error;
        }
    }
    /**
     * Fetches multiple images by URN in a batch.
     */
    async getImagesBatch(imageUrns) {
        const imageMap = new Map();
        if (imageUrns.length === 0)
            return imageMap;
        try {
            const encodedUrns = imageUrns
                .map((urn) => encodeURIComponent(urn))
                .join(",");
            const response = await this.request(`/rest/images?ids=List(${encodedUrns})`);
            if (response?.results) {
                for (const [urn, data] of Object.entries(response.results)) {
                    if (data.downloadUrl) {
                        imageMap.set(urn, data.downloadUrl);
                    }
                }
            }
        }
        catch (error) {
            console.error("Failed to fetch images batch:", error);
        }
        return imageMap;
    }
    /**
     * Gets the full creative content including resolved images.
     * This requires r_organization_social scope.
     */
    async getCreativeContent(creative, debug = false) {
        const result = {
            imageUrl: "",
            headline: creative.name || "",
            primaryText: "",
            landingPageUrl: "",
            contentType: "OTHER",
            carouselImages: [],
        };
        const reference = creative?.content?.reference;
        if (!reference)
            return result;
        // Handle non-post references (InMail, etc.)
        if (!reference.includes("share") && !reference.includes("ugcPost")) {
            if (reference.includes("adInMailContent")) {
                result.contentType = "INMAIL";
            }
            return result;
        }
        try {
            // Fetch the referenced post/share
            const post = await this.getPost(reference);
            if (!post)
                return result;
            if (debug) {
                console.log("\nPost structure:", JSON.stringify(post, null, 2).substring(0, 2000));
            }
            // Extract content from the post
            const commentary = post.commentary || "";
            result.primaryText = commentary;
            // Check for media content in different structures
            // LinkedIn posts can have: content.media, content.article, or content.multiImage
            const content = post.content || {};
            // Single media
            if (content.media) {
                const media = content.media;
                result.headline = result.headline || media.title || "";
                result.landingPageUrl = media.landingPage || "";
                // Get image from media URN
                const imageUrn = media.id;
                if (imageUrn && imageUrn.includes("image")) {
                    const image = await this.getImage(imageUrn);
                    if (image?.downloadUrl) {
                        result.imageUrl = image.downloadUrl;
                    }
                }
            }
            // Multi-image posts
            if (content.multiImage?.images?.length > 0) {
                const firstImage = content.multiImage.images[0];
                const imageUrn = firstImage.id;
                if (imageUrn && imageUrn.includes("image")) {
                    const image = await this.getImage(imageUrn);
                    if (image?.downloadUrl) {
                        result.imageUrl = image.downloadUrl;
                    }
                }
            }
            // Article content
            if (content.article) {
                const article = content.article;
                result.headline = result.headline || article.title || "";
                result.landingPageUrl = result.landingPageUrl || article.source || "";
                // Thumbnail can be a URN or direct URL
                if (article.thumbnail) {
                    if (article.thumbnail.includes("urn:li:image:")) {
                        // It's an image URN, fetch the download URL
                        const image = await this.getImage(article.thumbnail);
                        if (image?.downloadUrl) {
                            result.imageUrl = image.downloadUrl;
                        }
                    }
                    else {
                        // It's a direct URL
                        result.imageUrl = article.thumbnail;
                    }
                }
            }
            // Use contentLandingPage if available
            if (post.contentLandingPage && !result.landingPageUrl) {
                result.landingPageUrl = post.contentLandingPage;
            }
            // Determine content type from actual post structure
            if (content.multiImage?.images?.length > 1) {
                result.contentType = "CAROUSEL";
            }
            else if (content.media?.id?.includes("video")) {
                result.contentType = "VIDEO";
            }
            else if (content.media?.id?.includes("image") || result.imageUrl) {
                result.contentType = "IMAGE";
            }
            else if (content.article) {
                result.contentType = "ARTICLE";
            }
            else if (commentary &&
                !content.media &&
                !content.multiImage &&
                !content.article) {
                result.contentType = "TEXT";
            }
        }
        catch (error) {
            // Silently fail - already logged in getPost
        }
        return result;
    }
    // ==================== Analytics ====================
    /**
     * Gets analytics data with a specific pivot.
     */
    async getAnalytics(options) {
        const dateRange = this.formatDateRange(options.startDate, options.endDate);
        const metrics = [...new Set(options.metrics ?? DEFAULT_PERFORMANCE_METRICS)];
        if (!metrics.length || metrics.some(metric => !/^[A-Za-z][A-Za-z0-9]*$/.test(metric))) {
            throw new Error('metrics must contain valid LinkedIn metric names');
        }
        const metadataFields = options.timeGranularity && options.timeGranularity !== 'ALL' ? 2 : 1;
        const batchSize = 20 - metadataFields;
        if (metrics.length > batchSize) {
            // Merge by dimensions, never by row position: upstream row ordering may differ.
            let merged;
            for (let offset = 0; offset < metrics.length; offset += batchSize) {
                const records = await this.getAnalytics({ ...options, metrics: metrics.slice(offset, offset + batchSize) });
                const batch = new Map(records.map(record => [JSON.stringify([record.pivotValues, record.dateRange ?? null]), record]));
                if (batch.size !== records.length)
                    throw new Error('LinkedIn returned duplicate analytics dimensions');
                if (!merged) {
                    merged = batch;
                    continue;
                }
                if (merged.size !== batch.size || [...merged.keys()].some(key => !batch.has(key))) {
                    throw new Error('Analytics dimensions changed between metric batches; retry with a smaller metric selection');
                }
                for (const [key, record] of batch)
                    merged.set(key, { ...merged.get(key), ...record });
            }
            return [...merged.values()];
        }
        // Include dateRange field when using time-based granularity
        const fieldsToRequest = [...metrics, "pivotValues"];
        if (options.timeGranularity && options.timeGranularity !== "ALL") {
            fieldsToRequest.push("dateRange");
        }
        const params = {
            q: "analytics",
            pivot: options.pivot,
            dateRange,
            timeGranularity: options.timeGranularity || "ALL",
            accounts: [`urn:li:sponsoredAccount:${options.accountId}`],
            fields: fieldsToRequest.join(","),
        };
        if (options.campaigns?.length) {
            params.campaigns = options.campaigns.map((id) => `urn:li:sponsoredCampaign:${id}`);
        }
        if (options.campaignGroups?.length) {
            params.campaignGroups = options.campaignGroups.map((id) => `urn:li:sponsoredCampaignGroup:${id}`);
        }
        if (options.creatives?.length) {
            params.creatives = options.creatives.map(id => `urn:li:sponsoredCreative:${id}`);
        }
        const response = await this.request("/rest/adAnalytics", { params });
        if (!Array.isArray(response.elements))
            throw new Error('LinkedIn returned invalid analytics data');
        if (response.elements.length >= 15000 || response.paging?.links?.some(link => link.rel === 'next')) {
            throw new Error('Analytics reached the response limit; use a shorter date range or narrower entity filters');
        }
        return response.elements;
    }
    /**
     * Gets campaign performance metrics.
     */
    async getCampaignPerformance(options) {
        return this.getAnalytics({
            ...options,
            pivot: "CAMPAIGN",
            campaigns: options.campaignIds,
            campaignGroups: options.campaignGroupIds,
        });
    }
    /**
     * Gets creative performance metrics.
     */
    async getCreativePerformance(options) {
        // Remove audiencePenetration (unsupported for CREATIVE pivot) and costInLocalCurrency
        // (redundant with costInUsd) to stay under LinkedIn's 20-field API limit
        let metrics = DEFAULT_CREATIVE_METRICS.filter((m) => m !== "audiencePenetration" && m !== "costInLocalCurrency");
        if (options.includeVideoMetrics !== false) {
            metrics = [...metrics, ...VIDEO_METRICS];
        }
        return this.getAnalytics({
            accountId: options.accountId,
            pivot: "CREATIVE",
            startDate: options.startDate,
            endDate: options.endDate,
            timeGranularity: options.timeGranularity,
            campaigns: options.campaignIds,
            creatives: options.creativeIds,
            metrics,
        });
    }
    /**
     * Gets campaign group performance metrics.
     */
    async getCampaignGroupPerformance(options) {
        return this.getAnalytics({
            ...options,
            pivot: "CAMPAIGN_GROUP",
        });
    }
    /**
     * Gets audience demographic breakdown.
     */
    async getAudienceDemographics(options) {
        return this.getAnalytics({
            accountId: options.accountId,
            pivot: options.demographicType,
            startDate: options.startDate,
            endDate: options.endDate,
            campaigns: options.campaignIds,
            metrics: [...DEFAULT_PERFORMANCE_METRICS, "totalEngagements"],
        });
    }
    /**
     * Gets reach and frequency metrics.
     */
    async getAudienceReach(options) {
        validateDateRange(options.startDate, options.endDate);
        const end = options.endDate ?? new Date().toISOString().slice(0, 10);
        if ((Date.parse(end) - Date.parse(options.startDate)) / 86400000 + 1 > 92) {
            throw new Error('Reach reports support at most 92 calendar days');
        }
        // Note: approximateMemberReach requires date range of 92 days or less
        return this.getAnalytics({
            accountId: options.accountId,
            pivot: options.campaignIds?.length ? "CAMPAIGN" : "ACCOUNT",
            startDate: options.startDate,
            endDate: options.endDate,
            campaigns: options.campaignIds,
            campaignGroups: options.campaignGroupIds,
            metrics: REACH_METRICS,
        });
    }
    /**
     * Gets lead generation metrics.
     */
    async getLeadGenPerformance(options) {
        return this.getAnalytics({
            accountId: options.accountId,
            pivot: "CAMPAIGN",
            startDate: options.startDate,
            endDate: options.endDate,
            campaigns: options.campaignIds,
            timeGranularity: options.timeGranularity,
            metrics: [...LEAD_GEN_METRICS, "costInUsd", "impressions", "clicks"],
        });
    }
    /**
     * Gets conversion performance by conversion action.
     */
    async getConversionPerformance(options) {
        const metrics = [
            "externalWebsiteConversions",
            "externalWebsitePostClickConversions",
            "costInUsd",
            "conversionValueInLocalCurrency",
        ];
        if (options.includePostView !== false) {
            metrics.push("externalWebsitePostViewConversions");
        }
        return this.getAnalytics({
            accountId: options.accountId,
            pivot: "CONVERSION",
            startDate: options.startDate,
            endDate: options.endDate,
            campaigns: options.campaignIds,
            timeGranularity: options.timeGranularity,
            metrics,
        });
    }
    // ==================== Conversions ====================
    /**
     * Lists conversion tracking rules for an account.
     */
    async listConversions(accountId, enabledOnly = false) {
        const params = {
            q: "account",
            account: `urn:li:sponsoredAccount:${accountId}`,
        };
        let conversions = await this.requestAll("/rest/conversions", { params });
        if (enabledOnly) {
            conversions = conversions.filter((c) => c.enabled);
        }
        return conversions;
    }
    // ==================== Lead Gen ====================
    /**
     * Lists lead generation forms for an account.
     */
    async listLeadForms(accountId, status) {
        const params = {
            q: "owner",
            owner: `(sponsoredAccount:urn:li:sponsoredAccount:${accountId})`,
        };
        let forms = await this.requestAll("/rest/leadForms", { params });
        if (status?.length) {
            forms = forms.filter((f) => status.includes(f.status));
        }
        return forms;
    }
    // ==================== Audiences ====================
    // ==================== Ad Library ====================
    /**
     * Searches the LinkedIn Ad Library for ads matching criteria.
     * This is a public API that doesn't require ad account access — any
     * authenticated LinkedIn user can search the ad library.
     */
    async searchAdLibrary(options) {
        const queryParts = ["q=criteria"];
        if (options.keyword) {
            queryParts.push(`keyword=${encodeURIComponent(options.keyword)}`);
        }
        if (options.countries?.length) {
            const countryUrns = options.countries
                .map((c) => encodeURIComponent(`urn:li:country:${c.toLowerCase()}`))
                .join(",");
            queryParts.push(`countries=(value:List(${countryUrns}))`);
        }
        if (options.advertiser) {
            queryParts.push(`advertiser=${encodeURIComponent(options.advertiser)}`);
        }
        if (options.startDate || options.endDate) {
            const now = new Date();
            const defaultStart = new Date(now);
            defaultStart.setDate(defaultStart.getDate() - 2);
            const defaultEnd = new Date(now);
            defaultEnd.setDate(defaultEnd.getDate() - 1);
            const start = options.startDate
                ? this.parseDate(options.startDate)
                : {
                    year: defaultStart.getFullYear(),
                    month: defaultStart.getMonth() + 1,
                    day: defaultStart.getDate(),
                };
            const end = options.endDate
                ? this.parseDate(options.endDate)
                : {
                    year: defaultEnd.getFullYear(),
                    month: defaultEnd.getMonth() + 1,
                    day: defaultEnd.getDate(),
                };
            queryParts.push(`dateRange=(start:(day:${start.day},month:${start.month},year:${start.year}),end:(day:${end.day},month:${end.month},year:${end.year}))`);
        }
        if (options.start !== undefined) {
            queryParts.push(`start=${options.start}`);
        }
        if (options.count !== undefined) {
            queryParts.push(`count=${Math.min(options.count, 25)}`);
        }
        if (options.payerName) {
            queryParts.push(`payerName=${encodeURIComponent(options.payerName)}`);
        }
        if (options.includedTargetingFacetCategories?.length) {
            queryParts.push(`includedTargetingFacetCategories=List(${options.includedTargetingFacetCategories.join(",")})`);
        }
        if (options.excludedTargetingFacetCategories?.length) {
            queryParts.push(`excludedTargetingFacetCategories=List(${options.excludedTargetingFacetCategories.join(",")})`);
        }
        if (options.totalImpressionsRange) {
            queryParts.push(`totalImpressionsRange=(from:${options.totalImpressionsRange.from},to:${options.totalImpressionsRange.to})`);
        }
        if (options.sortBy) {
            queryParts.push(`sortBy=(order:${options.sortBy.order},field:${options.sortBy.field})`);
        }
        const endpoint = `/rest/adLibrary?${queryParts.join("&")}`;
        return this.request(endpoint);
    }
    // ==================== Campaign Group Management (Write) ====================
    /**
     * Creates a new campaign group.
     */
    async createCampaignGroup(accountId, data) {
        return this.request(`/rest/adAccounts/${accountId}/adCampaignGroups`, {
            method: "POST",
            body: {
                account: `urn:li:sponsoredAccount:${accountId}`,
                ...data,
            },
        });
    }
    /**
     * Partially updates a campaign group.
     */
    async updateCampaignGroup(accountId, campaignGroupId, updates) {
        await this.request(`/rest/adAccounts/${accountId}/adCampaignGroups/${campaignGroupId}`, {
            method: "POST",
            restliMethod: "PARTIAL_UPDATE",
            body: {
                patch: {
                    $set: updates,
                },
            },
        });
    }
    /**
     * Deletes a draft campaign group, or sets non-draft to PENDING_DELETION.
     */
    async deleteCampaignGroup(accountId, campaignGroupId, isDraft) {
        if (isDraft) {
            await this.request(`/rest/adAccounts/${accountId}/adCampaignGroups/${campaignGroupId}`, {
                method: "DELETE",
            });
        }
        else {
            await this.updateCampaignGroup(accountId, campaignGroupId, {
                status: "PENDING_DELETION",
            });
        }
    }
    // ==================== Campaign Management (Write) ====================
    /**
     * Creates a new campaign.
     */
    async createCampaign(accountId, data) {
        const campaignGroupUrn = data.campaignGroup.startsWith("urn:")
            ? data.campaignGroup
            : `urn:li:sponsoredCampaignGroup:${data.campaignGroup}`;
        const { campaignGroup: _cg, ...rest } = data;
        return this.request(`/rest/adAccounts/${accountId}/adCampaigns`, {
            method: "POST",
            body: {
                account: `urn:li:sponsoredAccount:${accountId}`,
                campaignGroup: campaignGroupUrn,
                ...rest,
            },
        });
    }
    /**
     * Partially updates a campaign.
     */
    async updateCampaign(accountId, campaignId, updates) {
        await this.request(`/rest/adAccounts/${accountId}/adCampaigns/${campaignId}`, {
            method: "POST",
            restliMethod: "PARTIAL_UPDATE",
            body: {
                patch: {
                    $set: updates,
                },
            },
        });
    }
    /**
     * Deletes a draft campaign, or sets non-draft to PENDING_DELETION.
     */
    async deleteCampaign(accountId, campaignId, isDraft) {
        if (isDraft) {
            await this.request(`/rest/adAccounts/${accountId}/adCampaigns/${campaignId}`, {
                method: "DELETE",
            });
        }
        else {
            await this.updateCampaign(accountId, campaignId, {
                status: "PENDING_DELETION",
            });
        }
    }
    // ==================== Creative Management (Write) ====================
    /**
     * Creates a new creative.
     */
    async createCreative(accountId, data) {
        const body = {
            campaign: data.campaign.startsWith("urn:")
                ? data.campaign
                : `urn:li:sponsoredCampaign:${data.campaign}`,
            intendedStatus: data.intendedStatus,
        };
        if (data.content)
            body.content = data.content;
        if (data.inlineContent)
            body.inlineContent = data.inlineContent;
        if (data.leadgenCallToAction)
            body.leadgenCallToAction = data.leadgenCallToAction;
        if (data.name)
            body.name = data.name;
        return this.request(`/rest/adAccounts/${accountId}/creatives`, {
            method: "POST",
            body,
        });
    }
    /**
     * Creates a new inline creative (ad with content created directly, not referencing an existing post).
     * Uses the ?action=createInline endpoint.
     */
    async createInlineCreative(accountId, data) {
        const campaignUrn = data.campaign.startsWith("urn:")
            ? data.campaign
            : `urn:li:sponsoredCampaign:${data.campaign}`;
        const orgUrn = data.organizationId.startsWith("urn:")
            ? data.organizationId
            : `urn:li:organization:${data.organizationId}`;
        const post = {
            adContext: {
                dscAdAccount: `urn:li:sponsoredAccount:${accountId}`,
                dscStatus: "ACTIVE",
            },
            author: orgUrn,
            commentary: data.commentary,
            visibility: "PUBLIC",
            lifecycleState: "PUBLISHED",
            isReshareDisabledByAuthor: false,
        };
        if (data.mediaId) {
            post.content = {
                media: {
                    id: data.mediaId,
                    title: data.mediaTitle || "",
                },
            };
        }
        if (data.landingPageUrl) {
            post.contentLandingPage = data.landingPageUrl;
        }
        if (data.callToActionLabel) {
            post.contentCallToActionLabel = data.callToActionLabel;
        }
        const creative = {
            inlineContent: { post },
            campaign: campaignUrn,
            intendedStatus: data.intendedStatus,
        };
        if (data.name)
            creative.name = data.name;
        if (data.leadgenCallToAction)
            creative.leadgenCallToAction = data.leadgenCallToAction;
        return this.request(`/rest/adAccounts/${accountId}/creatives?action=createInline`, {
            method: "POST",
            body: { creative },
        });
    }
    /**
     * Uploads an image to LinkedIn for use in ads.
     * Two-step process: 1) Initialize upload to get URL + URN, 2) PUT binary to upload URL.
     */
    async uploadImage(data) {
        if (this.config.readOnly)
            throw new Error('Write operations are disabled by LINKEDIN_READ_ONLY');
        if (!/^(?:[1-9]\d*|urn:li:(?:organization|sponsoredAccount):[1-9]\d*)$/.test(data.owner))
            throw new Error('Invalid image owner');
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const ext = path.extname(data.filePath).toLowerCase();
        const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
        if (!mimeTypes[ext])
            throw new Error('Image must be a PNG, JPEG, or GIF file');
        const file = await fs.open(data.filePath, 'r');
        let fileBuffer;
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size === 0 || stat.size > this.config.maxUploadBytes) {
                throw new Error(`Image must be a nonempty regular file no larger than ${this.config.maxUploadBytes} bytes`);
            }
            const buffer = Buffer.alloc(stat.size + 1);
            let offset = 0;
            while (offset < buffer.length) {
                const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
                if (!bytesRead)
                    break;
                offset += bytesRead;
            }
            if (offset !== stat.size)
                throw new Error('Image file changed during upload preparation');
            fileBuffer = buffer.subarray(0, offset);
        }
        finally {
            await file.close();
        }
        const signature = fileBuffer.subarray(0, 8);
        const valid = ext === '.png' ? signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : ext === '.gif' ? ['GIF87a', 'GIF89a'].includes(fileBuffer.subarray(0, 6).toString('ascii'))
                : signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
        if (!valid)
            throw new Error('Image content does not match its file extension');
        // Support both organization and sponsoredAccount as owner
        let ownerUrn;
        if (data.owner.startsWith("urn:")) {
            ownerUrn = data.owner;
        }
        else {
            // Default to organization URN, but callers can pass sponsoredAccount URN directly
            ownerUrn = `urn:li:organization:${data.owner}`;
        }
        // Step 1: Initialize upload
        const initBody = {
            initializeUploadRequest: {
                owner: ownerUrn,
            },
        };
        // Optionally register in media library
        if (data.accountId && data.assetName) {
            initBody.initializeUploadRequest.mediaLibraryMetadata = {
                associatedAccount: `urn:li:sponsoredAccount:${data.accountId}`,
                assetName: data.assetName,
            };
        }
        const initResponse = await this.request("/rest/images?action=initializeUpload", {
            method: "POST",
            body: initBody,
        });
        const { uploadUrl, image: imageUrn } = initResponse.value;
        const destination = new URL(uploadUrl);
        if (destination.protocol !== 'https:' || destination.username || destination.password
            || !['linkedin.com', 'licdn.com'].some(domain => destination.hostname === domain || destination.hostname.endsWith('.' + domain))) {
            throw new Error('LinkedIn returned an untrusted image upload URL');
        }
        const accessToken = await this.tokenStore.getAccessToken();
        if (!accessToken)
            throw new Error('Not authenticated. Please run: npm run auth');
        await this.transport.request(uploadUrl, {
            method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': mimeTypes[ext] }, body: fileBuffer,
        }, true);
        return { imageUrn, uploadUrl };
    }
    /**
     * Partially updates a creative (e.g., status change).
     */
    async updateCreative(accountId, creativeId, updates) {
        const encodedId = encodeURIComponent(creativeId.startsWith("urn:")
            ? creativeId
            : `urn:li:sponsoredCreative:${creativeId}`);
        await this.request(`/rest/adAccounts/${accountId}/creatives/${encodedId}`, {
            method: "POST",
            restliMethod: "PARTIAL_UPDATE",
            body: {
                patch: {
                    $set: updates,
                },
            },
        });
    }
    // ==================== Audiences ====================
    /**
     * Lists saved/matched audiences for an account.
     */
    async listSavedAudiences(accountId, options = {}) {
        const params = {
            q: "account",
            account: `urn:li:sponsoredAccount:${accountId}`,
        };
        let audiences = await this.requestAll("/rest/dmpSegments", { params });
        if (options.status?.length) {
            audiences = audiences.filter((a) => options.status.includes(a.status));
        }
        if (options.type) {
            audiences = audiences.filter((a) => a.type === options.type);
        }
        return audiences;
    }
}
//# sourceMappingURL=linkedin-api.js.map