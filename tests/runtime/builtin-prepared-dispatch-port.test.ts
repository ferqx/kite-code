import { describe, expect, test } from 'bun:test';
import { digestCapabilityValue } from '@kite/builtin-runtime/capability';
import {
  APP_BUILTIN_PREPARED_DISPATCH_PORT_SCHEMA_,
  AppBuiltinPreparedDispatchPortError,
  createAppBuiltinPreparedDispatchPort,
  createAppDynamicMcpPreparedDispatchAdapter,
} from '#app/bootstrap/runtime/builtin-prepared-dispatch-port';
import type {
  AppPreparedToolInvocationPacket,
  AppToolPipelinePreparedRequest,
} from '#app/bootstrap/runtime/tool-pipeline-prepared';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
  createCapabilityBinding,
} from '#builtin-runtime';
import type {
  CapabilityExecutionInvocation,
  CapabilityExecutionPort,
  CapabilityTurnContext,
  DynamicMcpPreparedToolInvocationIdentity,
  ExecutionReceipt,
  NonDynamicOperationId,
  NonDynamicPreparedToolInvocationIdentity,
  PreparedToolInvocation,
  RuntimeJsonValue,
} from '#runtime-spi';
import { createRuntimeModuleRegistry } from '#runtime-spi';

const turnContext: CapabilityTurnContext = Object.freeze({
  hasTaskAdapter: true,
  hasGitBroker: true,
  brokeredGitFeatureRevision: 'brokered-git-r1',
  toolSearchEnabled: true,
  activeSkillFrameIds: ['frame-1'],
  availableSkillIds: ['skill-1'],
  featureFlags: {
    brokeredGit: true,
    skillWorkflow: true,
    skillActivation: true,
  },
});

type PreparedPacket = AppPreparedToolInvocationPacket<RuntimeJsonValue>;
type DynamicPreparedPacket = PreparedPacket & {
  readonly identity: Readonly<DynamicMcpPreparedToolInvocationIdentity>;
};

type DynamicWrapperEntry = Extract<
  ReturnType<typeof projection>['entries'][number],
  { visibility: 'internal' }
>;

function projection() {
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  return createBuiltinToolCatalogProjection(registry, { turnContext });
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) freezeDeep(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function requestEnvelope(
  entry: ReturnType<typeof projection>['entries'][number],
): AppToolPipelinePreparedRequest {
  return freezeDeep({
    schema: 'kite.tool-pipeline-prepared-request.v1' as const,
    authorizationKind: 'policy_allow' as const,
    grantUsed: 'none' as const,
    interactionMode: 'accept_edits' as const,
    sandboxScope: {
      kind: 'baseline' as const,
      filesystem: 'workspace_write' as const,
      network: 'disabled' as const,
      digest: 'scope-baseline',
    },
    policyEffects: {},
    effectiveEffects: entry.effects,
    receiptRequirement: 'observation_receipt' as const,
    retryEligibility: 'safe_read_candidate' as const,
    taskId: null,
    planId: null,
    planStepId: null,
    capabilityRequestFacts: null,
  });
}

function preparedFor(
  catalog: ReturnType<typeof projection>,
  operationId: string,
  options: {
    readonly binding?: ReturnType<typeof createCapabilityBinding> | null;
    readonly projectionRevision?: string;
    readonly request?: AppToolPipelinePreparedRequest;
    readonly arguments?: RuntimeJsonValue;
    readonly argumentOrigin?: 'model_public' | 'runtime_private';
    readonly schemaDigest?: string;
  } = {},
): PreparedPacket {
  const entry = catalog.entries.find((candidate) => candidate.operationId === operationId);
  if (entry?.visibility !== 'model' || !entry.name || entry.kind === 'internal_runtime') {
    throw new Error(`Missing model entry: ${operationId}`);
  }
  if (!entry.inputSchema || !entry.inputSchemaDigest) {
    throw new Error(`Missing model schema: ${operationId}`);
  }
  const family =
    entry.executionMechanism === 'skill'
      ? ('skill' as const)
      : entry.executionMechanism === 'subagent'
        ? ('subagent' as const)
        : ('builtin' as const);
  const identity: NonDynamicPreparedToolInvocationIdentity = {
    invocationId: 'invocation-1',
    attemptId: 'attempt-1',
    toolCallId: 'call-1',
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    argumentOrigin: options.argumentOrigin ?? 'model_public',
    providerId: entry.providerId,
    operationId: entry.operationId as NonDynamicOperationId,
    executionFamily: family,
    executionMechanism: entry.executionMechanism,
    capabilityId: entry.capabilityId,
    capabilityRevision: entry.revision,
    descriptorRevision: entry.descriptor.revision,
    parserRevision: entry.parser.parserRevision,
    executorRevision: entry.executorRevision,
    argumentsDigest: 'arguments-1',
    schemaDigest: options.schemaDigest ?? entry.inputSchemaDigest,
    effectiveEffectsDigest: 'effects-1',
    policyDigest: 'policy-1',
    authorizationDigest: 'authorization-1',
    admissionDigest: 'admission-1',
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: null,
    visibility: 'model',
    modelVisible: true,
    exposedToolName: entry.name,
    builtinProjectionRevision: options.projectionRevision ?? catalog.revision,
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false,
    toolKind: entry.kind,
  };
  return freezeDeep({
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: options.arguments ?? { path: 'README.md' },
      request: options.request ?? requestEnvelope(entry),
      binding: options.binding ?? null,
      facts: { source: 'test' },
    },
  }) as PreparedPacket;
}

