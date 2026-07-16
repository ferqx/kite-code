import { afterEach, describe, expect, test } from 'bun:test';
import { createMockModelServer, type MockModelServer } from '../harness/fixtures';
import { sleep, typeText } from '../harness/input-helpers';
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

  test('publishes login-required without browser navigation and Esc defers the shell prompt', async () => {
    let mcpRequests = 0;
    let authorizationRequests = 0;
    authServer = Bun.serve({
      port: 0,
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
    await waitForText(() => tui!.output(), 'MCP authentication required', 15_000);
    expect(mcpRequests).toBeGreaterThan(0);
    expect(authorizationRequests).toBe(0);
    expect(screenContains(tui.output(), 'oauth')).toBe(true);

    tui.setRawMode(true);
    tui.write('\x1b');
    await sleep(200);
    await typeText(tui, '/help');
    tui.write('\r');
    await waitForText(() => tui!.output(), '快捷键', 10_000);
    expect(authorizationRequests).toBe(0);
  }, 40_000);

  test('Login reports opener failure, Esc cancels the flow, and input recovers', async () => {
    let baseUrl = '';
    let metadataRequests = 0;
    let authorizationRequests = 0;
    authServer = Bun.serve({
      port: 0,
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
    await waitForText(() => tui!.output(), 'MCP authentication required', 15_000);

    tui.setRawMode(true);
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
    tui.write('\x1b');
    await sleep(200);
    await typeText(tui, '/help');
    tui.write('\r');
    await waitForText(() => tui!.output(), '快捷键', 10_000);
  }, 50_000);
});
