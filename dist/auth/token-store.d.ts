import type { LinkedInTokens } from '../lib/types.js';
export declare function normalizeTokens(value: unknown, now?: number): LinkedInTokens;
export declare class TokenStore {
    private readonly fetcher;
    private readonly tokenPath;
    private tokens;
    private refreshPromise?;
    private nextRefreshAttemptAt;
    private writes;
    constructor(tokenPath?: string, fetcher?: typeof fetch);
    saveTokens(tokens: LinkedInTokens): Promise<void>;
    getTokens(): Promise<LinkedInTokens | null>;
    getAccessToken(): Promise<string | null>;
    hasValidToken(): Promise<boolean>;
    private refreshAccessToken;
    clearTokens(): Promise<void>;
    getTokenExpirationInfo(): {
        expiresAt: Date;
        isExpired: boolean;
        expiresInMinutes: number;
    } | null;
}
//# sourceMappingURL=token-store.d.ts.map