import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createBinding, descriptorRevision } from '@/core/capabilities/catalog';
import type { AgentConfig } from '@/core/config';
import { mcpServerSchema } from '@/core/config/mcp-server-config';
import {
  classifyRemoteMcpArgumentsV1,
  createRemoteMcpEgressPermitV1,
  type McpCapabilityRouteV1,
  RemoteMcpEgressDeniedError,
  RemoteMcpEgressPermitLedgerV1,
  type RemoteMcpEgressPermitRequestV1,
  remoteMcpArgumentDigestV1,
  resolveMcpContentEgressPolicyV1,
  snapshotRemoteMcpArgumentsV1,
} from '@/core/mcp';
import { McpConnectionManager } from '@/core/mcp/manager';
import { exposedMcpToolName } from '@/core/mcp/tool-adapter';
import type { RuntimeEvent } from '@/core/runtime/events';
import { createRuntimeEffectExecutor } from '@/core/runtime/executor';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import type { CapabilityDescriptor } from '@/protocol/capabilities';
import { executeTestRuntimeToolsV1 as executeRuntimeTools } from '../helpers/runtime-model';

function canonicalMcpDescriptor(
  input: Omit<CapabilityDescriptor, 'revision'> & { revision?: string },
): CapabilityDescriptor {
  const { revision: _ignored, ...withoutRevision } = input;
  return { ...withoutRevision, revision: descriptorRevision(withoutRevision) };
}

function issueMcpBinding(
  state: ReturnType<typeof createInitialRuntimeState>,
  descriptor: CapabilityDescriptor,
  exposedToolName: string,
) {
  const binding = createBinding({ descriptor, exposedToolName, turnId: state.turn.turnId });
  state.capabilities.bindings[binding.bindingId] = binding;
  return binding;
}