function dynamicPrepared(
  catalog: ReturnType<typeof projection>,
): Readonly<AppPreparedToolInvocationPacket<RuntimeJsonValue>> {
  const request = requestEnvelope(
    catalog.entries.find((entry) => entry.operationId === 'builtin:read_file')!,
  );
  const identity: DynamicMcpPreparedToolInvocationIdentity = {
    invocationId: 'invocation-1',
    attemptId: 'attempt-1',
    toolCallId: 'call-1',
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    argumentOrigin: 'model_public',
    providerId: 'mcp-provider',
    operationId: 'mcp:dynamic_tool',
    executionFamily: 'mcp',
    executionMechanism: 'mcp',
    capabilityId: 'mcp:server:tool',
    capabilityRevision: 'subject-revision',
    descriptorRevision: 'subject-descriptor',
    parserRevision: 'subject-parser',
    executorRevision: null,
    argumentsDigest: 'arguments-1',
    schemaDigest: 'schema-1',
    effectiveEffectsDigest: 'effects-1',
    policyDigest: 'policy-1',
    authorizationDigest: 'authorization-1',
    admissionDigest: 'admission-1',
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: 'binding-1',
    visibility: 'internal',
    modelVisible: false,
    exposedToolName: null,
    builtinProjectionRevision: null,
    dynamicCatalogRevision: 'dynamic-catalog-1',
    isDynamicMcp: true,
    subject: {
      capabilityId: 'mcp:server:tool',
      capabilityRevision: 'subject-revision',
      descriptorRevision: 'subject-descriptor',
      providerId: 'mcp-provider',
      exposedToolName: 'mcp__server__tool',
      dynamicCatalogRevision: 'dynamic-catalog-1',
      bindingId: 'binding-1',
    },
    runtimeWrapper: {
      operationId: 'mcp:dynamic_tool',
      capabilityId: 'mcp:dynamic_tool',
      providerId: 'builtin-runtime-model',
      capabilityRevision: 'wrapper-revision',
      executorRevision: 'wrapper-executor',
      schemaDigest: 'wrapper-schema',
      builtinProjectionRevision: 'wrapper-projection',
    },
  };
  return freezeDeep({
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: { capability_id: 'mcp:server:tool', arguments: {} },
      request,
      binding: null,
      facts: { source: 'test' },
    },
  });
}

