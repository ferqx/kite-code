import { afterEach, describe, expect, test } from 'bun:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpConnectionManager } from '@/core/mcp/manager';
import type {
  McpWriteDispatchGuardV1,
  McpWriteDispatchRequestV1,
} from '@/core/mcp/write-governance';

describe('MCP write dispatch governance integration', () => {
  const managers: McpConnectionManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disconnectAll()));
  });

  test('blocks before provider dispatch when a production write guard is absent', async () => {
    let providerCalls = 0;
    const manager = managerWithWriteTool(
      async () => {
        providerCalls += 1;
        return { content: [{ type: 'text', text: 'unexpected' }] };
      },
      { mcpWriteGovernanceRequired: true },
    );
    managers.push(manager);
    await connect(manager);

    await expect(
      manager.callTool('fixture', 'write_fixture', { value: 'secret-free' }),
    ).rejects.toMatchObject({
      name: 'McpWriteGovernanceErrorV1',
      reasonCode: 'production_write_guard_unconfigured',
    });
    expect(providerCalls).toBe(0);
  });

  test('persists admission before dispatch and records only a digest after success', async () => {
    const order: string[] = [];
    const requests: McpWriteDispatchRequestV1[] = [];
    const outcomes: Array<{ outcome: string; providerReceiptDigest: string | null }> = [];
    const guard: McpWriteDispatchGuardV1 = {
      async beforeDispatch(request) {
        order.push('intent');
        requests.push(request);
        return {
          admitted: true,
          invocationId: 'invocation-1',
          routeDigest: 'route-digest',
          intentDigest: 'intent-digest',
        };
      },
      async recordOutcome(input) {
        order.push('receipt');
        outcomes.push({
          outcome: input.outcome,
          providerReceiptDigest: input.providerReceiptDigest,
        });
      },
    };
    const manager = managerWithWriteTool(
      async () => {
        order.push('provider');
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      { mcpWriteGovernanceRequired: true, mcpWriteDispatchGuard: guard },
    );
    managers.push(manager);
    await connect(manager);

    await callGovernedWrite(manager, { value: 'safe' });
    expect(order).toEqual(['intent', 'provider', 'receipt']);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      capabilityId: 'mcp:fixture/write_fixture',
      providerIdentity: 'fixture',
      serverIdentity: 'fixture',
      toolName: 'write_fixture',
      userApprovalReceiptDigest: 'sha256:user-approval',
      providerDataPolicyRevision: 'fixture-policy-v1',
      providerDataPolicyReceiptDigest: 'sha256:provider-policy',
      transportAdmissionReceiptDigest: null,
      remoteEgressReceiptDigest: null,
    });
    expect(requests[0]).not.toHaveProperty('arguments');
    expect(outcomes).toEqual([{ outcome: 'succeeded', providerReceiptDigest: expect.any(String) }]);
  });

  test('records an unknown external outcome and fails closed when receipt persistence fails', async () => {
    const outcomes: string[] = [];
    const guard: McpWriteDispatchGuardV1 = {
      async beforeDispatch() {
        return {
          admitted: true,
          invocationId: 'invocation-2',
          routeDigest: 'route-digest',
          intentDigest: 'intent-digest',
        };
      },
      async recordOutcome(input) {
        outcomes.push(input.outcome);
        throw new Error('store unavailable');
      },
    };
    const manager = managerWithWriteTool(
      async () => {
        throw new Error('provider disconnected after dispatch');
      },
      { mcpWriteGovernanceRequired: true, mcpWriteDispatchGuard: guard },
    );
    managers.push(manager);
    await connect(manager);

    await expect(callGovernedWrite(manager, {})).rejects.toMatchObject({
      name: 'McpWriteGovernanceErrorV1',
      reasonCode: 'write_receipt_persistence_failed',
    });
    expect(outcomes).toEqual(['unknown']);
  });

  test('records protocol-level tool errors as unknown external outcomes', async () => {
    const outcomes: string[] = [];
    const guard: McpWriteDispatchGuardV1 = {
      async beforeDispatch() {
        return {
          admitted: true,
          invocationId: 'invocation-3',
          routeDigest: 'route-digest',
          intentDigest: 'intent-digest',
        };
      },
      async recordOutcome(input) {
        outcomes.push(input.outcome);
      },
    };
    const manager = managerWithWriteTool(
      async () => ({ isError: true, content: [{ type: 'text', text: 'provider rejected' }] }),
      { mcpWriteGovernanceRequired: true, mcpWriteDispatchGuard: guard },
    );
    managers.push(manager);
    await connect(manager);

    await callGovernedWrite(manager, {});
    expect(outcomes).toEqual(['unknown']);
  });

  test('blocks before provider dispatch when required invocation facts are absent', async () => {
    let providerCalls = 0;
    const guard: McpWriteDispatchGuardV1 = {
      async beforeDispatch() {
        throw new Error('must not be reached');
      },
      async recordOutcome() {},
    };
    const manager = managerWithWriteTool(
      async () => {
        providerCalls += 1;
        return { content: [{ type: 'text', text: 'unexpected' }] };
      },
      { mcpWriteGovernanceRequired: true, mcpWriteDispatchGuard: guard },
    );
    managers.push(manager);
    await connect(manager);

    await expect(manager.callTool('fixture', 'write_fixture', {})).rejects.toMatchObject({
      name: 'McpWriteGovernanceErrorV1',
      reasonCode: 'write_governance_facts_missing',
    });
    expect(providerCalls).toBe(0);
  });
});

function managerWithWriteTool(
  callTool: () => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>,
  options: {
    mcpWriteGovernanceRequired: true;
    mcpWriteDispatchGuard?: McpWriteDispatchGuardV1;
  },
): McpConnectionManager {
  const client = {
    connect: async () => {},
    close: async () => {},
    listTools: async () => ({
      tools: [
        {
          name: 'write_fixture',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: false },
        },
      ],
    }),
    listPrompts: async () => ({ prompts: [] }),
    listResources: async () => ({ resources: [] }),
    setNotificationHandler: () => {},
    callTool,
  } as unknown as Client;
  return new McpConnectionManager({
    createClient: () => client,
    createTransport: () => ({}) as never,
    ...options,
  });
}

async function callGovernedWrite(
  manager: McpConnectionManager,
  arguments_: Record<string, unknown>,
): Promise<void> {
  const descriptor = manager.findCapability('mcp:fixture/write_fixture');
  if (!descriptor) throw new Error('Fixture write capability is missing.');
  await manager.callCapability({
    capabilityId: descriptor.capabilityId,
    expectedRevision: descriptor.revision,
    arguments: arguments_,
    writeGovernance: {
      userApprovalReceiptDigest: 'sha256:user-approval',
      providerDataPolicyRevision: 'fixture-policy-v1',
      providerDataPolicyReceiptDigest: 'sha256:provider-policy',
    },
  });
}

async function connect(manager: McpConnectionManager): Promise<void> {
  await manager.connect('fixture', {
    type: 'stdio',
    command: 'fixture',
    tools: {
      write_fixture: {
        effects: { filesystem: 'none', network: 'write', externalState: 'write' },
        minimumApproval: 'user',
      },
    },
  });
}
