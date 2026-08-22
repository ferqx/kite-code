import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createMcpStdioTransportV1, McpConnectionManager } from '@kite/builtin-runtime/mcp';
import { createRuntimeHostMcpStdioProcessPortV1 } from '@kite/runtime-host';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const workspace = process.cwd();
const fixture = `${workspace}/tests/fixtures/mcp-governance-server.ts`;
const protectedPathEvaluator = {
  workspaceRoot: workspace,
  evaluate: ({ path }: { path: string }) => ({
    outcome: 'allow' as const,
    reason: 'explicit_test_fixture',
    canonicalPath: resolve(path),
  }),
};

function createPort() {
  return createRuntimeHostMcpStdioProcessPortV1({
    installationKey: { keyId: 'builtin-mcp-test-installation', key: new Uint8Array(32).fill(0x31) },
  });
}

describe('Builtin MCP Host stdio transport', () => {
  test('keeps SDK JSON-RPC semantics on the Host-authenticated process port', async () => {
    const client = new Client({ name: 'builtin-mcp-test', version: '1' }, { capabilities: {} });
    const transport = createMcpStdioTransportV1(
      {
        command: process.execPath,
        args: [fixture],
        cwd: workspace,
      },
      createPort(),
    );
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'read_fixture')).toBe(true);
    const result = await client.callTool({ name: 'read_fixture', arguments: { id: 'host-port' } });
    expect(result.structuredContent).toEqual({ id: 'host-port', value: 'ok' });
    await client.close();
  });

  test('fails closed without an injected Host process port and rejects unsafe env names', async () => {
    const noPortManager = new McpConnectionManager({ protectedPathEvaluator });
    await expect(
      noPortManager.connect('fixture', {
        type: 'stdio',
        command: process.execPath,
        cwd: workspace,
      }),
    ).rejects.toThrow(/process authority is unavailable/u);

    const unsafeEnvManager = new McpConnectionManager({
      stdioProcessPort: createPort(),
      protectedPathEvaluator,
    });
    await expect(
      unsafeEnvManager.connect('fixture', {
        type: 'stdio',
        command: process.execPath,
        args: [fixture],
        cwd: workspace,
        env: { MCP_SECRET: 'must-not-cross' },
      }),
    ).rejects.toThrow(/raw credential material/u);
  });
});
