import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjectionV1,
  createToolSearchProviderFactsV1,
  digestCapabilityValueV1,
  verifyBuiltinWorkspaceFilesystemTerminalV1,
} from '@kite/builtin-runtime';
import {
  type BuiltinWorkspaceFilesystemRuntimeV1,
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
} from '@kite/builtin-runtime/filesystem';
import { createProtectedPathEvaluatorV1 } from '@kite/builtin-runtime/sandbox';
import {
  createRuntimeHostCapabilityExecutionPortV1,
  createRuntimeHostToolCallSnapshotV1,
  runtimeHostState25CreateApprovalBindingDigestV1,
} from '@kite/runtime-host';
import type {
  CapabilityExecutionInvocationV1,
  CapabilityExecutionPortV1,
  CapabilityToolTerminalResultV1,
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelineAttemptAcknowledgementV1,
  ToolPipelineReceiptCommitV1,
  WorkspaceFilesystemEditObservationQueryV1,
  WorkspaceFilesystemIntentDraftV1,
  WorkspaceFilesystemPersistedIntentV1,
} from '@kite/runtime-spi';
import { createRuntimeModuleRegistryV1 } from '@kite/runtime-spi';
import { createAppToolPipelineCompositionV1 } from '#app/bootstrap/runtime/tool-pipeline-composition';
import {
  APP_ORDINARY_TOOL_PIPELINE_ATTEMPT_SCHEMA_V1,
  type AppOrdinaryWorkspaceFilesystemCompositionV1,
  createAppOrdinaryToolPipelineAttemptRuntimeV1,
  createAppToolPipelineAttemptScopeV1,
} from '#app/bootstrap/runtime/tool-pipeline-ordinary-attempt';
import type { AppState25ToolPipelinePersistenceV1 } from '#app/bootstrap/runtime/tool-pipeline-state25-persistence';
import { createAppTaskToolPipelineAttemptRuntimeV1 } from '#app/bootstrap/runtime/tool-pipeline-task-attempt';

function acknowledgement(
  prepared: Readonly<PreparedToolInvocationV1>,
): Readonly<ToolPipelineAttemptAcknowledgementV1> {
  const identity = prepared.identity;
  return Object.freeze({
    acknowledged: true,
    attempt: Object.freeze({
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
      runtimeWrapperProviderId: null,
      runtimeWrapperCapabilityRevision: null,
      runtimeWrapperExecutorRevision: null,
      runtimeWrapperSchemaDigest: null,
      runtimeWrapperBuiltinProjectionRevision: null,
      policyDigest: identity.policyDigest,
      authorizationDigest: identity.authorizationDigest,
      admissionDigest: identity.admissionDigest,
      idempotencyKey: identity.idempotencyKey,
      recordedAt: '2026-08-22T00:00:00.000Z',
      startedAt: '2026-08-22T00:00:00.000Z',
    }),
  });
}

