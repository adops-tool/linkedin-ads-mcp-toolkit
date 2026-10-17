#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { LinkedInApiClient } from "./lib/linkedin-api.js";
import { TokenStore } from "./auth/token-store.js";
export declare function createMcpServer(tokenStore?: TokenStore, apiClient?: LinkedInApiClient): Server;
//# sourceMappingURL=server.d.ts.map