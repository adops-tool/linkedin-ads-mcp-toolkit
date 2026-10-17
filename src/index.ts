#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { redact } from './lib/http.js';

async function main(): Promise<void> {
  const server = createMcpServer();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    await server.close();
    clearTimeout(deadline);
  };
  process.once('SIGINT', () => { void shutdown().catch(() => process.exit(1)); });
  process.once('SIGTERM', () => { void shutdown().catch(() => process.exit(1)); });
  await server.connect(new StdioServerTransport());
  console.error('LinkedIn Ads MCP server running on stdio');
}
main().catch(error => { console.error(redact(error instanceof Error ? error.message : 'Server startup failed')); process.exitCode = 1; });
