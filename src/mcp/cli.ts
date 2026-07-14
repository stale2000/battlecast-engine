#!/usr/bin/env node
// CLI entry: `battlecast-engine mcp` starts the MCP server on stdio.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { kaggleStep } from '../arena.js';

const command = process.argv[2] ?? 'mcp';

if (command === 'mcp') {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep quiet on stdout - it belongs to the MCP protocol. Diagnostics go to stderr.
  console.error('battlecast-engine MCP server running on stdio');
} else if (command === 'arena' && process.argv[3] === 'kaggle-step') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    process.stdout.write(`${JSON.stringify(kaggleStep(JSON.parse(input)))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  console.error(`Unknown command. Usage: battlecast-engine mcp | battlecast-engine arena kaggle-step`);
  process.exit(1);
}
