import { describe, expect, test } from 'bun:test';
import type {
  CapabilityToolTerminalResult,
  DynamicMcpPreparedToolInvocationIdentity,
  NonDynamicOperationId,
  NonDynamicPreparedToolInvocationIdentity,
  PreparedToolInvocation,
  PreparedToolInvocationIdentity,
  ToolPipelineAttemptAcknowledgement,
  ToolPipelineOutcomeDispatch,
  ToolPipelinePersistence,
  ToolPipelinePreparedIdentityVerifier,
} from '@kite-ai/runtime-spi';
import {
  type AppToolPipelineAttemptComposition,
  createAppToolPipelineAttemptComposition,
} from '#app/bootstrap/runtime/tool-pipeline-attempt-composition';

type Prepared = Readonly<PreparedToolInvocation>;
type Verifier = ToolPipelinePreparedIdentityVerifier;

const ordinaryOperationId = 'builtin:fixture' as NonDynamicOperationId;

function ordinaryIdentity(): NonDynamicPreparedToolInvocationIdentity {
  return {
    invocationId: 'invocation-1',
    attemptId: 'attempt-1',
    toolCallId: 'call-1',
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    argumentOrigin: 'model_public',
    providerId: 'fixture-provider',
    operationId: ordinaryOperationId,
    executionFamily: 'builtin',
    executionMechanism: 'filesystem',
    capabilityId: 'builtin:fixture',
    capabilityRevision: 'capability-1',
    descriptorRevision: 'descriptor-1',
    parserRevision: 'parser-1',
    executorRevision: 'executor-1',
    argumentsDigest: 'arguments-1',
    schemaDigest: 'schema-1',
    effectiveEffectsDigest: 'effects-1',
    policyDigest: 'policy-1',
    authorizationDigest: 'authorization-1',
    admissionDigest: 'admission-1',
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: 'binding-1',
    visibility: 'model',
    modelVisible: true,
    exposedToolName: 'fixture',
    builtinProjectionRevision: 'builtin-1',
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false,
    toolKind: 'computer',
  };
}

function dynamicIdentity(): DynamicMcpPreparedToolInvocationIdentity {
  return {
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
    capabilityId: 'mcp:server:fixture',
    capabilityRevision: 'subject-capability-1',
    descriptorRevision: 'subject-descriptor-1',
    parserRevision: 'wrapper-parser-1',
    executorRevision: null,
    argumentsDigest: 'arguments-1',
    schemaDigest: 'subject-schema-1',
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
      capabilityId: 'mcp:server:fixture',
      capabilityRevision: 'subject-capability-1',
      descriptorRevision: 'subject-descriptor-1',
      providerId: 'mcp-provider',
      exposedToolName: 'mcp__server__fixture',
      dynamicCatalogRevision: 'dynamic-catalog-1',
      bindingId: 'binding-1',
    },
    runtimeWrapper: {
      operationId: 'mcp:dynamic_tool',
      capabilityId: 'mcp:dynamic_tool',
      providerId: 'builtin-runtime',
      capabilityRevision: 'wrapper-capability-1',
      executorRevision: 'wrapper-executor-1',
      schemaDigest: 'wrapper-schema-1',
      builtinProjectionRevision: 'builtin-1',
    },
  };
}

function bindingFor(identity: Readonly<PreparedToolInvocationIdentity>): {
  readonly bindingId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly exposedToolName: string;
  readonly schemaDigest: string;
  readonly issuedForTurnId: string;
} {
  return identity.isDynamicMcp
    ? {
        bindingId: 'binding-1',
        capabilityId: 'mcp:server:fixture',
        capabilityRevision: 'subject-capability-1',
        exposedToolName: 'mcp__server__fixture',
        schemaDigest: 'subject-schema-1',
        issuedForTurnId: 'turn-1',
      }
    : {
        bindingId: 'binding-1',
        capabilityId: 'builtin:fixture',
        capabilityRevision: 'capability-1',
        exposedToolName: 'fixture',
        schemaDigest: 'schema-1',
        issuedForTurnId: 'turn-1',
      };
}

