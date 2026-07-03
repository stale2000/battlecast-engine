#!/usr/bin/env node
// CLI entry: `battlecast-engine mcp` starts the MCP server on stdio.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const command = process.argv[2] ?? 'mcp';

if (command === 'mcp') {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep quiet on stdout - it belongs to the MCP protocol. Diagnostics go to stderr.
  console.error('battlecast-engine MCP server running on stdio');
} else {
  console.error(`Unknown command "${command}". Usage: battlecast-engine mcp`);
  process.exit(1);
}
