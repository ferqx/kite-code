import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpManager } from '@/core/mcp';
import { normalizeMcpToolResult } from '@/core/mcp/result-normalizer';

describe('McpManager governance fixture', () => {
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

  test('opens a health circuit after repeated provider failures and fails closed', async () => {
    const manager = managerWithCall(async () => {
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
    const manager = managerWithCall(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient failure');
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const args = { id: 'same-input' };
    await manager.connect('retrying', {
      type: 'stdio',
      command: 'fixture',
      tools: { retry_fixture: { retry: 'safe_read' } },
    });
    await expect(manager.callTool('retrying', 'retry_fixture', args)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(calls).toBe(2);
    expect(args).toEqual({ id: 'same-input' });
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
});

function managerWithCall(
  callTool: (request: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>,
): McpManager {
  const client = {
    connect: async () => {},
    close: async () => {},
    listTools: async () => ({ tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] }),
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