function acknowledgement(prepared: Prepared): ToolPipelineAttemptAcknowledgement {
  const identity = prepared.identity;
  return {
    acknowledged: true,
    attempt: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      attempt: 1,
      toolCallId: identity.toolCallId,
      turnId: identity.turnId,
      modelMessageId: identity.modelMessageId,
      argumentOrigin: identity.argumentOrigin,
      providerId: identity.providerId,
      operationId: identity.operationId,
      capabilityId: identity.capabilityId,
      capabilityRevision: identity.capabilityRevision,
      descriptorRevision: identity.descriptorRevision,
      parserRevision: identity.parserRevision,
      executorRevision: identity.executorRevision,
      argumentsDigest: identity.argumentsDigest,
      schemaDigest: identity.schemaDigest,
      effectiveEffectsDigest: identity.effectiveEffectsDigest,
      builtinProjectionRevision: identity.builtinProjectionRevision,
      dynamicCatalogRevision: identity.dynamicCatalogRevision,
      runtimeWrapperProviderId: identity.isDynamicMcp ? identity.runtimeWrapper.providerId : null,
      runtimeWrapperCapabilityRevision: identity.isDynamicMcp
        ? identity.runtimeWrapper.capabilityRevision
        : null,
      runtimeWrapperExecutorRevision: identity.isDynamicMcp
        ? identity.runtimeWrapper.executorRevision
        : null,
      runtimeWrapperSchemaDigest: identity.isDynamicMcp
        ? identity.runtimeWrapper.schemaDigest
        : null,
      runtimeWrapperBuiltinProjectionRevision: identity.isDynamicMcp
        ? identity.runtimeWrapper.builtinProjectionRevision
        : null,
      policyDigest: identity.policyDigest,
      authorizationDigest: identity.authorizationDigest,
      admissionDigest: identity.admissionDigest,
      idempotencyKey: identity.idempotencyKey,
      recordedAt: '2026-08-21T00:00:00.000Z',
      startedAt: '2026-08-21T00:00:00.000Z',
    },
  };
}

function terminalResult(): CapabilityToolTerminalResult {
  return {
    status: 'success',
    content: [{ ok: true }],
    structuredContent: { result: 'fixture' },
  };
}

function fixture(
  options: {
    readonly identity?: PreparedToolInvocationIdentity;
    readonly verify?: Verifier;
    readonly recordAttempt?: (
      input: Prepared,
    ) => Promise<ToolPipelineAttemptAcknowledgement> | ToolPipelineAttemptAcknowledgement;
    readonly recordUnknown?: (input: unknown) => Promise<void> | void;
    readonly commitTerminal?: (input: unknown) => Promise<void> | void;
    readonly dispatch?: (
      input: Prepared,
    ) => Promise<CapabilityToolTerminalResult> | CapabilityToolTerminalResult;
  } = {},
) {
  const selectedIdentity = options.identity ?? ordinaryIdentity();
  const events: string[] = [];
  let persistenceCalls = 0;
  let dispatchCalls = 0;
  let unknownCalls = 0;
  let commitCalls = 0;
  const unknownInputs: unknown[] = [];
  const verifier = options.verify ?? (() => true);
  const persistence: ToolPipelinePersistence = {
    recordAttempt: async (prepared) => {
      events.push('record');
      persistenceCalls += 1;
      return options.recordAttempt?.(prepared) ?? acknowledgement(prepared);
    },
    recordUnknown: async (input) => {
      events.push('unknown');
      unknownCalls += 1;
      unknownInputs.push(input);
      await options.recordUnknown?.(input);
    },
    commitTerminal: async (input) => {
      events.push('commit');
      commitCalls += 1;
      await options.commitTerminal?.(input);
    },
    commitSuspension: async () => {
      throw new Error('fixture does not suspend');
    },
  };
  const dispatch: ToolPipelineOutcomeDispatch = {
    verifyPreparedIdentity: verifier,
    dispatch: async (prepared) => {
      events.push('dispatch');
      dispatchCalls += 1;
      return {
        kind: 'committed',
        terminal: (await options.dispatch?.(prepared)) ?? terminalResult(),
      };
    },
  };
  const composition = createAppToolPipelineAttemptComposition({
    persistence,
    dispatch,
  });
  const prepared = composition.prepare(selectedIdentity, {
    invocationId: selectedIdentity.invocationId,
    attemptId: selectedIdentity.attemptId,
    toolCallId: selectedIdentity.toolCallId,
    arguments: { path: 'README.md', nested: { limit: 10 } },
    request: { privateRequest: ['opaque', 1] },
    facts: { privateFacts: { revision: 'facts-1' } },
    binding: bindingFor(selectedIdentity),
  });
  return {
    composition,
    prepared,
    suppliedVerifier: verifier,
    events,
    unknownInputs,
    get persistenceCalls() {
      return persistenceCalls;
    },
    get dispatchCalls() {
      return dispatchCalls;
    },
    get unknownCalls() {
      return unknownCalls;
    },
    get commitCalls() {
      return commitCalls;
    },
  };
}

