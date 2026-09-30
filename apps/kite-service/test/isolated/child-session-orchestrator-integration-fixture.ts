import { expect } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyToolOutcome } from '@kite-ai/agent-kernel';
import {
  capabilityResultDigest,
  capabilityResultEvidenceDigest,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';
import {
  SubagentGrantAuthority,
  SubagentTaskArtifactStore,
} from '@kite-ai/builtin-runtime/subagent';
import {
  createRuntimeAbortReason,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeNotification,
} from '@kite-ai/runtime-contract';
import {
  createRuntimeHostCapabilityExecutionPortFromSnapshot,
  type RuntimeHostExecutionServices,
  resolveProjectIdentity,
} from '@kite-ai/runtime-host';
import {
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  INTERNAL_RESOURCE_BUDGET_,
  resourceDeadlineMs,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  createRuntimeRunStartResourceResult,
  createRuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';
import { EffectSupervisor } from '../../../../packages/runtime-host/src/lifecycle/effect-supervisor';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import { createKiteSessionAppServerStorageComposition } from '../../src/bootstrap';
import { createKiteHomeBuiltinArtifactBackends } from '../../src/bootstrap/kite-home-artifact-backends';
import { createKiteModelOperationExecutionPort } from '../../src/bootstrap/model-operation-execution';
import { createInstalledKiteRuntimeCompositionFactory } from '../../src/bootstrap/model-runtime-composition';
import {
  createRuntimeSessionCoordinatorBinding,
  type RuntimeSessionCoordinatorIdentity,
} from '../../src/bootstrap/runtime/RuntimeSessionCoordinator';
import { reconcileRuntimeSessionAfterRestart } from '../../src/bootstrap/runtime/session-restart-recovery';
import type {
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from '../../src/bootstrap/runtime/state-runtime';
import { createChildSessionAcceptanceStage } from '../../src/bootstrap/runtime/subagent/child-session-acceptance';
import { activateAcceptedChildSession } from '../../src/bootstrap/runtime/subagent/child-session-activation';
import { buildChildSessionCreation } from '../../src/bootstrap/runtime/subagent/child-session-creation';
import { createChildSessionOrchestrator } from '../../src/bootstrap/runtime/subagent/child-session-orchestrator';
import { createAppToolPipelineComposition } from '../../src/bootstrap/runtime/tool-pipeline-composition';

export interface CompletedChildOrchestrationFixture {
  readonly owner: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>>;
  readonly services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
  readonly coordinators: ReturnType<
    ReturnType<typeof createRuntimeSessionCoordinatorBinding>['access']
  >;
  readonly parentCoordinator: ReturnType<
    CompletedChildOrchestrationFixture['coordinators']['ensure']
  >;
  readonly orchestrator: ReturnType<typeof createChildSessionOrchestrator>;
  readonly modelRuntimeFactory: (workspace: string) => ReturnType<
    ReturnType<typeof createInstalledKiteRuntimeCompositionFactory>
  > & {
    readonly toolPipelineComposition?: ReturnType<typeof createAppToolPipelineComposition>;
  };
  readonly capabilities: ReturnType<typeof createRuntimeHostCapabilityExecutionPortFromSnapshot>;
  readonly builtinToolCatalog: ReturnType<typeof createBuiltinToolCatalogProjection>;
  readonly model: ReturnType<typeof createMockModelServer>;
  readonly bridgeInput: Parameters<typeof createChildSessionOrchestrator>[0]['bridgeInput'];
  readonly parentSessionId: string;
  readonly parentRunId: string;
  readonly childSessionId: string;
  readonly acceptedChild?: Parameters<
    ReturnType<typeof createChildSessionOrchestrator>['onAccepted']
  >[0];
  readonly workspace: string;
  readonly childNotifications: readonly RuntimeNotification[];
}

export async function exerciseChildOrchestration(
  recoverAcceptedIntent: boolean,
  crashAfterAttempt = false,
  cancelAfterAttempt = false,
  cancelViaTaskControl = false,
  stopBeforeDispatch = false,
  stopAfterAckBeforeDispatch = false,
  stopBeforeCrash = false,
  failRecoveryQueue = false,
  afterCompletedChild?: (fixture: CompletedChildOrchestrationFixture) => Promise<void>,
  sourceAutoRevision = false,
  duringActiveChild?: (
    fixture: CompletedChildOrchestrationFixture,
    releaseChildResponse: () => void,
  ) => Promise<void>,
  duringQueuedChild?: (fixture: CompletedChildOrchestrationFixture) => Promise<void>,
  duringAcknowledgedChild?: (fixture: CompletedChildOrchestrationFixture) => Promise<void>,
  zeroToolChild = false,
  childDeadlineMs = 120_000,
  retryChildModel = false,
  shellApprovalChild = false,
  shortInitialLease = false,
): Promise<void> {
  const durableHome = process.env.KITE_D3_SIGKILL_HOME;
  const localModelBaseURL = process.env.KITE_D3_SIGKILL_MOCK_URL;
  if (durableHome) {
    const temporaryRoot = realpathSync(tmpdir());
    const resolvedHome = realpathSync(durableHome);
    if (
      !resolvedHome.startsWith(`${temporaryRoot}/kite-d3-sigkill-`) ||
      resolvedHome !== durableHome
    )
      throw new Error('D3 process fixture requires its existing synthetic temporary home.');
  }
  if (localModelBaseURL) {
    const endpoint = new URL(localModelBaseURL);
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error('D3 process fixture accepts only the parent-owned loopback mock Model.');
  }
  const home = durableHome ?? mkdtempSync(join(realpathSync(tmpdir()), 'kite-child-orchestrator-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = localModelBaseURL
    ? ({
        baseURL: localModelBaseURL,
        setResponses: () => undefined,
        getRequestCount: () => 0,
        assertComplete: () => undefined,
        stop: () => undefined,
      } as unknown as ReturnType<typeof createMockModelServer>)
    : createMockModelServer();
  const childGate = deferred();
  const childWork: Promise<void>[] = [];
  const childNotifications: RuntimeNotification[] = [];
  let childModelRequests = 0;
  model.setResponses(
    Array.from(
      {
        length:
          duringQueuedChild || duringAcknowledgedChild
            ? 0
            : retryChildModel
              ? 2
              : afterCompletedChild || duringActiveChild
                ? 1
                : 4,
      },
      () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          childModelRequests += 1;
          expect(JSON.stringify(messages)).toContain('ORCHESTRATED_CHILD_TASK');
          if (crashAfterAttempt || cancelAfterAttempt || cancelViaTaskControl || duringActiveChild)
            await childGate.promise;
          if (retryChildModel && childModelRequests === 1)
            return { error: 'PRIVATE_PROVIDER_FAILURE' };
          return { message: { content: 'ORCHESTRATED_CHILD_RESULT' } };
        },
      }),
    ),
  );
  const owner = await createKiteSessionAppServerStorageComposition({
    databasePath: join(home, 'kite-session.sqlite'),
    hostInstanceId: 'orchestrator-integration-host',
    ...(crashAfterAttempt || shortInitialLease
      ? { executionLeaseMs: 120, renewIntervalMs: 40 }
      : durableHome
        ? { executionLeaseMs: 1_000, renewIntervalMs: 200 }
        : {}),
  });
  let recoveredOwner: typeof owner | undefined;
  let recoveredBinding: ReturnType<typeof createRuntimeSessionCoordinatorBinding> | undefined;
  const parentSessionId = 'orchestrator-parent';
  const parentRunId = 'orchestrator-parent-run';
  const parentInvocationId = 'orchestrator-parent-invocation';
  const parentToolCallId = 'orchestrator-task-tool';
  const childInvocationId = 'orchestrator-child-invocation';
  const now = Date.now();
  const deadlineAt = new Date(now + childDeadlineMs).toISOString();
  const project = resolveProjectIdentity(workspace);
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  const capabilitySnapshot = registry.snapshot();
  const builtinToolCatalog = createBuiltinToolCatalogProjection(capabilitySnapshot);
  const capabilities = createRuntimeHostCapabilityExecutionPortFromSnapshot(capabilitySnapshot);
  const backends = createKiteHomeBuiltinArtifactBackends(owner.artifactStore);
  const installedModelRuntimeFactory = createInstalledKiteRuntimeCompositionFactory(
    createKiteModelOperationExecutionPort(capabilities, builtinToolCatalog),
    backends,
  );
  const modelRuntimeFactory = (canonicalWorkspace: string) => ({
    ...installedModelRuntimeFactory(canonicalWorkspace),
    ...(afterCompletedChild || duringAcknowledgedChild
      ? { toolPipelineComposition: createAppToolPipelineComposition(builtinToolCatalog) }
      : {}),
  });
  const hostServices: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState> =
    new EffectSupervisor(owner.storage).services;
  const haltAfterCommittedStage = (
    stage:
      | 'prepared'
      | 'activated'
      | 'attempt_started'
      | 'current_turn_routed'
      | 'current_turn_prepared',
  ): void => {
    if (!durableHome || process.env.KITE_D3_SIGKILL_STAGE !== stage) return;
    writeFileSync(join(home, 'stage.marker'), stage);
    const result = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
    if (result === 'timed-out') throw new Error('D3 crash marker was not terminated.');
  };
  const services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState> = {
    ...hostServices,
    transactions: {
      ...hostServices.transactions,
      commit: (acknowledgement, transaction, requiredLease) => {
        hostServices.transactions.commit(acknowledgement, transaction, requiredLease);
        if (
          acknowledgement === 'decision' &&
          transaction.sessionId !== parentSessionId &&
          transaction.snapshot.activeFollowupTurn &&
          transaction.events.some((event) => event.type === 'model.invocation_prepared')
        )
          haltAfterCommittedStage('prepared');
        if (
          acknowledgement === 'decision' &&
          transaction.crossSessionAgentMailMutation?.kind === 'route_followup' &&
          transaction.crossSessionAgentMailMutation.route === 'new_turn'
        )
          haltAfterCommittedStage('activated');
        if (
          acknowledgement === 'decision' &&
          transaction.crossSessionAgentMailMutation?.kind === 'route_followup' &&
          transaction.crossSessionAgentMailMutation.route === 'current_turn'
        )
          haltAfterCommittedStage('current_turn_routed');
        if (
          acknowledgement === 'decision' &&
          transaction.crossSessionAgentMailMutation?.kind === 'release_current_turn_backup'
        )
          haltAfterCommittedStage('current_turn_prepared');
        if (
          transaction.sessionId !== parentSessionId &&
          transaction.snapshot.activeFollowupTurn &&
          transaction.events.some((event) => event.type === 'model.invocation_attempt_started')
        )
          haltAfterCommittedStage('attempt_started');
      },
    },
  };
  const store: StateRuntimeStorage = {
    sessions: services.sessions,
    transactions: services.transactions,
    effects: services.leases,
    checkpoints: services.checkpoints,
    recoveryIdentities: services.recoveryIdentities,
    commandReceipts: owner.storage.commandReceipts,
    close: () => undefined,
  };
  const binding = createRuntimeSessionCoordinatorBinding();
  binding.bind({
    services,
    capabilities,
    capabilityRegistrySnapshot: capabilitySnapshot,
    builtinToolCatalog,
    modelRuntimeFactory,
    store,
  });
  const coordinators = binding.access();
  const recoveryIdentityKey = 'a'.repeat(64);
  const identity: RuntimeSessionCoordinatorIdentity = {
    sessionId: parentSessionId,
    userId: 'orchestrator-user',
    workspace,
    projectId: project.projectId,
    canonicalWorkspaceDigest: project.workspaceDigest,
    interactionMode: 'accept_edits',
    recoveryIdentityKey,
    sandboxAvailable: true,
    modelArtifactEvidence: modelRuntimeFactory(workspace).evidence,
    capabilityArtifactEvidence: modelRuntimeFactory(workspace).capabilityArtifacts,
  };
  const transient = createZeroResourceUsage('versioned_upper_bound', 'test-task-v1');
  transient.counters.toolInvocations = 1;
  transient.counters.artifactBytes = 1024 * 1024;
  const transientReservationId = '00000000-0000-4000-8000-000000000001';
  const base = createRuntimeHostStateInitialState({
    threadId: parentSessionId,
    userId: identity.userId,
    workspace,
    projectId: identity.projectId,
    canonicalWorkspaceDigest: identity.canonicalWorkspaceDigest,
    recoveryIdentityKey,
    interactionMode: 'accept_edits',
  });
  const parent: RuntimeState = {
    ...base,
    turn: { turnId: parentRunId, turnIndex: 1, status: 'active' },
    resourceBudget: {
      status: 'active',
      runId: parentRunId,
      startedAt: new Date(now).toISOString(),
      deadlineAt,
      budget: INTERNAL_RESOURCE_BUDGET_,
      reconciledUsage: createZeroResourceUsage(),
      reservations: {},
      waiters: {},
      nextWaiterSequence: 0,
    },
  };
  const run = {
    sessionId: parentSessionId,
    runId: parentRunId,
    startCommandId: 'start-orchestrator-parent',
    phase: 'building' as const,
    status: 'queued' as const,
    createdRevision: 1,
    lastRevision: 1,
    createdAtMs: now,
  };
  const taskArtifacts = new SubagentTaskArtifactStore({ backend: backends.subagentTask });
  try {
    expect(
      owner.storage.recoveryIdentities.getOrCreate(parentSessionId, () => recoveryIdentityKey),
    ).toBe(recoveryIdentityKey);
    owner.storage.transactions.commitDecision({
      sessionId: parentSessionId,
      events: [],
      snapshot: parent,
      sessionModelRoute: { provider: 'fixture', name: 'mock-model' },
      commandReceipt: createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: parentSessionId,
          commandId: 'create-orchestrator-parent',
          requestDigest: 'f'.repeat(64),
          targetSessionId: parentSessionId,
          committedAt: now,
        },
        0,
      ),
    });
    owner.storage.transactions.commitDecision({
      sessionId: parentSessionId,
      events: [{ type: 'turn.started', turnId: parentRunId }],
      metadata: [{ eventId: 'parent-run-started', revision: 1 }],
      snapshot: { ...parent, revision: 1 },
      commandReceipt: createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: parentSessionId,
          commandId: run.startCommandId,
          requestDigest: 'e'.repeat(64),
          targetSessionId: parentSessionId,
          committedAt: now,
          resourceResult: createRuntimeRunStartResourceResult(run),
        },
        1,
      ),
      runMutation: { type: 'insert', run },
    });
    owner.runWithSessionExecution(parentSessionId, () =>
      owner.storage.runs!.transition({
        sessionId: parentSessionId,
        runId: parentRunId,
        expectedLastRevision: 1,
        next: { ...run, status: 'running', startedAtMs: now },
      }),
    );
    const parentCoordinator = coordinators.ensure(identity);
    if (sourceAutoRevision)
      owner.runWithSessionExecution(parentSessionId, () =>
        parentCoordinator.control.processEventBatch([
          {
            type: 'interaction_mode.changed',
            mode: 'auto',
            source: 'user',
            changedAt: new Date().toISOString(),
          },
        ]),
      );
    owner.runWithSessionExecution(parentSessionId, () =>
      parentCoordinator.control.processEventBatch([
        {
          type: 'tool.queued',
          toolCallId: parentToolCallId,
          name: 'task',
          args: {
            name: shellApprovalChild ? 'Code' : 'Review',
            subagent_type: shellApprovalChild ? 'code' : 'review',
            task: 'ORCHESTRATED_CHILD_TASK',
            background: true,
            result_disposition: 'required',
          },
          modelMessageId: 'parent-model-message',
        },
        { type: 'tool.started', toolCallId: parentToolCallId },
        {
          type: 'capability.invocation_recorded',
          invocationId: parentInvocationId,
          toolCallId: parentToolCallId,
          capabilityId: 'builtin:task',
          capabilityRevision: 'v1',
          argumentsDigest: `sha256:${'b'.repeat(64)}`,
          authorizationDigest: `sha256:${'c'.repeat(64)}`,
          admissionDigest: `sha256:${'2'.repeat(64)}`,
          effectiveEffectsDigest: `sha256:${'d'.repeat(64)}`,
          effectiveEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
          receiptRequirement: 'observation_receipt',
          recordedAt: new Date().toISOString(),
        },
        {
          type: 'capability.execution_started',
          invocationId: parentInvocationId,
          attempt: 1,
          startedAt: new Date().toISOString(),
        },
        {
          type: 'resource_budget.reserved',
          reservation: {
            version: 1,
            reservationId: transientReservationId,
            runId: parentRunId,
            invocationId: `tool:${parentToolCallId}`,
            resourceKind: 'subagent',
            executableUpperBound: transient,
            state: 'reserved',
          },
        },
        { type: 'resource_budget.dispatch_started', reservationId: transientReservationId },
      ]),
    );
    const task = owner.runWithSessionExecution(parentSessionId, () =>
      taskArtifacts.write({
        owner: {
          parentInvocationId,
          parentAttempt: 1,
          parentToolCallId,
          childInvocationId,
        },
        task: 'ORCHESTRATED_CHILD_TASK',
      }),
    );
    expect(
      owner.runWithSessionExecution(parentSessionId, () =>
        taskArtifacts.read(task.ref, {
          parentInvocationId,
          parentAttempt: 1,
          parentToolCallId,
          childInvocationId,
          taskDigest: task.taskDigest,
        }),
      ).task,
    ).toBe('ORCHESTRATED_CHILD_TASK');
    const grant = new SubagentGrantAuthority().issueStart({
      parentInvocationId,
      parentToolCallId,
      parentAttempt: 1,
      capabilityRevision: '1'.repeat(64),
      admissionDigest: '2'.repeat(64),
      effectiveEffectsDigest: '3'.repeat(64),
      childInvocationId,
      role: shellApprovalChild ? 'code' : 'review',
      taskArtifact: task.ref,
      taskDigest: task.taskDigest,
      capabilityCeiling: {
        allowedTools: zeroToolChild
          ? []
          : shellApprovalChild
            ? ['read_file', 'shell_execute']
            : ['read_file'],
        bindingIds: [],
        bindingRevision: '4'.repeat(64),
        ceilingDigest: '5'.repeat(64),
      },
      authorization: {
        authorizationDigest: '6'.repeat(64),
        interactionMode: sourceAutoRevision ? 'auto' : 'accept_edits',
        phase: 'building',
        workspaceAccess: 'write',
      },
      executionBoundary: {
        canonicalWorkspace: workspace,
        executionBoundaryDigest: `sha256:${'7'.repeat(64)}`,
      },
      resource: { parentReservationId: null, budgetDigest: '8'.repeat(64) },
      cancellationCorrelation: parentToolCallId,
      model: { parentModelInvocationId: 'parent-model', parentToolCallId },
    });
    const bridgeInput = {
      sessionId: parentSessionId,
      userId: identity.userId,
      workspace,
      projectIdentity: project,
      checkpointPath: join(home, 'kite-session.sqlite'),
      config: {
        providerName: 'fixture',
        providerType: 'openai-compatible' as const,
        apiKey: 'fixture-key',
        baseURL: model.baseURL,
        modelName: 'mock-model',
        modelKwargs: { maxOutputTokens: 64 },
        modelCapabilities: {
          contextWindowTokens: shellApprovalChild ? 8_192 : 4_096,
          maxOutputTokens: 64,
        },
        features: { resourceBudget: true, boundedCancellation: shellApprovalChild },
        sandbox: { enabled: shellApprovalChild },
      },
      shellExecutor: async ({ command }: { command: string }) => ({
        ok: true as const,
        command,
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
      interactionMode: 'accept_edits' as const,
      sandboxBackend: shellApprovalChild ? ('seatbelt' as const) : ('none' as const),
      skillOptions: {
        userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
        userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
        projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
        projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
      },
      initialSkillActivations: [],
    };
    const createOrchestrator = (rejectQueue = false) =>
      createChildSessionOrchestrator({
        detachedScope: new AsyncResource('child-test-scope'),
        owner,
        effectLeases: services.leases,
        parentSessionId,
        bridgeInput,
        coordinators,
        modelRuntimeFactory: (canonicalWorkspace) => ({
          ...modelRuntimeFactory(canonicalWorkspace),
          builtinToolCatalog,
        }),
        capabilityExecution: capabilities,
        projectChildSession: (sessionId, state) => ({
          schema: RUNTIME_PROJECTION_SCHEMA_,
          sessionId,
          revision: state.revision,
          lifecycle: 'open',
          interactionQueue: { revision: state.revision, interactions: [] },
        }),
        publishChildNotification: (notification) => childNotifications.push(notification),
        ...(afterCompletedChild || duringAcknowledgedChild
          ? {
              readCurrentSourceFollowupContext: () => ({
                mcpSnapshot: null,
                skillCatalog: null,
                agentMailboxPortAvailable: true,
                agentMailboxQueueOnlyAvailable: false,
                interactionModeOverride: null,
              }),
              readCurrentTargetPolicyContext: ({ targetState }: { targetState: RuntimeState }) => ({
                observedTargetRevision: targetState.revision,
                mcpSnapshot: null,
                skillCatalog: null,
              }),
            }
          : {}),
        enqueueSessionWork: async (_sessionId, work) => {
          if (rejectQueue) throw new Error('Injected child work queue failure.');
          const workPromise = work();
          childWork.push(
            workPromise.then(
              () => undefined,
              () => undefined,
            ),
          );
          return await workPromise;
        },
      });
    const orchestrator = createOrchestrator();
    const accepted = [] as Parameters<typeof orchestrator.onAccepted>[0][];
    const callbackFixture = (): CompletedChildOrchestrationFixture => ({
      owner,
      services,
      coordinators,
      parentCoordinator,
      orchestrator,
      modelRuntimeFactory,
      capabilities,
      builtinToolCatalog,
      model,
      bridgeInput,
      parentSessionId,
      parentRunId,
      childSessionId: accepted[0]!.childThreadId,
      acceptedChild: accepted[0]!,
      workspace,
      childNotifications,
    });
    const parentToolEffectLease = parentCoordinator.session.beginEffect({
      type: 'run_tools',
      toolCallIds: [parentToolCallId],
    });
    const stage = createChildSessionAcceptanceStage({
      getState: () => parentCoordinator.getState(),
      effectLeases: {
        tryAcquireEffectLease: services.leases.tryAcquire,
        releaseEffectLease: services.leases.release,
      },
      commit: async (events, requiredEffectLease, sealedGrant) =>
        parentCoordinator.session.commitBackgroundChildAcceptance(
          parentToolEffectLease,
          events,
          { ...requiredEffectLease, sessionId: parentSessionId },
          sealedGrant,
        ),
      onAccepted: (child) => {
        accepted.push(child);
      },
    });
    stage.stage({
      grant,
      name: shellApprovalChild ? 'Independent coder' : 'Independent reviewer',
      role: shellApprovalChild ? 'code' : 'review',
      originRunId: parentRunId,
      originTurnId: parentRunId,
      disposition: 'required',
    });
    const capabilityResult = {
      status: 'success' as const,
      content: [{ type: 'text', text: 'Accepted independent child.' }],
    };
    const capabilityArtifact = owner.runWithSessionExecution(parentSessionId, () =>
      modelRuntimeFactory(workspace).capabilityArtifacts.write(
        parentInvocationId,
        capabilityResult,
      ),
    );
    expect(
      await owner.runWithSessionExecution(parentSessionId, () =>
        stage.commitReceipt([
          {
            type: 'capability.execution_succeeded',
            invocationId: parentInvocationId,
            resultDigest: capabilityResultDigest(capabilityResult),
            evidenceDigest: capabilityResultEvidenceDigest(capabilityResult),
            artifact: capabilityArtifact,
            finishedAt: new Date().toISOString(),
          },
          {
            type: 'tool.finished',
            toolCallId: parentToolCallId,
            name: 'task',
            result: {
              ok: true,
              command: '',
              exitCode: 0,
              stdout: '',
              stderr: '',
              resultMeta: {
                taskId: childInvocationId,
                taskStatus: 'running',
                taskDisposition: 'required',
              },
            },
            outcome: classifyToolOutcome({
              status: 'success',
              authority: { dispatchState: 'started', externalEffects: 'none' },
            }),
          },
        ]),
      ),
    ).toBe(true);
    await Bun.sleep(0);
    expect(accepted).toHaveLength(1);
    expect(owner.readChildSessionIntent(accepted[0]!.childThreadId)).not.toBeNull();
    const persistedIntent = owner.readChildSessionIntent(accepted[0]!.childThreadId);
    if (!persistedIntent) throw new Error('Accepted child intent disappeared.');
    const sealedGrant = owner.runWithSessionExecution(parentSessionId, () =>
      owner.readChildSealedGrant(accepted[0]!.childThreadId),
    );
    if (!sealedGrant) throw new Error('Accepted child grant disappeared.');
    expect(parentCoordinator.getState().resourceBudget).toMatchObject({
      status: 'active',
      runId: parentRunId,
      deadlineAt,
      reservations: {
        [persistedIntent.delegatedReservationId]: { state: 'reserved' },
      },
    });
    const creation = buildChildSessionCreation({
      intent: { ...persistedIntent, ...sealedGrant },
      parentState: parentCoordinator.getState(),
      admittedWorkspace: workspace,
      parentModelRoute: owner.storage.sessions.getSessionModelRoute(parentSessionId),
      workerInstanceId: owner.hostInstanceId,
      executionClientId: owner.executionClientId,
      executionConnectionGeneration: owner.executionConnectionGeneration,
      nowMs: Date.now(),
    });
    expect(creation.runtime.snapshot.childSessionOrigin?.childInvocationId).toBe(childInvocationId);
    if (duringQueuedChild) {
      expect(
        owner.createChildSession(
          shortInitialLease
            ? {
                ...creation,
                controller: {
                  ...creation.controller,
                  executionLeaseUntilMs: Date.now() + 120,
                },
              }
            : creation,
        ).status,
      ).toBe('applied');
      expect(owner.loadCurrentSnapshot(accepted[0]!.childThreadId)?.revision).toBe(0);
      await duringQueuedChild(callbackFixture());
      return;
    }
    if (stopAfterAckBeforeDispatch || duringAcknowledgedChild) {
      activateAcceptedChildSession({
        owner,
        parent: parentCoordinator,
        ensureChild: () => {
          const state = owner.loadCurrentSnapshot(accepted[0]!.childThreadId)!;
          return coordinators.ensure({
            sessionId: accepted[0]!.childThreadId,
            userId: state.session.userId,
            workspace,
            projectId: project.projectId,
            canonicalWorkspaceDigest: project.workspaceDigest,
            interactionMode: state.mode,
            recoveryIdentityKey: state.toolRecovery.identityKey,
            sandboxAvailable: true,
            modelArtifactEvidence: modelRuntimeFactory(workspace).evidence,
            capabilityArtifactEvidence: modelRuntimeFactory(workspace).capabilityArtifacts,
          });
        },
        creation,
        childBudget: accepted[0]!.childBudget,
        childDeadlineAt: accepted[0]!.childDeadlineAt,
        childRunId: duringAcknowledgedChild
          ? `run_${createHash('sha256').update(`kite.child-run.v1\0${accepted[0]!.childThreadId}`).digest('hex')}`
          : 'child-stop-before-model-run',
        evidence: {
          scopeSessionId: accepted[0]!.childThreadId,
          targetSessionId: accepted[0]!.childThreadId,
          commandId: 'activate-stop-before-model',
          requestDigest: 'd'.repeat(64),
          committedAt: Date.now(),
        },
        inspectGrant: (value) =>
          modelRuntimeFactory(workspace).inspectChildStartGrant(value as never),
        startedAt: Date.now(),
      });
      expect(
        await owner.releaseSessionExecution(accepted[0]!.childThreadId, () =>
          coordinators.release(accepted[0]!.childThreadId),
        ),
      ).toBe(true);
      if (duringAcknowledgedChild) {
        await duringAcknowledgedChild(callbackFixture());
        return;
      }
      const authority = owner.readChildExecutionAuthority(
        parentSessionId,
        accepted[0]!.childThreadId,
      );
      owner.runWithSessionExecution(parentSessionId, () =>
        parentCoordinator.control.processEventBatch([
          {
            type: 'background_execution.stop_requested',
            commandId: 'stop-acknowledged-child',
            executionId: childInvocationId,
            executionKind: 'subagent',
            ownerGeneration: `child:${authority?.controllerGeneration}`,
          },
        ]),
      );
      const settled = await createOrchestrator().recoverPending();
      expect(settled).toMatchObject({ processed: 1, recoveryRequired: [] });
      expect(
        owner.loadCurrentSnapshot(accepted[0]!.childThreadId)?.childSessionOrigin?.terminal,
      ).toMatchObject({
        status: 'cancelled',
        cleanupConfirmed: true,
      });
      expect(await orchestrator.taskControl?.readTask(childInvocationId)).toMatchObject({
        status: 'cancelled',
      });
      expect(childModelRequests).toBe(0);
      return;
    }
    if (stopBeforeDispatch) {
      owner.runWithSessionExecution(parentSessionId, () =>
        parentCoordinator.control.processEventBatch([
          {
            type: 'background_execution.stop_requested',
            commandId: 'stop-before-child-dispatch',
            executionId: childInvocationId,
            executionKind: 'subagent',
            ownerGeneration: `accepted:${persistedIntent.toolEventId}`,
          },
        ]),
      );
      const settled = await createOrchestrator().recoverPending();
      expect(settled).toMatchObject({ processed: 1, recoveryRequired: [] });
      expect(owner.readChildSessionIntent(accepted[0]!.childThreadId)).toMatchObject({
        childSessionCreated: false,
        failureMode: 'absent_child',
      });
      const stoppedIntent = owner.readChildSessionIntent(accepted[0]!.childThreadId);
      expect(stoppedIntent?.failureReceiptDigest).toBeTruthy();
      expect(
        parentCoordinator.getState().capabilities.invocations[parentInvocationId]
          ?.subagentProviderLifecycle?.childSession?.terminalImport,
      ).toMatchObject({ status: 'failed', terminalRevision: 0 });
      expect(await orchestrator.taskControl?.readTask(childInvocationId)).toMatchObject({
        status: 'failed',
      });
      expect(childModelRequests).toBe(0);
      return;
    }
    if (cancelAfterAttempt || cancelViaTaskControl || duringActiveChild) {
      const parentAbort = new AbortController();
      const pending = orchestrator.onAccepted(accepted[0]!, parentAbort.signal);
      await until(() =>
        owner.storage.sessions
          .loadEventsStrict(accepted[0]!.childThreadId)
          .some(({ event }) => event.type === 'model.invocation_attempt_started'),
      );
      await until(() => childModelRequests === 1);
      expect(orchestrator.backgroundSnapshot?.().executions).toContainEqual(
        expect.objectContaining({ executionId: childInvocationId, status: 'running' }),
      );
      if (duringActiveChild) {
        await duringActiveChild(callbackFixture(), () => childGate.resolve());
        childGate.resolve();
        await pending;
        await Promise.allSettled(childWork);
        if (retryChildModel) {
          const events = owner.storage.sessions
            .loadEventsStrict(accepted[0]!.childThreadId)
            .map(({ event }) => event);
          expect(events.some((event) => event.type === 'model.retry')).toBe(true);
          const terminal = await orchestrator.taskControl!.readTask(childInvocationId);
          expect(terminal).toMatchObject({
            ok: true,
            status: 'completed',
          });
          expect(JSON.stringify(terminal)).not.toContain('PRIVATE_PROVIDER_FAILURE');
          expect(await orchestrator.taskControl!.waitTasks([childInvocationId], 0)).toMatchObject({
            ok: true,
            status: 'completed',
            tasks: [{ ok: true, status: 'completed' }],
          });
          expect(childModelRequests).toBe(2);
        }
        return;
      }
      if (cancelViaTaskControl)
        expect(
          await orchestrator.taskControl!.cancelTask(childInvocationId, { waitMs: 0 }),
        ).toMatchObject({ status: 'unknown', cleanup_confirmed: false });
      const cancellation = cancelViaTaskControl
        ? orchestrator.taskControl!.cancelTask(childInvocationId)
        : undefined;
      if (!cancelViaTaskControl)
        parentAbort.abort(createRuntimeAbortReason('user', 'Delegated task cancelled by user.'));
      childGate.resolve();
      if (cancellation) expect(await cancellation).toMatchObject({ status: 'cancelled' });
      await pending;
      await Promise.allSettled(childWork);
      const cancelled = owner.loadCurrentSnapshot(accepted[0]!.childThreadId);
      expect(cancelled?.turn).toMatchObject({ status: 'aborted', abortCause: 'user' });
      expect(cancelled?.childSessionOrigin?.terminal?.status).toBe('cancelled');
      expect(cancelled?.terminalOutcome).toBeUndefined();
      expect(await orchestrator.taskControl?.readTask(childInvocationId)).toMatchObject({
        status: 'cancelled',
      });
      expect(orchestrator.backgroundSnapshot?.().executions).toContainEqual(
        expect.objectContaining({ executionId: childInvocationId, status: 'cancelled' }),
      );
      expect(
        owner.storage.sessions
          .loadEventsStrict(parentSessionId)
          .filter(({ event }) => event.type === 'subagent.child_terminal_imported'),
      ).toHaveLength(1);
      expect(
        owner.readChildSessionIntent(accepted[0]!.childThreadId)?.parentClaimSettledEventId,
      ).toBeTruthy();
      expect(childModelRequests).toBe(1);
      return;
    }
    if (crashAfterAttempt) {
      void orchestrator.onAccepted(accepted[0]!);
      await until(() =>
        owner.storage.sessions
          .loadEventsStrict(accepted[0]!.childThreadId)
          .some(({ event }) => event.type === 'model.invocation_attempt_started'),
      );
      await until(() => childModelRequests === 1);
      expect(childModelRequests).toBe(1);
      const oldChildRevision = owner.loadCurrentSnapshot(accepted[0]!.childThreadId)?.revision;
      if (stopBeforeCrash) {
        const authority = owner.readChildExecutionAuthority(
          parentSessionId,
          accepted[0]!.childThreadId,
        );
        owner.runWithSessionExecution(parentSessionId, () =>
          parentCoordinator.control.processEventBatch([
            {
              type: 'background_execution.stop_requested',
              commandId: 'stop-at-child-model-attempt',
              executionId: childInvocationId,
              executionKind: 'subagent',
              ownerGeneration: `child:${authority?.controllerGeneration}`,
            },
          ]),
        );
      }
      owner.disposeStorage();
      await Bun.sleep(160);
      recoveredOwner = await createKiteSessionAppServerStorageComposition({
        databasePath: join(home, 'kite-session.sqlite'),
        hostInstanceId: 'orchestrator-restarted-host',
        executionLeaseMs: 120,
        renewIntervalMs: 40,
      });
      const nextBackends = createKiteHomeBuiltinArtifactBackends(recoveredOwner.artifactStore);
      const nextModelRuntimeFactory = createInstalledKiteRuntimeCompositionFactory(
        createKiteModelOperationExecutionPort(capabilities, builtinToolCatalog),
        nextBackends,
      );
      const nextServices: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState> =
        new EffectSupervisor(recoveredOwner.storage).services;
      const nextStore: StateRuntimeStorage = {
        sessions: nextServices.sessions,
        transactions: nextServices.transactions,
        effects: nextServices.leases,
        checkpoints: nextServices.checkpoints,
        recoveryIdentities: nextServices.recoveryIdentities,
        commandReceipts: recoveredOwner.storage.commandReceipts,
        close: () => undefined,
      };
      recoveredBinding = createRuntimeSessionCoordinatorBinding();
      recoveredBinding.bind({
        services: nextServices,
        capabilities,
        capabilityRegistrySnapshot: capabilitySnapshot,
        builtinToolCatalog,
        modelRuntimeFactory: nextModelRuntimeFactory,
        store: nextStore,
      });
      const nextCoordinators = recoveredBinding.access();
      await recoveredOwner.reconcileInterruptedSession(
        parentSessionId,
        async (generation, assertCurrent) => {
          const restoredParent = nextCoordinators.ensure(identity);
          const result = await reconcileRuntimeSessionAfterRestart({
            control: restoredParent.control,
            modelInvocationRuntime: nextModelRuntimeFactory(workspace),
            shellExecutor: bridgeInput.shellExecutor,
            historyEvents: recoveredOwner!.storage.sessions
              .loadEventsStrict(parentSessionId)
              .map(({ event }) => event),
            recoveryOwnership: {
              kind: 'fenced_previous_execution',
              controllerGeneration: generation,
              assertCurrent,
            },
          });
          if (!result.complete) throw new Error('Parent recovery did not complete.');
          return undefined;
        },
      );
      const nextOrchestrator = createChildSessionOrchestrator({
        detachedScope: new AsyncResource('child-restart-test-scope'),
        owner: recoveredOwner,
        effectLeases: nextServices.leases,
        parentSessionId,
        bridgeInput,
        coordinators: nextCoordinators,
        modelRuntimeFactory: (canonicalWorkspace) => ({
          ...nextModelRuntimeFactory(canonicalWorkspace),
          builtinToolCatalog,
        }),
        capabilityExecution: capabilities,
        enqueueSessionWork: async (_sessionId, work) => await work(),
      });
      const recovered = await nextOrchestrator.recoverPending();
      expect(recovered).toMatchObject({ processed: 1, recoveryRequired: [] });
      const unknownChild = recoveredOwner.loadCurrentSnapshot(accepted[0]!.childThreadId);
      expect(unknownChild?.childSessionOrigin?.terminal).toMatchObject({
        status: 'unknown',
        cleanupConfirmed: false,
      });
      expect(
        recoveredOwner.readChildExecutionAuthority(parentSessionId, accepted[0]!.childThreadId),
      ).toMatchObject({ status: 'recovery_required', cleanupConfirmed: false });
      expect(await nextOrchestrator.taskControl?.readTask(childInvocationId)).toMatchObject({
        status: 'unknown',
      });
      expect(nextOrchestrator.backgroundSnapshot?.().executions).toContainEqual(
        expect.objectContaining({ executionId: childInvocationId, status: 'unavailable' }),
      );
      const recoveredIntent = recoveredOwner.readChildSessionIntent(accepted[0]!.childThreadId);
      expect(
        recoveredOwner.storage.runs?.get(
          accepted[0]!.childThreadId,
          recoveredIntent!.childBudgetActivatedRunId!,
        )?.status,
      ).toBe('unknown');
      const parentEvents = recoveredOwner.storage.sessions
        .loadEventsStrict(parentSessionId)
        .map(({ event }) => event);
      expect(
        parentEvents.filter((event) => event.type === 'subagent.child_terminal_imported'),
      ).toHaveLength(1);
      expect(parentEvents).toContainEqual(
        expect.objectContaining({
          type: 'resource_budget.unknown',
          reservationId: persistedIntent.delegatedReservationId,
        }),
      );
      expect(
        recoveredOwner.readChildSessionIntent(accepted[0]!.childThreadId)
          ?.parentClaimSettledEventId,
      ).toBeTruthy();
      expect(
        recoveredOwner.listCurrentSessions('', 10).map((entry) => entry.threadId),
      ).not.toContain(accepted[0]!.childThreadId);
      const second = await nextOrchestrator.recoverPending();
      expect(second).toMatchObject({ processed: 0, recoveryRequired: [] });
      expect(
        recoveredOwner.storage.sessions
          .loadEventsStrict(parentSessionId)
          .filter(({ event }) => event.type === 'subagent.child_terminal_imported'),
      ).toHaveLength(1);
      childGate.resolve();
      await Promise.allSettled(childWork);
      expect(recoveredOwner.loadCurrentSnapshot(accepted[0]!.childThreadId)?.revision).toBe(
        unknownChild?.revision,
      );
      expect(oldChildRevision).toBeLessThan(unknownChild!.revision);
      expect(childModelRequests).toBe(1);
      return;
    }
    if (recoverAcceptedIntent) {
      expect(owner.readChildSessionIntent(accepted[0]!.childThreadId)?.childSessionCreated).toBe(
        false,
      );
      expect(owner.readSessionLineage(accepted[0]!.childThreadId)).toBeNull();
      const recovered = await createOrchestrator(failRecoveryQueue).recoverPending();
      if (failRecoveryQueue) {
        expect(recovered).toMatchObject({
          processed: 0,
          recoveryRequired: [
            {
              childThreadId: accepted[0]!.childThreadId,
              reason: 'recovery_action_create_child_failed',
            },
          ],
        });
        expect(owner.readChildSessionIntent(accepted[0]!.childThreadId)?.childSessionCreated).toBe(
          false,
        );
        expect(
          owner.storage.sessions
            .loadEventsStrict(parentSessionId)
            .filter(({ event }) => event.type === 'subagent.child_recovery_required'),
        ).toHaveLength(1);
        expect(await createOrchestrator().taskControl?.readTask(childInvocationId)).toMatchObject({
          status: 'unknown',
          cleanup_confirmed: false,
        });
        expect(createOrchestrator().backgroundSnapshot?.().executions).toContainEqual(
          expect.objectContaining({ executionId: childInvocationId, status: 'unavailable' }),
        );
        expect(childModelRequests).toBe(0);
        return;
      }
      expect(recovered).toMatchObject({ processed: 1, recoveryRequired: [] });
      expect(recovered.nextCursor).toBeUndefined();
    } else {
      await orchestrator.onAccepted(accepted[0]!);
    }
    await Promise.all(childWork);
    if (!localModelBaseURL) expect(childModelRequests).toBe(1);
    const postLaunchIntent = owner.readChildSessionIntent(accepted[0]!.childThreadId);
    expect(postLaunchIntent).toMatchObject({
      childSessionCreated: true,
      failureReceiptDigest: null,
    });
    expect(owner.readSessionLineage(accepted[0]!.childThreadId)).toEqual({ parentSessionId });
    const activatedIntent = owner.readChildSessionIntent(accepted[0]!.childThreadId);
    expect(activatedIntent?.childSessionCreated).toBe(true);
    expect(typeof activatedIntent?.childBudgetActivatedRunId).toBe('string');
    expect(typeof activatedIntent?.dispatchAckEventId).toBe('string');
    expect(owner.loadCurrentSnapshot(accepted[0]!.childThreadId)?.revision).toBeGreaterThan(0);
    expect(
      owner.loadCurrentSnapshot(accepted[0]!.childThreadId)?.childSessionOrigin?.taskInputAdmitted,
    ).toBe(true);
    expect(() => modelRuntimeFactory(workspace).inspectChildStartGrant(grant)).toThrow(
      'already consumed',
    );
    const childEventTypes = owner.storage.sessions
      .loadEventsStrict(accepted[0]!.childThreadId)
      .map(({ event }) => event.type);
    expect(childEventTypes).not.toContain('run.error');
    expect(childEventTypes).toContain('run.completed');
    expect(childEventTypes).toContain('subagent.child_terminal_sealed');
    expect(childEventTypes).not.toContain('user.message_appended');
    const child = owner.loadCurrentSnapshot(accepted[0]!.childThreadId);
    expect(child?.childSessionOrigin?.terminal?.status).toBe('completed');
    expect(
      owner.readChildExecutionAuthority(parentSessionId, accepted[0]!.childThreadId),
    ).toMatchObject({
      status: 'idle',
      cleanupConfirmed: true,
    });
    expect(await orchestrator.taskControl?.readTask(childInvocationId)).toMatchObject({
      status: 'completed',
    });
    expect(orchestrator.backgroundSnapshot?.().executions).toContainEqual(
      expect.objectContaining({ executionId: childInvocationId, status: 'completed' }),
    );
    if (child?.resourceBudget.status !== 'active')
      throw new Error('Child delegated budget was not activated.');
    expect(Number.isFinite(child.resourceBudget.budget.maxRunDurationMs)).toBe(true);
    expect(child.resourceBudget.budget.maxRunDurationMs).toBeLessThanOrEqual(
      accepted[0]!.childBudget.maxRunDurationMs,
    );
    expect(resourceDeadlineMs(child.resourceBudget.deadlineAt)).toBe(
      Date.parse(child.resourceBudget.startedAt) + child.resourceBudget.budget.maxRunDurationMs,
    );
    expect(
      parentCoordinator.getState().capabilities.invocations[parentInvocationId]
        ?.subagentProviderLifecycle?.childSession?.terminalImport?.status,
    ).toBe('completed');
    expect(
      owner.storage.sessions.loadEventsStrict(parentSessionId).map(({ event }) => event.type),
    ).toContain('subagent.child_terminal_imported');
    expect(
      owner.readChildSessionIntent(accepted[0]!.childThreadId)?.parentClaimSettledEventId,
    ).toBeTruthy();
    expect(owner.listCurrentSessions('', 10).map((entry) => entry.threadId)).not.toContain(
      accepted[0]!.childThreadId,
    );
    if (recoverAcceptedIntent) {
      const childEventCount = owner.storage.sessions.loadEventsStrict(
        accepted[0]!.childThreadId,
      ).length;
      const parentImportCount = owner.storage.sessions
        .loadEventsStrict(parentSessionId)
        .filter(({ event }) => event.type === 'subagent.child_terminal_imported').length;
      const second = await createOrchestrator().recoverPending();
      expect(second).toMatchObject({ processed: 0, recoveryRequired: [] });
      expect(owner.storage.sessions.loadEventsStrict(accepted[0]!.childThreadId)).toHaveLength(
        childEventCount,
      );
      expect(
        owner.storage.sessions
          .loadEventsStrict(parentSessionId)
          .filter(({ event }) => event.type === 'subagent.child_terminal_imported'),
      ).toHaveLength(parentImportCount);
      expect(childModelRequests).toBe(1);
    }
    if (afterCompletedChild) await afterCompletedChild(callbackFixture());
  } finally {
    childGate.resolve();
    await Promise.allSettled(childWork);
    await coordinators.close();
    await recoveredBinding?.access().close();
    recoveredOwner?.disposeStorage();
    owner.disposeStorage();
    model.assertComplete({ allowUnconsumedResponses: true });
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    if (!durableHome) rmSync(home, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error('Child Provider attempt did not become durable.');
}
