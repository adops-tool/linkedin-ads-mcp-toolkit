// Tool definitions
export const listAdAccountsTool = {
    name: 'list_ad_accounts',
    description: 'Lists all LinkedIn Ad Accounts accessible to the authenticated user. Returns account names, IDs, status, currency, and serving statuses. Use this to get an overview of all accounts or find a specific account ID.',
    inputSchema: {
        type: 'object',
        properties: {
            status: {
                type: 'array',
                items: {
                    type: 'string',
                    enum: ['ACTIVE', 'DRAFT', 'CANCELED', 'PENDING_DELETION'],
                },
                description: 'Filter by account status. If not specified, returns all statuses.',
            },
            type: {
                type: 'string',
                enum: ['BUSINESS', 'ENTERPRISE'],
                description: 'Filter by account type.',
            },
            includeTest: {
                type: 'boolean',
                description: 'Include test accounts. Default: false',
                default: false,
            },
        },
    },
};
export const getAccountDetailsTool = {
    name: 'get_account_details',
    description: 'Retrieves detailed information about a specific LinkedIn Ad Account including status, currency, notification settings, and linked organization.',
    inputSchema: {
        type: 'object',
        properties: {
            accountId: {
                type: 'string',
                description: 'The LinkedIn Ad Account ID (numeric ID, not the URN)',
            },
        },
        required: ['accountId'],
    },
};
// Tool handlers
export async function handleListAdAccounts(client, args) {
    const input = args;
    const accounts = await client.listAdAccounts({
        status: input.status,
        type: input.type,
        includeTest: input.includeTest,
    });
    return {
        accounts: accounts.map(account => ({
            id: account.id,
            name: account.name,
            currency: account.currency,
            type: account.type,
            status: account.status,
            servingStatuses: account.servingStatuses,
            reference: account.reference,
            isTest: account.test,
        })),
        totalCount: accounts.length,
    };
}
export async function handleGetAccountDetails(client, args) {
    const input = args;
    if (!input.accountId) {
        throw new Error('accountId is required');
    }
    const account = await client.getAccountDetails(input.accountId);
    return {
        id: account.id,
        name: account.name,
        currency: account.currency,
        type: account.type,
        status: account.status,
        servingStatuses: account.servingStatuses,
        reference: account.reference,
        notificationSettings: {
            campaignOptimization: account.notifiedOnCampaignOptimization,
            creativeApproval: account.notifiedOnCreativeApproval,
            creativeRejection: account.notifiedOnCreativeRejection,
            endOfCampaign: account.notifiedOnEndOfCampaign,
        },
        isTest: account.test,
    };
}
//# sourceMappingURL=accounts.js.map