describe('RM-16 App Tool Pipeline attempt composition', () => {
  test('passes the exact Builtin verifier and preserves ack-before-dispatch', async () => {
    let verifierCalls = 0;
    const exactVerifier: Verifier = () => {
      verifierCalls += 1;
      return true;
    };
    const harness = fixture({ verify: exactVerifier });

    expect(harness.composition.verifyPreparedIdentity).toBe(exactVerifier);
    const committed = await harness.composition.execute(harness.prepared);

    expect(verifierCalls).toBe(1);
    expect(harness.persistenceCalls).toBe(1);
    expect(harness.dispatchCalls).toBe(1);
    expect(harness.commitCalls).toBe(1);
    expect(harness.events).toEqual(['record', 'dispatch', 'commit']);
    const composition: AppToolPipelineAttemptComposition = harness.composition;
    composition.assertCommitted(committed);
  });

  test('fails closed before persistence and dispatch for identity mismatch', async () => {
    const harness = fixture({ verify: () => false });

    await expect(harness.composition.execute(harness.prepared)).rejects.toMatchObject({
      code: 'verification_failed',
    });
    expect(harness.persistenceCalls).toBe(0);
    expect(harness.dispatchCalls).toBe(0);
  });

  test('fails closed before dispatch when acknowledgement is invalid', async () => {
    const harness = fixture({
      recordAttempt: () =>
        ({ acknowledged: true, attempt: {} }) as unknown as ToolPipelineAttemptAcknowledgement,
    });

    await expect(harness.composition.execute(harness.prepared)).rejects.toMatchObject({
      code: 'acknowledgement_failed',
    });
    expect(harness.persistenceCalls).toBe(1);
    expect(harness.dispatchCalls).toBe(0);
    expect(harness.commitCalls).toBe(0);
  });

  test('records post-ack dispatch uncertainty and does not fall back', async () => {
    const harness = fixture({
      dispatch: () => {
        throw new Error('executor failure');
      },
    });

    await expect(harness.composition.execute(harness.prepared)).rejects.toMatchObject({
      code: 'unknown_outcome',
    });
    expect(harness.events).toEqual(['record', 'dispatch', 'unknown']);
    expect(harness.unknownCalls).toBe(1);
    expect(harness.unknownInputs).toMatchObject([
      { code: 'dispatch_failed', acknowledgement: { acknowledged: true } },
    ]);
    expect(harness.commitCalls).toBe(0);
  });

  test('deep-freezes ordinary prepared identity and transport input', () => {
    const harness = fixture();
    const prepared = harness.prepared;

    expect(Object.isFrozen(harness.composition)).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.identity)).toBe(true);
    expect(Object.isFrozen(prepared.input)).toBe(true);
    expect(Object.isFrozen(prepared.input.arguments)).toBe(true);
    expect(Object.isFrozen(prepared.input.binding)).toBe(true);
    expect(Reflect.set(prepared.input.arguments as object, 'path', 'tampered')).toBe(false);
    expect((prepared.input.arguments as { readonly path: string }).path).toBe('README.md');
  });

  test('retains dynamic MCP subject and private wrapper identity as one prepared packet', async () => {
    let verifiedIdentity: PreparedToolInvocationIdentity | undefined;
    const harness = fixture({
      identity: dynamicIdentity(),
      verify: (prepared) => {
        verifiedIdentity = prepared.identity;
        return (
          prepared.identity.isDynamicMcp === true &&
          prepared.identity.operationId === 'mcp:dynamic_tool' &&
          prepared.identity.subject.exposedToolName === 'mcp__server__fixture' &&
          prepared.identity.runtimeWrapper.operationId === 'mcp:dynamic_tool' &&
          prepared.identity.runtimeWrapper.capabilityId === 'mcp:dynamic_tool'
        );
      },
    });

    await harness.composition.execute(harness.prepared);
    expect(verifiedIdentity?.isDynamicMcp).toBe(true);
    if (!verifiedIdentity?.isDynamicMcp) {
      throw new Error('dynamic identity was not observed');
    }
    expect(verifiedIdentity.subject.dynamicCatalogRevision).toBe('dynamic-catalog-1');
    expect(verifiedIdentity.runtimeWrapper.builtinProjectionRevision).toBe('builtin-1');
    expect(harness.dispatchCalls).toBe(1);
  });
});
