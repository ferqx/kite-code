import { afterEach, describe, expect, test } from 'bun:test';
import type { CallbackServerFactory } from '@kite/builtin-runtime/mcp';
import {
  DefaultMcpAuthCoordinator,
  DefaultMcpSupervisor,
  MemoryMcpCredentialStore,
} from '@kite/builtin-runtime/mcp';
import type { McpConfigCatalog } from '#app/config';
import { createInMemoryMcpConfigRepositoryV1 } from './helpers/mcp-test-composition';
import { startTestHttpServer } from './helpers/test-http-server';

describe('HTTP MCP OAuth integration', () => {
  let stopServer: (() => void) | undefined;

  afterEach(() => {
    stopServer?.();
    stopServer = undefined;
  });

  test('discovers OAuth, validates PKCE/state, exchanges the code, and rediscovers tools', async () => {
    const requests: Array<{ path: string; authorization?: string }> = [];
    let observedVerifier = '';
    let callback: ((url: URL) => void) | undefined;
    let baseUrl = '';
    const fixture: ReturnType<typeof Bun.serve> = startTestHttpServer({
      fetch: async (request): Promise<Response> => {
        const url = new URL(request.url);
        requests.push({
          path: url.pathname,
          ...(request.headers.get('authorization')
            ? { authorization: request.headers.get('authorization')! }
            : {}),
        });
        if (url.pathname === '/resource-metadata') {
          return Response.json({
            resource: `${baseUrl}/mcp`,
            authorization_servers: [baseUrl],
            scopes_supported: ['mcp:tools'],
          });
        }
        if (url.pathname === '/.well-known/oauth-authorization-server') {
          return Response.json({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
          });
        }
        if (url.pathname === '/register') {
          const metadata = (await request.json()) as Record<string, unknown>;
          return Response.json(
            { ...metadata, client_id: 'dynamic-client', token_endpoint_auth_method: 'none' },
            { status: 201 },
          );
        }
        if (url.pathname === '/token') {
          const body = new URLSearchParams(await request.text());
          expect(body.get('code')).toBe('opaque-code');
          observedVerifier = body.get('code_verifier') ?? '';
          expect(body.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
          return Response.json({
            access_token: 'access-secret',
            refresh_token: 'refresh-secret',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        if (url.pathname === '/mcp') {
          if (request.headers.get('authorization') !== 'Bearer access-secret') {
            return new Response('Unauthorized', {
              status: 401,
              headers: {
                'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/resource-metadata", scope="mcp:tools"`,
              },
            });
          }
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
                capabilities: {},
                serverInfo: { name: 'oauth-fixture', version: '1.0.0' },
              },
            });
          }
          if (message.method === 'tools/list') {
            return Response.json({
              jsonrpc: '2.0',
              id: message.id,
              result: { tools: [{ name: 'read', inputSchema: { type: 'object' } }] },
            });
          }
          if (message.method === 'prompts/list') {
            return Response.json({ jsonrpc: '2.0', id: message.id, result: { prompts: [] } });
          }
          if (message.method === 'resources/list') {
            return Response.json({ jsonrpc: '2.0', id: message.id, result: { resources: [] } });
          }
          return new Response(null, { status: 202 });
        }
        return new Response('Not found', { status: 404 });
      },
    });
    baseUrl = fixture.url.origin;
    stopServer = () => fixture.stop(true);

    const opened: string[] = [];
    const callbackFactory: CallbackServerFactory = async (onCallback) => {
      callback = onCallback;
      return {
        redirectUrl: new URL('http://127.0.0.1:43119/oauth/callback'),
        close: async () => {},
      };
    };
    const authCoordinator = new DefaultMcpAuthCoordinator({
      credentialStore: new MemoryMcpCredentialStore(),
      browserOpener: {
        open: async (url) => {
          opened.push(url.toString());
        },
      },
      startCallbackServer: callbackFactory,
    });
    const supervisor = new DefaultMcpSupervisor({
      authCoordinator,
      repository: createInMemoryMcpConfigRepositoryV1(() => catalog(`${fixture.url.origin}/mcp`)),
    });

    await supervisor.start(process.cwd());
    await waitFor(() => supervisor.getSnapshot().servers[0]?.authStatus === 'login_required');
    expect(opened).toEqual([]);
    expect(supervisor.getSnapshot().servers[0]).toMatchObject({
      health: 'disconnected',
      authStatus: 'login_required',
      toolCount: 0,
    });

    const result = await supervisor.login(supervisor.getSnapshot().servers[0]!.key);
    expect(result.status).toBe('authorization_required');
    expect(opened).toHaveLength(1);
    const authorizationUrl = new URL(opened[0]!);
    expect(authorizationUrl.origin).toBe(fixture.url.origin);
    expect(authorizationUrl.pathname).toBe('/authorize');
    expect(authorizationUrl.searchParams.get('code_challenge')).not.toBeNull();
    const state = authorizationUrl.searchParams.get('state');
    expect(state?.length).toBeGreaterThan(20);

    if (!callback || !state) throw new Error('OAuth callback was not prepared');
    callback(new URL(`http://127.0.0.1:43119/oauth/callback?code=opaque-code&state=${state}`));
    await waitFor(() => supervisor.getSnapshot().servers[0]?.health === 'ready');
    expect(observedVerifier.length).toBeGreaterThan(40);
    expect(supervisor.getSnapshot().servers[0]).toMatchObject({
      authStatus: 'authenticated',
      credentialPresent: true,
      health: 'ready',
      toolCount: 1,
      availableToolCount: 1,
    });
    expect(supervisor.getRuntimeProvider().getCapabilitySnapshot().descriptors).toHaveLength(1);
    expect(requests.some((entry) => entry.authorization === 'Bearer access-secret')).toBe(true);
    expect(JSON.stringify(supervisor.getSnapshot())).not.toContain('access-secret');
    expect(JSON.stringify(supervisor.getSnapshot())).not.toContain('refresh-secret');
    await supervisor.stop();
  });
});

function catalog(url: string): McpConfigCatalog {
  const entry = {
    name: 'oauth',
    source: { kind: 'user' as const, path: '/home/user/config.jsonc', workspace: process.cwd() },
    rawConfig: { type: 'http', url },
    normalizedConfig: { type: 'http' as const, url, providerVersion: 'oauth-provider-v1' },
    revision: 'oauth-entry-revision',
    providerConfigDigest: 'oauth-provider-v1',
    enabled: true,
    approvalStatus: 'not_required' as const,
    diagnostics: [],
    effective: true,
  };
  return {
    entries: [entry],
    effective: new Map([['oauth', entry]]),
    connectableServers: { oauth: entry.normalizedConfig },
    projectApprovals: [],
    diagnostics: [],
    workspace: process.cwd(),
    sourceRevisions: { local: 'local', project: 'project', user: 'user' },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for OAuth state');
    await Bun.sleep(10);
  }
}