function harness() {
  const registry = createRuntimeModuleRegistryV1(createBuiltinRuntimeModules());
  const projection = createBuiltinToolCatalogProjectionV1(registry.snapshot());
  const composition = createAppToolPipelineCompositionV1(projection);
  const turn = composition.forTurn(
    Object.freeze({
      workspace: '/workspace',
      threadId: 'thread-1',
      turnId: 'turn-1',
      modelMessageId: 'message-1',
      toolCallId: 'call-1',
      phase: 'building' as const,
      interactionMode: 'accept_edits' as const,
      toolSearchEnabled: true,
      hasTaskAdapter: true,
      hasGitBroker: true,
      brokeredGitFeatureRevision: 'brokered-git-r1',
      featureFlags: Object.freeze({ brokeredGitV1: true }),
    }),
  );
  const calls = { record: 0, host: 0, commit: 0, suspend: 0, unknown: 0 };
  const acknowledgements = new WeakMap<object, Readonly<ToolPipelineAttemptAcknowledgementV1>>();
  const issuedFilesystemIntents = new WeakSet<object>();
  const persistence: AppState25ToolPipelinePersistenceV1 = Object.freeze({
    recordAttempt: async (prepared: Readonly<PreparedToolInvocationV1>) => {
      calls.record += 1;
      const recorded = acknowledgement(prepared);
      acknowledgements.set(prepared, recorded);
      return recorded;
    },
    recordUnknown: async () => {
      calls.unknown += 1;
    },
    commitTerminal: async (commit: Readonly<ToolPipelineReceiptCommitV1>) => {
      calls.commit += 1;
      const structured = commit.result.structuredContent;
      if (
        structured !== null &&
        typeof structured === 'object' &&
        !Array.isArray(structured) &&
        Object.hasOwn(structured, 'filesystemObservation')
      ) {
        expect(verifyBuiltinWorkspaceFilesystemTerminalV1(commit).valid).toBe(true);
      }
    },
    commitSuspension: async () => {
      calls.suspend += 1;
    },
    createSandboxLifecycle: () => {
      throw new Error('sandbox lifecycle is outside this read-only fixture');
    },
    workspaceFilesystemEvidence: Object.freeze({
      persistIntent: async <
        TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
        TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
      >(
        draft: Readonly<WorkspaceFilesystemIntentDraftV1<TArguments, TRequest>>,
      ): Promise<Readonly<WorkspaceFilesystemPersistedIntentV1<TArguments, TRequest>>> => {
        const recorded = acknowledgements.get(draft.prepared);
        if (!recorded) throw new Error('attempt not acknowledged');
        const persisted = Object.freeze({
          schema: 'kite.workspace-filesystem-pipeline.v1' as const,
          status: 'durably_persisted' as const,
          prepared: draft.prepared,
          acknowledgement: recorded,
          operation: draft.operation,
          record: draft.record,
        });
        issuedFilesystemIntents.add(persisted);
        return persisted;
      },
      verifyPersistedIntent: (persisted: Readonly<WorkspaceFilesystemPersistedIntentV1>) =>
        issuedFilesystemIntents.has(persisted)
          ? Object.freeze({ valid: true as const })
          : Object.freeze({ valid: false as const, code: 'intent_not_issued' as const }),
    }),
    workspaceFilesystemMutationEvidence: Object.freeze({
      persistIntent: async () => {
        throw new Error('mutation evidence is outside this read-only fixture');
      },
      verifyPersistedIntent: () =>
        Object.freeze({ valid: false as const, code: 'intent_not_issued' as const }),
      persistMutationReady: async () => {
        throw new Error('mutation ready evidence is outside this read-only fixture');
      },
      verifyPersistedMutationReady: () =>
        Object.freeze({ valid: false as const, code: 'ready_not_issued' as const }),
    }),
    workspaceFilesystemEditObservation: Object.freeze({
      findLatestAuthenticRead: async (query: Readonly<WorkspaceFilesystemEditObservationQueryV1>) =>
        Object.freeze({ status: 'missing' as const, code: 'read_required' as const, query }),
      verifyLatestAuthenticRead: () =>
        Object.freeze({ valid: false as const, code: 'query_result_not_issued' as const }),
    }),
  });
  const host = createRuntimeHostCapabilityExecutionPortV1(registry);
  const countedHost: CapabilityExecutionPortV1 = Object.freeze({
    invoke: (invocation: CapabilityExecutionInvocationV1) => {
      calls.host += 1;
      return host.invoke(invocation);
    },
  });
  const scope = createAppToolPipelineAttemptScopeV1({ persistence });
  const runtime = createAppOrdinaryToolPipelineAttemptRuntimeV1({ persistence, scope });
  return { projection, turn, calls, countedHost, runtime, persistence, scope };
}

