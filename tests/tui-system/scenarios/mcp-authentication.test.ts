import { afterEach, describe, expect, test } from 'bun:test';
import { startTestHttpServer } from '../../helpers/test-http-server';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer, type MockModelServer } from '../harness/fixtures';
import {
  submitCommand,
  submitCurrentInput,
  submitUserMessage,
  typeText,
} from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — MCP authentication recovery', () => {
  let tui: PtyProcess | undefined;
  let modelServer: MockModelServer | undefined;
  let authServer: ReturnType<typeof Bun.serve> | undefined;
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [tui],
      mockServers: [modelServer],
      servers: [authServer],
      workspaces: [workspace],
    });
  });

  test('publishes login-required without browser navigation and exposes it through /mcp', async () => {
    let mcpRequests = 0;
    let authorizationRequests = 0;
    authServer = startTestHttpServer({
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/authorize') authorizationRequests += 1;
        if (url.pathname === '/mcp') {
          mcpRequests += 1;
          return new Response('Unauthorized', { status: 401 });
        }
        return new Response('Not found', { status: 404 });
      },
    });
    modelServer = createMockModelServer();
    modelServer.setResponses([]);
    workspace = createTestWorkspace({
      configOverrides: {
        mcpServers: {
          oauth: { type: 'http', url: `${authServer.url.origin}/mcp` },
        },
      },
      projectConfigOverrides: {},
    });
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: modelServer, workspace });
    await waitForCondition(() => mcpRequests > 0, 'initial MCP connection attempt', 5_000);
    expect(mcpRequests).toBeGreaterThan(0);
    expect(authorizationRequests).toBe(0);
    await submitCommand(tui, '/mcp');
    await waitForText(() => tui!.viewport(), '● 需要登录', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.viewport(), '认证', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.viewport(), '打开浏览器', 10_000);
    expect(authorizationRequests).toBe(0);
    tui.write('\x1b');
    await waitForText(() => tui!.viewport(), '认证', 10_000);
    expect(authorizationRequests).toBe(0);
  }, 40_000);

  test('Login reports opener failure, Esc cancels the flow, and input recovers', async () => {
    let baseUrl = '';
    let metadataRequests = 0;
    let authorizationRequests = 0;
    authServer = startTestHttpServer({
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/resource-metadata') {
          metadataRequests += 1;
          return Response.json({
            resource: `${baseUrl}/mcp`,
            authorization_servers: [baseUrl],
          });
        }
        if (url.pathname === '/.well-known/oauth-authorization-server') {
          metadataRequests += 1;
          return Response.json({
            issuer: baseUrl,
            authorization_endpoint: 'ftp://127.0.0.1/authorize',
            token_endpoint: `${baseUrl}/token`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
          });
        }
        if (url.pathname === '/authorize') authorizationRequests += 1;
        if (url.pathname === '/mcp') {
          return new Response('Unauthorized', {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/resource-metadata"`,
            },
          });
        }
        return new Response('Not found', { status: 404 });
      },
    });
    baseUrl = authServer.url.origin;
    modelServer = createMockModelServer();
    modelServer.setResponses([]);
    workspace = createTestWorkspace({
      configOverrides: {
        mcpServers: {
          oauth: {
            type: 'http',
            url: `${baseUrl}/mcp`,
            auth: { type: 'oauth', clientId: 'pty-client' },
          },
        },
      },
      projectConfigOverrides: {},
    });
    workspace.env.NODE_ENV = 'test';
    workspace.env.KITE_TEST_MCP_CREDENTIAL_STORE = 'memory';
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: modelServer, workspace });
    await submitCommand(tui, '/mcp');
    await waitForText(() => tui!.viewport(), '● 需要登录', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.viewport(), '认证', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.viewport(), '打开浏览器', 10_000);
    const openerFrames = tui.markScreen();
    tui.write('\r');
    await waitForText(() => tui!.viewport(), 'browser_open_failed', 15_000);
    const openerFailureOutput = tui.screenFramesSince(openerFrames).join('\n');
    expect(metadataRequests).toBeGreaterThanOrEqual(2);
    expect(authorizationRequests).toBe(0);
    expect(screenContains(openerFailureOutput, 'ftp://')).toBe(false);
    expect(screenContains(openerFailureOutput, 'pty-client')).toBe(false);

    tui.write('\x1b');
    await waitForText(() => tui!.viewport(), 'MCP authentication cancelled.', 10_000);
  }, 50_000);

  test('required login provider gates the model and Session Waive continues without exposing it', async () => {
    authServer = startTestHttpServer({
      fetch: () => new Response('Unauthorized', { status: 401 }),
    });
    modelServer = createMockModelServer();
    modelServer.setResponses([{ message: { content: 'continued after provider waiver' } }]);
    workspace = createTestWorkspace({
      configOverrides: {
        features: { mcpProviderActionV1: true },
        mcpServers: {
          oauth: {
            type: 'http',
            url: `${authServer.url.origin}/mcp`,
            required: true,
          },
        },
      },
      projectConfigOverrides: {},
    });
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: modelServer, workspace });
    await typeText(tui, 'continue without required provider');
    await submitCurrentInput(tui, {
      acceptWhen: (viewport) => screenContains(viewport, 'Session Waive'),
    });
    await waitForText(() => tui!.outputSinceLastAction(), "Required MCP provider 'oauth'", 15_000);
    expect(modelServer.getRequestCount()).toBe(0);
    await waitForText(() => tui!.viewport(), '❯ 1. Session Waive', 5_000);
    tui.write('\r');
    await waitForText(
      () => tui!.outputSinceLastAction(),
      'continued after provider waiver',
      15_000,
    );
    expect(modelServer.getRequestCount()).toBe(1);
  }, 50_000);

  test('a failed MCP Tool Call offers Provider Action and Later continues without replay', async () => {
    let toolCalls = 0;
    authServer = startTestHttpServer({
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
              serverInfo: { name: 'provider-action-fixture', version: '1.0.0' },
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
                  name: 'echo',
                  description: 'Echo a message.',
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
          return new Response('Unauthorized', { status: 401 });
        }
        return new Response(null, { status: 202 });
      },
    });
    modelServer = createMockModelServer();
    modelServer.setResponses([
      {
        message: {
          tool_calls: [
            {
              id: 'capability-search',
              name: 'tool_search',
              args: { query: 'recoverable echo' },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'capability-search', contentIncludes: ['recoverable'] }],
        },
        message: {
          tool_calls: [
            {
              id: 'mcp-call',
              name: 'mcp__recoverable__echo',
              args: { message: 'hello' },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [
            {
              toolCallId: 'mcp-call',
              contentIncludes: ['provider_auth_required'],
            },
          ],
        },
        message: { content: 'continued after deferring provider login' },
      },
    ]);
    workspace = createTestWorkspace({
      configOverrides: {
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          mcpProviderActionV1: true,
          remoteMcpEgressPolicyV1: true,
        },
        mcpServers: {
          recoverable: {
            type: 'http',
            url: `${authServer.url.origin}/mcp`,
            trust: 'trusted',
            tools: {
              echo: {
                effects: { filesystem: 'none', network: 'none', externalState: 'read' },
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
      mockServer: modelServer,
      workspace,
      remoteMcpEgressPermitResolver: 'allow-each-invocation',
    });
    await submitUserMessage(tui, modelServer, 'call the recoverable echo tool', {
      timeout: 15_000,
    });
    await waitForText(
      () => tui!.outputSinceLastAction(),
      "MCP provider 'recoverable' requires login.",
      15_000,
    );
    expect(toolCalls).toBe(1);
    expect(modelServer.getRequestCount()).toBe(2);
    await waitForText(() => tui!.viewport(), '❯ 1. Run login', 5_000);
    tui.write('\x1b[B');
    await waitForText(() => tui!.viewport(), '❯ 2. Later', 5_000);
    tui.write('\r');
    await waitForText(
      () => tui!.outputSinceLastAction(),
      'continued after deferring provider login',
      15_000,
    );
    expect(toolCalls).toBe(1);
    expect(modelServer.getRequestCount()).toBe(3);
  }, 50_000);
});