function dynamicPreparedForAdapter(
  catalog: ReturnType<typeof projection>,
  overrides: {
    readonly identity?: Partial<DynamicMcpPreparedToolInvocationIdentity>;
    readonly subject?: Partial<DynamicMcpPreparedToolInvocationIdentity['subject']>;
    readonly runtimeWrapper?: Partial<DynamicMcpPreparedToolInvocationIdentity['runtimeWrapper']>;
  } = {},
): DynamicPreparedPacket {
  const wrapper = catalog.entries.find(
    (entry): entry is DynamicWrapperEntry =>
      entry.visibility === 'internal' && entry.operationId === 'mcp:dynamic_tool',
  );
  if (!wrapper?.inputSchema) throw new Error('dynamic wrapper entry missing');
  const subjectSchema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  } as const;
  const subject = {
    capabilityId: 'mcp:fixture/search',
    capabilityRevision: 'subject-revision',
    descriptorRevision: 'subject-revision',
    providerId: 'fixture-provider',
    exposedToolName: 'mcp__fixture__search' as const,
    dynamicCatalogRevision: 'd'.repeat(64),
    bindingId: createCapabilityBinding({
      capabilityId: 'mcp:fixture/search',
      capabilityRevision: 'subject-revision',
      exposedToolName: 'mcp__fixture__search',
      inputSchema: subjectSchema,
      turnId: 'turn-1',
    }).bindingId,
  } as const;
  const binding = createCapabilityBinding({
    capabilityId: subject.capabilityId,
    capabilityRevision: subject.capabilityRevision,
    exposedToolName: subject.exposedToolName,
    inputSchema: subjectSchema,
    turnId: 'turn-1',
  });
  const wrapperSchemaDigest = digestCapabilityValue(wrapper.inputSchema);
  const runtimeWrapper = {
    operationId: 'mcp:dynamic_tool' as const,
    capabilityId: 'mcp:dynamic_tool',
    providerId: wrapper.providerId,
    capabilityRevision: wrapper.revision,
    executorRevision: wrapper.executorRevision,
    schemaDigest: wrapperSchemaDigest,
    builtinProjectionRevision: catalog.revision,
  } as const;
  const argumentsValue = Object.freeze({ query: 'fixture' });
  const identity: DynamicMcpPreparedToolInvocationIdentity = {
    invocationId: 'dynamic-invocation',
    attemptId: 'dynamic-invocation:attempt:1',
    toolCallId: 'dynamic-call',
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    argumentOrigin: 'model_public',
    providerId: subject.providerId,
    operationId: 'mcp:dynamic_tool',
    executionFamily: 'mcp',
    executionMechanism: 'mcp',
    capabilityId: subject.capabilityId,
    capabilityRevision: subject.capabilityRevision,
    descriptorRevision: subject.descriptorRevision,
    parserRevision: 'subject-parser',
    executorRevision: null,
    argumentsDigest: digestCapabilityValue(argumentsValue),
    schemaDigest: digestCapabilityValue(subjectSchema),
    effectiveEffectsDigest: digestCapabilityValue({
      filesystem: 'none',
      network: 'read',
      externalState: 'read',
    }),
    policyDigest: 'policy-digest',
    authorizationDigest: 'authorization-digest',
    admissionDigest: 'admission-digest',
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: binding.bindingId,
    visibility: 'internal',
    modelVisible: false,
    exposedToolName: null,
    builtinProjectionRevision: null,
    dynamicCatalogRevision: subject.dynamicCatalogRevision,
    isDynamicMcp: true,
    subject: { ...subject },
    runtimeWrapper,
  };
  return freezeDeep({
    identity: {
      ...identity,
      ...overrides.identity,
      subject: { ...identity.subject, ...overrides.subject },
      runtimeWrapper: { ...identity.runtimeWrapper, ...overrides.runtimeWrapper },
    },
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: argumentsValue,
      request: requestEnvelope(wrapper),
      binding,
      facts: { source: 'dynamic-adapter-test' },
    },
  }) as DynamicPreparedPacket;
}

function dynamicHostPort(
  entry: DynamicWrapperEntry,
  calls: CapabilityExecutionInvocation[],
): CapabilityExecutionPort {
  return Object.freeze({
    invoke: async (invocation: CapabilityExecutionInvocation): Promise<ExecutionReceipt> => {
      calls.push(invocation);
      return Object.freeze({
        invocationId: invocation.request.invocationId,
        attemptId: invocation.attempt.attemptId,
        providerId: entry.providerId,
        executorRevision: entry.executorRevision,
        requestDigest: invocation.requestDigest,
        status: 'succeeded' as const,
        dispatchCertainty: 'attempted' as const,
        cleanupCertainty: 'not_required' as const,
        value: Object.freeze({
          schema: 'kite.builtin-operation-result.v1' as const,
          ok: true,
          stdout: 'dynamic-ok',
          stderr: '',
        }),
      });
    },
  });
}

