import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type McpCredentialKey,
  McpManager,
  type McpResource,
  MemoryMcpCredentialStore,
} from '@/core/mcp';
import { normalizeMcpToolResult } from '@/core/mcp/result-normalizer';
import { startTestHttpServer } from './helpers/test-http-server';

describe('McpManager governance fixture', () => {
  test('uses a typed provider failure when a direct call targets an unavailable server', async () => {
    const manager = new McpManager();
    expect(manager.getProviderDirectorySnapshot()).toEqual({
      revision: expect.any(String),
      entries: [],
    });
    await expect(manager.callTool('missing', 'read', {})).rejects.toMatchObject({
      name: 'McpProviderError',
      providerId: 'missing',
      kind: 'provider_unavailable',
    });
  });

  const manager = new McpManager();

  afterEach(async () => {
    await manager.disconnectAll();
  });

  test('discovers a revisioned stdio capability and preserves its structured result', async () => {
    await manager.connect('fixture', {
      type: 'stdio',
      command: process.execPath,
      args: [resolve(import.meta.dir, 'fixtures/mcp-governance-server.ts')],
      trust: 'trusted',
    });
    const snapshot = manager.getCapabilitySnapshot();
    const descriptor = snapshot.descriptors.find(
      (candidate) => candidate.capabilityId === 'mcp:fixture/read_fixture',
    );
    expect(snapshot.revision).toHaveLength(64);
    expect(descriptor?.availability).toBe('available');
    expect(descriptor?.effectiveEffects.externalState).toBe('read');
    expect(manager.getServerStates().get('fixture')?.health).toBe('ready');

    const raw = await manager.callTool('fixture', 'read_fixture', { id: '42' });
    const result = normalizeMcpToolResult(raw, descriptor?.outputSchema);
    expect(result.status).toBe('success');
    expect(result.structuredContent).toEqual({ id: '42', value: 'ok' });
    expect(result.content).toHaveLength(2);
  });

  test('retains the last successful capability catalog during a failed reconnect', async () => {
    await manager.connect('stable', {
      type: 'stdio',
      command: process.execPath,
      args: [resolve(import.meta.dir, 'fixtures/mcp-governance-server.ts')],
    });
    const before = manager.findCapability('mcp:stable/read_fixture');
    expect(before).toBeDefined();

    await expect(
      manager.reconnect('stable', { type: 'http', url: 'not a valid url' }, 2),
    ).rejects.toThrow();
    expect(manager.findCapability('mcp:stable/read_fixture')?.revision).toBe(before?.revision);
    expect(manager.getProviderDirectorySnapshot().entries[0]?.status).toBe('failed');

    await manager.disconnect('stable');
    expect(manager.findCapability('mcp:stable/read_fixture')).toBeUndefined();
  });

  test('replaces the retained catalog when a successful rediscovery is empty', async () => {
    let clientIndex = 0;
    const clients = [
      {
        connect: async () => {},
        close: async () => {},
        listTools: async () => ({
          tools: [{ name: 'old_tool', inputSchema: { type: 'object' } }],
        }),
        listPrompts: async () => ({ prompts: [] }),
        listResources: async () => ({ resources: [] }),
        setNotificationHandler: () => {},
      },
      {
        connect: async () => {},
        close: async () => {},
        listTools: async () => ({ tools: [] }),
        listPrompts: async () => ({ prompts: [] }),
        listResources: async () => ({ resources: [] }),
        setNotificationHandler: () => {},
      },
    ] as unknown as Client[];
    const emptyRefreshManager = new McpManager({
      createClient: () => clients[clientIndex++]!,
      createTransport: () => ({}) as never,
    });
    try {
      await emptyRefreshManager.connect('refresh', { type: 'stdio', command: 'fixture' }, 1);
      expect(emptyRefreshManager.findCapability('mcp:refresh/old_tool')).toBeDefined();

      await emptyRefreshManager.reconnect('refresh', { type: 'stdio', command: 'fixture' }, 2);
      expect(emptyRefreshManager.findCapability('mcp:refresh/old_tool')).toBeUndefined();
      expect(emptyRefreshManager.getCapabilitySnapshot().descriptors).toEqual([]);
    } finally {
      await emptyRefreshManager.disconnectAll();
    }
  });

  test('refreshes tools from the registered list_changed handler and retains the catalog on failure', async () => {
    let toolHandler: (() => Promise<void>) | undefined;
    let tools = [{ name: 'old_tool', inputSchema: { type: 'object' } }];
    let refreshError: Error | undefined;
    const client = {
      connect: async () => {},
      close: async () => {},
      listTools: async () => {
        if (refreshError) throw refreshError;
        return { tools };
      },
      listPrompts: async () => ({ prompts: [] }),
      listResources: async () => ({ resources: [] }),
      setNotificationHandler: (schema: unknown, handler: () => Promise<void>) => {
        if (schema === ToolListChangedNotificationSchema) toolHandler = handler;
      },
    } as unknown as Client;
    const notificationManager = new McpManager({
      createClient: () => client,
      createTransport: () => ({}) as never,
    });
    try {
      await notificationManager.connect('notifications', { type: 'stdio', command: 'fixture' }, 1);
      expect(toolHandler).toBeDefined();
      expect(notificationManager.findCapability('mcp:notifications/old_tool')).toBeDefined();

      tools = [{ name: 'new_tool', inputSchema: { type: 'object' } }];
      await toolHandler?.();
      expect(notificationManager.findCapability('mcp:notifications/old_tool')).toBeUndefined();
      const retained = notificationManager.findCapability('mcp:notifications/new_tool');
      expect(retained).toBeDefined();

      refreshError = new Error('list refresh failed');
      await toolHandler?.();
      expect(notificationManager.findCapability('mcp:notifications/new_tool')?.revision).toBe(
        retained?.revision,
      );
      expect(notificationManager.getServerStates().get('notifications')).toMatchObject({
        health: 'degraded',
        diagnostic: { code: 'discovery_failed' },
      });
    } finally {
      await notificationManager.disconnectAll();
    }
  });

  test('publishes static resources, validates reads, and retains the last list on refresh failure', async () => {
    let resourceHandler: (() => Promise<void>) | undefined;
    let resources: McpResource[] = [
      { uri: 'docs://b', name: 'B', description: 'untrusted prose' },
      { uri: 'docs://a', name: 'A', mimeType: 'text/markdown' },
    ];
    let refreshError: Error | undefined;
    const client = {
      connect: async () => {},
      close: async () => {},
      listTools: async () => ({ tools: [] }),
      listPrompts: async () => ({ prompts: [] }),
      listResources: async () => {
        if (refreshError) throw refreshError;
        return { resources };
      },
      readResource: async ({ uri }: { uri: string }) => ({
        contents: [{ uri, text: `content:${uri}` }],
      }),
      setNotificationHandler: (schema: unknown, handler: () => Promise<void>) => {
        if (schema === ResourceListChangedNotificationSchema) resourceHandler = handler;
      },
    } as unknown as Client;
    const resourceManager = new McpManager({
      createClient: () => client,
      createTransport: () => ({}) as never,
    });
    try {
      await resourceManager.connect('docs', { type: 'stdio', command: 'fixture' }, 1);
      expect(resourceManager.getResourceDirectorySnapshot().resources).toEqual([
        {
          providerId: 'docs',
          uri: 'docs://a',
          name: 'A',
          mimeType: 'text/markdown',
        },
        { providerId: 'docs', uri: 'docs://b', name: 'B' },
      ]);
      expect(
        JSON.stringify(resourceManager.getResourceDirectorySnapshot().resources),
      ).not.toContain('untrusted prose');
      await expect(resourceManager.readResource('docs', 'docs://a')).resolves.toBe(
        'content:docs://a',
      );
      await expect(resourceManager.readResource('docs', 'docs://missing')).rejects.toThrow(
        'not present in the current discovery snapshot',
      );

      resources = [{ uri: 'docs://new', name: 'New' }];
      await resourceHandler?.();
      expect(resourceManager.getResourceDirectorySnapshot().resources).toEqual([
        { providerId: 'docs', uri: 'docs://new', name: 'New' },
      ]);

      refreshError = new Error('resource refresh failed');
      await resourceHandler?.();
      expect(resourceManager.getResourceDirectorySnapshot().resources).toEqual([
        { providerId: 'docs', uri: 'docs://new', name: 'New' },
      ]);
      expect(resourceManager.getServerStates().get('docs')?.health).toBe('degraded');
    } finally {
      await resourceManager.disconnectAll();
    }
  });

  test('opens a health circuit after repeated provider failures and fails closed', async () => {
    const manager = managerWithCall('fail_fixture', async () => {
      throw new Error('fixture unavailable');
    });
    await manager.connect('failing', { type: 'stdio', command: 'fixture' });

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(manager.callTool('failing', 'fail_fixture', {})).rejects.toThrow(
        'fixture unavailable',
      );
    }
    const failingState = manager.getServerStates().get('failing');
    expect(failingState?.health).toBe('circuit_open');
    expect(failingState?.retryAt).toBeGreaterThan(Date.now());
    expect(failingState?.diagnostic?.code).toBe('circuit_open');
    await expect(manager.callTool('failing', 'fail_fixture', {})).rejects.toThrow(
      'circuit is open',
    );
    await manager.disconnectAll();
  });

  test('retries only an explicitly configured safe read with unchanged arguments', async () => {
    let calls = 0;
    const manager = managerWithCall('retry_fixture', async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient failure');
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const args = { id: 'same-input' };
    await manager.connect('retrying', {
      type: 'stdio',
      command: 'fixture',
      tools: {
        retry_fixture: {
          effects: { filesystem: 'read', network: 'read', externalState: 'read' },
          retry: 'safe_read',
        },
      },
    });
    await expect(manager.callTool('retrying', 'retry_fixture', args)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(calls).toBe(2);
    expect(args).toEqual({ id: 'same-input' });
    await manager.disconnectAll();
  });

  test('does not retry a safe_read label while effective effects remain unknown', async () => {
    let calls = 0;
    const manager = managerWithCall('unknown_retry', async () => {
      calls += 1;
      throw new Error('transient failure');
    });
    await manager.connect('retrying', {
      type: 'stdio',
      command: 'fixture',
      tools: { unknown_retry: { retry: 'safe_read' } },
    });

    await expect(manager.callTool('retrying', 'unknown_retry', {})).rejects.toThrow(
      'transient failure',
    );
    expect(calls).toBe(1);
    await manager.disconnectAll();
  });

  test('publishes immutable state and invalidates capabilities before disconnect returns', async () => {
    const manager = new McpManager();
    let notifications = 0;
    const unsubscribe = manager.subscribe(() => {
      notifications += 1;
    });
    await manager.connect(
      'generation-fixture',
      {
        type: 'stdio',
        command: process.execPath,
        args: [resolve(import.meta.dir, 'fixtures/mcp-governance-server.ts')],
      },
      7,
    );
    expect(manager.getServerStates().get('generation-fixture')?.generation).toBe(7);
    const disconnecting = manager.disconnect('generation-fixture');
    expect(manager.getServerStates().has('generation-fixture')).toBe(false);
    expect(manager.getCapabilitySnapshot().descriptors).toHaveLength(0);
    await disconnecting;
    expect(notifications).toBeGreaterThanOrEqual(4);
    unsubscribe();
  });

  test('ignores a late connection from an older generation', async () => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    let firstCloses = 0;
    const clients = [
      fakeClient({ connect: () => firstGate.promise, close: async () => firstCloses++ }),
      fakeClient({ connect: () => secondGate.promise }),
    ];
    const manager = new McpManager({
      createClient: () => clients.shift()!,
      createTransport: () => ({}) as never,
    });

    const oldConnect = manager.connect('generation', { type: 'stdio', command: 'old' }, 1);
    const replacement = manager.reconnect('generation', { type: 'stdio', command: 'new' }, 2);
    await Bun.sleep(0);
    expect(firstCloses).toBe(1);
    secondGate.resolve();
    await replacement;
    firstGate.resolve();
    await oldConnect;

    expect(manager.getServerStates().get('generation')).toMatchObject({
      generation: 2,
      config: { command: 'new' },
      health: 'ready',
    });
    await manager.disconnectAll();
  });

  test('publishes a typed diagnostic when transport construction fails', async () => {
    const manager = new McpManager();
    await expect(
      manager.connect('invalid-url', { type: 'http', url: 'not a valid url' }, 1),
    ).rejects.toThrow();
    expect(manager.getServerStates().get('invalid-url')).toMatchObject({
      health: 'disconnected',
      diagnostic: { code: 'url_invalid', retryable: false },
    });
    await manager.disconnectAll();
  });

  test('keeps OAuth explicit, finishes the current callback, then rediscovers', async () => {
    let finishCode = '';
    const clients = [
      fakeClient({
        connect: async () => {
          throw new UnauthorizedError('Login required');
        },
      }),
      fakeClient({}),
    ];
    const manager = new McpManager({
      createClient: () => clients.shift()!,
      createTransport: (_config, authProvider) => {
        expect(authProvider).toBeDefined();
        return {
          finishAuth: async (code: string) => {
            finishCode = code;
          },
        } as never;
      },
    });
    const provider = {} as OAuthClientProvider;
    const config = { type: 'http' as const, url: 'https://mcp.example.com' };

    await expect(manager.beginOAuth('oauth', config, 9, provider)).resolves.toBe(
      'authorization_required',
    );
    expect(manager.getServerStates().get('oauth')).toMatchObject({
      health: 'disconnected',
      diagnostic: { code: 'auth_required' },
    });
    await manager.finishOAuth('oauth', 'authorization-code', 9);
    expect(finishCode).toBe('authorization-code');
    expect(manager.getServerStates().get('oauth')).toMatchObject({
      health: 'ready',
      generation: 9,
    });
    await manager.clearOAuth('oauth');
    expect(manager.getServerStates().has('oauth')).toBe(false);
  });

  test('records explicit local provenance when trusting read-only annotations', async () => {
    await manager.connect('trusted-fixture', {
      type: 'stdio',
      command: process.execPath,
      args: [resolve(import.meta.dir, 'fixtures/mcp-governance-server.ts')],
      trust: { provenance: 'admin', allowAnnotations: 'read_only' },
    });
    const descriptor = manager
      .getCapabilitySnapshot()
      .descriptors.find(
        (candidate) => candidate.capabilityId === 'mcp:trusted-fixture/read_fixture',
      );
    expect(descriptor?.provider.provenance).toBe('admin');
    expect(descriptor?.effectiveEffects.externalState).toBe('read');
    expect(descriptor?.policy.minimumApproval).toBe('user');
  });

  test('resolves a bearer credential reference only while constructing HTTP headers', async () => {
    const key: McpCredentialKey = {
      workspaceKey: 'workspace',
      source: 'user',
      server: 'bearer',
      profile: 'work-account',
    };
    const store = new MemoryMcpCredentialStore();
    await store.put(key, {
      version: 1,
      kind: 'bearer',
      secret: 'bearer-secret',
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    let observedAuthorization = '';
    const fixture = startTestHttpServer({
      fetch: async (request) => {
        observedAuthorization = request.headers.get('authorization') ?? observedAuthorization;
        if (observedAuthorization !== 'Bearer bearer-secret') {
          return new Response('Unauthorized', { status: 401 });
        }
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
                serverInfo: { name: 'bearer-fixture', version: '1.0.0' },
              }
            : message.method === 'tools/list'
              ? { tools: [] }
              : message.method === 'prompts/list'
                ? { prompts: [] }
                : { resources: [] };
        return Response.json({ jsonrpc: '2.0', id: message.id, result });
      },
    });
    const bearerManager = new McpManager({ credentialStore: store });
    try {
      await bearerManager.connect('bearer', {
        type: 'http',
        url: `${fixture.url.origin}/mcp`,
        auth: {
          type: 'credential',
          header: 'Authorization',
          credentialRef: 'work-account',
          scheme: 'Bearer',
        },
        credentialKey: key,
      });
      expect(observedAuthorization).toBe('Bearer bearer-secret');
      expect(JSON.stringify(bearerManager.getServerStates().get('bearer')?.config)).not.toContain(
        'bearer-secret',
      );
    } finally {
      await bearerManager.disconnectAll();
      fixture.stop(true);
    }
  });
});

function managerWithCall(
  toolName: string,
  callTool: (request: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>,
): McpManager {
  const client = {
    connect: async () => {},
    close: async () => {},
    listTools: async () => ({ tools: [{ name: toolName, inputSchema: { type: 'object' } }] }),
    listPrompts: async () => ({ prompts: [] }),
    listResources: async () => ({ resources: [] }),
    setNotificationHandler: () => {},
    callTool,
  } as unknown as Client;
  return new McpManager({
    createClient: () => client,
    createTransport: () => ({}) as never,
  });
}

function fakeClient(overrides: {
  connect?: () => Promise<void>;
  close?: () => Promise<unknown>;
}): Client {
  return {
    connect: overrides.connect ?? (async () => {}),
    close: overrides.close ?? (async () => {}),
    listTools: async () => ({ tools: [] }),
    listPrompts: async () => ({ prompts: [] }),
    listResources: async () => ({ resources: [] }),
    setNotificationHandler: () => {},
  } as unknown as Client;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