async function remoteManager(input: { readOnly?: boolean } = {}) {
  let requests = 0;
  const receivedArguments: Record<string, unknown>[] = [];
  const client = {
    connect: async () => {},
    close: async () => {},
    listTools: async () => ({
      tools: [
        {
          name: 'search',
          inputSchema: { type: 'object' },
          ...(input.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        },
      ],
    }),
    listPrompts: async () => ({ prompts: [] }),
    listResources: async () => ({ resources: [] }),
    setNotificationHandler: () => {},
    callTool: async (request: { arguments?: Record<string, unknown> }) => {
      requests += 1;
      receivedArguments.push(request.arguments ?? {});
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as Client;
  const manager = new McpConnectionManager({
    createClient: () => client,
    createTransport: () => ({}) as never,
    remoteMcpEgressPolicyRequired: true,
    remoteMcpEgressPermitLedger: new RemoteMcpEgressPermitLedgerV1(),
  });
  await manager.connect('docs', {
    type: 'http',
    url: 'https://mcp.example.test/rpc',
    providerVersion: 'endpoint-v1',
    tools: { search: { minimumApproval: 'none' } },
    ...(input.readOnly ? { trust: 'trusted' as const } : {}),
  });
  const descriptor = manager.findCapability('mcp:docs/search');
  if (!descriptor) throw new Error('fixture capability is missing');
  const route = manager.getCapabilityRoute(descriptor.capabilityId);
  if (!route) throw new Error('fixture route is missing');
  return {
    manager,
    descriptor,
    route,
    requests: () => requests,
    receivedArguments: () => receivedArguments,
  };
}

function permitRequest(input: {
  route: McpCapabilityRouteV1;
  invocationId?: string;
  toolCallId?: string;
  args: Record<string, unknown>;
}): RemoteMcpEgressPermitRequestV1 {
  return {
    ...input.route,
    invocationId: input.invocationId ?? 'invocation-1',
    toolCallId: input.toolCallId ?? 'tool-call-1',
    argumentDigest: remoteMcpArgumentDigestV1(input.args),
    content: classifyRemoteMcpArgumentsV1(input.args),
  };
}

function permitFor(request: RemoteMcpEgressPermitRequestV1, nonce = 'nonce-1') {
  const now = Date.now();
  return createRemoteMcpEgressPermitV1({
    request,
    nonce,
    approvedAt: new Date(now - 1_000),
    expiresAt: new Date(now + 60_000),
  });
}

describe('remote MCP data egress policy', () => {
  test('ToolController blocks secret and uninspectable arguments before permit resolution or provider readiness', async () => {
    const state = createInitialRuntimeState({
      threadId: 'remote-egress-controller',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization = { mode: 'full_access', commandGrants: {} };
    const descriptor = canonicalMcpDescriptor({
      capabilityId: 'mcp:docs/search',
      kind: 'mcp_tool' as const,
      displayName: 'search',
      description: 'fixture',
      provider: { type: 'mcp' as const, id: 'docs', provenance: 'remote' as const },
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      declaredEffects: {
        filesystem: 'read' as const,
        network: 'read' as const,
        externalState: 'read' as const,
      },
      effectiveEffects: {
        filesystem: 'read' as const,
        network: 'read' as const,
        externalState: 'read' as const,
      },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' as const },
      availability: 'available' as const,
      diagnostics: [],
    });
    const exposedName = exposedMcpToolName('docs', 'search');
    const binding = issueMcpBinding(state, descriptor, exposedName);
    state.tools.calls.remote = {
      toolCallId: 'remote',
      modelMessageId: 'model',
      name: exposedName,
      args: { token: 123456 },
      status: 'queued',
      bindingId: binding.bindingId,
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('remote');
    let readinessCalls = 0;
    let protocolCalls = 0;
    let permitResolverCalls = 0;
    const receipts: Array<{ reason: string }> = [];
    const config: AgentConfig = {
      apiKey: 'test',
      baseURL: 'https://model.example.test',
      modelName: 'model',
      providerName: 'provider',
      providerType: 'openai-compatible',
      sandbox: { enabled: false },
      features: {
        capabilityCatalogV1: true,
        mcpRuntimeBindingV1: true,
        providerDataPolicyV1: true,
        remoteMcpEgressPolicyV1: true,
      },
    };
    const mcpManager = {
      getCapabilitySnapshot: () => ({ revision: 'snapshot', descriptors: [descriptor] }),
      getProviderDirectorySnapshot: () => ({ revision: 'directory', entries: [] }),
      getResourceDirectorySnapshot: () => ({ revision: 'resources', resources: [] }),
      findCapability: () => descriptor,
      getCapabilityRoute: () => ({
        transport: 'http' as const,
        serverIdentity: 'docs',
        endpointRevision: 'endpoint-v1',
        toolRevision: descriptor.revision,
      }),
      ensureProviderReady: async () => {
        readinessCalls += 1;
      },
      callCapability: async () => {
        protocolCalls += 1;
        return { content: [] };
      },
      readResource: async () => '',
    };
    for (const [reason, args] of [
      ['secret_detected', { token: 123456 }],
      ['content_inspection_unknown', { ['x'.repeat(1_000_001)]: true }],
    ] as const) {
      state.tools.calls.remote!.args = args;
      const events = await executeRuntimeTools({
        state,
        toolCallIds: ['remote'],
        taskConfig: config,
        providerDataAdmission: () => ({
          admitted: true,
          reason: 'admitted',
          routeAlias: 'model-provider-consent',
        }),
        remoteMcpEgressPermitResolver: (request) => {
          permitResolverCalls += 1;
          return permitFor(request, 'must-not-be-issued');
        },
        mcpManager,
        recordRemoteMcpEgressDecision: (receipt) => {
          receipts.push(receipt);
        },
      });
      expect(receipts.at(-1)).toMatchObject({ reason });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.rejected',
          failure: expect.objectContaining({ kind: 'policy_denied' }),
        }),
      );
    }

    state.tools.calls.remote!.args = { payload: new Date('2026-08-01T00:00:00.000Z') };
    const nonCanonicalEvents = await executeRuntimeTools({
      state,
      toolCallIds: ['remote'],
      taskConfig: config,
      mcpManager,
      recordRemoteMcpEgressDecision: (receipt) => {
        receipts.push(receipt);
      },
    });
    expect(nonCanonicalEvents).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        failure: expect.objectContaining({ kind: 'tool_invalid_args' }),
      }),
    );

    expect(readinessCalls).toBe(0);
    expect(protocolCalls).toBe(0);
    expect(permitResolverCalls).toBe(0);
    expect(receipts).toHaveLength(2);
  });

  test('disabled rollout and missing permits deny content before the protocol request', async () => {
    const { manager, descriptor, route, requests } = await remoteManager();
    const args = { query: 'confidential workspace notes' };
    const request = permitRequest({ route, args });

    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: args,
      }),
    ).rejects.toMatchObject({ receipt: { reason: 'receipt_persistence_failed' } });
    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: args,
        remoteEgress: {
          enabled: false,
          invocationId: request.invocationId,
          toolCallId: request.toolCallId,
          content: request.content,
          recordDecision: () => {},
        },
      }),
    ).rejects.toMatchObject({ receipt: { reason: 'feature_disabled' } });
    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: args,
        remoteEgress: {
          enabled: true,
          invocationId: 'invocation-2',
          toolCallId: 'tool-call-2',
          content: request.content,
          recordDecision: () => {},
        },
      }),
    ).rejects.toMatchObject({ receipt: { reason: 'permit_missing' } });
    expect(requests()).toBe(0);
  });

  test.each([
    ['secret_detected', { token: 'ghp_1234567890abcdefghijklmnop' }],
    ['secret_detected', { password: 1234 }],
    ['secret_detected', { path: '/workspace/.ssh/id_ed25519' }],
    ['content_inspection_unknown', { ['x'.repeat(1_000_001)]: true }],
    ['content_inspection_unknown', { payload: new Date('2026-08-01T00:00:00.000Z') }],
    ['content_inspection_unknown', { payload: 'x'.repeat(1_000_001) }],
  ] as const)('Manager blocks %s arguments before ledger consumption and protocol dispatch', async (reason, args) => {
    const { manager, descriptor, route, requests } = await remoteManager();
    const request = permitRequest({ route, args });
    const receipts: Array<{ reason: string }> = [];

    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: args,
        remoteEgress: {
          enabled: true,
          invocationId: request.invocationId,
          toolCallId: request.toolCallId,
          content: request.content,
          permit: permitFor(request, `blocked-${reason}`),
          recordDecision: (receipt) => {
            receipts.push(receipt);
          },
        },
      }),
    ).rejects.toMatchObject({ receipt: { reason } });
    expect(receipts).toMatchObject([{ reason }]);
    expect(requests()).toBe(0);
    await manager.disconnectAll();
  });

  test('ToolController resolves and consumes one exact permit through the real HTTP manager', async () => {
    const { manager, descriptor, requests, receivedArguments } = await remoteManager({
      readOnly: true,
    });
    const state = createInitialRuntimeState({
      threadId: 'remote-egress-allowed',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization = { mode: 'full_access', commandGrants: {} };
    const exposedName = exposedMcpToolName('docs', 'search');
    const binding = issueMcpBinding(state, descriptor, exposedName);
    const originalArguments = { query: 'workspace content' };
    state.tools.calls.remote = {
      toolCallId: 'remote',
      modelMessageId: 'model',
      name: exposedName,
      args: originalArguments,
      status: 'queued',
      bindingId: binding.bindingId,
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('remote');
    const receipts: Array<{ reason: string; nonceDigest?: string }> = [];
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['remote'],
      mcpManager: manager,
      taskConfig: {
        apiKey: 'test',
        baseURL: 'https://model.example.test',
        modelName: 'model',
        providerName: 'provider',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          remoteMcpEgressPolicyV1: true,
        },
      },
      remoteMcpEgressPermitResolver: (request) => {
        const permit = permitFor(request, 'controller-nonce');
        originalArguments.query = 'api_key=sk-mutated-during-resolver-123456789';
        return permit;
      },
      recordRemoteMcpEgressDecision: (receipt) => {
        receipts.push(receipt);
      },
    });

    expect(requests()).toBe(1);
    expect(receivedArguments()).toEqual([{ query: 'workspace content' }]);
    expect(receipts).toMatchObject([{ reason: 'permit_consumed' }]);
    expect(receipts[0]?.nonceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.finished' }));
  });

  test('Manager dispatches the exact immutable argument snapshot bound to the permit', async () => {
    const { manager, descriptor, route, requests, receivedArguments } = await remoteManager({
      readOnly: true,
    });
    const args = { payload: { query: 'safe before authorization' } };
    const request = permitRequest({ route, args });
    const receipts: Array<{ reason: string; argumentDigest: string }> = [];

    await manager.callCapability({
      capabilityId: descriptor.capabilityId,
      expectedRevision: descriptor.revision,
      arguments: args,
      remoteEgress: {
        enabled: true,
        invocationId: request.invocationId,
        toolCallId: request.toolCallId,
        content: request.content,
        permit: permitFor(request, 'snapshot-toctou'),
        recordDecision: (receipt) => {
          receipts.push(receipt);
          args.payload.query = 'api_key=sk-mutated-after-permit-123456789';
        },
      },
    });

    expect(requests()).toBe(1);
    expect(receivedArguments()).toEqual([{ payload: { query: 'safe before authorization' } }]);
    expect(receipts).toMatchObject([{ reason: 'permit_consumed' }]);
    expect(receipts[0]?.argumentDigest).toBe(remoteMcpArgumentDigestV1(receivedArguments()[0]!));
    await manager.disconnectAll();
  });

  test('argument snapshot rejects custom serialization, accessors, symbols and cycles', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'query', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'secret';
      },
    });
    const withSymbol = { query: 'safe', [Symbol('hidden')]: 'secret' };
    const nonEnumerable = Object.defineProperty({ query: 'safe' }, 'hidden', {
      enumerable: false,
      value: 'secret',
    });
    const cyclic: Record<string, unknown> = { query: 'safe' };
    cyclic.self = cyclic;

    for (const value of [
      accessor,
      withSymbol,
      nonEnumerable,
      cyclic,
      { query: 'safe', toJSON: () => ({ query: 'changed' }) },
      { payload: new Date('2026-08-01T00:00:00.000Z') },
      { payload: new Map([['query', 'safe']]) },
    ]) {
      expect(snapshotRemoteMcpArgumentsV1(value)).toEqual({ ok: false });
    }
    expect(getterCalls).toBe(0);
  });

  test('read-only effects and model-provider consent cannot substitute for an egress permit', async () => {
    const { manager, descriptor, route, requests } = await remoteManager({ readOnly: true });
    expect(descriptor.effectiveEffects).toEqual({
      filesystem: 'read',
      network: 'read',
      externalState: 'read',
    });
    const args = { query: 'workspace content' };
    const request = permitRequest({ route, args });
    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: args,
        remoteEgress: {
          enabled: true,
          invocationId: request.invocationId,
          toolCallId: request.toolCallId,
          content: request.content,
          // There is deliberately no Provider-consent field in this contract.
          recordDecision: () => {},
        },
      }),
    ).rejects.toBeInstanceOf(RemoteMcpEgressDeniedError);
    expect(requests()).toBe(0);
  });

  test('project/server policy cannot lower non-empty arguments below confidential', () => {
    const parsedProjectConfig = mcpServerSchema.parse({
      type: 'http',
      url: 'https://mcp.example.test',
      dataClassification: 'public',
    });
    expect('dataClassification' in parsedProjectConfig).toBe(false);
    expect(resolveMcpContentEgressPolicyV1('http', { query: 'content' })).toEqual({
      transport: 'http',
      sendsContent: true,
      requiresIndependentPermit: true,
      content: {
        dataClassifications: ['confidential'],
        payloadKinds: ['user_prompt', 'file_snippet', 'tool_result'],
      },
    });
    expect(resolveMcpContentEgressPolicyV1('stdio', { query: 'content' })).toEqual({
      transport: 'stdio',
      sendsContent: false,
      requiresIndependentPermit: false,
      content: { dataClassifications: [], payloadKinds: [] },
    });
  });

  test('content-free remote calls are permit-free and still produce a redacted receipt', async () => {
    const { manager, descriptor, requests } = await remoteManager();
    const receipts: Array<{ reason: string; argumentDigest: string }> = [];
    await manager.callCapability({
      capabilityId: descriptor.capabilityId,
      expectedRevision: descriptor.revision,
      arguments: {},
      remoteEgress: {
        enabled: false,
        invocationId: 'content-free',
        toolCallId: 'content-free-call',
        content: classifyRemoteMcpArgumentsV1({}),
        recordDecision: (receipt) => {
          receipts.push(receipt);
        },
      },
    });
    expect(requests()).toBe(1);
    expect(receipts).toMatchObject([
      {
        reason: 'content_free',
        argumentDigest: remoteMcpArgumentDigestV1({}),
      },
    ]);
    expect(JSON.stringify(receipts)).not.toContain('query');
  });

  test.each([
    [
      'argument_digest_mismatch',
      (permit: ReturnType<typeof permitFor>) => ({ ...permit, argumentDigest: 'changed' }),
    ],
    [
      'endpoint_revision_mismatch',
      (permit: ReturnType<typeof permitFor>) => ({ ...permit, endpointRevision: 'changed' }),
    ],
    [
      'tool_revision_mismatch',
      (permit: ReturnType<typeof permitFor>) => ({ ...permit, toolRevision: 'changed' }),
    ],
  ] as const)('%s produces zero protocol requests', async (reason, mutate) => {
    const { manager, descriptor, route, requests } = await remoteManager();
    const args = { query: 'content' };
    const request = permitRequest({ route, args });
    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: args,
        remoteEgress: {
          enabled: true,
          invocationId: request.invocationId,
          toolCallId: request.toolCallId,
          content: request.content,
          permit: mutate(permitFor(request)),
          recordDecision: () => {},
        },
      }),
    ).rejects.toMatchObject({ receipt: { reason } });
    expect(requests()).toBe(0);
  });

  test('expired permits and receipt persistence failure fail closed before dispatch', async () => {
    const { manager, descriptor, route, requests } = await remoteManager();
    const args = { query: 'content' };
    const request = permitRequest({ route, args });
    const now = Date.now();
    const expired = createRemoteMcpEgressPermitV1({
      request,
      nonce: 'expired',
      approvedAt: new Date(now - 120_000),
      expiresAt: new Date(now - 60_000),
    });
    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: args,
        remoteEgress: {
          enabled: true,
          invocationId: request.invocationId,
          toolCallId: request.toolCallId,
          content: request.content,
          permit: expired,
          recordDecision: () => {},
        },
      }),
    ).rejects.toMatchObject({ receipt: { reason: 'permit_expired' } });

    const persistenceRequest = permitRequest({
      route,
      args,
      invocationId: 'persistence',
      toolCallId: 'persistence-call',
    });
    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: args,
        remoteEgress: {
          enabled: true,
          invocationId: persistenceRequest.invocationId,
          toolCallId: persistenceRequest.toolCallId,
          content: persistenceRequest.content,
          permit: permitFor(persistenceRequest, 'persistence'),
          recordDecision: () => {
            throw new Error('store unavailable');
          },
        },
      }),
    ).rejects.toMatchObject({ receipt: { reason: 'receipt_persistence_failed' } });
    expect(requests()).toBe(0);
  });

  test('rejects excessive TTL and malformed resolver output with a typed receipt', async () => {
    const { manager, descriptor, route, requests } = await remoteManager();
    const args = { query: 'content' };
    const request = permitRequest({ route, args });
    const now = Date.now();
    expect(() =>
      createRemoteMcpEgressPermitV1({
        request,
        approvedAt: new Date(now),
        expiresAt: new Date(now + 5 * 60_000 + 1),
      }),
    ).toThrow('TTL');

    const malformed = { version: 1, nonce: 'malformed' } as never;
    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: args,
        remoteEgress: {
          enabled: true,
          invocationId: request.invocationId,
          toolCallId: request.toolCallId,
          content: request.content,
          permit: malformed,
          recordDecision: () => {},
        },
      }),
    ).rejects.toMatchObject({ receipt: { reason: 'permit_invalid' } });

    const nonCanonicalTimestamp = {
      ...permitFor(request, 'non-canonical-date'),
      expiresAt: new Date(Date.now() + 60_000).toUTCString(),
    };
    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: args,
        remoteEgress: {
          enabled: true,
          invocationId: request.invocationId,
          toolCallId: request.toolCallId,
          content: request.content,
          permit: nonCanonicalTimestamp,
          recordDecision: () => {},
        },
      }),
    ).rejects.toMatchObject({ receipt: { reason: 'permit_invalid' } });
    expect(requests()).toBe(0);
  });

  test('a reopened Runtime Store rejects permit replay before a second Manager dispatch', async () => {
    const path = join(tmpdir(), `kite-mcp-egress-replay-${crypto.randomUUID()}.db`);
    const first = await remoteManager({ readOnly: true });
    const args = { query: 'content' };
    const request = permitRequest({ route: first.route, args });
    const permit = permitFor(request, 'durable-restart-nonce');
    let store = createRuntimeStore(path);
    const record = (decision: import('@/core/mcp').RemoteMcpEgressReceiptV1) => {
      store.appendEvents('durable-egress', [
        { type: 'mcp.egress_decided', toolCallId: decision.toolCallId, decision },
      ]);
    };

    try {
      await first.manager.callCapability({
        capabilityId: first.descriptor.capabilityId,
        expectedRevision: first.descriptor.revision,
        arguments: args,
        remoteEgress: {
          enabled: true,
          invocationId: request.invocationId,
          toolCallId: request.toolCallId,
          content: request.content,
          permit,
          recordDecision: record,
        },
      });
      expect(first.requests()).toBe(1);
      store.close();

      const second = await remoteManager({ readOnly: true });
      store = createRuntimeStore(path);
      try {
        await expect(
          second.manager.callCapability({
            capabilityId: second.descriptor.capabilityId,
            expectedRevision: second.descriptor.revision,
            arguments: args,
            remoteEgress: {
              enabled: true,
              invocationId: request.invocationId,
              toolCallId: request.toolCallId,
              content: request.content,
              permit,
              recordDecision: record,
            },
          }),
        ).rejects.toMatchObject({ receipt: { reason: 'receipt_persistence_failed' } });
        expect(second.requests()).toBe(0);
        expect(store.loadEventsStrict('durable-egress')).toHaveLength(1);
      } finally {
        await second.manager.disconnectAll();
      }
    } finally {
      await first.manager.disconnectAll();
      store.close();
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });

  test('production Runtime persists a replay denial after a durable nonce conflict', async () => {
    const path = join(tmpdir(), `kite-mcp-egress-runtime-replay-${crypto.randomUUID()}.db`);
    const config: AgentConfig = {
      apiKey: 'test',
      baseURL: 'https://model.example.test',
      modelName: 'model',
      providerName: 'provider',
      providerType: 'openai-compatible',
      sandbox: { enabled: false },
      features: {
        capabilityCatalogV1: true,
        mcpRuntimeBindingV1: true,
        remoteMcpEgressPolicyV1: true,
      },
    };
    const executeOnce = async (
      managerFixture: Awaited<ReturnType<typeof remoteManager>>,
      store: ReturnType<typeof createRuntimeStore>,
      threadId: string,
    ) => {
      const { manager, descriptor } = managerFixture;
      const state = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: process.cwd(),
      });
      state.authorization = { mode: 'full_access', commandGrants: {} };
      const exposedName = exposedMcpToolName('docs', 'search');
      const binding = issueMcpBinding(state, descriptor, exposedName);
      state.tools.calls.remote = {
        toolCallId: 'remote',
        modelMessageId: 'model',
        name: exposedName,
        args: { query: 'workspace content' },
        status: 'queued',
        bindingId: binding.bindingId,
        capabilityId: descriptor.capabilityId,
        capabilityRevision: descriptor.revision,
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('remote');
      const executor = createRuntimeEffectExecutor({
        config,
        model: {} as never,
        mcpManager: manager,
        remoteMcpEgressPermitResolver: (request) =>
          permitFor(request, 'production-durable-replay-nonce'),
      });
      const emitted: RuntimeEvent[] = [];
      let runtimeState = state;
      const terminal = await executor(
        { type: 'run_tools', toolCallIds: ['remote'] },
        state,
        (event) => emitted.push(event),
        {
          reservationIds: [],
          getState: () => runtimeState,
          persistEvent: async (event) => {
            store.appendEvents(threadId, [event]);
            runtimeState = reduceRuntimeState(runtimeState, event);
            return true;
          },
          persistEvents: async (events) => {
            store.appendEvents(threadId, events);
            for (const event of events) runtimeState = reduceRuntimeState(runtimeState, event);
            return true;
          },
        },
      );
      return [...emitted, ...terminal];
    };

    const first = await remoteManager({ readOnly: true });
    let store = createRuntimeStore(path);
    try {
      const firstEvents = await executeOnce(first, store, 'runtime-replay-first');
      expect(first.requests()).toBe(1);
      expect(firstEvents).toContainEqual(expect.objectContaining({ type: 'tool.finished' }));
      await first.manager.disconnectAll();
      store.close();

      const second = await remoteManager({ readOnly: true });
      store = createRuntimeStore(path);
      try {
        const secondEvents = await executeOnce(second, store, 'runtime-replay-second');
        expect(second.requests()).toBe(0);
        expect(secondEvents).toContainEqual(
          expect.objectContaining({
            type: 'tool.failed',
            failure: expect.objectContaining({ kind: 'policy_denied' }),
          }),
        );
        expect(
          store
            .loadEventsStrict('runtime-replay-second')
            .filter((entry) => entry.event.type === 'mcp.egress_decided'),
        ).toMatchObject([{ event: { decision: { admitted: false, reason: 'permit_replayed' } } }]);
      } finally {
        await second.manager.disconnectAll();
      }
    } finally {
      await first.manager.disconnectAll();
      store.close();
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });
});