function dynamicAdapterFixture(
  catalog: ReturnType<typeof projection>,
  packet: DynamicPreparedPacket,
  projectionOverride: ReturnType<typeof projection> = catalog,
) {
  const wrapper =
    projectionOverride.entries.find(
      (entry): entry is DynamicWrapperEntry =>
        entry.visibility === 'internal' && entry.operationId === 'mcp:dynamic_tool',
    ) ??
    catalog.entries.find(
      (entry): entry is DynamicWrapperEntry =>
        entry.visibility === 'internal' && entry.operationId === 'mcp:dynamic_tool',
    );
  if (!wrapper) throw new Error('dynamic wrapper entry missing');
  const calls: CapabilityExecutionInvocation[] = [];
  let resolverCalls = 0;
  const signal = new AbortController().signal;
  const host = dynamicHostPort(wrapper, calls);
  const expected = dynamicPreparedForAdapter(catalog);
  const verifyPreparedIdentity = (candidate: Readonly<PreparedToolInvocation>) => {
    const identity = candidate.identity;
    const valid =
      identity.isDynamicMcp === true &&
      identity.operationId === 'mcp:dynamic_tool' &&
      identity.visibility === 'internal' &&
      identity.modelVisible === false &&
      identity.exposedToolName === null &&
      identity.dynamicCatalogRevision === expected.identity.dynamicCatalogRevision &&
      identity.bindingId === expected.identity.bindingId &&
      identity.capabilityId === expected.identity.capabilityId &&
      identity.capabilityRevision === expected.identity.capabilityRevision &&
      identity.descriptorRevision === expected.identity.descriptorRevision &&
      identity.subject.exposedToolName === expected.identity.subject.exposedToolName &&
      identity.subject.capabilityId === expected.identity.subject.capabilityId &&
      identity.subject.capabilityRevision === expected.identity.subject.capabilityRevision &&
      identity.subject.descriptorRevision === expected.identity.subject.descriptorRevision &&
      identity.subject.providerId === expected.identity.subject.providerId &&
      identity.subject.dynamicCatalogRevision ===
        expected.identity.subject.dynamicCatalogRevision &&
      identity.subject.bindingId === expected.identity.subject.bindingId &&
      identity.runtimeWrapper.providerId === expected.identity.runtimeWrapper.providerId &&
      identity.runtimeWrapper.capabilityRevision ===
        expected.identity.runtimeWrapper.capabilityRevision &&
      identity.runtimeWrapper.executorRevision ===
        expected.identity.runtimeWrapper.executorRevision &&
      identity.runtimeWrapper.schemaDigest === expected.identity.runtimeWrapper.schemaDigest &&
      identity.runtimeWrapper.builtinProjectionRevision ===
        expected.identity.runtimeWrapper.builtinProjectionRevision;
    return Object.freeze(
      valid
        ? { valid: true as const }
        : { valid: false as const, code: 'identity_mismatch' as const },
    );
  };
  const adapter = createAppDynamicMcpPreparedDispatchAdapter({
    projection: projectionOverride,
    capabilityExecution: host,
    verifyPreparedIdentity,
    resolveMechanisms: () => {
      resolverCalls += 1;
      return Object.freeze({
        mcp: Object.freeze({
          runtime: Object.freeze({}),
          invocation: Object.freeze({
            capabilityId: packet.identity.subject.capabilityId,
            expectedRevision: packet.identity.subject.capabilityRevision,
          }),
        }),
      });
    },
    signal,
  });
  return { adapter, calls, resolverCalls: () => resolverCalls, signal };
}

function projectionWithDynamicWrapperPatch(
  catalog: ReturnType<typeof projection>,
  patch: Readonly<Record<string, unknown>>,
): ReturnType<typeof projection> {
  const entries = Object.freeze(
    catalog.entries.map((entry) =>
      entry.visibility === 'internal' && entry.operationId === 'mcp:dynamic_tool'
        ? Object.freeze({ ...entry, ...patch })
        : entry,
    ),
  );
  return Object.freeze({
    ...catalog,
    entries,
  }) as ReturnType<typeof projection>;
}

