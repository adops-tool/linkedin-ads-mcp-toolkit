export interface ClientConfig {
    apiVersion: string;
    requestTimeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    maxConcurrency: number;
    pageSize: number;
    maxPages: number;
    readOnly: boolean;
    maxUploadBytes: number;
}
export declare function loadConfig(env?: NodeJS.ProcessEnv): ClientConfig;
//# sourceMappingURL=config.d.ts.map