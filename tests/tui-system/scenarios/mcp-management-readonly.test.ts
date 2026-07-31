import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exposedMcpToolName } from '@/core/mcp';
import { startTestHttpServer } from '../../helpers/test-http-server';
import { createMockModelServer, type MockModelServer } from '../harness/fixtures';
import { typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForCondition, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — MCP Select management', () => {
  let tui: PtyProcess | undefined;
  let server: MockModelServer | undefined;
  let mcpServer: ReturnType<typeof Bun.serve> | undefined;
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    server?.stop();
    mcpServer?.stop(true);
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test('opens a selected server in the read-only detail action menu', async () => {
    server = createMockModelServer();
    server.setResponses([{ message: { content: 'unused' } }]);
    workspace = createTestWorkspace({
      configOverrides: {
        mcpServers: {
          fixture: {
            type: 'stdio',
            command: process.execPath,
            args: [resolve(import.meta.dir, '..', '..', 'fixtures', 'mcp-test-server.ts')],
          },
        },
      },
      projectConfigOverrides: {},
    });
    expect(readFileSync(workspace.configPath, 'utf-8')).not.toContain('mcpServers');
    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui!.outputSinceLastAction(), '❯', 15_000);
    tui.setRawMode(true);

    await typeText(tui, '/mcp', 20);
    tui.write('\r');
    await waitForText(() => tui!.outputSinceLastAction(), 'MCP Servers', 15_000);
    await waitForText(() => tui!.outputSinceLastAction(), 'fixture · ✔ connected', 15_000);
    expect(screenContains(tui.viewport(), 'Add MCP server')).toBe(true);
    expect(screenContains(tui.viewport(), 'echo')).toBe(false);

    tui.write('\r');
    await waitForText(() => tui!.outputSinceLastAction(), 'Reconnect', 10_000);
    expect(screenContains(tui.viewport(), 'Disable server')).toBe(true);
    expect(screenContains(tui.viewport(), 'Remove server')).toBe(true);
    expect(screenContains(tui.viewport(), 'A Add')).toBe(false);
    expect(screenContains(tui.viewport(), 'R Retry')).toBe(false);
  }, 40_000);

  test('discovers, binds, and executes an MCP tool during a real TUI conversation', async () => {
    let toolCalls = 0;
    const remoteToolName = 'search documentation / latest';
    const exposedToolName = exposedMcpToolName('docs', remoteToolName);
    mcpServer = startTestHttpServer({
      fetch: async (request) => {
        if (request.method === 'GET' || request.method === 'DELETE') {
          return new Response(null, { status: 405 });
        }
        const message = (await request.json()) as {
          id?: string | number;
          method?: string;
          params?: { protocolVersion?: string; uri?: string };
        };
        if (message.method === 'initialize') {
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
              capabilities: { tools: {}, resources: { listChanged: true } },
              serverInfo: { name: 'conversation-fixture', version: '1.0.0' },
            },
          });
        }
        if (message.method === 'tools/list') {
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [
                {
                  name: remoteToolName,
                  description: 'Search the documentation.',
                  inputSchema: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                  },
                },
              ],
            },
          });
        }
        if (message.method === 'prompts/list') {
          return Response.json({ jsonrpc: '2.0', id: message.id, result: { prompts: [] } });
        }
        if (message.method === 'resources/list') {
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              resources: [
                {
                  uri: 'docs://langgraph/overview',
                  name: 'LangGraph overview',
                  description: 'Remote prose must not enter the list result.',
                  mimeType: 'text/markdown',
                },
              ],
            },
          });
        }
        if (message.method === 'resources/read') {
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              contents: [
                {
                  uri: message.params?.uri,
                  mimeType: 'text/markdown',
                  text: 'LangGraph resource content from MCP resources/read.',
                },
              ],
            },
          });
        }
        if (message.method === 'tools/call') {
          toolCalls += 1;
          if (toolCalls > 1) {
            return new Response('deliberate MCP failure', { status: 500 });
          }
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [{ type: 'text', text: 'documentation result from MCP' }],
            },
          });
        }
        return new Response(null, { status: 202 });
      },
    });
    server = createMockModelServer();
    const longMcpSummary = [
      'MCP conversation completed successfully.',
      ...Array.from(
        { length: 36 },
        (_, index) => `Documentation summary line ${index + 1}: stable MCP content.`,
      ),
      '',
      'TAIL_MARKER: the final MCP summary paragraph is visible before the prompt.',
    ].join('\n');
    server.setResponses([
      {
        message: {
          tool_calls: [
            {
              id: 'search-capabilities',
              name: 'tool_search',
              args: { query: 'search documentation' },
            },
          ],
        },
      },
      {
        message: {
          tool_calls: [
            {
              id: 'call-mcp-tool',
              name: exposedToolName,
              args: { query: 'runtime binding' },
            },
          ],
        },
      },
      { message: { content: longMcpSummary } },
      {
        message: {
          tool_calls: [
            {
              id: 'call-failing-mcp-tool',
              name: exposedToolName,
              args: { query: 'failure isolation' },
            },
          ],
        },
      },
      {
        message: {
          content: 'The MCP call failed, but the TUI conversation continued normally.',
        },
      },
      {
        message: {
          tool_calls: [
            {
              id: 'list-mcp-resources',
              name: 'list_mcp_resources',
              args: { server: 'docs' },
            },
          ],
        },
      },
      {
        message: {
          tool_calls: [
            {
              id: 'read-mcp-resource',
              name: 'read_mcp_resource',
              args: { server: 'docs', uri: 'docs://langgraph/overview' },
            },
          ],
        },
      },
      {
        message: {
          content: 'RESOURCE_TAIL: MCP resource discovery and reading completed.',
        },
      },
      {
        message: {
          tool_calls: [
            {
              id: 'read-missing-mcp-resource',
              name: 'read_mcp_resource',
              args: { server: 'docs', uri: 'docs://missing' },
            },
          ],
        },
      },
      {
        message: {
          content: 'RESOURCE_FAILURE_RECOVERED: the conversation continued after the read error.',
        },
      },
    ]);
    workspace = createTestWorkspace({
      configOverrides: {
        mcpServers: {
          docs: {
            type: 'http',
            url: `${mcpServer.url.origin}/mcp`,
            tools: {
              [remoteToolName]: {
                effects: { filesystem: 'none', network: 'read', externalState: 'read' },
                minimumApproval: 'none',
                retry: 'safe_read',
              },
            },
          },
        },
      },
      projectConfigOverrides: {},
    });
    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui!.outputSinceLastAction(), '❯', 15_000);
    tui.setRawMode(true);

    const conversationFrames = tui.markScreen();
    await typeText(tui, 'search the documentation with MCP', 20);
    tui.write('\r');
    await waitForText(
      () => tui!.outputSinceLastAction(),
      'TAIL_MARKER: the final MCP summary paragraph is visible before the prompt.',
      20_000,
    );
    await waitForCondition(
      () =>
        tui!
          .screenFramesSince(conversationFrames)
          .some(
            (frame) =>
              screenContains(
                frame,
                'TAIL_MARKER: the final MCP summary paragraph is visible before the prompt.',
              ) && screenContains(frame, '❯'),
          ),
      'final MCP tail and interactive prompt to coexist in one parsed terminal frame',
      10_000,
    );

    expect(toolCalls).toBe(1);
    expect(screenContains(tui.viewport(), '❯')).toBe(true);
    const requests = server.getRequests();
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[0]?.body)).toContain('tool_search');
    // Small catalogs (≤ 20 tools) bind directly alongside tool_search, so the
    // MCP tool name may appear in the first request's tool list in 'all' mode.
    expect(JSON.stringify(requests[1]?.body)).toContain(exposedToolName);
    expect(JSON.stringify(requests[2]?.messages)).toContain('documentation result from MCP');
    expect(tui.scrollback()).toContain('Searched for tools');
    expect(tui.scrollback()).toContain(`docs · ${remoteToolName}`);
    expect(tui.screenFramesSince(conversationFrames).join('\n')).not.toContain(
      `mcp__docs__${remoteToolName}`,
    );

    await typeText(tui, 'call the same MCP tool again', 20);
    tui.write('\r');
    await waitForText(
      () => tui!.outputSinceLastAction(),
      'The MCP call failed, but the TUI conversation continued normally.',
      20_000,
    );

    expect(toolCalls).toBeGreaterThanOrEqual(2);
    const continuedRequests = server.getRequests();
    expect(continuedRequests).toHaveLength(5);
    expect(JSON.stringify(continuedRequests[4]?.messages)).toContain('provider_unavailable');

    await typeText(tui, 'read the available MCP documentation resource', 20);
    tui.write('\r');
    await waitForText(
      () => tui!.outputSinceLastAction(),
      'RESOURCE_TAIL: MCP resource discovery and reading completed.',
      20_000,
    );
    expect(tui.scrollback()).toContain('Listed MCP resources');
    expect(tui.scrollback()).toContain('docs · docs://langgraph/overview');
    const resourceRequests = server.getRequests();
    expect(resourceRequests).toHaveLength(8);
    expect(JSON.stringify(resourceRequests[7]?.messages)).toContain(
      'LangGraph resource content from MCP resources/read.',
    );

    await typeText(tui, 'try a missing MCP resource and continue', 20);
    tui.write('\r');
    await waitForText(
      () => tui!.outputSinceLastAction(),
      'RESOURCE_FAILURE_RECOVERED: the conversation continued after the read error.',
      20_000,
    );
    const failureRequests = server.getRequests();
    expect(failureRequests).toHaveLength(10);
    expect(JSON.stringify(failureRequests[9]?.messages)).toContain(
      'not present in the current discovery snapshot',
    );
  }, 40_000);
});