function hostPortFor(
  entry: Readonly<
    Extract<ReturnType<typeof projection>['entries'][number], { visibility: 'model' }>
  >,
  calls: CapabilityExecutionInvocation[],
): CapabilityExecutionPort {
  return Object.freeze({
    invoke: async (invocation: CapabilityExecutionInvocation): Promise<ExecutionReceipt> => {
      calls.push(invocation);
      return Object.freeze({
        invocationId: invocation.request.invocationId,
        attemptId: invocation.attempt.attemptId,
        providerId: entry.providerId,
        executorRevision: entry.executorRevision,
        requestDigest: invocation.requestDigest,
        status: 'succeeded' as const,
        dispatchCertainty: 'attempted' as const,
        cleanupCertainty: 'not_required' as const,
        value: Object.freeze({
          schema: 'kite.builtin-operation-result.v1' as const,
          ok: true,
          stdout: 'ok',
          stderr: '',
        }),
      });
    },
  });
}

function filesystemMechanism() {
  return Object.freeze({
    filesystem: Object.freeze({
      allowExternalPaths: false,
      dispatch: async () => ({ ok: true }),
    }),
  });
}

function subagentMechanism() {
  return Object.freeze({
    subagent: Object.freeze({
      phase: 'building' as const,
      executeTask: async () => Object.freeze({ ok: true }),
    }),
  });
}

function bridgeFixture(
  catalog: ReturnType<typeof projection>,
  packet: Readonly<PreparedPacket>,
  options: {
    readonly mechanisms?: () => Readonly<Record<string, unknown>>;
  } = {},
) {
  const entry = catalog.entries.find((candidate) =>
    packet.identity.isDynamicMcp
      ? candidate.visibility === 'model'
      : candidate.operationId === packet.identity.operationId,
  );
  if (entry?.visibility !== 'model') throw new Error('fixture entry missing');
  const calls: CapabilityExecutionInvocation[] = [];
  const signal = new AbortController().signal;
  const host = hostPortFor(entry, calls);
  let resolverCalls = 0;
  const bridge = createAppBuiltinPreparedDispatchPort({
    projection: catalog,
    capabilityExecution: host,
    resolveMechanisms: () => {
      resolverCalls += 1;
      return options.mechanisms?.() ?? filesystemMechanism();
    },
    signal,
  });
  return { bridge, calls, resolverCalls, signal, host, catalog };
}

