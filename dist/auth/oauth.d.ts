import { TokenStore } from './token-store.js';
import type { LinkedInTokens } from '../lib/types.js';
interface OAuthOptions {
    openBrowser?: (url: string) => Promise<unknown>;
    onAuthorizationUrl?: (url: string) => void;
    timeoutMs?: number;
    fetch?: typeof fetch;
}
export declare class LinkedInOAuth {
    private readonly tokenStore;
    private readonly options;
    private readonly clientId;
    private readonly clientSecret;
    private readonly redirectUrl;
    private readonly scopes;
    constructor(tokenStore: TokenStore, options?: OAuthOptions);
    authenticate(): Promise<LinkedInTokens>;
}
export {};
//# sourceMappingURL=oauth.d.ts.map