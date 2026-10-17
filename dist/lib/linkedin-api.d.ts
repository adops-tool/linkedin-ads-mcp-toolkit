import { TokenStore } from "../auth/token-store.js";
import { LinkedInApiResponse, AdAccount, Campaign, CampaignGroup, Creative, Conversion, LeadGenForm, SavedAudience, AnalyticsRecord, TimeGranularity, DemographicPivot, EntityPivot, AdLibraryAd, SearchAdLibraryInput } from "./types.js";
import { type ClientConfig } from './config.js';
export declare class LinkedInApiClient {
    private tokenStore;
    readonly config: ClientConfig;
    private readonly transport;
    private readonly pendingReads;
    constructor(tokenStore: TokenStore, options?: {
        config?: ClientConfig;
        fetch?: typeof fetch;
        sleep?: (ms: number) => Promise<unknown>;
    });
    private request;
    private requestAll;
    private formatDateRange;
    private parseDate;
    /**
     * Lists all ad accounts accessible to the authenticated user.
     */
    listAdAccounts(options?: {
        status?: string[];
        type?: string;
        includeTest?: boolean;
    }): Promise<AdAccount[]>;
    /**
     * Gets details for a specific ad account.
     */
    getAccountDetails(accountId: string): Promise<AdAccount>;
    /**
     * Lists campaigns for an account.
     */
    listCampaigns(accountId: string, options?: {
        campaignGroupIds?: string[];
        status?: string[];
    }): Promise<Campaign[]>;
    /**
     * Gets campaign by ID.
     */
    getCampaign(accountId: string, campaignId: string): Promise<Campaign | null>;
    /**
     * Gets multiple campaigns by IDs.
     */
    getCampaignsByIds(accountId: string, campaignIds: string[]): Promise<Map<string, Campaign>>;
    /**
     * Lists campaign groups for an account.
     */
    listCampaignGroups(accountId: string, options?: {
        status?: string[];
    }): Promise<CampaignGroup[]>;
    /**
     * Lists creatives for campaigns.
     */
    listCreatives(accountId: string, options?: {
        campaignIds?: string[];
        creativeIds?: string[];
        isTestAccount?: boolean;
        pageSize?: number;
    }): Promise<Creative[]>;
    /**
     * Gets a single creative with full content details.
     */
    getCreative(accountId: string, creativeId: string): Promise<any | null>;
    /**
     * Gets multiple creatives with full content by IDs using batch lookup.
     * Uses the search API for more efficient batch retrieval.
     */
    getCreativesByIds(accountId: string, creativeIds: string[]): Promise<Map<string, any>>;
    /**
     * Fetches a post/share by URN to get the content including image references.
     */
    getPost(postUrn: string): Promise<any | null>;
    /**
     * Fetches an image by URN to get the download URL.
     */
    getImage(imageUrn: string): Promise<{
        downloadUrl: string;
        status: string;
    } | null>;
    /**
     * Fetches multiple images by URN in a batch.
     */
    getImagesBatch(imageUrns: string[]): Promise<Map<string, string>>;
    /**
     * Gets the full creative content including resolved images.
     * This requires r_organization_social scope.
     */
    getCreativeContent(creative: any, debug?: boolean): Promise<{
        imageUrl: string;
        headline: string;
        primaryText: string;
        landingPageUrl: string;
        contentType: string;
        carouselImages: string[];
    }>;
    /**
     * Gets analytics data with a specific pivot.
     */
    getAnalytics(options: {
        accountId: string;
        pivot: EntityPivot | DemographicPivot;
        startDate: string;
        endDate?: string;
        timeGranularity?: TimeGranularity;
        campaigns?: string[];
        creatives?: string[];
        campaignGroups?: string[];
        metrics?: string[];
    }): Promise<AnalyticsRecord[]>;
    /**
     * Gets campaign performance metrics.
     */
    getCampaignPerformance(options: {
        accountId: string;
        campaignIds?: string[];
        campaignGroupIds?: string[];
        startDate: string;
        endDate?: string;
        timeGranularity?: TimeGranularity;
        metrics?: string[];
    }): Promise<AnalyticsRecord[]>;
    /**
     * Gets creative performance metrics.
     */
    getCreativePerformance(options: {
        accountId: string;
        campaignIds?: string[];
        creativeIds?: string[];
        startDate: string;
        endDate?: string;
        timeGranularity?: TimeGranularity;
        includeVideoMetrics?: boolean;
    }): Promise<AnalyticsRecord[]>;
    /**
     * Gets campaign group performance metrics.
     */
    getCampaignGroupPerformance(options: {
        accountId: string;
        startDate: string;
        endDate?: string;
        timeGranularity?: TimeGranularity;
    }): Promise<AnalyticsRecord[]>;
    /**
     * Gets audience demographic breakdown.
     */
    getAudienceDemographics(options: {
        accountId: string;
        demographicType: DemographicPivot;
        campaignIds?: string[];
        startDate: string;
        endDate?: string;
    }): Promise<AnalyticsRecord[]>;
    /**
     * Gets reach and frequency metrics.
     */
    getAudienceReach(options: {
        accountId: string;
        campaignIds?: string[];
        campaignGroupIds?: string[];
        startDate: string;
        endDate?: string;
    }): Promise<AnalyticsRecord[]>;
    /**
     * Gets lead generation metrics.
     */
    getLeadGenPerformance(options: {
        accountId: string;
        campaignIds?: string[];
        startDate: string;
        endDate?: string;
        timeGranularity?: TimeGranularity;
    }): Promise<AnalyticsRecord[]>;
    /**
     * Gets conversion performance by conversion action.
     */
    getConversionPerformance(options: {
        accountId: string;
        campaignIds?: string[];
        startDate: string;
        endDate?: string;
        includePostView?: boolean;
        timeGranularity?: TimeGranularity;
    }): Promise<AnalyticsRecord[]>;
    /**
     * Lists conversion tracking rules for an account.
     */
    listConversions(accountId: string, enabledOnly?: boolean): Promise<Conversion[]>;
    /**
     * Lists lead generation forms for an account.
     */
    listLeadForms(accountId: string, status?: string[]): Promise<LeadGenForm[]>;
    /**
     * Searches the LinkedIn Ad Library for ads matching criteria.
     * This is a public API that doesn't require ad account access — any
     * authenticated LinkedIn user can search the ad library.
     */
    searchAdLibrary(options: SearchAdLibraryInput): Promise<LinkedInApiResponse<AdLibraryAd>>;
    /**
     * Creates a new campaign group.
     */
    createCampaignGroup(accountId: string, data: {
        name: string;
        status: string;
        runSchedule: {
            start: number;
            end?: number;
        };
        totalBudget?: {
            amount: string;
            currencyCode: string;
        };
        dailyBudget?: {
            amount: string;
            currencyCode: string;
        };
        objectiveType?: string;
    }): Promise<{
        id: string;
    }>;
    /**
     * Partially updates a campaign group.
     */
    updateCampaignGroup(accountId: string, campaignGroupId: string, updates: Record<string, unknown>): Promise<void>;
    /**
     * Deletes a draft campaign group, or sets non-draft to PENDING_DELETION.
     */
    deleteCampaignGroup(accountId: string, campaignGroupId: string, isDraft: boolean): Promise<void>;
    /**
     * Creates a new campaign.
     */
    createCampaign(accountId: string, data: {
        name: string;
        campaignGroup: string;
        status: string;
        type: string;
        objectiveType: string;
        costType: string;
        dailyBudget?: {
            amount: string;
            currencyCode: string;
        };
        totalBudget?: {
            amount: string;
            currencyCode: string;
        };
        unitCost: {
            amount: string;
            currencyCode: string;
        };
        locale: {
            country: string;
            language: string;
        };
        targetingCriteria: unknown;
        runSchedule?: {
            start: number;
            end?: number;
        };
        offsiteDeliveryEnabled?: boolean;
        audienceExpansionEnabled?: boolean;
        creativeSelection?: string;
        politicalIntent?: string;
    }): Promise<{
        id: string;
    }>;
    /**
     * Partially updates a campaign.
     */
    updateCampaign(accountId: string, campaignId: string, updates: Record<string, unknown>): Promise<void>;
    /**
     * Deletes a draft campaign, or sets non-draft to PENDING_DELETION.
     */
    deleteCampaign(accountId: string, campaignId: string, isDraft: boolean): Promise<void>;
    /**
     * Creates a new creative.
     */
    createCreative(accountId: string, data: {
        campaign: string;
        content?: unknown;
        intendedStatus: string;
        inlineContent?: unknown;
        leadgenCallToAction?: unknown;
        name?: string;
    }): Promise<{
        id: string;
    }>;
    /**
     * Creates a new inline creative (ad with content created directly, not referencing an existing post).
     * Uses the ?action=createInline endpoint.
     */
    createInlineCreative(accountId: string, data: {
        campaign: string;
        intendedStatus: string;
        name?: string;
        organizationId: string;
        commentary: string;
        mediaId?: string;
        mediaTitle?: string;
        landingPageUrl?: string;
        callToActionLabel?: string;
        leadgenCallToAction?: {
            destination: string;
            label: string;
        };
    }): Promise<{
        id: string;
    }>;
    /**
     * Uploads an image to LinkedIn for use in ads.
     * Two-step process: 1) Initialize upload to get URL + URN, 2) PUT binary to upload URL.
     */
    uploadImage(data: {
        owner: string;
        filePath: string;
        accountId?: string;
        assetName?: string;
    }): Promise<{
        imageUrn: string;
        uploadUrl: string;
    }>;
    /**
     * Partially updates a creative (e.g., status change).
     */
    updateCreative(accountId: string, creativeId: string, updates: Record<string, unknown>): Promise<void>;
    /**
     * Lists saved/matched audiences for an account.
     */
    listSavedAudiences(accountId: string, options?: {
        status?: string[];
        type?: string;
    }): Promise<SavedAudience[]>;
}
//# sourceMappingURL=linkedin-api.d.ts.map