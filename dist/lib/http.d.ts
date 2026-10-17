import type { ClientConfig } from './config.js';
export declare class LinkedInRequestError extends Error {
    readonly status?: number | undefined;
    readonly requestId?: string | undefined;
    constructor(message: string, status?: number | undefined, requestId?: string | undefined);
}
export declare function redact(message: string): string;
export declare function retryAfterMs(value: string | null, now?: number): number | undefined;
/** Limits entire fetch/body lifetimes, rather than only request creation. */
export declare class HttpTransport {
    private readonly config;
    private readonly fetcher;
    private readonly sleep;
    private active;
    private readonly queue;
    constructor(config: ClientConfig, fetcher?: typeof fetch, sleep?: (ms: number) => Promise<unknown>);
    private acquire;
    private release;
    request<T>(url: string, init?: RequestInit, rawResponse?: boolean): Promise<T>;
}
//# sourceMappingURL=http.d.ts.map