#!/usr/bin/env bun

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const providedToken = process.env.MCP_AUTH_TOKEN;
const expectedToken = process.env.MCP_EXPECTED_TOKEN;

if (!providedToken || !expectedToken || providedToken !== expectedToken) {
  process.stderr.write('MCP authentication failed.\n');
  process.exit(2);
}

const scope = process.env.MCP_AUTH_SCOPE ?? 'unknown';
const server = new McpServer({ name: 'authenticated-stdio-fixture', version: '1.0.0' });

server.registerTool(
  'authenticated_echo',
  {
    description: 'Returns data only after stdio environment authentication succeeds.',
    inputSchema: { message: z.string() },
    outputSchema: { scope: z.string(), message: z.string(), transport: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ message }) => ({
    content: [{ type: 'text' as const, text: `authenticated:${scope}:${message}` }],
    structuredContent: { scope, message, transport: 'stdio' },
  }),
);

await server.connect(new StdioServerTransport());
