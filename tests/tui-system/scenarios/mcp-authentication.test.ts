import { afterEach, describe, expect, test } from 'bun:test';
import { startTestHttpServer } from '../../helpers/test-http-server';
import { createMockModelServer, type MockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — MCP authentication recovery', () => {
  let tui: PtyProcess | undefined;
  let modelServer: MockModelServer | undefined;
  let authServer: ReturnType<typeof Bun.serve> | undefined;
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    authServer?.stop(true);
    modelServer?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
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
    modelServer.setResponses([{ message: { content: 'unused' } }]);
    workspace = createTestWorkspace({
      configOverrides: {
        mcpServers: {
          oauth: { type: 'http', url: `${authServer.url.origin}/mcp` },
        },
      },
      projectConfigOverrides: {},
    });
    tui = spawnTui({ cols: 120, rows: 40, mockServer: modelServer, workspace });
    await waitForText(() => tui!.output(), '❯', 15_000);
    await sleep(300);
    expect(mcpRequests).toBeGreaterThan(0);
    expect(authorizationRequests).toBe(0);

    tui.setRawMode(true);
    await typeText(tui, '/mcp');
    tui.write('\r');
    await waitForText(() => tui!.output(), 'oauth · ✘ login required', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.output(), 'Authenticate', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.output(), 'Open browser', 10_000);
    expect(authorizationRequests).toBe(0);
    tui.write('\x1b');
    await waitForText(() => tui!.output(), 'Authenticate', 10_000);
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
    modelServer.setResponses([{ message: { content: 'unused' } }]);
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
    tui = spawnTui({ cols: 120, rows: 40, mockServer: modelServer, workspace });
    await waitForText(() => tui!.output(), '❯', 15_000);
    await sleep(300);

    tui.setRawMode(true);
    await typeText(tui, '/mcp');
    tui.write('\r');
    await waitForText(() => tui!.output(), 'oauth · ✘ login required', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.output(), 'Authenticate', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.output(), 'Open browser', 10_000);
    tui.write('\r');
    const openerFailureOutput = await waitForText(
      () => tui!.output(),
      'browser_open_failed',
      15_000,
    );
    expect(metadataRequests).toBeGreaterThanOrEqual(2);
    expect(authorizationRequests).toBe(0);
    expect(screenContains(openerFailureOutput, 'ftp://')).toBe(false);
    expect(screenContains(openerFailureOutput, 'pty-client')).toBe(false);

    tui.write('\x1b');
    await waitForText(() => tui!.output(), 'MCP authentication cancelled.', 10_000);
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
    tui = spawnTui({ cols: 120, rows: 40, mockServer: modelServer, workspace });
    await waitForText(() => tui!.output(), '❯', 15_000);
    await sleep(300);

    tui.setRawMode(true);
    await typeText(tui, 'continue without required provider');
    tui.write('\r');
    await waitForText(() => tui!.output(), "Required MCP provider 'oauth'", 15_000);
    expect(modelServer.getRequestCount()).toBe(0);
    await waitForText(() => tui!.output(), 'Session Waive', 5_000);
    tui.write('\r');
    await waitForText(() => tui!.output(), 'continued after provider waiver', 15_000);
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
              name: 'capability_search',
              args: { query: 'recoverable echo' },
            },
          ],
        },
      },
      {
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
      { message: { content: 'continued after deferring provider login' } },
    ]);
    workspace = createTestWorkspace({
      configOverrides: {
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          mcpProviderActionV1: true,
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
    tui = spawnTui({ cols: 120, rows: 40, mockServer: modelServer, workspace });
    await waitForText(() => tui!.output(), '❯', 15_000);

    tui.setRawMode(true);
    await sleep(300);
    await typeText(tui, 'call the recoverable echo tool');
    tui.write('\r');
    await waitForRequestMessage(modelServer, 'call the recoverable echo tool', 15_000);
    await waitForText(() => tui!.output(), "MCP provider 'recoverable' requires login.", 15_000);
    expect(toolCalls).toBe(1);
    expect(modelServer.getRequestCount()).toBe(2);
    await waitForText(() => tui!.output(), 'Later', 5_000);
    tui.write('\x1b[B');
    tui.write('\r');
    await waitForText(() => tui!.output(), 'continued after deferring provider login', 15_000);
    expect(toolCalls).toBe(1);
    expect(modelServer.getRequestCount()).toBe(3);
  }, 50_000);
});