describe('App Builtin prepared dispatch port', () => {
  test('dynamic adapter dispatches one exact internal wrapper through the supplied Host port', async () => {
    const catalog = projection();
    const packet = dynamicPreparedForAdapter(catalog);
    const fixture = dynamicAdapterFixture(catalog, packet);
    const verified = fixture.adapter.verifyPreparedIdentity(packet);
    expect(verified).toMatchObject({ valid: true });
    const terminal = await fixture.adapter.dispatch(packet);

    expect(terminal.status).toBe('success');
    expect(fixture.resolverCalls()).toBe(1);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.binding.exposedToolName).toBe('mcp:dynamic_tool');
    expect(fixture.calls[0]?.request.capabilityId).toBe('mcp:dynamic_tool');
    expect(fixture.calls[0]?.request.input).toMatchObject({
      capability_id: packet.identity.subject.capabilityId,
      capability_revision: packet.identity.subject.capabilityRevision,
      arguments: packet.input.arguments,
    });
  });

  test('dynamic subject, wrapper, and visibility drift fail before resolver or Host', async () => {
    const catalog = projection();
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly packet: DynamicPreparedPacket;
      readonly projection?: ReturnType<typeof projection>;
    }> = [
      {
        name: 'subject binding',
        packet: dynamicPreparedForAdapter(catalog, {
          identity: { bindingId: 'forged-binding' },
          subject: { bindingId: 'forged-binding' },
        }),
      },
      {
        name: 'dynamic catalog revision',
        packet: dynamicPreparedForAdapter(catalog, {
          identity: { dynamicCatalogRevision: 'e'.repeat(64) },
          subject: { dynamicCatalogRevision: 'e'.repeat(64) },
        }),
      },
      {
        name: 'subject capability revision',
        packet: dynamicPreparedForAdapter(catalog, {
          identity: {
            capabilityRevision: 'forged-subject-revision',
            descriptorRevision: 'forged-subject-revision',
          },
          subject: {
            capabilityRevision: 'forged-subject-revision',
            descriptorRevision: 'forged-subject-revision',
          },
        }),
      },
      {
        name: 'subject exposed name',
        packet: dynamicPreparedForAdapter(catalog, {
          subject: { exposedToolName: 'mcp__fixture__other' },
        }),
      },
      {
        name: 'wrapper provider',
        packet: dynamicPreparedForAdapter(catalog, {
          runtimeWrapper: { providerId: 'forged-provider' },
        }),
      },
      {
        name: 'wrapper executor revision',
        packet: dynamicPreparedForAdapter(catalog, {
          runtimeWrapper: { executorRevision: 'forged-executor' },
        }),
      },
      {
        name: 'wrapper capability revision',
        packet: dynamicPreparedForAdapter(catalog, {
          runtimeWrapper: { capabilityRevision: 'forged-wrapper-revision' },
        }),
      },
      {
        name: 'wrapper schema digest',
        packet: dynamicPreparedForAdapter(catalog, {
          runtimeWrapper: { schemaDigest: 'forged-schema' },
        }),
      },
      {
        name: 'wrapper projection revision',
        packet: dynamicPreparedForAdapter(catalog, {
          runtimeWrapper: { builtinProjectionRevision: 'forged-projection' },
        }),
      },
      {
        name: 'model-visible confusion',
        packet: dynamicPreparedForAdapter(catalog, {
          identity: {
            visibility: 'model',
            modelVisible: true,
          } as unknown as Partial<DynamicMcpPreparedToolInvocationIdentity>,
        }),
      },
      {
        name: 'unavailable wrapper',
        packet: dynamicPreparedForAdapter(catalog),
        projection: projectionWithDynamicWrapperPatch(catalog, { availability: 'unavailable' }),
      },
      {
        name: 'non-internal wrapper',
        packet: dynamicPreparedForAdapter(catalog),
        projection: projectionWithDynamicWrapperPatch(catalog, { visibility: 'model' }),
      },
    ];

    for (const candidate of cases) {
      const fixture = dynamicAdapterFixture(catalog, candidate.packet, candidate.projection);
      const verification = fixture.adapter.verifyPreparedIdentity(candidate.packet);
      if (candidate.projection && candidate.name.includes('wrapper')) {
        expect(verification).toMatchObject({ valid: true });
      } else {
        expect(verification).toMatchObject({ valid: false });
      }
      if (verification !== true && (verification === false || verification.valid !== true)) {
        expect(fixture.calls).toHaveLength(0);
        expect(fixture.resolverCalls()).toBe(0);
        continue;
      }
      await expect(fixture.adapter.dispatch(candidate.packet)).rejects.toBeInstanceOf(
        AppBuiltinPreparedDispatchPortError,
      );
      expect(fixture.calls).toHaveLength(0);
      expect(fixture.resolverCalls()).toBe(0);
    }
  });

  test('builds one exact invocation and enters projection.dispatch with the supplied Host port', async () => {
    const catalog = projection();
    const packet = preparedFor(catalog, 'builtin:read_file');
    const calls: CapabilityExecutionInvocation[] = [];
    const entry = catalog.entries.find(
      (candidate) => candidate.operationId === 'builtin:read_file',
    );
    if (entry?.visibility !== 'model') throw new Error('fixture entry missing');
    const signal = new AbortController().signal;
    const host = hostPortFor(entry, calls);
    let resolverInput:
      | Parameters<
          NonNullable<
            Parameters<typeof createAppBuiltinPreparedDispatchPort>[0]['resolveMechanisms']
          >
        >[0]
      | undefined;
    const bridge = createAppBuiltinPreparedDispatchPort({
      projection: catalog,
      capabilityExecution: host,
      resolveMechanisms: (input) => {
        resolverInput = input;
        return filesystemMechanism();
      },
      signal,
    });
    const receipt = await bridge.dispatch({
      prepared: packet,
      operationId: packet.identity.operationId,
      executionMechanism: packet.identity.executionMechanism,
      arguments: packet.input.arguments,
    });

    expect(bridge.schema).toBe(APP_BUILTIN_PREPARED_DISPATCH_PORT_SCHEMA_);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.binding.bindingId).toBeDefined();
    expect(calls[0]?.binding.bindingId).not.toBe(packet.identity.bindingId);
    expect(calls[0]?.request.input).toBe(packet.input.arguments);
    expect(calls[0]?.request.facts).toEqual({ toolCallId: packet.identity.toolCallId });
    expect(calls[0]?.grant.authority).toMatchObject({
      policyDigest: packet.identity.policyDigest,
      authorizationDigest: packet.identity.authorizationDigest,
      admissionDigest: packet.identity.admissionDigest,
      authorizationKind: 'policy_allow',
      grantUsed: 'none',
      policyEffects: {},
      effectiveEffects: packet.input.request?.effectiveEffects,
    });
    expect(calls[0]?.environment.mechanisms).toMatchObject({ filesystem: {} });
    expect(calls[0]?.signal).toBe(signal);
    expect(resolverInput?.prepared).toBe(packet);
    expect(resolverInput?.signal).toBe(signal);
    expect(receipt.status).toBe('succeeded');
  });

  test('accepts ordinary prepared binding=null and rejects a forged supplied binding', async () => {
    const catalog = projection();
    const ordinary = preparedFor(catalog, 'builtin:read_file');
    const valid = bridgeFixture(catalog, ordinary);
    await valid.bridge.dispatch({
      prepared: ordinary,
      operationId: ordinary.identity.operationId,
      executionMechanism: ordinary.identity.executionMechanism,
      arguments: ordinary.input.arguments,
    });
    expect(valid.calls).toHaveLength(1);

    const forgedBinding = createCapabilityBinding({
      capabilityId: 'builtin:read_file',
      capabilityRevision: 'forged',
      exposedToolName: 'read_file',
      inputSchema: {},
      turnId: 'turn-1',
    });
    const forged = preparedFor(catalog, 'builtin:read_file', { binding: forgedBinding });
    const forgedFixture = bridgeFixture(catalog, forged);
    await expect(
      forgedFixture.bridge.dispatch({
        prepared: forged,
        operationId: forged.identity.operationId,
        executionMechanism: forged.identity.executionMechanism,
        arguments: forged.input.arguments,
      }),
    ).rejects.toMatchObject({ code: 'binding_mismatch' });
    expect(forgedFixture.calls).toHaveLength(0);
  });

  test('preserves public and runtime-private Task parser identities while failing closed before Host', async () => {
    const catalog = projection();
    const taskCases: ReadonlyArray<{
      readonly argumentOrigin: 'model_public' | 'runtime_private';
      readonly schemaDigest: string;
      readonly arguments: RuntimeJsonValue;
    }> = [
      {
        argumentOrigin: 'model_public' as const,
        schemaDigest: 'task-model-schema-digest',
        arguments: { subagent_type: 'explore', task: 'inspect the repository' },
      },
      {
        argumentOrigin: 'runtime_private' as const,
        schemaDigest: 'task-runtime-schema-digest',
        arguments: {
          subagent_type: 'explore',
          taskArtifact: { schema: 'kite.subagent-task-request.v1', artifactId: 'artifact-1' },
        },
      },
    ];
    for (const taskCase of taskCases) {
      const packet = preparedFor(catalog, 'builtin:task', taskCase);
      const fixture = bridgeFixture(catalog, packet, {
        mechanisms: subagentMechanism,
      });
      await expect(
        fixture.bridge.dispatch({
          prepared: packet,
          operationId: packet.identity.operationId,
          executionMechanism: packet.identity.executionMechanism,
          arguments: packet.input.arguments,
        }),
      ).rejects.toMatchObject({ code: 'unsupported_operation' });
      expect(fixture.calls).toHaveLength(0);
      expect(fixture.resolverCalls).toBe(0);
    }
  });

  test('fails closed before resolver and Host for identity, request, and four-field drift', async () => {
    const catalog = projection();
    const cases = [
      {
        packet: preparedFor(catalog, 'builtin:read_file', {
          projectionRevision: 'forged-projection',
        }),
        input: (packet: PreparedPacket) => ({
          prepared: packet,
          operationId: packet.identity.operationId,
          executionMechanism: packet.identity.executionMechanism,
          arguments: packet.input.arguments,
        }),
        code: 'projection_identity_mismatch',
      },
      {
        packet: preparedFor(catalog, 'builtin:read_file', {
          request: {
            ...requestEnvelope(
              catalog.entries.find((entry) => entry.operationId === 'builtin:read_file')!,
            ),
            schema: 'bad',
          } as unknown as AppToolPipelinePreparedRequest,
        }),
        input: (packet: PreparedPacket) => ({
          prepared: packet,
          operationId: packet.identity.operationId,
          executionMechanism: packet.identity.executionMechanism,
          arguments: packet.input.arguments,
        }),
        code: 'request_envelope_invalid',
      },
      {
        packet: preparedFor(catalog, 'builtin:read_file', {
          request: {
            ...requestEnvelope(
              catalog.entries.find((entry) => entry.operationId === 'builtin:read_file')!,
            ),
            grantUsed: 'approve_once',
          } as unknown as AppToolPipelinePreparedRequest,
        }),
        input: (packet: PreparedPacket) => ({
          prepared: packet,
          operationId: packet.identity.operationId,
          executionMechanism: packet.identity.executionMechanism,
          arguments: packet.input.arguments,
        }),
        code: 'request_envelope_invalid',
      },
      {
        packet: preparedFor(catalog, 'builtin:read_file', {
          request: {
            ...requestEnvelope(
              catalog.entries.find((entry) => entry.operationId === 'builtin:read_file')!,
            ),
            policyEffects: { network: false },
          } as unknown as AppToolPipelinePreparedRequest,
        }),
        input: (packet: PreparedPacket) => ({
          prepared: packet,
          operationId: packet.identity.operationId,
          executionMechanism: packet.identity.executionMechanism,
          arguments: packet.input.arguments,
        }),
        code: 'request_envelope_invalid',
      },
    ] as const;
    for (const candidate of cases) {
      const fixture = bridgeFixture(catalog, candidate.packet);
      await expect(
        fixture.bridge.dispatch(candidate.input(candidate.packet)),
      ).rejects.toMatchObject({
        code: candidate.code,
      });
      expect(fixture.calls).toHaveLength(0);
      expect(fixture.resolverCalls).toBe(0);
    }

    const packet = preparedFor(catalog, 'builtin:read_file');
    const fixture = bridgeFixture(catalog, packet);
    await expect(
      fixture.bridge.dispatch({
        prepared: packet,
        operationId: 'builtin:write_file',
        executionMechanism: packet.identity.executionMechanism,
        arguments: packet.input.arguments,
      }),
    ).rejects.toMatchObject({ code: 'projection_identity_mismatch' });
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.resolverCalls).toBe(0);
  });

  test('rejects mutable or non-exact mechanism maps before Host invocation', async () => {
    const catalog = projection();
    const packet = preparedFor(catalog, 'builtin:read_file');
    const mutable = { filesystem: { allowExternalPaths: false, dispatch: async () => ({}) } };
    for (const mechanisms of [
      () => mutable,
      () => ({ ...filesystemMechanism(), extra: Object.freeze({}) }),
    ]) {
      const fixture = bridgeFixture(catalog, packet, { mechanisms });
      await expect(
        fixture.bridge.dispatch({
          prepared: packet,
          operationId: packet.identity.operationId,
          executionMechanism: packet.identity.executionMechanism,
          arguments: packet.input.arguments,
        }),
      ).rejects.toMatchObject({ code: 'mechanism_unavailable' });
      expect(fixture.calls).toHaveLength(0);
    }
  });

  test('fails closed for dynamic MCP, ask_user, and subagent without Host calls', async () => {
    const catalog = projection();
    const ordinary = preparedFor(catalog, 'builtin:read_file');
    const dynamic = dynamicPrepared(catalog);
    const cases: Readonly<PreparedToolInvocation>[] = [
      ordinary,
      dynamic,
      preparedFor(catalog, 'builtin:ask_user'),
    ];
    for (const packet of cases.slice(1)) {
      const fixture = bridgeFixture(catalog, packet as PreparedPacket);
      await expect(
        fixture.bridge.dispatch({
          prepared: packet,
          operationId: packet.identity.operationId,
          executionMechanism: packet.identity.executionMechanism,
          arguments: packet.input.arguments,
        }),
      ).rejects.toBeInstanceOf(AppBuiltinPreparedDispatchPortError);
      expect(fixture.calls).toHaveLength(0);
      expect(fixture.resolverCalls).toBe(0);
    }
  });

  test('does not call the supplied Host port directly or create a second registry', async () => {
    const source = await Bun.file(
      new URL(
        '../../apps/kite/src/bootstrap/runtime/builtin-prepared-dispatch-port.ts',
        import.meta.url,
      ),
    ).text();
    expect(source).toContain('input.projection.dispatch');
    expect(source).not.toContain('capabilityExecution.invoke(');
    expect(source).not.toContain('createRuntimeModuleRegistry');
    expect(source).not.toContain('createRuntimeHost');
  });
});