function input(
  fixture: ReturnType<typeof harness>,
  options: {
    readonly name?: string;
    readonly revision?: string;
    readonly rawArguments?: Readonly<Record<string, unknown>>;
    readonly argumentOrigin?: 'model_public' | 'runtime_private';
    readonly mechanismResources?: Readonly<Record<string, unknown>>;
    readonly workspaceFilesystem?: Readonly<AppOrdinaryWorkspaceFilesystemCompositionV1>;
  } = {},
) {
  const name = options.name ?? 'tool_search';
  const snapshot = createRuntimeHostToolCallSnapshotV1({
    toolCallId: 'call-1',
    name,
    rawArguments: options.rawArguments ?? (name === 'tool_search' ? { query: 'calendar' } : {}),
    argumentOrigin: options.argumentOrigin ?? 'model_public',
    createdAtTurnId: 'turn-1',
    modelMessageId: 'message-1',
    bindingId: null,
    capabilityId: null,
    capabilityRevision: null,
  });
  if (!snapshot.ok) throw new Error(snapshot.failure.code);
  return Object.freeze({
    turn: fixture.turn,
    snapshot: snapshot.value,
    resolution: Object.freeze({
      currentTurnId: 'turn-1',
      builtinProjectionRevision: options.revision ?? fixture.turn.projection.revision,
      dynamicCatalogRevision: null,
      availabilityContext: Object.freeze({
        workspace: '/workspace',
        threadId: 'thread-1',
        turnId: 'turn-1',
        modelMessageId: 'message-1',
        toolCallId: 'call-1',
        phase: 'building' as const,
        toolSearchEnabled: true,
        hasGitBroker: true,
        brokeredGitFeatureRevision: 'brokered-git-r1',
        featureFlags: Object.freeze({ brokeredGitV1: true }),
      }),
      bindings: Object.freeze([]),
      descriptors: Object.freeze([]),
      disclosures: Object.freeze([]),
    }),
    governance: Object.freeze({
      workspace: '/workspace',
      threadId: 'thread-1',
      context: Object.freeze({
        phase: 'building' as const,
        interactionMode: 'accept_edits' as const,
        authorizationMode: 'default' as const,
        sandboxAvailable: true,
        circuitBreakerTripped: false,
        gates: Object.freeze({
          recoveryAdmission: 'admitted' as const,
          boundedCancellation: 'admitted' as const,
          executionBoundary: 'admitted' as const,
          skillCapabilityCeiling: 'admitted' as const,
        }),
      }),
      approval: Object.freeze({
        status: 'queued' as const,
        grant: 'none' as const,
        approvedToolCallId: null,
        approvalBindingDigest: null,
      }),
    }),
    admission: Object.freeze({
      freshness: 'current' as const,
      reservationRequired: false,
      reservationIds: Object.freeze([]),
    }),
    threadId: 'thread-1',
    attempt: 1,
    taskId: null,
    planId: null,
    planStepId: null,
    capabilityRequestFacts:
      name === 'tool_search'
        ? createToolSearchProviderFactsV1({
            threadId: 'thread-1',
            turnId: 'turn-1',
            toolCallId: 'call-1',
          })
        : null,
    capabilityExecution: fixture.countedHost,
    signal: new AbortController().signal,
    mechanismResources: Object.freeze({
      workspace: '/workspace',
      ...(options.mechanismResources ?? {}),
    }),
    ...(options.workspaceFilesystem ? { workspaceFilesystem: options.workspaceFilesystem } : {}),
  });
}

function filesystemComposition() {
  const workspace = realpathSync(process.cwd());
  const grants = new WorkspaceFilesystemGrantAuthorityV1();
  const provider = new LocalWorkspaceFilesystemProviderV1(grants.verifier());
  let providerCalls = 0;
  const runtime: BuiltinWorkspaceFilesystemRuntimeV1 = Object.freeze({
    canonicalWorkspace: workspace,
    grants,
    provider: Object.freeze({
      observe: (input: Parameters<typeof provider.observe>[0]) => {
        providerCalls += 1;
        return provider.observe(input);
      },
      prepareMutation: (input: Parameters<typeof provider.prepareMutation>[0]) =>
        provider.prepareMutation(input),
      commitMutation: (input: Parameters<typeof provider.commitMutation>[0]) =>
        provider.commitMutation(input),
    }),
    preimageArtifacts: Object.freeze({
      write: () => {
        throw new Error('read-only ordinary test cannot write a preimage');
      },
    }),
  });
  return {
    composition: Object.freeze({
      runtime,
      protectedPathEvaluator: createProtectedPathEvaluatorV1({
        workspaceRoot: workspace,
        mode: 'deny',
      }),
      protectedPathRevision: 'ordinary-fsr-v1',
      actorIdentity: Object.freeze({ threadId: 'thread-1', actorId: 'parent' }),
    }) satisfies Readonly<AppOrdinaryWorkspaceFilesystemCompositionV1>,
    get providerCalls() {
      return providerCalls;
    },
  };
}

