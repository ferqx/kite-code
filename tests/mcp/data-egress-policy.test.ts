import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeAgentEvent, type RuntimeEvent } from '@kite/agent-kernel';
import { createCapabilityBindingV1, descriptorRevisionV1 } from '@kite/builtin-runtime';
import {
  classifyRemoteMcpArgumentsV1,
  createRemoteMcpEgressPermitV1,
  exposedMcpToolName,
  type McpCapabilityRouteV1,
  McpConnectionManager,
  RemoteMcpEgressDeniedError,
  RemoteMcpEgressPermitLedgerV1,
  type RemoteMcpEgressPermitRequestV1,
  remoteMcpArgumentDigestV1,
  resolveMcpContentEgressPolicyV1,
  snapshotRemoteMcpArgumentsV1,
} from '@kite/builtin-runtime/mcp';
import type { CapabilityDescriptor } from '@kite/runtime-contract';
import { createRuntimeHostState26InitialStateV1 } from '@kite/runtime-host';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AgentConfig } from '#app/config';
import { mcpServerSchema } from '#app/config/mcp-server-config';
import { reduceRuntimeState } from '#runtime-support/runtime-state26-reducer';
import { createAppRuntimeEffectExecutorV1 } from '../../apps/kite/src/bootstrap/runtime/runtime-effect-coordinator';
import { openState26Store5ForTestV1 } from '../../scripts/support/runtime-storage';
import { testRemoteMcpOriginFactsV1 } from '../helpers/mcp-egress';
import {
  executeTestRuntimeToolsV1,
  testBuiltinToolCatalogV1,
  testCapabilityArtifactWriterV1,
  testModelInvocationRuntimeV1,
  testRuntimeCapabilityExecutionPortV1,
  testToolPipelineCompositionV1,
} from '../helpers/runtime-model';

function canonicalMcpDescriptor(
  input: Omit<CapabilityDescriptor, 'revision'> & { revision?: string },
): CapabilityDescriptor {
  const { revision: _ignored, ...withoutRevision } = input;
  return { ...withoutRevision, revision: descriptorRevisionV1(withoutRevision) };
}

function issueMcpBinding(
  state: ReturnType<typeof createRuntimeHostState26InitialStateV1>,
  descriptor: CapabilityDescriptor,
  exposedToolName: string,
) {
  const binding = createCapabilityBindingV1({
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    exposedToolName,
    inputSchema: descriptor.inputSchema ?? {},
    turnId: state.turn.turnId,
  });
  state.capabilities.bindings[binding.bindingId] = binding;
  return binding;
}

