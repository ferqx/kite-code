import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { McpManager } from '@/core/mcp';
import { normalizeMcpToolResult } from '@/core/mcp/result-normalizer';
import type { McpServerState } from '@/core/mcp/types';

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
    const manager = new McpManager();
    const failingState: McpServerState = {
      config: { type: 'stdio' },
      client: {
        callTool: async () => {
          throw new Error('fixture unavailable');
        },
      },
      tools: [],
      prompts: [],
      resources: [],
      health: 'ready',
      consecutiveCallFailures: 0,
    };
    manager.getServerStates().set('failing', failingState);

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(manager.callTool('failing', 'write', {})).rejects.toThrow('fixture unavailable');
    }
    expect(failingState.health).toBe('circuit_open');
    expect(failingState.retryAt).toBeGreaterThan(Date.now());
    await expect(manager.callTool('failing', 'write', {})).rejects.toThrow('circuit is open');
  });

  test('retries only an explicitly configured safe read with unchanged arguments', async () => {
    const manager = new McpManager();
    let calls = 0;
    const args = { id: 'same-input' };
    manager.getServerStates().set('retrying', {
      config: { type: 'stdio', tools: { read: { retry: 'safe_read' } } },
      client: {
        callTool: async () => {
          calls += 1;
          if (calls === 1) throw new Error('transient failure');
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
      tools: [],
      prompts: [],
      resources: [],
      health: 'ready',
      consecutiveCallFailures: 0,
    });
    await expect(manager.callTool('retrying', 'read', args)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(calls).toBe(2);
    expect(args).toEqual({ id: 'same-input' });
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