describe('RMV1-16 App ordinary Tool Pipeline attempt runtime', () => {
  test('executes tool_search through one Host acknowledgement and one registry call', async () => {
    const fixture = harness();
    const result = await fixture.runtime.execute(input(fixture));

    expect(fixture.runtime.schema).toBe(APP_ORDINARY_TOOL_PIPELINE_ATTEMPT_SCHEMA_V1);
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error(result.kind);
    expect(result.committed.result.status).toBe('success');
    expect(result.committed.result.structuredContent).toMatchObject({
      schema: 'kite.builtin-operation-result.v1',
      ok: true,
      runtimeEvents: [
        {
          type: 'capability.search_completed',
          result: { query: 'calendar', requestedAtTurnId: 'turn-1' },
        },
      ],
    });
    expect(fixture.calls).toEqual({ record: 1, host: 1, commit: 1, suspend: 0, unknown: 0 });
  });

  test('executes MCP inventory through one injected runtime and fails closed when it is absent', async () => {
    const fixture = harness();
    let snapshots = 0;
    const runtime = {
      getCapabilitySnapshot: () => {
        snapshots += 1;
        return { revision: 'cap-1', descriptors: [] };
      },
      getProviderDirectorySnapshot: () => ({ revision: 'providers-1', entries: [] }),
      getResourceDirectorySnapshot: () => ({ revision: 'resources-1', resources: [] }),
      findCapability: () => undefined,
      callCapability: async () => ({ content: [] }),
      readResource: async () => '',
    };
    const result = await fixture.runtime.execute(
      input(fixture, {
        name: 'list_mcp_tools',
        mechanismResources: Object.freeze({
          preassembledMechanism: Object.freeze({
            mcp: Object.freeze({ runtime }),
          }),
        }),
      }),
    );
    expect(result.kind).toBe('committed');
    expect(snapshots).toBe(1);
    expect(fixture.calls).toEqual({ record: 1, host: 1, commit: 1, suspend: 0, unknown: 0 });

    const missing = harness();
    const unavailable = await missing.runtime.execute(input(missing, { name: 'list_mcp_tools' }));
    expect(unavailable).toEqual({
      kind: 'governance_failure',
      code: 'mechanism_unavailable',
      diagnostic: 'The admitted Builtin execution mechanism is unavailable.',
    });
    expect(missing.calls).toEqual({ record: 0, host: 0, commit: 0, suspend: 0, unknown: 0 });
  });

  test('executes read_file through durable intent, one Host call, one Provider call, and authentic terminal evidence', async () => {
    const fixture = harness();
    const filesystem = filesystemComposition();
    const result = await fixture.runtime.execute(
      input(fixture, {
        name: 'read_file',
        rawArguments: { path: 'README.md' },
        workspaceFilesystem: filesystem.composition,
      }),
    );

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error(result.kind);
    expect(result.committed.result).toMatchObject({
      status: 'success',
      structuredContent: {
        schema: 'kite.builtin-operation-result.v1',
        ok: true,
        path: 'README.md',
        filesystemObservation: {},
      },
    });
    expect(filesystem.providerCalls).toBe(1);
    expect(fixture.calls).toEqual({ record: 1, host: 1, commit: 1, suspend: 0, unknown: 0 });
  });

  test('executes both filesystem searches through the same durable route without observation evidence', async () => {
    const cases = [
      {
        name: 'search_files',
        rawArguments: {
          path: 'packages/builtin-runtime/src/filesystem',
          pattern: '*evidence.ts',
        },
      },
      {
        name: 'search_content',
        rawArguments: {
          path: 'packages/builtin-runtime/src/filesystem/evidence.ts',
          pattern: 'filesystem intent',
        },
      },
    ] as const;
    for (const item of cases) {
      const fixture = harness();
      const filesystem = filesystemComposition();
      const result = await fixture.runtime.execute(
        input(fixture, {
          name: item.name,
          rawArguments: item.rawArguments,
          workspaceFilesystem: filesystem.composition,
        }),
      );
      expect(result.kind).toBe('committed');
      if (result.kind !== 'committed') throw new Error(result.kind);
      expect(result.committed.result.structuredContent).not.toHaveProperty('filesystemObservation');
      expect(filesystem.providerCalls).toBe(1);
      expect(fixture.calls).toEqual({ record: 1, host: 1, commit: 1, suspend: 0, unknown: 0 });
    }
  });

  test('projects one write_plan review into a suspended Host authority without a terminal commit', async () => {
    const fixture = harness();
    const reviewEvent = Object.freeze({
      type: 'plan.review_requested' as const,
      interactionId: 'review-1',
      toolCallId: 'call-1',
      taskId: 'task-1',
      plan: Object.freeze({
        name: 'Review pipeline',
        description: 'Review the suspended Tool Pipeline.',
        status: 'pending',
        steps: Object.freeze([
          Object.freeze({ id: 'review', step: 'Review the pipeline', status: 'pending' }),
        ]),
      }),
      planSummary: 'Review pipeline\n\n1. Review the pipeline',
      planId: 'plan-1',
      version: 1,
      structuralDigest: 'digest-1',
      artifact: Object.freeze({
        artifactId: 'plan-1:v1',
        taskId: 'task-1',
        planId: 'plan-1',
        version: 1,
        fileName: 'v1.md',
        relativePath: 'plans/task-1/plan-1/v1.md',
        displayPath: '/plans/task-1/plan-1/v1.md',
        structuralDigest: 'digest-1',
        byteLength: 128,
      }),
    });
    const planning = Object.freeze({
      read: async () => ({ ok: false, stdout: '', stderr: 'unused' }),
      update: async () => ({ ok: false, stdout: '', stderr: 'unused' }),
      write: async () => ({
        ok: true,
        stdout: '',
        stderr: '',
        runtimeEvents: Object.freeze([reviewEvent]),
      }),
    });
    const outcome = await fixture.runtime.execute(
      input(fixture, {
        name: 'write_plan',
        rawArguments: {
          action: 'submit',
          plan_id: 'plan-1',
          version: 1,
          structural_digest: 'digest-1',
        },
        mechanismResources: Object.freeze({
          preassembledMechanism: Object.freeze({ planning }),
        }),
      }),
    );

    expect(outcome.kind).toBe('suspended');
    if (outcome.kind !== 'suspended') throw new Error(outcome.kind);
    expect(outcome.suspended.suspension).toEqual({
      schema: 'kite.tool-pipeline-stage.v1',
      kind: 'plan_review',
      toolCallId: 'call-1',
      event: reviewEvent,
    });
    expect(outcome.suspended.result.structuredContent).toMatchObject({
      schema: 'kite.builtin-operation-result.v1',
      ok: true,
      runtimeEvents: [reviewEvent],
    });
    expect(fixture.calls).toEqual({ record: 1, host: 1, commit: 0, suspend: 1, unknown: 0 });
  });

  test('rejects task outside the cutover tranche before acknowledgement and Host', async () => {
    const fixture = harness();
    const result = await fixture.runtime.execute(
      input(fixture, {
        name: 'task',
        rawArguments: { subagent_type: 'explore', task: 'inspect the workspace' },
      }),
    );

    expect(result).toMatchObject({
      kind: 'stage_failure',
      failure: { stage: 'resolve', code: 'unsupported_operation' },
    });
    expect(fixture.calls).toEqual({ record: 0, host: 0, commit: 0, suspend: 0, unknown: 0 });
  });

  test('keeps private Task on the shared Host scope with one registry executor', async () => {
    const fixture = harness();
    const taskArtifact = {
      artifactId: `pa_${'0'.repeat(64)}`,
      kind: 'subagent_task_request' as const,
      integrityIdentifier: `hmac-sha256:${'0'.repeat(64)}`,
      byteLength: 1,
    };
    const candidate = input(fixture, {
      name: 'task',
      argumentOrigin: 'runtime_private',
      rawArguments: { subagent_type: 'explore', taskArtifact },
    });
    const resolved = fixture.turn.callbacks.resolve(candidate.snapshot, candidate.resolution);
    if (!resolved.ok) throw new Error(resolved.failure.code);
    const validated = fixture.turn.callbacks.validate(resolved.value);
    if (!validated.ok) throw new Error(validated.failure.code);
    const classified = fixture.turn.callbacks.classify(validated.value);
    if (!classified.ok) throw new Error(classified.failure.code);
    const projected = fixture.turn.governance.project(
      Object.freeze({ ...candidate.governance, classified: classified.value }),
      candidate.admission,
    );
    if (!projected.ok) throw new Error(projected.failure.code);
    const approvalBindingDigest = runtimeHostState25CreateApprovalBindingDigestV1(
      projected.value.invocation,
      projected.value.policy,
    );
    const approved = Object.freeze({
      ...candidate,
      governance: Object.freeze({
        ...candidate.governance,
        approval: Object.freeze({
          status: 'approved' as const,
          grant: 'approve_once' as const,
          approvedToolCallId: 'call-1',
          approvalBindingDigest,
        }),
      }),
    });
    let childCalls = 0;
    let suspensionCalls = 0;
    const taskRuntime = createAppTaskToolPipelineAttemptRuntimeV1({
      persistence: fixture.persistence,
      scope: fixture.scope,
    });
    const result = await taskRuntime.execute({
      ...approved,
      phase: 'building',
      executionMode: 'start',
      workspace: '/workspace',
      executeTask: async () => {
        childCalls += 1;
        return Object.freeze({ ok: true, summary: 'child completed', terminalStatus: 'completed' });
      },
      projectSuspension: () => {
        suspensionCalls += 1;
        return null;
      },
    });
    expect(result.kind).toBe('committed');
    expect(childCalls).toBe(1);
    expect(suspensionCalls).toBe(0);
    expect(fixture.calls).toEqual({ record: 1, host: 1, commit: 1, suspend: 0, unknown: 0 });
    await expect(
      taskRuntime.execute({
        ...approved,
        phase: 'building',
        executionMode: 'start',
        workspace: '/workspace',
        executeTask: async () => {
          childCalls += 1;
          return Object.freeze({ ok: true });
        },
        projectSuspension: () => null,
      }),
    ).rejects.toMatchObject({ code: 'duplicate_attempt' });
    expect(childCalls).toBe(1);
    expect(fixture.calls).toEqual({ record: 1, host: 1, commit: 1, suspend: 0, unknown: 0 });
  });

  test('projects an exact blocked Task result to suspension after one Host dispatch', async () => {
    const fixture = harness();
    const taskArtifact = {
      artifactId: `pa_${'1'.repeat(64)}`,
      kind: 'subagent_task_request' as const,
      integrityIdentifier: `hmac-sha256:${'2'.repeat(64)}`,
      byteLength: 1,
    };
    const candidate = input(fixture, {
      name: 'task',
      argumentOrigin: 'runtime_private',
      rawArguments: { subagent_type: 'code', taskArtifact },
    });
    const resolved = fixture.turn.callbacks.resolve(candidate.snapshot, candidate.resolution);
    if (!resolved.ok) throw new Error(resolved.failure.code);
    const validated = fixture.turn.callbacks.validate(resolved.value);
    if (!validated.ok) throw new Error(validated.failure.code);
    const classified = fixture.turn.callbacks.classify(validated.value);
    if (!classified.ok) throw new Error(classified.failure.code);
    const projected = fixture.turn.governance.project(
      Object.freeze({ ...candidate.governance, classified: classified.value }),
      candidate.admission,
    );
    if (!projected.ok) throw new Error(projected.failure.code);
    const approvalBindingDigest = runtimeHostState25CreateApprovalBindingDigestV1(
      projected.value.invocation,
      projected.value.policy,
    );
    const approved = Object.freeze({
      ...candidate,
      governance: Object.freeze({
        ...candidate.governance,
        approval: Object.freeze({
          status: 'approved' as const,
          grant: 'approve_once' as const,
          approvedToolCallId: 'call-1',
          approvalBindingDigest,
        }),
      }),
    });
    const continuationId = `continuation-${'3'.repeat(64)}`;
    const blockedTool = Object.freeze({
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' as const,
      toolCallId: 'child-call-1',
      runtimeToolCallId: 'runtime-child-call-1',
      toolName: 'write_file',
      command: 'write child file',
      args: Object.freeze({ path: 'note.txt', content: 'child' }),
      message: 'Child write requires approval.',
      continuation: Object.freeze({
        id: 'subagent-1',
        role: Object.freeze({ role: 'code' as const }),
        task: 'Write the child note.',
        messages: Object.freeze([]),
        toolCallCount: 1,
        steps: Object.freeze([]),
        toolRecovery: Object.freeze({}),
        modelInvocationOrdinal: 0,
      }),
    });
    const taskRuntime = createAppTaskToolPipelineAttemptRuntimeV1({
      persistence: fixture.persistence,
      scope: fixture.scope,
    });
    let observedTerminal: CapabilityToolTerminalResultV1 | undefined;
    const result = await taskRuntime.execute({
      ...approved,
      phase: 'building',
      executionMode: 'start',
      workspace: '/workspace',
      executeTask: async () =>
        Object.freeze({
          ok: false,
          summary: 'blocked child',
          toolCallCount: 1,
          durationMs: 2,
          terminalStatus: 'suspended' as const,
          blocked: blockedTool,
        }),
      projectSuspension: ({ terminal, prepared }) => {
        observedTerminal = terminal;
        return Object.freeze({
          schema: 'kite.tool-pipeline-stage.v1' as const,
          kind: 'task_subagent' as const,
          operationId: 'builtin:task' as const,
          executionMode: 'start' as const,
          toolCallId: 'call-1',
          parent: Object.freeze({
            toolCallId: 'call-1',
            invocationId: prepared.identity.invocationId,
            attemptId: prepared.identity.attemptId,
            attempt: 1,
          }),
          subagent: Object.freeze({
            storage: 'private_artifact_v1' as const,
            subagentId: 'subagent-1',
            role: 'code' as const,
            continuationId,
            modelInvocationOrdinal: 0,
            continuationArtifact: Object.freeze({
              artifactId: `pa_${'4'.repeat(64)}`,
              kind: 'subagent_continuation' as const,
              integrityIdentifier: `hmac-sha256:${'5'.repeat(64)}`,
              byteLength: 1,
            }),
            parentInvocationId: prepared.identity.invocationId,
            parentAttempt: 1,
            blockedTool: Object.freeze({
              reasonCode: blockedTool.reasonCode,
              toolCallId: blockedTool.toolCallId,
              runtimeToolCallId: blockedTool.runtimeToolCallId,
              toolName: blockedTool.toolName,
            }),
          }),
          blockedTool: Object.freeze({
            toolCallId: blockedTool.toolCallId,
            runtimeToolCallId: blockedTool.runtimeToolCallId,
            toolName: blockedTool.toolName,
            argumentsDigest: digestCapabilityValueV1(blockedTool.args),
            commandDigest: digestCapabilityValueV1(blockedTool.command.trim()),
          }),
          event: Object.freeze({
            type: 'approval.requested' as const,
            interactionId: 'interaction-1',
            toolCallId: 'call-1',
            approval: Object.freeze({
              scope: 'once' as const,
              callId: blockedTool.runtimeToolCallId,
              cwd: '/workspace',
              threadId: 'thread-1',
              tool: blockedTool.toolName,
              command: blockedTool.command,
              risk: 'write_file' as const,
              approvalHash: 'approval-hash-1',
              summary: 'Child write requires approval.',
              reason: 'Child write requires approval.',
              expectedEffects: Object.freeze(['child file update']),
              grantOptions: Object.freeze(['approve_once' as const]),
              recommendedGrant: 'approve_once' as const,
            }),
          }),
        });
      },
    });
    expect(result.kind).toBe('suspended');
    expect(observedTerminal?.structuredContent).toMatchObject({
      subagentResult: { blocked: { toolCallId: 'child-call-1' } },
    });
    expect(fixture.calls).toEqual({ record: 1, host: 1, commit: 0, suspend: 1, unknown: 0 });
  });

  test('keeps child failure terminal and turns malformed blocked projection into unknown', async () => {
    const failureFixture = harness();
    const taskArtifact = {
      artifactId: `pa_${'6'.repeat(64)}`,
      kind: 'subagent_task_request' as const,
      integrityIdentifier: `hmac-sha256:${'7'.repeat(64)}`,
      byteLength: 1,
    };
    const candidate = input(failureFixture, {
      name: 'task',
      argumentOrigin: 'runtime_private',
      rawArguments: { subagent_type: 'explore', taskArtifact },
    });
    const resolved = failureFixture.turn.callbacks.resolve(
      candidate.snapshot,
      candidate.resolution,
    );
    if (!resolved.ok) throw new Error(resolved.failure.code);
    const validated = failureFixture.turn.callbacks.validate(resolved.value);
    if (!validated.ok) throw new Error(validated.failure.code);
    const classified = failureFixture.turn.callbacks.classify(validated.value);
    if (!classified.ok) throw new Error(classified.failure.code);
    const projected = failureFixture.turn.governance.project(
      Object.freeze({ ...candidate.governance, classified: classified.value }),
      candidate.admission,
    );
    if (!projected.ok) throw new Error(projected.failure.code);
    const approvalBindingDigest = runtimeHostState25CreateApprovalBindingDigestV1(
      projected.value.invocation,
      projected.value.policy,
    );
    const approved = Object.freeze({
      ...candidate,
      governance: Object.freeze({
        ...candidate.governance,
        approval: Object.freeze({
          status: 'approved' as const,
          grant: 'approve_once' as const,
          approvedToolCallId: 'call-1',
          approvalBindingDigest,
        }),
      }),
    });
    const taskRuntime = createAppTaskToolPipelineAttemptRuntimeV1({
      persistence: failureFixture.persistence,
      scope: failureFixture.scope,
    });
    const failure = await taskRuntime.execute({
      ...approved,
      phase: 'building',
      executionMode: 'start',
      workspace: '/workspace',
      executeTask: async () =>
        Object.freeze({ ok: false, summary: 'child failed', terminalStatus: 'failed' as const }),
      projectSuspension: () => null,
    });
    expect(failure.kind).toBe('committed');
    expect(failureFixture.calls).toEqual({ record: 1, host: 1, commit: 1, suspend: 0, unknown: 0 });

    const malformedFixture = harness();
    const malformedCandidate = input(malformedFixture, {
      name: 'task',
      argumentOrigin: 'runtime_private',
      rawArguments: {
        subagent_type: 'explore',
        taskArtifact: {
          artifactId: `pa_${'8'.repeat(64)}`,
          kind: 'subagent_task_request',
          integrityIdentifier: `hmac-sha256:${'9'.repeat(64)}`,
          byteLength: 1,
        },
      },
    });
    const malformedResolved = malformedFixture.turn.callbacks.resolve(
      malformedCandidate.snapshot,
      malformedCandidate.resolution,
    );
    if (!malformedResolved.ok) throw new Error(malformedResolved.failure.code);
    const malformedValidated = malformedFixture.turn.callbacks.validate(malformedResolved.value);
    if (!malformedValidated.ok) throw new Error(malformedValidated.failure.code);
    const malformedClassified = malformedFixture.turn.callbacks.classify(malformedValidated.value);
    if (!malformedClassified.ok) throw new Error(malformedClassified.failure.code);
    const malformedProjected = malformedFixture.turn.governance.project(
      Object.freeze({ ...malformedCandidate.governance, classified: malformedClassified.value }),
      malformedCandidate.admission,
    );
    if (!malformedProjected.ok) throw new Error(malformedProjected.failure.code);
    const malformedApprovalBindingDigest = runtimeHostState25CreateApprovalBindingDigestV1(
      malformedProjected.value.invocation,
      malformedProjected.value.policy,
    );
    const malformedRuntime = createAppTaskToolPipelineAttemptRuntimeV1({
      persistence: malformedFixture.persistence,
      scope: malformedFixture.scope,
    });
    await expect(
      malformedRuntime.execute({
        ...malformedCandidate,
        governance: Object.freeze({
          ...malformedCandidate.governance,
          approval: Object.freeze({
            status: 'approved' as const,
            grant: 'approve_once' as const,
            approvedToolCallId: 'call-1',
            approvalBindingDigest: malformedApprovalBindingDigest,
          }),
        }),
        phase: 'building',
        executionMode: 'start',
        workspace: '/workspace',
        executeTask: async () =>
          Object.freeze({
            ok: false,
            summary: 'malformed blocked child',
            terminalStatus: 'suspended' as const,
            blocked: Object.freeze({ marker: true }),
          }),
        projectSuspension: () => null,
      }),
    ).rejects.toMatchObject({ code: 'unknown_outcome' });
    expect(malformedFixture.calls).toEqual({
      record: 1,
      host: 1,
      commit: 0,
      suspend: 0,
      unknown: 1,
    });
  });

  test('projects ask_user to Kernel governance without attempt, Host, or terminal persistence', async () => {
    const fixture = harness();
    const result = await fixture.runtime.execute(
      input(fixture, {
        name: 'ask_user',
        rawArguments: {
          questions: [
            {
              question: 'Continue?',
              options: [
                { label: 'Yes', description: 'Continue the task.', recommended: true },
                { label: 'No', description: 'Stop the task.', recommended: false },
              ],
            },
          ],
        },
      }),
    );

    expect(result).toMatchObject({
      kind: 'governance_terminal',
      classified: {
        validated: {
          resolved: {
            target: {
              operationId: 'builtin:ask_user',
              executionMechanism: 'user_input',
            },
          },
        },
      },
      decision: { kind: 'request_user_input' },
    });
    expect(fixture.calls).toEqual({ record: 0, host: 0, commit: 0, suspend: 0, unknown: 0 });
  });

  test('rejects projection drift and duplicate attempt without fallback', async () => {
    const fixture = harness();
    const drift = await fixture.runtime.execute(input(fixture, { revision: 'stale' }));
    expect(drift).toMatchObject({
      kind: 'stage_failure',
      failure: { code: 'resolution_context_invalid' },
    });
    expect(fixture.calls).toEqual({ record: 0, host: 0, commit: 0, suspend: 0, unknown: 0 });

    await fixture.runtime.execute(input(fixture));
    await expect(fixture.runtime.execute(input(fixture))).rejects.toMatchObject({
      code: 'duplicate_attempt',
    });
    expect(fixture.calls).toEqual({ record: 1, host: 1, commit: 1, suspend: 0, unknown: 0 });
  });
});
