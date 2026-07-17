import { afterEach, describe, expect, test } from 'bun:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import { createBinding } from '@/core/capabilities/catalog';
import {
  isMcpToolEnabled,
  McpManager,
  type McpServerConfig,
  resolveMcpToolPolicy,
} from '@/core/mcp';

describe('MCP Tool visibility and policy', () => {
  const managers: McpManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disconnectAll()));
  });

  test('applies allowlist, denylist, then exact enabled override precedence', () => {
    const config: McpServerConfig = {
      type: 'stdio',
      command: 'fixture',
      enabledTools: ['allowed', 'denied'],
      disabledTools: ['denied', 'reenabled'],
      tools: {
        denied: { enabled: true },
        reenabled: { enabled: true },
        outside: { enabled: false },
      },
    };

    expect(isMcpToolEnabled(config, 'allowed')).toBe(true);
    expect(isMcpToolEnabled(config, 'denied')).toBe(true);
    expect(isMcpToolEnabled(config, 'reenabled')).toBe(true);
    expect(isMcpToolEnabled(config, 'outside')).toBe(false);
    expect(isMcpToolEnabled(config, 'unspecified')).toBe(false);
  });

  test('records remote declarations without trusting them as effective effects', () => {
    const untrusted = resolveMcpToolPolicy(
      { type: 'stdio', command: 'fixture', tools: { read: { retry: 'safe_read' } } },
      { name: 'read', annotations: { readOnlyHint: true } },
    );
    expect(untrusted.declaredEffects).toEqual({
      filesystem: 'read',
      network: 'read',
      externalState: 'read',
    });
    expect(untrusted.effectiveEffects).toEqual({
      filesystem: 'unknown',
      network: 'unknown',
      externalState: 'unknown',
    });
    expect(untrusted.retry).toBe('never');

    const trusted = resolveMcpToolPolicy(
      {
        type: 'stdio',
        command: 'fixture',
        trust: { provenance: 'user', allowAnnotations: 'read_only' },
        tools: { read: { minimumApproval: 'none', retry: 'safe_read' } },
      },
      { name: 'read', annotations: { readOnlyHint: true } },
    );
    expect(trusted.annotationProvenance).toBe('user');
    expect(trusted.effectiveEffects).toEqual({
      filesystem: 'read',
      network: 'read',
      externalState: 'read',
    });
    expect(trusted.minimumApproval).toBe('none');
    expect(trusted.retry).toBe('safe_read');

    expect(
      resolveMcpToolPolicy(
        {
          type: 'stdio',
          command: 'fixture',
          tools: { write: { retry: 'idempotency_key' } },
        },
        { name: 'write' },
      ).retry,
    ).toBe('never');
    expect(
      resolveMcpToolPolicy(
        {
          type: 'stdio',
          command: 'fixture',
          tools: {
            write: {
              retry: 'idempotency_key',
              idempotencyKeyArgument: 'idempotency_key',
            },
          },
        },
        { name: 'write' },
      ),
    ).toMatchObject({
      retry: 'idempotency_key',
      idempotencyKeyArgument: 'idempotency_key',
    });
  });

  test('keeps all discovery data but publishes and calls only enabled schema-valid Tools', async () => {
    const calls: string[] = [];
    const manager = managerWithTools(
      [
        { name: 'allowed', inputSchema: { type: 'object' } },
        { name: 'disabled', inputSchema: { type: 'object' } },
        { name: 'invalid', inputSchema: { type: 'string' } } as unknown as SdkTool,
      ],
      async (request) => {
        calls.push((request as { name: string }).name);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );
    managers.push(manager);
    await manager.connect('fixture', {
      type: 'stdio',
      command: 'fixture',
      disabledTools: ['disabled'],
    });

    expect(
      manager
        .getServerStates()
        .get('fixture')
        ?.tools.map((tool) => tool.name),
    ).toEqual(['allowed', 'disabled', 'invalid']);
    expect(
      manager.getCapabilitySnapshot().descriptors.map((descriptor) => descriptor.capabilityId),
    ).toEqual(['mcp:fixture/allowed']);
    await expect(manager.callTool('fixture', 'disabled', {})).rejects.toMatchObject({
      name: 'McpProviderError',
      providerId: 'fixture',
      kind: 'provider_capability_changed',
    });
    await expect(manager.callTool('fixture', 'invalid', {})).rejects.toMatchObject({
      name: 'McpProviderError',
      providerId: 'fixture',
      kind: 'provider_capability_changed',
    });
    await expect(manager.callTool('fixture', 'allowed', {})).resolves.toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(calls).toEqual(['allowed']);
  });

  test('changes descriptor and catalog revisions so an old binding becomes stale', async () => {
    const manager = managerWithTools([{ name: 'read', inputSchema: { type: 'object' } }]);
    managers.push(manager);
    await manager.connect('fixture', {
      type: 'stdio',
      command: 'fixture',
      providerVersion: 'same-provider',
    });
    const beforeSnapshot = manager.getCapabilitySnapshot();
    const before = manager.findCapability('mcp:fixture/read')!;
    const binding = createBinding({
      descriptor: before,
      exposedToolName: 'mcp__fixture__read',
      turnId: 'turn-1',
    });

    await manager.reconnect(
      'fixture',
      {
        type: 'stdio',
        command: 'fixture',
        providerVersion: 'same-provider',
        tools: {
          read: {
            effects: { filesystem: 'read', network: 'read', externalState: 'read' },
            minimumApproval: 'none',
          },
        },
      },
      2,
    );
    const afterSnapshot = manager.getCapabilitySnapshot();
    const after = manager.findCapability('mcp:fixture/read')!;

    expect(after.revision).not.toBe(binding.capabilityRevision);
    expect(afterSnapshot.revision).not.toBe(beforeSnapshot.revision);
    expect(after.policy.minimumApproval).toBe('none');
  });
});

function managerWithTools(
  tools: SdkTool[],
  callTool: (request: unknown) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }> = async () => ({ content: [{ type: 'text', text: 'ok' }] }),
): McpManager {
  const client = {
    connect: async () => {},
    close: async () => {},
    listTools: async () => ({ tools }),
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
