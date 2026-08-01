import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'governance-fixture', version: '1.0.0' });

server.registerTool(
  'read_fixture',
  {
    description: 'Returns structured fixture data.',
    inputSchema: { id: z.string() },
    outputSchema: { id: z.string(), value: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => ({
    content: [
      { type: 'text' as const, text: `fixture:${id}` },
      { type: 'resource_link' as const, uri: `resource://fixture/${id}`, name: 'fixture' },
    ],
    structuredContent: { id, value: 'ok' },
  }),
);

server.registerTool('fail_fixture', { inputSchema: {} }, async () => {
  throw new Error('fixture unavailable');
});

server.registerTool('exit_fixture', { inputSchema: {} }, async () => {
  process.exit(23);
});

let retryCalls = 0;
server.registerTool('retry_fixture', { inputSchema: {} }, async () => {
  retryCalls += 1;
  if (retryCalls === 1) throw new Error('transient failure');
  return { content: [{ type: 'text' as const, text: 'ok' }] };
});

await server.connect(new StdioServerTransport());
