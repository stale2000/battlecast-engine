#!/usr/bin/env node
// CLI entry: `battlecast-engine mcp` starts the MCP server on stdio.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { EncounterError } from '../api/encounter.js';
import { kaggleStep, validateArenaParty } from '../arena.js';

const command = process.argv[2] ?? 'mcp';

if (command === 'mcp') {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep quiet on stdout - it belongs to the MCP protocol. Diagnostics go to stderr.
  console.error('battlecast-engine MCP server running on stdio');
} else if (command === 'arena' && (process.argv[3] === 'kaggle-step' || process.argv[3] === 'validate-party')) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const request = JSON.parse(input) as unknown;
    if (process.argv[3] === 'validate-party') {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new EncounterError('request must be an object.');
      const { team, party } = request as { team?: unknown; party?: unknown };
      if (team !== 'red' && team !== 'blue') throw new EncounterError('team must be red or blue.');
      validateArenaParty(party, team);
      process.stdout.write('{"valid":true}\n');
    } else {
      process.stdout.write(`${JSON.stringify(kaggleStep(request))}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${error instanceof EncounterError || error instanceof SyntaxError ? 'INVALID_REQUEST' : 'BRIDGE_FAILURE'}: ${message}`);
    process.exitCode = 1;
  }
} else {
  console.error(`Unknown command. Usage: battlecast-engine mcp | battlecast-engine arena kaggle-step | battlecast-engine arena validate-party`);
  process.exit(1);
}