function attachTestModelOrigins(
  state: ReturnType<typeof createRuntimeHostState26InitialStateV1>,
  toolCallId: string,
  content: ReturnType<typeof classifyRemoteMcpArgumentsV1>,
): void {
  const modelInvocationId = `model-${toolCallId}`;
  const { sourceOrigins } = testRemoteMcpOriginFactsV1(content);
  const surfaceArtifact = {
    artifactId: `artifact-${toolCallId}`,
    kind: 'model_surface' as const,
    integrityIdentifier: `sha256:${'a'.repeat(64)}`,
    byteLength: 1,
  };
  state.modelInvocations[modelInvocationId] = {
    invocationId: modelInvocationId,
    purpose: 'primary_agent',
    status: 'completed',
    surfaceArtifact,
    surfaceIntegrityIdentifier: surfaceArtifact.integrityIdentifier,
    routeFingerprint: `sha256:${'b'.repeat(64)}`,
    admission: {
      providerDataPolicyRevision: 'test-policy-v1',
      routeIdentityDigest: `sha256:${'c'.repeat(64)}`,
      payloadClassificationDigest: `sha256:${'d'.repeat(64)}`,
      admitted: true,
    },
    budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
    limits: { maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 1_000 },
    preparedStateRevision: state.revision,
    parentInvocationId: null,
    parentToolCallId: null,
    dataOrigins: sourceOrigins,
    egressOriginIds: sourceOrigins.map((origin) => origin.originId),
    egressAuthority: {
      egressId: `sha256:${'e'.repeat(64)}`,
      destination: {
        destinationId: 'model:test',
        kind: 'model',
        routeIdentity: 'test-model-route',
        nonceNamespace: 'model.egress.v1',
      },
      allowedClassifications: ['public', 'internal', 'confidential'],
      allowedOriginKinds: ['user'],
      invocationId: modelInvocationId,
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
    attempts: 1,
    responseArtifact: {
      artifactId: `response-${toolCallId}`,
      kind: 'model_response',
      integrityIdentifier: `hmac-sha256:${'f'.repeat(64)}`,
      byteLength: 1,
    },
    finishReason: 'tool_calls',
  };
  const call = state.tools.calls[toolCallId];
  if (!call) throw new Error(`Missing test ToolCall ${toolCallId}.`);
  state.tools.calls[toolCallId] = { ...call, modelInvocationId };
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
  const content = classifyRemoteMcpArgumentsV1(input.args);
  return {
    ...input.route,
    invocationId: input.invocationId ?? 'invocation-1',
    toolCallId: input.toolCallId ?? 'tool-call-1',
    argumentDigest: remoteMcpArgumentDigestV1(input.args),
    ...testRemoteMcpOriginFactsV1(content),
    content,
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
  test('ToolController supplies immutable policy facts without becoming a second egress decision owner', async () => {
    const state = createRuntimeHostState26InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
    state.tools.queue = [...state.tools.queue, 'remote'];
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
    for (const args of [{ token: 123456 }, { ['x'.repeat(1_000_001)]: true }] as const) {
      state.tools.calls.remote!.args = args;
      const events = await executeTestRuntimeToolsV1({
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
        sandboxAvailable: true,
        mcpManager,
        recordRemoteMcpEgressDecision: (receipt) => {
          receipts.push(receipt);
        },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.finished',
        }),
      );
    }

    state.tools.calls.remote!.args = { payload: new Date('2026-08-01T00:00:00.000Z') };
    const nonCanonicalEvents = await executeTestRuntimeToolsV1({
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

    expect(readinessCalls).toBe(2);
    expect(protocolCalls).toBe(2);
    expect(permitResolverCalls).toBe(2);
    expect(receipts).toHaveLength(0);
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
          ...testRemoteMcpOriginFactsV1(request.content),
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
          ...testRemoteMcpOriginFactsV1(request.content),
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
          ...testRemoteMcpOriginFactsV1(request.content),
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
    const state = createRuntimeHostState26InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
    state.tools.queue = [...state.tools.queue, 'remote'];
    attachTestModelOrigins(state, 'remote', classifyRemoteMcpArgumentsV1(originalArguments));
    const receipts: Array<{ reason: string; nonceDigest?: string }> = [];
    const events = await executeTestRuntimeToolsV1({
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
      sandboxAvailable: true,
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
        ...testRemoteMcpOriginFactsV1(request.content),
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
          ...testRemoteMcpOriginFactsV1(request.content),
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
        ...testRemoteMcpOriginFactsV1(classifyRemoteMcpArgumentsV1({})),
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
          ...testRemoteMcpOriginFactsV1(request.content),
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
          ...testRemoteMcpOriginFactsV1(request.content),
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
          ...testRemoteMcpOriginFactsV1(persistenceRequest.content),
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
          ...testRemoteMcpOriginFactsV1(request.content),
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
          ...testRemoteMcpOriginFactsV1(request.content),
          permit: nonCanonicalTimestamp,
          recordDecision: () => {},
        },
      }),
    ).rejects.toMatchObject({ receipt: { reason: 'permit_invalid' } });
    expect(requests()).toBe(0);
  });

  test('a reopened Runtime Store rejects permit replay before a second Manager dispatch', async () => {
    const path = join(process.cwd(), `.kite-mcp-egress-replay-${crypto.randomUUID()}.db`);
    const first = await remoteManager({ readOnly: true });
    const args = { query: 'content' };
    const request = permitRequest({ route: first.route, args });
    const permit = permitFor(request, 'durable-restart-nonce');
    let store = openState26Store5ForTestV1(path);
    let runtimeState = createRuntimeHostState26InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'durable-egress',
      userId: 'user',
      workspace: process.cwd(),
    });
    const record = (decision: import('@kite/builtin-runtime/mcp').RemoteMcpEgressReceiptV1) => {
      const event: RuntimeEvent = {
        type: 'mcp.egress_decided',
        toolCallId: decision.toolCallId,
        decision,
      };
      const revision = runtimeState.revision + 1;
      runtimeState = { ...runtimeState, revision };
      store.appendEventsAndSnapshot('durable-egress', [event], runtimeState, [
        { eventId: `durable-egress-event-${revision}`, revision },
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
          ...testRemoteMcpOriginFactsV1(request.content),
          permit,
          recordDecision: record,
        },
      });
      expect(first.requests()).toBe(1);
      store.close();

      const second = await remoteManager({ readOnly: true });
      store = openState26Store5ForTestV1(path);
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
              ...testRemoteMcpOriginFactsV1(request.content),
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
    const path = join(process.cwd(), `.kite-mcp-egress-runtime-replay-${crypto.randomUUID()}.db`);
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
      store: ReturnType<typeof openState26Store5ForTestV1>,
      threadId: string,
    ) => {
      const { manager, descriptor } = managerFixture;
      const state = createRuntimeHostState26InitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
      state.tools.queue = [...state.tools.queue, 'remote'];
      attachTestModelOrigins(
        state,
        'remote',
        classifyRemoteMcpArgumentsV1({ query: 'workspace content' }),
      );
      const modelInvocationRuntime = testModelInvocationRuntimeV1(process.cwd());
      const executor = createAppRuntimeEffectExecutorV1({
        config,
        model: {} as never,
        mcpManager: manager,
        capabilityExecution: testRuntimeCapabilityExecutionPortV1(),
        builtinToolCatalog: testBuiltinToolCatalogV1(),
        toolPipelineComposition: testToolPipelineCompositionV1(),
        capabilityArtifactStore: testCapabilityArtifactWriterV1(),
        modelEffectCoordinator: modelInvocationRuntime.modelEffects,
        sandboxBackend: 'seatbelt',
        remoteMcpEgressPermitResolver: (request) =>
          permitFor(request, 'production-durable-replay-nonce'),
      });
      const emitted: RuntimeEvent[] = [];
      let runtimeState = state;
      const persistBatch = async (events: RuntimeEvent[]) => {
        const metadata = [];
        let nextState = runtimeState;
        for (const event of events) {
          const previousRevision = nextState.revision;
          const occurredAt = new Date().toISOString();
          nextState = {
            ...reduceRuntimeState(
              nextState,
              normalizeAgentEvent(event, nextState, occurredAt) as RuntimeEvent,
            ),
            revision: previousRevision + 1,
          };
          metadata.push({
            eventId: `${threadId}-event-${nextState.revision}`,
            revision: nextState.revision,
            occurredAt,
          });
        }
        store.appendEventsAndSnapshot(threadId, events, nextState, metadata);
        runtimeState = nextState;
        return true;
      };
      const terminal = await executor(
        { type: 'run_tools', toolCallIds: ['remote'] },
        state,
        (event) => emitted.push(event),
        {
          reservationIds: [],
          getState: () => runtimeState,
          persistEvent: async (event) => persistBatch([event]),
          persistEvents: persistBatch,
          persistAttemptStartEvents: persistBatch,
          persistTerminalRecoveryEvents: persistBatch,
        },
      );
      return [...emitted, ...terminal];
    };

    const first = await remoteManager({ readOnly: true });
    let store = openState26Store5ForTestV1(path);
    try {
      const firstEvents = await executeOnce(first, store, 'runtime-replay-first');
      expect(first.requests()).toBe(1);
      expect(firstEvents).toEqual([]);
      expect(
        store.loadEventsStrict('runtime-replay-first').map((entry) => entry.event),
      ).toContainEqual(expect.objectContaining({ type: 'tool.finished' }));
      await first.manager.disconnectAll();
      store.close();

      const second = await remoteManager({ readOnly: true });
      store = openState26Store5ForTestV1(path);
      try {
        const secondEvents = await executeOnce(second, store, 'runtime-replay-second');
        expect(second.requests()).toBe(0);
        expect(secondEvents).toEqual([]);
        expect(
          store.loadEventsStrict('runtime-replay-second').map((entry) => entry.event),
        ).toContainEqual(
          expect.objectContaining({
            type: 'tool.finished',
            result: expect.objectContaining({ ok: false, status: 'error' }),
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
