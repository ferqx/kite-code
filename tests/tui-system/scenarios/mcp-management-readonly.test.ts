import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestHttpServer } from '../../helpers/test-http-server';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer, type MockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition, waitForText } from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedTurnEvents,
  type TestWorkspace,
} from '../harness/test-workspace';

describe('TUI PTY System — MCP Select management', () => {
  let tui: PtyProcess | undefined;
  let server: MockModelServer | undefined;
  let mcpServer: ReturnType<typeof Bun.serve> | undefined;
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [tui],
      mockServers: [server],
      servers: [mcpServer],
      workspaces: [workspace],
    });
  });

  test('opens a selected server in the read-only detail action menu', async () => {
    server = createMockModelServer();
    server.setResponses([]);
    mcpServer = startTestHttpServer({
      fetch: async (request) => {
        if (request.method === 'GET' || request.method === 'DELETE') {
          return new Response(null, { status: 405 });
        }
        const message = (await request.json()) as {
          id?: string | number;
          method?: string;
          params?: { protocolVersion?: string };
        };
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
                capabilities: {},
                serverInfo: { name: 'readonly-fixture', version: '1.0.0' },
              }
            : message.method === 'tools/list'
              ? { tools: [] }
              : message.method === 'prompts/list'
                ? { prompts: [] }
                : { resources: [] };
        return Response.json({ jsonrpc: '2.0', id: message.id, result });
      },
    });
    workspace = createTestWorkspace({
      configOverrides: {
        mcpServers: {
          fixture: {
            type: 'http',
            url: `${mcpServer.url.origin}/mcp`,
          },
        },
      },
      projectConfigOverrides: {},
    });
    expect(readFileSync(workspace.configPath, 'utf-8')).not.toContain('mcpServers');
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
      entryPath: join(import.meta.dir, '../fixtures/mcp-management-tui.tsx'),
    });

    await submitCommand(tui, '/mcp', 20);
    await waitForText(() => tui!.viewport(), 'MCP 服务器', 15_000);
    await waitForText(() => tui!.viewport(), '● 已连接', 15_000);
    expect(screenContains(tui.viewport(), '＋ 添加 MCP 服务器')).toBe(true);
    expect(screenContains(tui.viewport(), 'echo')).toBe(false);

    tui.write('\r');
    await waitForText(() => tui!.viewport(), '重新连接', 10_000);
    expect(screenContains(tui.viewport(), '禁用')).toBe(true);
    expect(screenContains(tui.viewport(), '移除')).toBe(true);
    expect(screenContains(tui.viewport(), 'A Add')).toBe(false);
    expect(screenContains(tui.viewport(), 'R Retry')).toBe(false);
  }, 40_000);

  test('sends inspected remote MCP arguments without a separate permit protocol', async () => {
    let toolCalls = 0;
    const remoteToolName = 'remote echo';
    const exposedToolName = `mcp__closed__${remoteToolName}`;
    mcpServer = startTestHttpServer({
      fetch: async (request) => {
        if (request.method === 'GET' || request.method === 'DELETE') {
          return new Response(null, { status: 405 });
        }
        const message = (await request.json()) as {
          id?: string | number;
          method?: string;
          params?: { protocolVersion?: string };
        };
        if (message.method === 'initialize') {
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'closed-fixture', version: '1.0.0' },
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
                  inputSchema: {
                    type: 'object',
                    properties: { message: { type: 'string' } },
                    required: ['message'],
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
          return Response.json({ jsonrpc: '2.0', id: message.id, result: { resources: [] } });
        }
        if (message.method === 'tools/call') {
          toolCalls += 1;
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: 'remote echo accepted' }] },
          });
        }
        return new Response(null, { status: 202 });
      },
    });
    server = createMockModelServer();
    server.setResponses([
      {
        message: {
          tool_calls: [
            {
              id: 'closed-mcp-call',
              name: exposedToolName,
              args: { message: 'must not leave the process' },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'closed-mcp-call', contentIncludes: ['remote echo accepted'] },
          ],
        },
        message: { content: 'REMOTE_MCP_CALL_HANDLED' },
      },
    ]);
    workspace = createTestWorkspace({
      configOverrides: {
        mcpServers: {
          closed: {
            type: 'http',
            url: `${mcpServer.url.origin}/mcp`,
            tools: {
              [remoteToolName]: {
                effects: { filesystem: 'none', network: 'read', externalState: 'read' },
                minimumApproval: 'none',
                retry: 'never',
              },
            },
          },
        },
      },
      projectConfigOverrides: {},
    });
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
      entryPath: join(import.meta.dir, '../fixtures/mcp-management-tui.tsx'),
    });

    await submitUserMessage(tui, server, 'call the closed remote MCP tool', {
      delayMs: 20,
      timeout: 15_000,
    });
    await waitForText(() => tui!.outputSinceLastAction(), 'REMOTE_MCP_CALL_HANDLED', 20_000);

    expect(toolCalls).toBe(1);
    // Dynamic MCP names and call arguments remain in the durable tool result
    // (asserted by the mock response above), never in client presentation.
    expect(tui.scrollback()).toContain('MCP tool');
    expect(tui.scrollback()).not.toContain(remoteToolName);
    expect(tui.scrollback()).not.toContain('must not leave the process');
    expect(tui.scrollback()).not.toContain('Remote MCP content egress denied');
  }, 40_000);

  test('discovers, binds, and executes an MCP tool during a real TUI conversation', async () => {
    let toolCalls = 0;
    let resourceReads = 0;
    let transportFailure = false;
    let failedTransportCalls = 0;
    const remoteToolName = 'search documentation / latest';
    const exposedToolName = `mcp__docs__${remoteToolName}`;
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
          resourceReads++;
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
          if (transportFailure) {
            failedTransportCalls++;
            return new Response('deliberate MCP failure', { status: 500 });
          }
          if (toolCalls > 1) {
            return Response.json({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                isError: true,
                content: [{ type: 'text', text: 'provider_unavailable: deliberate MCP failure' }],
              },
            });
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
        expectedRequest: {
          toolResults: [{ toolCallId: 'search-capabilities', contentIncludes: [remoteToolName] }],
        },
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
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call-mcp-tool', contentIncludes: ['documentation result from MCP'] },
          ],
        },
        message: { content: longMcpSummary },
      },
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
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call-failing-mcp-tool', contentIncludes: ['provider_unavailable'] },
          ],
        },
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
        expectedRequest: {
          toolResults: [
            { toolCallId: 'list-mcp-resources', contentIncludes: ['docs://langgraph/overview'] },
          ],
        },
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
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'read-mcp-resource',
              contentIncludes: ['LangGraph resource content from MCP resources/read.'],
            },
          ],
        },
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
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'read-missing-mcp-resource',
              contentIncludes: ['mcp_descriptor_stale'],
            },
          ],
        },
        message: {
          content: 'RESOURCE_FAILURE_RECOVERED: the conversation continued after the read error.',
        },
      },
      {
        toolContinuation: 'aborted',
        message: {
          tool_calls: [
            {
              id: 'call-http500-mcp-tool',
              name: exposedToolName,
              args: { query: 'actual HTTP500 unknown effect' },
            },
          ],
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
                retry: 'never',
              },
            },
          },
        },
      },
      projectConfigOverrides: {},
    });
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
      entryPath: join(import.meta.dir, '../fixtures/mcp-management-tui.tsx'),
    });

    const conversationFrames = tui.markScreen();
    await submitUserMessage(tui, server, 'search the documentation with MCP', {
      delayMs: 20,
      timeout: 15_000,
    });
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
    const requests = server.getWorkRequests();
    expect(requests).toHaveLength(3);
    expect(requests[0]?.body.tools).toContainEqual(
      expect.objectContaining({ function: expect.objectContaining({ name: 'mcp_tools_search' }) }),
    );
    // Small catalogs (≤ 20 tools) bind directly alongside tool_search, so the
    // MCP tool name may appear in the first request's tool list in 'all' mode.
    const discovered = requests[1]?.messages
      .filter((message) => message.role === 'tool')
      .flatMap((message) => {
        try {
          const result = JSON.parse(String(message.content));
          return result.source === 'frozen_selected_mcp_catalogue' && Array.isArray(result.items)
            ? result.items
            : [];
        } catch {
          return [];
        }
      })
      .filter((item) => item.serverName === 'docs' && item.remoteName === remoteToolName);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].definitionId).toMatch(/^mcp\.mcp-[a-f0-9]{64}\.[a-f0-9]{32}$/);
    expect(JSON.stringify(requests[1]?.body)).toContain(discovered[0].definitionId);
    expect(JSON.stringify(requests[2]?.messages)).toContain('documentation result from MCP');
    const clientConversation = tui.screenFramesSince(conversationFrames).join('\n');
    // Dynamic MCP execution must retain a concrete label; it must not regress
    // to the generic `● Tool` card that hides which lifecycle is running. Use
    // the captured frame history because a final Ink redraw may legitimately
    // move an earlier card out of the terminal's current scrollback snapshot.
    expect(clientConversation).toContain('● mcp:dynamic_tool');
    expect(clientConversation).not.toContain('● Tool');
    expect(clientConversation).toContain(remoteToolName);
    expect(clientConversation).not.toContain(`mcp__docs__${remoteToolName}`);
    expect(clientConversation).not.toContain('runtime binding');
    expect(clientConversation).not.toContain('documentation result from MCP');

    await submitUserMessage(tui, server, 'call the same MCP tool again', {
      delayMs: 20,
      timeout: 15_000,
    });
    await waitForText(
      () => tui!.outputSinceLastAction(),
      'The MCP call failed, but the TUI conversation continued normally.',
      20_000,
    );

    expect(toolCalls).toBeGreaterThanOrEqual(2);
    const continuedRequests = server.getWorkRequests();
    expect(continuedRequests).toHaveLength(5);
    expect(JSON.stringify(continuedRequests[4]?.messages)).toContain('provider_unavailable');

    const resourceFrames = tui.markScreen();
    await submitUserMessage(tui, server, 'read the available MCP documentation resource', {
      delayMs: 20,
      timeout: 15_000,
    });
    await waitForText(
      () => tui!.outputSinceLastAction(),
      'RESOURCE_TAIL: MCP resource discovery and reading completed.',
      20_000,
    );
    const resourceConversation = tui.screenFramesSince(resourceFrames).join('\n');
    expect(resourceConversation).toContain('Listed MCP resources');
    expect(resourceConversation).toContain('docs://langgraph/overview');
    expect(resourceConversation).not.toContain(
      'LangGraph resource content from MCP resources/read.',
    );
    const resourceRequests = server.getWorkRequests();
    expect(resourceRequests).toHaveLength(8);
    expect(JSON.stringify(resourceRequests[7]?.messages)).toContain(
      'LangGraph resource content from MCP resources/read.',
    );
    expect(resourceReads).toBe(1);

    await submitUserMessage(tui, server, 'try a missing MCP resource and continue', {
      delayMs: 20,
      timeout: 15_000,
    });
    await waitForText(
      () => tui!.outputSinceLastAction(),
      'RESOURCE_FAILURE_RECOVERED: the conversation continued after the read error.',
      20_000,
    );
    const failureRequests = server.getWorkRequests();
    expect(failureRequests).toHaveLength(10);
    expect(JSON.stringify(failureRequests[9]?.messages)).toContain('mcp_descriptor_stale');
    expect(resourceReads).toBe(1);

    // Restore the original transport failure separately from the known isError
    // result above: a dispatched HTTP500 cannot prove that the remote effect
    // did not happen, so it must not be fed to another Model as a safe retry.
    transportFailure = true;
    const beforeFailure = toolCalls;
    const prompt = 'retain the original MCP HTTP500 uncertainty without retry';
    await submitUserMessage(tui, server, prompt, { delayMs: 20, timeout: 15_000 });
    await waitForCondition(
      () => {
        const observation = observePersistedTurnEvents(workspace!, prompt);
        if (observation.status !== 'ready' || !observation.value) return false;
        using db = new Database(workspace!.databasePath, { readonly: true });
        const run = db
          .query<{ is_active: number }, [string, string]>(
            'SELECT is_active FROM run WHERE id=? AND session_id=?',
          )
          .get(observation.value.turnId, observation.value.threadId);
        return run?.is_active === 0;
      },
      'the original HTTP500 Run reaches its durable terminal without a continuation',
      15_000,
    );
    const observation = observePersistedTurnEvents(workspace, prompt);
    expect(observation.status).toBe('ready');
    if (observation.status !== 'ready' || !observation.value)
      throw Error('http500_original_run_missing');
    using db = new Database(workspace.databasePath, { readonly: true });
    const actual = db
      .query<{ state: string; result_json: string; dispatched: number }, [string, string]>(`
      SELECT e.state,e.result_json,e.dispatched FROM execution e JOIN run r ON r.id=e.run_id
      WHERE e.run_id=? AND e.session_id=? AND e.call_id='call-http500-mcp-tool' AND e.kind='tool'
        AND e.origin_store_id=r.origin_store_id AND e.root_work_command_id=r.root_work_command_id
        AND e.root_work_seq=r.root_work_seq
    `)
      .all(observation.value.turnId, observation.value.threadId);
    expect(actual).toHaveLength(1);
    expect(actual[0]!.state).toBe('outcome_unknown');
    expect(actual[0]!.dispatched).toBe(1);
    expect(JSON.parse(actual[0]!.result_json)).toMatchObject({ outcome: 'outcome_unknown' });
    expect(failedTransportCalls).toBe(1);
    expect(toolCalls).toBe(beforeFailure + 1);
    expect(server.getWorkRequestCount()).toBe(11);
    await waitForText(() => tui!.viewport(), '未知 — 核实原任务', 5_000);
    expect(
      screenContains(tui.viewport(), 'Outcome unknown; original work remains unverified.'),
    ).toBe(true);
    expect(server.getWorkRequestCount()).toBe(11);
    expect(failedTransportCalls).toBe(1);
  }, 40_000);
});
