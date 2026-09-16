import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextCompactionCheckpoint, RuntimeEvent } from '@kite-ai/agent-kernel';
import {
  BUILTIN_MODEL_OPERATION_BY_PURPOSE_,
  BuiltinModelEffectCoordinator,
  buildContextProjection,
  type ContextProjectionEnvironment,
  createChatModel,
  expectedCompactionSourceDigest,
  type SingleAttemptTransport,
} from '@kite-ai/builtin-runtime/model';
import {
  RUNTIME_COMMAND_CONTEXT_SCHEMA_,
  RUNTIME_COMMAND_SCHEMA_,
  type RuntimeCommandContext,
} from '@kite-ai/runtime-contract';
import {
  createRuntimeCommandCommitEvidence,
  createRuntimeHost,
  RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
  type RuntimeHostExecutionServices,
  resolveProjectIdentity,
} from '@kite-ai/runtime-host';
import {
  createRuntimeHostStateInitialState,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import { defineRuntimeModule, type VerificationSpec } from '@kite-ai/runtime-spi';
import { createBuiltinRuntimeModules, createBuiltinToolCatalogProjection } from '#builtin-runtime';
import { createRuntimeHostStateStorageBinding } from '#runtime-host';
import { createRuntimeModuleRegistry } from '#runtime-spi';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { createRuntimeHostCapabilityExecutionPortFromSnapshot } from '../../../../packages/runtime-host/src/execution/capability-execution';
import type { RuntimeSnapshotCodec } from '../../../../packages/runtime-host/src/storage';
import { createStateStorageForTest } from '../../../../scripts/support/runtime-storage';
import { createTestModelInvocationHarness } from '../../../../tests/helpers/model-invocation';
import {
  testCapabilityArtifactWriter,
  testWorkspaceFilesystemRuntime,
} from '../../../../tests/helpers/runtime-model';
import type { InstalledKiteRuntimeComposition } from '../../src/bootstrap/model-runtime-composition';
import { createCliRuntimeBridge } from '../../src/bootstrap/runtime/CliRuntimeBridge';
import {
  createRuntimeSessionCoordinatorBinding,
  type RuntimeSessionCoordinatorAccess,
  type RuntimeSessionCoordinatorIdentity,
} from '../../src/bootstrap/runtime/RuntimeSessionCoordinator';
import { createAppRuntimeEffectExecutor } from '../../src/bootstrap/runtime/runtime-effect-coordinator';
import type {
  AppWorkspaceEffectCompositionFactory,
  RuntimeExecutorDependencies,
} from '../../src/bootstrap/runtime/runtime-effect-dependencies';
import { obsoleteGlobalAdmissionSettlementEvents } from '../../src/bootstrap/runtime/state-actions';
import type { StateRuntimeStorage } from '../../src/bootstrap/runtime/state-runtime';
import { createAppToolPipelineComposition } from '../../src/bootstrap/runtime/tool-pipeline-composition';
import {
  assertPrecommittedStartTurn,
  planStartTurnCommand,
} from '../../src/bootstrap/runtime/turn-command-decision';

const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
const snapshot = registry.snapshot();
const builtinToolCatalog = createBuiltinToolCatalogProjection(snapshot);
const capabilityExecution = createRuntimeHostCapabilityExecutionPortFromSnapshot(snapshot);
const retainedWorkspaceRoot = mkdtempSync(join(tmpdir(), 'kite-retained-workspace-'));
const retainedWorkspace = join(retainedWorkspaceRoot, 'workspace');
mkdirSync(retainedWorkspace);

function runtimeStoreView(
  services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>,
): StateRuntimeStorage {
  return {
    sessions: services.sessions,
    transactions: services.transactions,
    effects: services.leases,
    checkpoints: services.checkpoints,
    recoveryIdentities: services.recoveryIdentities,
    close: () => undefined,
  };
}

function projectIdentityForWorkspace(workspace: string) {
  const project = resolveProjectIdentity(workspace);
  return {
    projectId: 'project_retained_coordinator',
    canonicalWorkspaceDigest: project.workspaceDigest,
  };
}

function modelRuntime(
  workspace: string,
  state: RuntimeState,
  transport?: SingleAttemptTransport,
  withToolPipelineComposition = false,
): InstalledKiteRuntimeComposition {
  const runtime = createTestModelInvocationHarness({
    workspace,
    state,
    ...(transport ? { transport } : {}),
  });
  const modelEffects = new BuiltinModelEffectCoordinator(runtime.gateway);
  const capabilityArtifacts = withToolPipelineComposition
    ? testCapabilityArtifactWriter()
    : undefined;
  return {
    status: 'available',
    gateway: runtime.gateway,
    modelEffects,
    ...(withToolPipelineComposition
      ? {
          toolPipelineComposition: createAppToolPipelineComposition(builtinToolCatalog),
          capabilityArtifacts: capabilityArtifacts!,
          workspaceFilesystem: testWorkspaceFilesystemRuntime(workspace, capabilityArtifacts),
        }
      : {}),
  } as unknown as InstalledKiteRuntimeComposition;
}

function identity(sessionId: string): RuntimeSessionCoordinatorIdentity {
  const workspace = retainedWorkspace;
  return {
    sessionId,
    userId: 'tui-user',
    workspace,
    ...projectIdentityForWorkspace(workspace),
    interactionMode: 'accept_edits',
    recoveryIdentityKey: 'a'.repeat(64),
  };
}

function config() {
  return {
    apiKey: 'test',
    baseURL: 'http://localhost:1',
    modelName: 'test-model',
    providerName: 'deepseek',
    providerType: 'openai-compatible' as const,
    sandbox: { enabled: true },
  };
}

function startCommand(
  sessionId: string,
  expectedRevision: number,
  phase: 'planning' | 'building' = 'building',
) {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId: 'command_start_turn_fixture',
    type: 'start_turn' as const,
    sessionId,
    expectedRevision,
    input: 'Start a durable fixture turn.',
    phase,
  };
}

function closeCommand(
  sessionId: string,
  expectedRevision: number,
  commandId = 'command_close_fixture',
) {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId,
    type: 'close_session' as const,
    sessionId,
    expectedRevision,
  };
}

function commandEvidence(sessionId: string, commandId = 'command_start_turn_fixture') {
  return {
    scopeSessionId: sessionId,
    commandId,
    requestDigest: 'd'.repeat(64),
    targetSessionId: sessionId,
    committedAt: 1_700_000_000_000,
  };
}

function writeInitialSkill(root: string, name: string): void {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---
name: ${name}
version: 1.0.0
description: Initial fixture.
invocation:
  allow_implicit: false
  allow_manual: true
context:
  mode: inline
  agent: code
input_schema:
  type: object
output_schema:
  type: object
capabilities:
  require: [builtin:read_file]
  deny: []
effects:
  filesystem: read
  network: none
  external_state: none
approval:
  minimum: none
execution:
  timeout_ms: 1000
  max_attempts: 1
verification:
  mode: not_required
recovery:
  retry: never
---

Follow the initial workflow.
`,
  );
}

function requestedState(sessionId: string) {
  const state = createRuntimeHostStateInitialState({
    threadId: sessionId,
    userId: 'tui-user',
    workspace: retainedWorkspace,
    ...projectIdentityForWorkspace(retainedWorkspace),
    recoveryIdentityKey: 'a'.repeat(64),
  });
  state.transcript.messages = [
    {
      kind: 'user',
      messageId: 'historical-message',
      turnId: 'historical-turn',
      ordinal: 0,
      createdAt: '2026-08-21T00:00:00.000Z',
      content: 'Historical context '.repeat(200),
    },
    {
      kind: 'user',
      messageId: 'current-message',
      turnId: state.turn.turnId,
      ordinal: 1,
      createdAt: '2026-08-21T00:00:01.000Z',
      content: 'Current request',
    },
  ];
  return reduceRuntimeState(state, {
    type: 'context.compaction_requested',
    compactionId: 'retained-compaction-1',
    reason: 'manual',
    requestedAtRevision: state.revision,
    requestedAtTurnId: state.turn.turnId,
    force: false,
    estimate: {
      systemTokens: 10,
      toolSchemaTokens: 10,
      transcriptTokens: 400,
      summaryTokens: 0,
      dynamicRuntimeTokens: 10,
      framingTokens: 10,
      totalInputTokens: 440,
    },
  });
}

function autoReviewState(
  sessionId: string,
  options: { toolName?: string; subagentId?: string } = {},
) {
  const toolName = options.toolName ?? 'shell_execute';
  let state = createRuntimeHostStateInitialState({
    threadId: sessionId,
    userId: 'tui-user',
    workspace: retainedWorkspace,
    ...projectIdentityForWorkspace(retainedWorkspace),
    recoveryIdentityKey: 'a'.repeat(64),
  });
  state = reduceRuntimeState(state, {
    type: 'tool.queued',
    toolCallId: 'reviewed-shell',
    name: toolName,
    args: { command: 'printf retained' },
  });
  return reduceRuntimeState(state, {
    type: 'auto_review.requested',
    reviewId: 'retained-review-1',
    toolCallId: 'reviewed-shell',
    toolName,
    reason: 'Requires App review.',
    fullModeBypassEligible: false,
    fullModePolicyBypassAllowed: false,
    owner: { kind: 'root_tool', toolCallId: 'reviewed-shell' },
    approval: {
      scope: 'once',
      cwd: retainedWorkspace,
      threadId: sessionId,
      tool: toolName,
      command: 'printf retained',
      risk: 'execute_code',
      approvalHash: 'retained-review-hash',
      summary: 'Run a retained fixture command.',
      reason: 'Requires App review.',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
      ...(options.subagentId ? { subagentId: options.subagentId } : {}),
    },
  });
}

function verificationState(sessionId: string) {
  const state = createRuntimeHostStateInitialState({
    threadId: sessionId,
    userId: 'tui-user',
    workspace: retainedWorkspace,
    ...projectIdentityForWorkspace(retainedWorkspace),
    recoveryIdentityKey: 'a'.repeat(64),
  });
  state.activeTaskId = 'verification-task';
  state.tasks['verification-task'] = {
    taskId: 'verification-task',
    userGoal: 'Verify the runtime coordinator cutover.',
    status: 'active',
    startedAtTurnId: state.turn.turnId,
    sideEffectsStarted: true,
    planning: { kind: 'building_without_plan' },
    planHistory: [],
  };
  state.transcript.final = 'ready for verification';
  const spec: VerificationSpec = {
    schemaVersion: 1,
    verificationId: 'retained-verification-1',
    taskId: 'verification-task',
    subject: 'retained deterministic verification route',
    checks: [
      {
        checkId: 'schema',
        type: 'schema',
        description: 'Validate retained deterministic evidence.',
        subject: { kind: 'literal', value: {} },
        schema: { type: 'object' },
      },
    ],
    repair: { maxAttempts: 1 },
  };
  return reduceRuntimeState(state, {
    type: 'verification.requested',
    verificationId: spec.verificationId,
    taskId: 'verification-task',
    mode: 'required',
    spec,
    requestedAt: '2026-08-21T00:00:00.000Z',
  });
}

function checkpointFor(
  state: ReturnType<typeof requestedState>,
  sourceRevision: number,
  environment?: ContextProjectionEnvironment,
): ContextCompactionCheckpoint {
  const before = buildContextProjection({
    role: 'agent',
    state,
    serializedTools: environment?.serializedTools,
    activeSkillInstructions: environment?.activeSkillInstructions,
    workflowSkills: environment?.workflowSkills,
  }).estimate.totalInputTokens;
  const source = state.transcript.messages[0]!;
  return {
    compactionId: 'retained-compaction-1',
    version: 1,
    sourceRevision,
    sourceDigest: expectedCompactionSourceDigest(undefined, [source]),
    coveredThroughMessageId: source.messageId,
    coveredThroughTurnId: source.turnId,
    summary: 'One runtime coordinator summary.',
    inputTokensBefore: before,
    inputTokensAfter: 0,
    reason: 'manual',
    createdAt: '2026-08-21T00:00:02.000Z',
  };
}

function createFixture(
  sessionId: string,
  requested?: RuntimeState,
  workspace = retainedWorkspace,
  options: {
    readonly failCommandCommit?: () => boolean;
    readonly storeRuns?: boolean;
    readonly modelTransport?: SingleAttemptTransport;
    readonly withToolPipelineComposition?: boolean;
  } = {},
) {
  const state =
    requested ??
    createRuntimeHostStateInitialState({
      threadId: sessionId,
      userId: 'tui-user',
      workspace,
      ...projectIdentityForWorkspace(workspace),
      recoveryIdentityKey: 'a'.repeat(64),
    });
  const root = mkdtempSync(join(process.cwd(), '.kite-retained-coordinator-'));
  const databasePath = join(root, 'runtime.db');
  const stateStorage = createRuntimeHostStateStorageBinding();
  const codec = stateStorage.codec as RuntimeSnapshotCodec<RuntimeEvent, RuntimeState>;
  const storage = createStateStorageForTest<RuntimeEvent, RuntimeState>({
    databasePath,
    codec,
    sessionId,
    ...(options.storeRuns
      ? {
          workspaceBinding: {
            layoutGeneration: 'retained-recovery-tests',
            workerScopeId: 'retained-recovery-worker',
            workspaceIdentityDigest:
              projectIdentityForWorkspace(workspace).canonicalWorkspaceDigest,
          },
          targetStore: 'run' as const,
        }
      : {}),
  });
  const services = {
    sessions: storage.sessions,
    transactions: {
      commit: (
        acknowledgement: 'decision' | 'receipt_evidence',
        input: Parameters<typeof storage.transactions.commitDecision>[0],
        requiredEffectLease?: Parameters<
          RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>['transactions']['commit']
        >[2],
      ) => {
        if (acknowledgement === 'receipt_evidence') {
          storage.transactions.commitReceiptEvidence(input);
        } else {
          storage.transactions.commitDecision(input);
        }
        void requiredEffectLease;
      },
      commitCommandDecision: (input: Parameters<typeof storage.transactions.commitDecision>[0]) => {
        if (options.failCommandCommit?.()) throw new Error('injected command transaction failure');
        storage.transactions.commitDecision(input);
      },
    },
    leases: {
      tryAcquire: storage.effects.tryAcquireEffectLease,
      renew: storage.effects.renewEffectLease,
      release: storage.effects.releaseEffectLease,
      hasClaim: () => false,
    },
    checkpoints: options.storeRuns
      ? storage.checkpoints
      : ({} as RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>['checkpoints']),
    recoveryIdentities: storage.recoveryIdentities,
    ...(options.storeRuns ? { runs: storage.runs } : {}),
  } as unknown as RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
  const store = runtimeStoreView(services);
  storage.transactions.commitDecision({
    sessionId,
    events: [],
    snapshot: state,
  });
  const runtime = modelRuntime(
    workspace,
    state,
    options.modelTransport,
    options.withToolPipelineComposition,
  );
  const binding = createRuntimeSessionCoordinatorBinding();
  let factoryCalls = 0;
  const factory = (workspace: string) => {
    factoryCalls += 1;
    void workspace;
    return runtime;
  };
  binding.bind({
    services,
    capabilities: capabilityExecution,
    capabilityRegistrySnapshot: snapshot,
    builtinToolCatalog,
    modelRuntimeFactory: factory,
    store,
  });
  return {
    binding,
    store,
    runtime,
    services,
    factory,
    factoryCalls: () => factoryCalls,
    storage,
    root,
  };
}

function createFixtureBridge(
  sessionId: string,
  fixture: ReturnType<typeof createFixture>,
  access: RuntimeSessionCoordinatorAccess,
  workspaceEffectCompositionFactory?: AppWorkspaceEffectCompositionFactory,
) {
  return createCliRuntimeBridge(
    {
      sessionId,
      userId: 'tui-user',
      workspace: retainedWorkspace,
      projectIdentity: {
        ...resolveProjectIdentity(retainedWorkspace),
        projectId: 'project_retained_coordinator',
      },
      checkpointPath: join(fixture.root, 'runtime.db'),
      config: config(),
      interactionMode: 'accept_edits',
      shellExecutor: async ({ command }) => ({
        ok: true,
        command,
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
      sandboxBackend: 'none',
      skillOptions: {
        userKiteCodeSkillsDir: join(fixture.root, 'user-skills'),
        userAgentsSkillsDir: join(fixture.root, 'agent-skills'),
        projectKiteCodeSkillsDir: join(fixture.root, 'project-skills'),
        projectAgentsSkillsDir: join(fixture.root, 'project-agent-skills'),
      },
      initialSkillActivations: [],
      ...(workspaceEffectCompositionFactory ? { workspaceEffectCompositionFactory } : {}),
    },
    capabilityExecution,
    () => ({ ...fixture.runtime, builtinToolCatalog }),
    () => 'a'.repeat(64),
    access,
  );
}

function dependencies(
  store: StateRuntimeStorage,
  runtime: InstalledKiteRuntimeComposition,
  contextCompactor?: RuntimeExecutorDependencies['testContextCompactor'],
): RuntimeExecutorDependencies {
  if (runtime.status !== 'available') throw new Error('test model runtime unavailable');
  return {
    config: config(),
    model: createChatModel(config()),
    builtinToolCatalog,
    capabilityExecution,
    runtimeStore: store,
    modelInvocationGateway: runtime.gateway,
    modelEffectCoordinator: runtime.modelEffects,
    ...(contextCompactor ? { testContextCompactor: contextCompactor } : {}),
  };
}

describe('retained TUI session coordinator', () => {
  afterAll(() => {
    rmSync(retainedWorkspaceRoot, { recursive: true, force: true });
  });

  test('admits the durable Project identity resolved for one existing Workspace', async () => {
    const sessionId = 'retained-resolved-project-identity';
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'kite-resolved-project-identity-'));
    const workspace = join(workspaceRoot, 'WorkspaceWithANameLongerThanEight');
    mkdirSync(workspace);
    const project = resolveProjectIdentity(workspace);
    const state = createRuntimeHostStateInitialState({
      threadId: sessionId,
      userId: 'tui-user',
      workspace,
      projectId: project.projectId,
      canonicalWorkspaceDigest: project.workspaceDigest,
      recoveryIdentityKey: 'a'.repeat(64),
    });
    const fixture = createFixture(sessionId, state, workspace);
    const access = fixture.binding.access();
    try {
      expect(() =>
        access.ensure({
          sessionId,
          userId: 'tui-user',
          workspace,
          projectId: project.projectId,
          canonicalWorkspaceDigest: project.workspaceDigest,
          interactionMode: 'accept_edits',
          recoveryIdentityKey: 'a'.repeat(64),
        }),
      ).not.toThrow();
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('Host recovery ensures one Kernel/composition identity and fails closed on drift or double bind', async () => {
    const sessionId = 'retained-identity';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    try {
      const hostRecover = () => access.ensure(identity(sessionId));
      const first = hostRecover();
      const second = hostRecover();
      expect(second).toBe(first);
      expect(second.session).toBe(first.session);
      expect(first.getStateRuntimeStorage()).toBe(fixture.store);
      expect(fixture.factoryCalls()).toBe(1);
      expect(() => access.ensure({ ...identity(sessionId), userId: 'different-user' })).toThrow(
        'identity drifted',
      );
      expect(() =>
        first.createRuntimeEffectPort(dependencies(fixture.store, fixture.runtime, undefined)),
      ).toBeFunction();
      expect(() =>
        first.createRuntimeEffectPort({
          ...dependencies(fixture.store, fixture.runtime),
          capabilityExecution: Object.freeze({ invoke: async () => ({}) }),
        } as unknown as RuntimeExecutorDependencies),
      ).toThrow('capability execution port identity mismatch');
      expect(() =>
        fixture.binding.bind({
          services: fixture.services,
          capabilities: capabilityExecution,
          capabilityRegistrySnapshot: snapshot,
          builtinToolCatalog,
          modelRuntimeFactory: fixture.factory,
          store: fixture.store,
        }),
      ).toThrow('already bound');
    } finally {
      await access.close();
      expect(fixture.store.sessions.getLastEventPosition(sessionId)).toBe(0);
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('commits a building start command as one deterministic State decision before a runner begins', async () => {
    const sessionId = 'retained-command-start-building';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    try {
      const coordinator = access.ensure(identity(sessionId));
      const command = startCommand(sessionId, coordinator.getState().revision);
      const beforeRevision = coordinator.getState().revision;
      const firstPlan = planStartTurnCommand(coordinator.getState(), command);
      const retryPlan = planStartTurnCommand(coordinator.getState(), command);
      expect(retryPlan.descriptor).toEqual(firstPlan.descriptor);

      const committed = coordinator.commitStartTurnCommand(command, commandEvidence(sessionId));
      expect(committed.receipt.committedRevision).toBe(committed.descriptor.committedRevision);
      expect(
        committed.events.filter((event) => event.type === 'user.message_appended'),
      ).toHaveLength(1);
      expect(committed.events.filter((event) => event.type === 'turn.started')).toHaveLength(1);
      expect(coordinator.getState().transcript.messages).toHaveLength(1);
      expect(coordinator.isTurnActive()).toBe(false);
      assertPrecommittedStartTurn(coordinator.getState(), committed.descriptor, sessionId);
      expect(
        committed.events.map((event) => ({
          revision: coordinator.revisionForEvent?.(event),
          stateRevision: coordinator.stateForEvent?.(event)?.revision,
        })),
      ).toEqual(
        committed.events.map((_, index) => ({
          revision: beforeRevision + index + 1,
          stateRevision: beforeRevision + index + 1,
        })),
      );

      expect(() => coordinator.commitStartTurnCommand(command, commandEvidence(sessionId))).toThrow(
        'revision conflict',
      );
      expect(coordinator.getState().transcript.messages).toHaveLength(1);
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('includes planning task and entry facts in the same committed start decision', async () => {
    const sessionId = 'retained-command-start-planning';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    try {
      const coordinator = access.ensure(identity(sessionId));
      const committed = coordinator.commitStartTurnCommand(
        startCommand(sessionId, coordinator.getState().revision, 'planning'),
        commandEvidence(sessionId),
      );
      expect(committed.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'task.started',
          'planning.entered',
          'user.message_appended',
          'turn.started',
        ]),
      );
      expect(coordinator.getState().activeTaskId).toBe(committed.descriptor.taskId ?? null);
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('commits an interaction-mode decision with the receipt timestamp and updates live mode after commit', async () => {
    const sessionId = 'retained-command-interaction-mode';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    try {
      const coordinator = access.ensure(identity(sessionId));
      const committedAt = 1_700_000_000_000;
      const committed = coordinator.commitInteractionModeCommand(
        {
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: 'command_mode_fixture',
          type: 'set_interaction_mode',
          sessionId,
          expectedRevision: coordinator.getState().revision,
          mode: 'auto',
        },
        { ...commandEvidence(sessionId, 'command_mode_fixture'), committedAt },
      );
      expect(committed.events).toEqual([
        expect.objectContaining({
          type: 'interaction_mode.changed',
          mode: 'auto',
          changedAt: new Date(committedAt).toISOString(),
        }),
      ]);
      expect(coordinator.getInteractionModeState().interactionMode).toBe('auto');
      const unchangedRevision = coordinator.getState().revision;
      const unchanged = coordinator.commitInteractionModeCommand(
        {
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: 'command_mode_duplicate',
          type: 'set_interaction_mode',
          sessionId,
          expectedRevision: unchangedRevision,
          mode: 'auto',
        },
        commandEvidence(sessionId, 'command_mode_duplicate'),
      );
      expect(unchanged.events).toEqual([]);
      expect(unchanged.receipt.commandId).toBe('command_mode_duplicate');
      expect(unchanged.receipt.committedRevision).toBe(unchangedRevision);
      expect(coordinator.getState().revision).toBe(unchangedRevision);
      expect(coordinator.getInteractionModeState().interactionMode).toBe('auto');
      expect(() =>
        coordinator.commitInteractionModeCommand(
          {
            schema: RUNTIME_COMMAND_SCHEMA_,
            commandId: 'command_mode_wrong_revision',
            type: 'set_interaction_mode',
            sessionId,
            expectedRevision: coordinator.getState().revision + 1,
            mode: 'full',
          },
          commandEvidence(sessionId, 'command_mode_wrong_revision'),
        ),
      ).toThrow('session or revision');
      expect(() =>
        coordinator.commitInteractionModeCommand(
          {
            schema: RUNTIME_COMMAND_SCHEMA_,
            commandId: 'command_mode_wrong_session',
            type: 'set_interaction_mode',
            sessionId: 'other-session',
            expectedRevision: coordinator.getState().revision,
            mode: 'full',
          },
          commandEvidence('other-session', 'command_mode_wrong_session'),
        ),
      ).toThrow('session or revision');
      expect(() =>
        coordinator.commitInteractionModeCommand(
          {
            schema: RUNTIME_COMMAND_SCHEMA_,
            commandId: 'command_mode_wrong_value',
            type: 'set_interaction_mode',
            sessionId,
            expectedRevision: coordinator.getState().revision,
            mode: 'invalid' as never,
          },
          commandEvidence(sessionId, 'command_mode_wrong_value'),
        ),
      ).toThrow('invalid');
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('atomically cancels an active command turn and a later Host cancellation cannot add facts', async () => {
    const sessionId = 'retained-command-cancel-turn';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    try {
      const coordinator = access.ensure(identity(sessionId));
      const started = coordinator.commitStartTurnCommand(
        startCommand(sessionId, coordinator.getState().revision),
        commandEvidence(sessionId),
      );
      const revision = coordinator.getState().revision;
      expect(() =>
        coordinator.commitCancelTurnCommand(
          {
            schema: RUNTIME_COMMAND_SCHEMA_,
            commandId: 'command_cancel_wrong_turn',
            type: 'cancel_turn',
            sessionId,
            expectedRevision: revision,
            turnId: 'other-turn',
            runId: started.descriptor.turnId,
          },
          commandEvidence(sessionId, 'command_cancel_wrong_turn'),
        ),
      ).toThrow('does not match the active turn');
      expect(() =>
        coordinator.commitCancelTurnCommand(
          {
            schema: RUNTIME_COMMAND_SCHEMA_,
            commandId: 'command_cancel_wrong_revision',
            type: 'cancel_turn',
            sessionId,
            expectedRevision: revision + 1,
            turnId: started.descriptor.turnId,
            runId: started.descriptor.turnId,
          },
          commandEvidence(sessionId, 'command_cancel_wrong_revision'),
        ),
      ).toThrow('session or revision');

      const committed = coordinator.commitCancelTurnCommand(
        {
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: 'command_cancel_fixture',
          type: 'cancel_turn',
          sessionId,
          expectedRevision: revision,
          turnId: started.descriptor.turnId,
          runId: started.descriptor.turnId,
        },
        commandEvidence(sessionId, 'command_cancel_fixture'),
      );
      expect(committed.events.some((event) => event.type === 'turn.aborted')).toBe(true);
      expect(coordinator.getState().turn.status).toBe('aborted');
      const afterCommitRevision = coordinator.getState().revision;
      expect(coordinator.control.cancelRun('Host signal after command commit.')).toEqual([]);
      expect(coordinator.getState().revision).toBe(afterCommitRevision);
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('does not abort or mutate State when a cancel command transaction fails', async () => {
    const sessionId = 'retained-command-cancel-rollback';
    let failCommandCommit = false;
    const fixture = createFixture(sessionId, undefined, retainedWorkspace, {
      failCommandCommit: () => failCommandCommit,
    });
    const access = fixture.binding.access();
    try {
      const coordinator = access.ensure(identity(sessionId));
      const started = coordinator.commitStartTurnCommand(
        startCommand(sessionId, coordinator.getState().revision),
        commandEvidence(sessionId),
      );
      const revision = coordinator.getState().revision;
      failCommandCommit = true;
      expect(() =>
        coordinator.commitCancelTurnCommand(
          {
            schema: RUNTIME_COMMAND_SCHEMA_,
            commandId: 'command_cancel_rollback',
            type: 'cancel_turn',
            sessionId,
            expectedRevision: revision,
            turnId: started.descriptor.turnId,
            runId: started.descriptor.turnId,
          },
          commandEvidence(sessionId, 'command_cancel_rollback'),
        ),
      ).toThrow('injected command transaction failure');
      expect(coordinator.getState().revision).toBe(revision);
      expect(coordinator.getState().turn.status).toBe('active');
      expect(coordinator.control.cancelRun()).toEqual([]);
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('does not start a runner or advance State when the start command transaction fails', async () => {
    const sessionId = 'retained-command-start-rollback';
    const fixture = createFixture(sessionId, undefined, retainedWorkspace, {
      failCommandCommit: () => true,
    });
    const access = fixture.binding.access();
    try {
      const coordinator = access.ensure(identity(sessionId));
      const revision = coordinator.getState().revision;
      expect(() =>
        coordinator.commitStartTurnCommand(
          startCommand(sessionId, revision),
          commandEvidence(sessionId),
        ),
      ).toThrow('injected command transaction failure');
      expect(coordinator.getState().revision).toBe(revision);
      expect(coordinator.getState().transcript.messages).toHaveLength(0);
      expect(coordinator.isTurnActive()).toBe(false);
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('commits an idle close as a snapshot receipt without changing State revision', async () => {
    const sessionId = 'retained-idle-close-command';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    try {
      const coordinator = access.ensure(identity(sessionId));
      coordinator.commitCancelTurnCommand(
        {
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: 'command_prepare_idle_close',
          type: 'cancel_turn',
          sessionId,
          expectedRevision: coordinator.getState().revision,
          turnId: coordinator.getState().turn.turnId,
          runId: coordinator.getState().turn.turnId,
        },
        commandEvidence(sessionId, 'command_prepare_idle_close'),
      );
      const revision = coordinator.getState().revision;
      const committed = coordinator.commitCloseSessionCommand(
        closeCommand(sessionId, revision),
        commandEvidence(sessionId, 'command_close_fixture'),
      );
      expect(committed).toMatchObject({ wasActive: false, events: [] });
      expect(committed.receipt.committedRevision).toBe(revision);
      expect(coordinator.getState().revision).toBe(revision);
      expect(() =>
        coordinator.commitCloseSessionCommand(
          closeCommand(sessionId, revision - 1, 'command_close_wrong_revision'),
          commandEvidence(sessionId, 'command_close_wrong_revision'),
        ),
      ).toThrow('session or revision');
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('fails closed before the receipt transaction when initial skill activation lacks a pure plan', async () => {
    const sessionId = 'retained-command-start-initial-skills';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    try {
      const coordinator = access.ensure(identity(sessionId));
      const revision = coordinator.getState().revision;
      expect(() =>
        coordinator.commitStartTurnCommand(
          {
            ...startCommand(sessionId, revision),
            initialSkills: [{ skillId: 'skill_fixture', input: {} }],
          },
          commandEvidence(sessionId),
        ),
      ).toThrow('requires planning context');
      expect(coordinator.getState().revision).toBe(revision);
      expect(coordinator.getState().transcript.messages).toHaveLength(0);
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('plans multiple initial skills in one committed start batch and rejects an invalid later skill', async () => {
    const sessionId = 'retained-command-start-initial-skill-plan';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    try {
      const skillsRoot = join(fixture.root, 'skills');
      writeInitialSkill(skillsRoot, 'first');
      writeInitialSkill(skillsRoot, 'second');
      const context = {
        skillOptions: {
          projectKiteCodeSkillsDir: skillsRoot,
          projectAgentsSkillsDir: join(fixture.root, 'missing-project-agents'),
          userKiteCodeSkillsDir: join(fixture.root, 'missing-user-kite'),
          userAgentsSkillsDir: join(fixture.root, 'missing-user-agents'),
        },
        flags: { skillWorkflow: true, skillActivation: true },
      } as const;
      const coordinator = access.ensure(identity(sessionId));
      const command = {
        ...startCommand(sessionId, coordinator.getState().revision, 'planning'),
        initialSkills: [
          { skillId: 'skill:first', input: {} },
          { skillId: 'skill:second', input: {} },
        ],
      };
      const committed = coordinator.commitStartTurnCommand(
        command,
        commandEvidence(sessionId),
        context,
      );
      expect(
        committed.events.filter((event) => event.type === 'skill.catalog_refreshed'),
      ).toHaveLength(1);
      expect(
        committed.events.filter((event) => event.type === 'skill.activation_started'),
      ).toHaveLength(2);
      expect(
        committed.events
          .filter((event) => event.type === 'skill.activation_started')
          .map((event) => event.activation.activatedAt),
      ).toEqual(['2023-11-14T22:13:20.000Z', '2023-11-14T22:13:20.000Z']);
      expect(committed.descriptor.initialSkillActivations).toMatchObject([
        { activationId: expect.stringMatching(/^skill_activation_/u) },
        { activationId: expect.stringMatching(/^skill_activation_/u) },
      ]);
      const revisionBeforeInvalid = coordinator.getState().revision;
      expect(() =>
        coordinator.commitStartTurnCommand(
          {
            ...startCommand(sessionId, coordinator.getState().revision, 'planning'),
            initialSkills: [
              { skillId: 'skill:first', input: {} },
              { skillId: 'skill:missing', input: {} },
            ],
          },
          commandEvidence(sessionId, 'invalid-later-skill'),
          context,
        ),
      ).toThrow('initial skill activation rejected');
      expect(coordinator.getState().revision).toBe(revisionBeforeInvalid);
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('fails closed rather than deriving a planning task from pre-recovery State', async () => {
    const sessionId = 'retained-command-start-recovery-planning';
    let state = createRuntimeHostStateInitialState({
      threadId: sessionId,
      userId: 'tui-user',
      workspace: retainedWorkspace,
      ...projectIdentityForWorkspace(retainedWorkspace),
      recoveryIdentityKey: 'a'.repeat(64),
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'superseded-tool',
      name: 'shell_execute',
      args: { command: 'printf superseded' },
    });
    const fixture = createFixture(sessionId, state);
    const access = fixture.binding.access();
    try {
      const coordinator = access.ensure(identity(sessionId));
      const revision = coordinator.getState().revision;
      expect(() =>
        coordinator.commitStartTurnCommand(
          startCommand(sessionId, revision, 'planning'),
          commandEvidence(sessionId),
        ),
      ).toThrow('requires a pure post-recovery plan');
      expect(coordinator.getState().revision).toBe(revision);
      expect(coordinator.getState().transcript.messages).toHaveLength(0);
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('fails closed when a precommitted start descriptor no longer matches State', async () => {
    const sessionId = 'retained-command-start-mismatch';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    try {
      const coordinator = access.ensure(identity(sessionId));
      const committed = coordinator.commitStartTurnCommand(
        startCommand(sessionId, coordinator.getState().revision),
        commandEvidence(sessionId),
      );
      expect(() =>
        assertPrecommittedStartTurn(
          coordinator.getState(),
          {
            ...committed.descriptor,
            committedRevision: committed.descriptor.committedRevision + 1,
          },
          sessionId,
        ),
      ).toThrow('does not match current State');
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('releases one runtime coordinator and preserves Host storage ownership', async () => {
    const sessionId = 'retained-release';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    const coordinator = access.ensure(identity(sessionId));
    coordinator.beginTurn();
    const closing = coordinator.close();
    expect(coordinator.lifecycle).toBe('closing');
    expect(() => coordinator.beginTurn()).toThrow('closing');
    coordinator.endTurn();
    await closing;
    expect(coordinator.lifecycle).toBe('closed');
    expect(() => coordinator.getState()).toThrow('closed');
    expect(fixture.store.sessions.getLastEventPosition(sessionId)).toBe(0);
    await access.release(sessionId);
    expect(access.get(sessionId)).toBeUndefined();
    fixture.storage.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  test('cleans up after identity failure and accepts exactly one compaction terminal', async () => {
    const sessionId = 'retained-compaction';
    const state = requestedState(sessionId);
    const fixture = createFixture(sessionId, state);
    const access = fixture.binding.access();
    const coordinator = access.ensure(identity(sessionId));
    const compactor = async ({
      state: current,
      sourceRevision,
      projectionEnvironment,
    }: Parameters<NonNullable<RuntimeExecutorDependencies['testContextCompactor']>>[0]) =>
      checkpointFor(current, sourceRevision, projectionEnvironment);
    try {
      expect(coordinator.getState().context.pendingCompaction?.compactionId).toBe(
        'retained-compaction-1',
      );
      const goodDependencies = dependencies(fixture.store, fixture.runtime, compactor);
      (fixture.runtime as unknown as { status: 'available' | 'unavailable' }).status =
        'unavailable';
      await expect(
        coordinator.executePendingCompaction({
          dependencies: goodDependencies,
        }),
      ).rejects.toThrow('Model composition is unavailable');
      expect(coordinator.lifecycle).toBe('idle');
      (fixture.runtime as unknown as { status: 'available' | 'unavailable' }).status = 'available';
      await expect(
        coordinator.executePendingCompaction({
          dependencies: {
            ...goodDependencies,
            capabilityExecution: Object.freeze({ invoke: async () => ({}) }),
          } as unknown as RuntimeExecutorDependencies,
        }),
      ).rejects.toThrow('capability execution port identity mismatch');
      expect(coordinator.lifecycle).toBe('idle');
      const terminals = await coordinator.executePendingCompaction({
        dependencies: goodDependencies,
      });
      expect(
        terminals.filter(
          (event) =>
            event.type === 'context.compaction_completed' ||
            event.type === 'context.compaction_failed',
        ),
      ).toHaveLength(1);
      expect(coordinator.getState().context.pendingCompaction).toBeUndefined();
      expect(
        await coordinator.executePendingCompaction({
          dependencies: goodDependencies,
        }),
      ).toEqual([]);
      expect(
        fixture.store.sessions
          .loadEventsStrict(sessionId)
          .filter(
            (event) =>
              event.event.type === 'context.compaction_completed' ||
              event.event.type === 'context.compaction_failed',
          ),
      ).toHaveLength(1);
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('retained compaction fails before Builtin coordinator or Provider without persistence context', async () => {
    const sessionId = 'retained-compaction-no-context';
    const fixture = createFixture(sessionId, requestedState(sessionId));
    const access = fixture.binding.access();
    const coordinator = access.ensure(identity(sessionId));
    if (fixture.runtime.status !== 'available') {
      throw new Error('test model runtime unavailable');
    }
    const runtime = fixture.runtime;
    const modelEffects = runtime.modelEffects as unknown as {
      createContextCompactor: (...args: never[]) => unknown;
    };
    const gateway = runtime.gateway as unknown as {
      invoke: (...args: never[]) => Promise<unknown>;
    };
    const originalCreateContextCompactor = modelEffects.createContextCompactor;
    const originalInvoke = gateway.invoke;
    let coordinatorCalls = 0;
    let providerCalls = 0;
    modelEffects.createContextCompactor = () => {
      coordinatorCalls += 1;
      throw new Error('Builtin compactor must not be created without persistence.');
    };
    gateway.invoke = function (...args: never[]) {
      providerCalls += 1;
      return originalInvoke.apply(this, args);
    };
    try {
      const executor = coordinator.createRuntimeEffectPort(dependencies(fixture.store, runtime));
      await expect(
        executor(
          { type: 'compact_context', compactionId: 'retained-compaction-1' },
          coordinator.getState(),
        ),
      ).rejects.toThrow('Model effect persistence context is unavailable.');
      expect(coordinatorCalls).toBe(0);
      expect(providerCalls).toBe(0);
    } finally {
      modelEffects.createContextCompactor = originalCreateContextCompactor;
      gateway.invoke = originalInvoke;
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('closing a consumer before execution persists an interrupted terminal instead of leaving a running Turn', async () => {
    const sessionId = 'retained-consumer-closed';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    const coordinator = access.ensure(identity(sessionId));
    if (fixture.runtime.status !== 'available') throw new Error('test model runtime unavailable');
    try {
      const stream = coordinator.executeTurn(
        {
          task: 'The consumer closes after the durable Turn starts.',
          userId: 'tui-user',
          threadId: sessionId,
          workspace: retainedWorkspace,
          recoveryIdentityKey: 'a'.repeat(64),
          config: config(),
          model: createChatModel(config()),
          modelInvocationRuntime: { ...fixture.runtime, builtinToolCatalog },
          capabilityExecution,
          interactionMode: 'accept_edits',
          phase: 'building',
          sandboxBackend: 'none',
        },
        { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      );
      for await (const event of stream) {
        if (event.type === 'turn.started') break;
      }
      expect(coordinator.isTurnActive()).toBe(false);
      expect(coordinator.getState().turn).toMatchObject({ status: 'aborted', abortCause: 'error' });
      expect(coordinator.getState().terminalOutcome).toMatchObject({
        status: 'unknown',
        safeRetry: false,
        recoveryEntry: 'reconcile',
      });
      expect(
        fixture.store.sessions
          .loadEventsStrict(sessionId)
          .some(({ event }) => event.type === 'run.error'),
      ).toBe(true);
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('failed start activation settles its accepted Turn before Host dispatch', async () => {
    const sessionId = 'retained-start-activation-failure';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    const coordinator = access.ensure({ ...identity(sessionId), sandboxAvailable: false });
    const bridge = createFixtureBridge(sessionId, fixture, access);
    try {
      await bridge.recoverSession(sessionId, () => {});
      const inspected = await bridge.inspectCommand(
        startCommand(sessionId, coordinator.getState().revision),
        { targetSessionId: sessionId },
      );
      if (inspected.kind !== 'accepted') throw new Error('Start not accepted');
      const committed = await inspected.decision.commit(commandEvidence(sessionId));
      await expect(
        committed.activation?.(() => {
          throw new Error('Injected activation failure');
        }),
      ).rejects.toThrow('Injected activation failure');
      expect(coordinator.isTurnActive()).toBe(false);
      expect(coordinator.getState().turn).toMatchObject({ status: 'aborted', abortCause: 'error' });
      expect(coordinator.getState().terminalOutcome?.safeRetry).toBe(false);
      expect(fixture.store.sessions.loadEventsStrict(sessionId).at(-1)?.event.type).toBe(
        'turn.aborted',
      );
      const projection = await bridge.query({
        schema: 'kite.runtime-query.v1',
        type: 'get_session_projection',
        sessionId,
      });
      expect(projection.status).toBe('ok');
    } finally {
      await bridge.close();
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('resume settles a proven old global admission and rehydrates an undispatched Run', async () => {
    const sessionId = 'retained-obsolete-provider-admission';
    const fixture = createFixture(sessionId, undefined, retainedWorkspace, { storeRuns: true });
    const access = fixture.binding.access();
    const coordinator = access.ensure({ ...identity(sessionId), sandboxAvailable: false });
    const bridge = createFixtureBridge(sessionId, fixture, access);
    try {
      const started = coordinator.commitStartTurnCommand(
        startCommand(sessionId, coordinator.getState().revision),
        commandEvidence(sessionId),
      );
      coordinator.activateStartTurnRun?.(started.descriptor.turnId);
      coordinator.control.processEvent({
        type: 'provider.admission_required',
        interactionId: 'old-global-admission',
        providerId: 'offline-provider',
        source: 'explicit',
        providerStatus: 'login_required',
        retryable: true,
      });
      const before = coordinator.getState();
      expect(coordinator.session.getLifecycleProjection().currentRun?.status).toBe('waiting');
      const journal = fixture.store.sessions.loadEventsStrict(sessionId);
      const turnIndex = journal.findIndex(({ event }) => event.type === 'turn.started');
      expect(
        obsoleteGlobalAdmissionSettlementEvents(before, [
          ...journal.slice(0, turnIndex + 1),
          {
            event: { type: 'model.requested', requestId: 'pre-admission-dispatch' },
            revision: journal[turnIndex]!.revision,
          },
          ...journal.slice(turnIndex + 1),
        ]),
      ).toEqual([]);
      expect(
        obsoleteGlobalAdmissionSettlementEvents(
          {
            ...before,
            interactions: {
              kind: 'awaiting_provider_action',
              interactionId: 'real-provider-action',
              providerId: 'offline-provider',
              action: 'login',
              originatingToolCallId: 'actual-tool',
              status: 'required',
            },
          },
          journal,
        ),
      ).toEqual([]);
      expect(
        obsoleteGlobalAdmissionSettlementEvents(
          {
            ...before,
            recoveryState: { kind: 'corrupted', reason: 'unknown external outcome' },
          },
          journal,
        ),
      ).toEqual([]);
      await bridge.recoverSession(sessionId, () => {});
      const command = {
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'resume_session' as const,
        commandId: 'resume-original-run',
        sessionId,
      };
      const inspected = await bridge.inspectCommand(command, { targetSessionId: sessionId });
      if (inspected.kind !== 'accepted') throw new Error('Resume was not accepted');
      const committed = await inspected.decision.commit(
        commandEvidence(sessionId, command.commandId),
      );
      expect(committed.preparedExecution?.execution).toMatchObject({
        sessionId,
        operationId: command.commandId,
        committedRevision: committed.receipt.revision,
      });
      expect(coordinator.getState().turn.turnId).toBe(before.turn.turnId);
      expect(coordinator.getState().activeTaskId).toBe(before.activeTaskId);
      expect(coordinator.getState().transcript.messages).toEqual(before.transcript.messages);
      expect(coordinator.getState().providerAdmission.pending).toHaveLength(0);
      expect(coordinator.getState().providerAdmission.waivers).toEqual({});
      expect(coordinator.session.getLifecycleProjection().currentRun).toMatchObject({
        runId: started.descriptor.turnId,
        status: 'running',
      });
      expect(fixture.store.sessions.loadEventsStrict(sessionId).at(-1)?.event.type).toBe(
        'provider.admission_cancelled',
      );
      // The first receipt committed, but no prepared execution was dispatched.
      // After rehydration, the complete journal still proves no model or Tool
      // dispatch. A later command can continue this same Run.
      await access.release(sessionId);
      await bridge.recoverSession(sessionId, () => {});
      const restored = access.get(sessionId);
      expect(restored).toBeDefined();
      expect(restored).not.toBe(coordinator);
      expect(restored?.session.getLifecycleProjection().currentRun).toMatchObject({
        runId: started.descriptor.turnId,
        status: 'running',
      });
      expect(
        await bridge.recoverCommittedResume?.(command, committed.receipt.revision, () => {}),
      ).toMatchObject({
        execution: {
          sessionId,
          operationId: command.commandId,
          committedRevision: committed.receipt.revision,
        },
      });
      const repeat = await bridge.inspectCommand(
        { ...command, commandId: 'resume-again' },
        { targetSessionId: sessionId },
      );
      if (repeat.kind !== 'accepted') throw new Error('Repeat resume was not accepted');
      const repeated = await repeat.decision.commit(commandEvidence(sessionId, 'resume-again'));
      expect(repeated.preparedExecution?.execution).toMatchObject({
        sessionId,
        operationId: 'resume-again',
        committedRevision: repeated.receipt.revision,
      });
      expect(repeated.receipt.revision).toBe(committed.receipt.revision);
      expect(
        fixture.store.sessions
          .loadEventsStrict(sessionId)
          .filter(({ event }) => event.type === 'provider.admission_cancelled'),
      ).toHaveLength(1);
      expect(restored?.getState().transcript.messages).toEqual(before.transcript.messages);
    } finally {
      await bridge.close();
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('a waiting old global admission resumes its original Turn through one model call', async () => {
    const sessionId = 'retained-obsolete-admission-execution';
    let modelCalls = 0;
    const fixture = createFixture(sessionId, undefined, retainedWorkspace, {
      storeRuns: true,
      modelTransport: async () => {
        modelCalls += 1;
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered answer.' }] },
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null },
          providerMetadata: { responseId: 'recovered-answer-1' },
        };
      },
    });
    const access = fixture.binding.access();
    const coordinator = access.ensure({ ...identity(sessionId), sandboxAvailable: false });
    const bridge = createFixtureBridge(sessionId, fixture, access);
    try {
      const started = coordinator.commitStartTurnCommand(
        startCommand(sessionId, coordinator.getState().revision),
        commandEvidence(sessionId),
      );
      coordinator.activateStartTurnRun?.(started.descriptor.turnId);
      coordinator.control.processEvent({
        type: 'provider.admission_required',
        interactionId: 'obsolete-gate-to-execute',
        providerId: 'offline-provider',
        source: 'explicit',
        providerStatus: 'login_required',
        retryable: true,
      });
      const originalTurnId = coordinator.getState().turn.turnId;
      const originalTaskId = coordinator.getState().activeTaskId;
      await bridge.recoverSession(sessionId, () => {});
      const command = {
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'resume_session' as const,
        commandId: 'resume-and-execute-original',
        sessionId,
      };
      const inspected = await bridge.inspectCommand(command, { targetSessionId: sessionId });
      if (inspected.kind !== 'accepted') throw new Error('Resume was not accepted');
      const committed = await inspected.decision.commit(
        commandEvidence(sessionId, command.commandId),
      );
      const notifications: import('@kite-ai/runtime-contract').RuntimeNotification[] = [];
      await committed.activation?.((notification) => notifications.push(notification));
      const controller = new AbortController();
      await committed.preparedExecution?.execution?.run(controller.signal, (reason) =>
        controller.abort(reason),
      );
      expect(controller.signal.aborted).toBe(false);
      expect(modelCalls).toBe(1);
      expect(coordinator.getState().turn).toMatchObject({
        turnId: originalTurnId,
        status: 'completed',
      });
      expect(coordinator.getState().tasks[originalTaskId!]).toMatchObject({
        taskId: originalTaskId,
        status: 'completed',
      });
      expect(
        coordinator.getState().transcript.messages.filter((message) => message.kind === 'user'),
      ).toHaveLength(1);
      expect(coordinator.session.getLifecycleProjection().currentRun).toMatchObject({
        runId: started.descriptor.turnId,
        status: 'completed',
      });
      expect(
        fixture.store.sessions
          .loadEventsStrict(sessionId)
          .filter(({ event }) => event.type === 'model.requested'),
      ).toHaveLength(1);
      expect(notifications.some((notification) => notification.durability === 'durable')).toBe(
        true,
      );
    } finally {
      await bridge.close();
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('Host replays a committed resume from Store 8 after the pre-dispatch crash window', async () => {
    const sessionId = 'retained-obsolete-admission-host-replay';
    let modelCalls = 0;
    const fixture = createFixture(sessionId, undefined, retainedWorkspace, {
      storeRuns: true,
      modelTransport: async () => {
        modelCalls += 1;
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered once.' }] },
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null },
          providerMetadata: { responseId: 'host-replay-response-1' },
        };
      },
    });
    const access = fixture.binding.access();
    const coordinator = access.ensure({ ...identity(sessionId), sandboxAvailable: false });
    const bridge = createFixtureBridge(sessionId, fixture, access);
    let host: ReturnType<typeof createRuntimeHost<RuntimeEvent, RuntimeState>> | undefined;
    try {
      const started = coordinator.commitStartTurnCommand(
        startCommand(sessionId, coordinator.getState().revision),
        commandEvidence(sessionId),
      );
      coordinator.activateStartTurnRun?.(started.descriptor.turnId);
      coordinator.control.processEvent({
        type: 'provider.admission_required',
        interactionId: 'host-replay-obsolete-gate',
        providerId: 'offline-provider',
        source: 'explicit',
        providerStatus: 'login_required',
        retryable: true,
      });
      await bridge.recoverSession(sessionId, () => {});
      const command = {
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'resume_session' as const,
        commandId: 'host-replay-resume',
        sessionId,
      };
      const inspected = await bridge.inspectCommand(command, { targetSessionId: sessionId });
      if (inspected.kind !== 'accepted') throw new Error('Resume was not accepted');
      const committed = await inspected.decision.commit(
        createRuntimeCommandCommitEvidence({
          command,
          targetSessionId: sessionId,
          committedAt: Date.now(),
        }),
      );
      expect(committed.preparedExecution?.execution).toBeDefined();
      expect(modelCalls).toBe(0);
      expect(
        fixture.storage.commandReceipts.lookup({
          scopeSessionId: sessionId,
          commandId: command.commandId,
          requestDigest: createRuntimeCommandCommitEvidence({
            command,
            targetSessionId: sessionId,
            committedAt: Date.now(),
          }).requestDigest,
        }).status,
      ).toBe('replay');

      await access.release(sessionId);
      await bridge.recoverSession(sessionId, () => {});
      expect(
        await bridge.recoverCommittedResume?.(command, committed.receipt.revision, () => {}),
      ).toBeDefined();
      const module = defineRuntimeModule({
        moduleId: 'old-admission-host-replay-test',
        revision: '1',
        register: (registry) =>
          registry.registerExecutionAdapter({
            adapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
            revision: '1',
            create: () => bridge,
          }),
      });
      host = createRuntimeHost({ storage: fixture.storage, modules: [module] });
      const [left, right] = await Promise.all([host.command(command), host.command(command)]);
      expect(left).toMatchObject({
        status: 'idempotent_replay',
        originalRevision: committed.receipt.revision,
      });
      expect(right).toEqual(left);
      await host.waitForSessionIdle(sessionId);
      expect(modelCalls).toBe(1);
      expect(fixture.storage.runs?.get(sessionId, started.descriptor.turnId)).toMatchObject({
        status: 'completed',
      });
      const events = fixture.store.sessions.loadEventsStrict(sessionId);
      expect(
        events.filter(({ event }) => event.type === 'provider.admission_cancelled'),
      ).toHaveLength(1);
      expect(events.filter(({ event }) => event.type === 'model.requested')).toHaveLength(1);
      const eventCount = events.length;
      await host.query({
        schema: 'kite.runtime-query.v1',
        type: 'get_session_projection',
        sessionId,
      });
      expect(fixture.store.sessions.loadEventsStrict(sessionId)).toHaveLength(eventCount);
    } finally {
      await host?.[Symbol.asyncDispose]();
      await bridge.close();
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test.each([
    ['fresh', 'fresh-worker-binding', true],
    ['missing', null, false],
    ['stale', 'stale-worker-binding', false],
  ] as const)('replayed original Turn tool call enforces the %s command binding', async (scenario, bindingReference, shouldComplete) => {
    const sessionId = `retained-obsolete-admission-${scenario}-binding`;
    const fileName = 'fresh-binding-tool.txt';
    writeFileSync(join(retainedWorkspace, fileName), 'fresh binding tool input\n');
    let modelCalls = 0;
    const fixture = createFixture(sessionId, undefined, retainedWorkspace, {
      storeRuns: true,
      withToolPipelineComposition: true,
      modelTransport: async () => {
        modelCalls += 1;
        return {
          message:
            modelCalls === 1
              ? {
                  role: 'assistant',
                  content: [
                    {
                      type: 'tool_call',
                      toolCallId: 'fresh-binding-read',
                      toolName: 'read_file',
                      input: { path: fileName },
                    },
                  ],
                }
              : { role: 'assistant', content: [{ type: 'text', text: 'Tool completed.' }] },
          finishReason: modelCalls === 1 ? 'tool_calls' : 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null },
          providerMetadata: { responseId: `fresh-binding-response-${modelCalls}` },
        };
      },
    });
    const contexts: Readonly<RuntimeCommandContext>[] = [];
    const effectFactory: AppWorkspaceEffectCompositionFactory = (context) => {
      contexts.push(context);
      if (context.bindingReference !== 'fresh-worker-binding') {
        throw new Error('Workspace effect factory rejected a stale command binding.');
      }
      return {
        context: {} as ReturnType<AppWorkspaceEffectCompositionFactory>['context'],
        gate: {
          run: async (_attempt, dispatch) => ({ status: 'applied', result: await dispatch() }),
        },
        createAttempt: () => {
          throw new Error('Read-only tool must not create a Workspace effect attempt.');
        },
      };
    };
    const access = fixture.binding.access();
    const coordinator = access.ensure({
      ...identity(sessionId),
      sandboxAvailable: false,
      capabilityArtifactEvidence: fixture.runtime.capabilityArtifacts,
    });
    const bridge = createFixtureBridge(sessionId, fixture, access, effectFactory);
    let host: ReturnType<typeof createRuntimeHost<RuntimeEvent, RuntimeState>> | undefined;
    try {
      const started = coordinator.commitStartTurnCommand(
        startCommand(sessionId, coordinator.getState().revision),
        commandEvidence(sessionId),
      );
      coordinator.activateStartTurnRun?.(started.descriptor.turnId);
      coordinator.control.processEvent({
        type: 'provider.admission_required',
        interactionId: 'fresh-binding-obsolete-gate',
        providerId: 'offline-provider',
        source: 'explicit',
        providerStatus: 'login_required',
        retryable: true,
      });
      await bridge.recoverSession(sessionId, () => {});
      const command = {
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'resume_session' as const,
        commandId: 'resume-fresh-binding',
        sessionId,
      };
      const inspected = await bridge.inspectCommand(command, { targetSessionId: sessionId });
      if (inspected.kind !== 'accepted') throw new Error('Resume was not accepted');
      await inspected.decision.commit(
        createRuntimeCommandCommitEvidence({
          command,
          targetSessionId: sessionId,
          committedAt: Date.now(),
        }),
      );
      await access.release(sessionId);
      await bridge.recoverSession(sessionId, () => {});
      const module = defineRuntimeModule({
        moduleId: 'old-admission-fresh-binding-test',
        revision: '1',
        register: (registry) =>
          registry.registerExecutionAdapter({
            adapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
            revision: '1',
            create: () => bridge,
          }),
      });
      host = createRuntimeHost({ storage: fixture.storage, modules: [module] });
      const freshContext: RuntimeCommandContext = {
        schema: RUNTIME_COMMAND_CONTEXT_SCHEMA_,
        connectionId: 'reconnected-client',
        requestId: 'fresh-replay-request',
        bindingReference,
      };
      expect(await host.command(command, freshContext)).toMatchObject({
        status: 'idempotent_replay',
      });
      await host.waitForSessionIdle(sessionId);
      if (shouldComplete) {
        expect(contexts).toEqual([freshContext]);
        expect(modelCalls).toBe(2);
        expect(fixture.storage.runs?.get(sessionId, started.descriptor.turnId)).toMatchObject({
          status: 'completed',
        });
        expect(access.get(sessionId)?.getState().tools.calls['fresh-binding-read']).toMatchObject({
          status: 'succeeded',
        });
        expect(
          fixture.store.sessions
            .loadEventsStrict(sessionId)
            .some(
              ({ event }) =>
                event.type === 'tool.finished' && event.toolCallId === 'fresh-binding-read',
            ),
        ).toBe(true);
      } else {
        expect(contexts).toEqual(bindingReference === null ? [] : [freshContext]);
        expect(modelCalls).toBe(1);
        expect(fixture.storage.runs?.get(sessionId, started.descriptor.turnId)).toMatchObject({
          status: 'unknown',
          terminal: { safeRetry: false },
        });
        expect(
          fixture.store.sessions
            .loadEventsStrict(sessionId)
            .some(
              ({ event }) =>
                event.type === 'tool.finished' && event.toolCallId === 'fresh-binding-read',
            ),
        ).toBe(false);
      }
    } finally {
      await host?.[Symbol.asyncDispose]();
      await bridge.close();
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test.each([
    'prepared',
    'attempt_started',
  ] as const)('Host does not replay a committed resume with durable model %s evidence', async (dispatchEvidence) => {
    const sessionId = `retained-obsolete-admission-${dispatchEvidence}`;
    const fixture = createFixture(sessionId, undefined, retainedWorkspace, { storeRuns: true });
    const access = fixture.binding.access();
    const coordinator = access.ensure({ ...identity(sessionId), sandboxAvailable: false });
    const bridge = createFixtureBridge(sessionId, fixture, access);
    let host: ReturnType<typeof createRuntimeHost<RuntimeEvent, RuntimeState>> | undefined;
    try {
      const started = coordinator.commitStartTurnCommand(
        startCommand(sessionId, coordinator.getState().revision),
        commandEvidence(sessionId),
      );
      coordinator.activateStartTurnRun?.(started.descriptor.turnId);
      coordinator.control.processEvent({
        type: 'provider.admission_required',
        interactionId: 'obsolete-gate-before-model',
        providerId: 'offline-provider',
        source: 'explicit',
        providerStatus: 'login_required',
        retryable: true,
      });
      await bridge.recoverSession(sessionId, () => {});
      const command = {
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'resume_session' as const,
        commandId: `resume-before-${dispatchEvidence}`,
        sessionId,
      };
      const inspected = await bridge.inspectCommand(command, { targetSessionId: sessionId });
      if (inspected.kind !== 'accepted') throw new Error('Resume was not accepted');
      const committed = await inspected.decision.commit(
        createRuntimeCommandCommitEvidence({
          command,
          targetSessionId: sessionId,
          committedAt: Date.now(),
        }),
      );
      const invocationId = 'model-before-replay';
      const surfaceArtifact = {
        kind: 'model_surface' as const,
        artifactId: `pa_${'b'.repeat(64)}`,
        integrityIdentifier: `sha256:${'c'.repeat(64)}`,
        byteLength: 1,
      };
      coordinator.control.processEvent({
        type: 'model.invocation_prepared',
        invocationId,
        purpose: 'primary_agent',
        surfaceArtifact,
        surfaceIntegrityIdentifier: surfaceArtifact.integrityIdentifier,
        routeFingerprint: `sha256:${'d'.repeat(64)}`,
        budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
        limits: { maxAttempts: 1, perAttemptTimeoutMs: 1000, totalTimeBudgetMs: 1000 },
        preparedStateRevision: committed.receipt.revision,
        parentInvocationId: null,
        parentToolCallId: null,
      });
      if (dispatchEvidence === 'attempt_started') {
        coordinator.control.processEvent({
          type: 'model.invocation_attempt_started',
          invocationId,
          attempt: 1,
          maxAttempts: 1,
        });
      }
      await access.release(sessionId);
      await bridge.recoverSession(sessionId, () => {});
      const eventCount = fixture.store.sessions.loadEventsStrict(sessionId).length;
      const module = defineRuntimeModule({
        moduleId: `old-admission-${dispatchEvidence}-test`,
        revision: '1',
        register: (registry) =>
          registry.registerExecutionAdapter({
            adapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
            revision: '1',
            create: () => bridge,
          }),
      });
      host = createRuntimeHost({ storage: fixture.storage, modules: [module] });
      expect(await host.command(command)).toMatchObject({
        status: 'idempotent_replay',
        originalRevision: committed.receipt.revision,
      });
      expect(
        await host.command({ ...command, commandId: `new-${command.commandId}` }),
      ).toMatchObject({
        status: 'applied',
      });
      await host.waitForSessionIdle(sessionId);
      expect(fixture.store.sessions.loadEventsStrict(sessionId)).toHaveLength(eventCount);
      expect(fixture.storage.runs?.get(sessionId, started.descriptor.turnId)).toMatchObject({
        status: 'running',
      });
      expect(
        await bridge.recoverCommittedResume?.(command, committed.receipt.revision, () => {}),
      ).toBeUndefined();
    } finally {
      await host?.[Symbol.asyncDispose]();
      await bridge.close();
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test.each([
    ['reject', 'none'],
    ['approve_once', 'none'],
    ['approve_once', 'activation'],
    ['approve_once', 'setup'],
  ] as const)('a recovered approval %s with %s failure preserves receipt and Turn ownership', async (decision, failure) => {
    const sessionId = `retained-recovered-approval-${decision}-${failure}`;
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    const coordinator = access.ensure({ ...identity(sessionId), sandboxAvailable: false });
    const bridge = createFixtureBridge(sessionId, fixture, access);
    try {
      coordinator.commitStartTurnCommand(
        startCommand(sessionId, coordinator.getState().revision),
        commandEvidence(sessionId),
      );
      // Persist an approval without a process-local broker waiter, as on recovery.
      coordinator.control.processEventBatch([
        {
          type: 'tool.queued',
          toolCallId: 'approval-shell',
          name: 'shell_execute',
          args: { command: 'printf retained' },
        },
        {
          type: 'approval.requested',
          interactionId: 'recovered-approval',
          toolCallId: 'approval-shell',
          fullModeBypassEligible: false,
          fullModePolicyBypassAllowed: false,
          owner: { kind: 'root_tool', toolCallId: 'approval-shell' },
          approval: {
            scope: 'once',
            cwd: retainedWorkspace,
            threadId: sessionId,
            tool: 'shell_execute',
            command: 'printf retained',
            risk: 'execute_code',
            approvalHash: 'retained-approval-hash',
            summary: 'Run a retained fixture command.',
            reason: 'Recovered approval fixture.',
            expectedEffects: [],
            grantOptions: ['approve_once'],
            recommendedGrant: 'approve_once',
          },
        },
      ]);
      await bridge.recoverSession(sessionId, () => {});
      const query = await bridge.query({
        schema: 'kite.runtime-query.v1',
        type: 'get_session_projection',
        sessionId,
      });
      if (query.status !== 'ok' || !query.session) throw new Error('Projection unavailable');
      const interaction = query.session.interactionQueue?.interactions[0];
      if (interaction?.kind !== 'approval') throw new Error('Approval unavailable');
      const commandId = `recovered-${decision}`;
      const inspected = await bridge.inspectCommand(
        {
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'respond_interaction',
          commandId,
          sessionId,
          expectedRevision: query.session.revision,
          interaction,
          response: { kind: 'approval', decision },
        },
        { targetSessionId: sessionId },
      );
      if (inspected.kind !== 'accepted') throw new Error('Approval response not accepted');
      const committed = await inspected.decision.commit(commandEvidence(sessionId, commandId));
      const published: import('@kite-ai/runtime-contract').RuntimeNotification[] = [];
      if (failure === 'activation') {
        await expect(
          committed.activation?.(() => {
            throw new Error('Recovered activation failure');
          }),
        ).rejects.toThrow('Recovered activation failure');
        expect(coordinator.getState().turn).toMatchObject({
          status: 'aborted',
          abortCause: 'error',
        });
        expect(coordinator.getState().terminalOutcome?.safeRetry).toBe(false);
        expect(fixture.store.sessions.loadEventsStrict(sessionId).at(-1)?.event.type).toBe(
          'turn.aborted',
        );
        return;
      }
      await committed.activation?.((notification) => published.push(notification));
      if (failure === 'setup') {
        const original = coordinator.session.getLifecycleProjection;
        coordinator.session.getLifecycleProjection = () => ({});
        const controller = new AbortController();
        try {
          await committed.preparedExecution?.execution?.run(controller.signal, (reason) =>
            controller.abort(reason),
          );
        } finally {
          coordinator.session.getLifecycleProjection = original;
        }
        expect(coordinator.isTurnActive()).toBe(false);
        expect(coordinator.getState().turn).toMatchObject({
          status: 'aborted',
          abortCause: 'error',
        });
        expect(coordinator.getState().terminalOutcome?.safeRetry).toBe(false);
        expect(fixture.store.sessions.loadEventsStrict(sessionId).at(-1)?.event.type).toBe(
          'turn.aborted',
        );
        return;
      }
      expect(committed.receipt).toMatchObject({ status: 'applied', commandId, sessionId });
      expect(published.at(-1)).toMatchObject({
        durability: 'durable',
        revision: coordinator.getState().revision,
      });
      if (decision === 'reject') {
        expect(coordinator.getState().pendingApprovals.size).toBe(0);
        expect(committed.preparedExecution).toBeUndefined();
        expect(coordinator.getState().turn).toMatchObject({
          status: 'aborted',
          abortCause: 'user',
        });
        expect(fixture.store.sessions.loadEventsStrict(sessionId).at(-1)?.event.type).toBe(
          'turn.aborted',
        );
      } else {
        expect(coordinator.getState().pendingApprovals.get('recovered-approval')?.status).toBe(
          'authorized_queued',
        );
        expect(committed.preparedExecution?.execution).toMatchObject({
          sessionId,
          operationId: commandId,
          committedRevision: committed.receipt.revision,
        });
        expect(coordinator.getState().turn.status).toBe('active');
      }
    } finally {
      await bridge.close();
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('an early recovered-provider failure publishes the canonical terminal without a generic closure', async () => {
    const sessionId = 'retained-canonical-recovery-failure';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    const coordinator = access.ensure({ ...identity(sessionId), sandboxAvailable: false });
    const bridge = createFixtureBridge(sessionId, fixture, access);
    try {
      await bridge.recoverSession(sessionId, () => {});
      const inspected = await bridge.inspectCommand(
        startCommand(sessionId, coordinator.getState().revision),
        { targetSessionId: sessionId },
      );
      if (inspected.kind !== 'accepted') throw new Error('Start not accepted');
      const committed = await inspected.decision.commit(commandEvidence(sessionId));
      const published: import('@kite-ai/runtime-contract').RuntimeNotification[] = [];
      await committed.activation?.((notification) => published.push(notification));
      // A restored provider handle becomes visible after admission. Recovery
      // cannot confirm it, so Kernel supplies canonical failure metadata.
      Object.assign(coordinator.getState().capabilities.invocations, {
        'canonical-invocation': {
          invocationId: 'canonical-invocation',
          toolCallId: 'canonical-tool',
          capabilityId: 'builtin:task',
          capabilityRevision: '2'.repeat(64),
          argumentsDigest: '3'.repeat(64),
          authorizationDigest: '4'.repeat(64),
          admissionDigest: '5'.repeat(64),
          effectiveEffectsDigest: '6'.repeat(64),
          receiptRequirement: 'control_receipt',
          status: 'running',
          recordedAt: '2026-08-25T00:00:00.000Z',
          startedAt: '2026-08-25T00:00:00.000Z',
          attemptsStarted: 1,
          subagentProviderLifecycle: {
            attempt: 1,
            purpose: 'start',
            childInvocationId: 'audit-child-invocation',
            taskArtifact: {
              artifactId: `pa_${'7'.repeat(64)}`,
              kind: 'subagent_task',
              integrityIdentifier: `sha256:${'8'.repeat(64)}`,
              byteLength: 128,
            },
            dispatchIntentDigest: `sha256:${'c'.repeat(64)}`,
            status: 'handle_recorded',
            recordedAt: '2026-08-25T00:00:00.000Z',
            handleArtifact: {
              artifactId: `pa_${'9'.repeat(64)}`,
              kind: 'subagent_handle',
              integrityIdentifier: `sha256:${'a'.repeat(64)}`,
              byteLength: 256,
            },
            handleIntegrityIdentifier: `sha256:${'b'.repeat(64)}`,
            handleRecordedAt: '2026-08-25T00:00:00.000Z',
          },
        },
      });
      const controller = new AbortController();
      await committed.preparedExecution?.execution?.run(controller.signal, (reason) =>
        controller.abort(reason),
      );
      const errors = fixture.store.sessions
        .loadEventsStrict(sessionId)
        .filter(({ event }) => event.type === 'run.error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.event).toMatchObject({
        type: 'run.error',
        message: 'Subagent Provider crash recovery could not be confirmed.',
      });
      expect(published).toContainEqual(
        expect.objectContaining({
          durability: 'durable',
          projection: expect.objectContaining({
            event: expect.objectContaining({ type: 'run.terminal' }),
          }),
        }),
      );
      expect(coordinator.getState().turn).toMatchObject({ status: 'aborted', abortCause: 'error' });
      expect(coordinator.isTurnActive()).toBe(false);
    } finally {
      await bridge.close();
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('control activation publishes an already-committed background event before its newer revision', async () => {
    const sessionId = 'retained-control-publication-order';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    const coordinator = access.ensure({ ...identity(sessionId), sandboxAvailable: false });
    const bridge = createFixtureBridge(sessionId, fixture, access);
    try {
      await bridge.recoverSession(sessionId, () => {});
      const start = await bridge.inspectCommand(
        startCommand(sessionId, coordinator.getState().revision),
        { targetSessionId: sessionId },
      );
      if (start.kind !== 'accepted') throw new Error('Start not accepted');
      const committed = await start.decision.commit(commandEvidence(sessionId));
      const published: import('@kite-ai/runtime-contract').RuntimeNotification[] = [];
      await committed.activation?.((notification) => published.push(notification));
      // Background execution commits before its generator gets its next turn.
      // Keep that exact event pending while the command mailbox admits a control.
      coordinator.control.processEventBatch([
        {
          type: 'tool.queued',
          toolCallId: 'background-shell',
          name: 'shell_execute',
          args: { command: 'printf background' },
        },
      ]);
      const controlId = 'control-after-background-commit';
      const control = await bridge.inspectCommand(
        {
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'set_interaction_mode',
          commandId: controlId,
          sessionId,
          expectedRevision: coordinator.getState().revision,
          mode: 'auto',
        },
        { targetSessionId: sessionId },
      );
      if (control.kind !== 'accepted') throw new Error('Control not accepted');
      const changed = await control.decision.commit(commandEvidence(sessionId, controlId));
      await changed.activation?.((notification) => published.push(notification));
      expect(
        published
          .filter((notification) => notification.durability === 'durable')
          .map((notification) => notification.revision),
      ).toEqual([1, 2, 3, 4]);
      expect(published[2]).toMatchObject({
        revision: 3,
        projection: { event: { type: 'tool.queued', toolId: 'background-shell' } },
      });
    } finally {
      await bridge.close();
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('live pending approval activation failure releases the runner waiter', async () => {
    const sessionId = 'retained-live-pending-activation-failure';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    const coordinator = access.ensure({ ...identity(sessionId), sandboxAvailable: false });
    const bridge = createFixtureBridge(sessionId, fixture, access);
    const originalExecuteTurn = coordinator.executeTurn;
    let runPromise: Promise<void> | undefined;
    try {
      await bridge.recoverSession(sessionId, () => {});
      const inspectedStart = await bridge.inspectCommand(
        startCommand(sessionId, coordinator.getState().revision),
        { targetSessionId: sessionId },
      );
      if (inspectedStart.kind !== 'accepted') throw new Error('Start not accepted');
      const committedStart = await inspectedStart.decision.commit(commandEvidence(sessionId));
      const published: import('@kite-ai/runtime-contract').RuntimeNotification[] = [];
      await committedStart.activation?.((notification) => published.push(notification));

      coordinator.control.processEventBatch([
        {
          type: 'tool.queued',
          toolCallId: 'live-approval-shell',
          name: 'shell_execute',
          args: { command: 'printf live' },
        },
        {
          type: 'approval.requested',
          interactionId: 'live-approval',
          toolCallId: 'live-approval-shell',
          fullModeBypassEligible: false,
          fullModePolicyBypassAllowed: false,
          owner: { kind: 'root_tool', toolCallId: 'live-approval-shell' },
          approval: {
            scope: 'once',
            cwd: retainedWorkspace,
            threadId: sessionId,
            tool: 'shell_execute',
            command: 'printf live',
            risk: 'execute_code',
            approvalHash: 'live-approval-hash',
            summary: 'Run live fixture command.',
            reason: 'Live waiter fixture.',
            expectedEffects: [],
            grantOptions: ['approve_once'],
            recommendedGrant: 'approve_once',
          },
        },
      ]);

      coordinator.executeTurn = async function* (_input, provider) {
        await provider.requestAction(
          {
            type: 'request_tool_approval',
            interactionId: 'live-approval',
            toolCallId: 'live-approval-shell',
          },
          coordinator.getState() as RuntimeState,
          {
            commit: (action, evidence, expectedRevision) =>
              coordinator.commitInteractionCommand!({
                action,
                sessionId,
                interactionId: 'live-approval',
                expectedRevision,
                effectType: 'request_tool_approval',
                reservationReconciliationEvents: [],
                sandboxAvailable: coordinator.getSandboxAvailable() === true,
                evidence,
              }),
          },
        );
      };

      const execution = committedStart.preparedExecution?.execution;
      if (!execution) throw new Error('Prepared execution unavailable');
      runPromise = execution.run(new AbortController().signal, () => undefined);

      // #runTurn starts the generator synchronously, so the broker waiter is
      // installed before the prepared execution returns its pending Promise.
      const query = await bridge.query({
        schema: 'kite.runtime-query.v1',
        type: 'get_session_projection',
        sessionId,
      });
      if (query.status !== 'ok' || !query.session) throw new Error('Projection unavailable');
      const interaction = query.session.interactionQueue?.interactions[0];
      if (interaction?.kind !== 'approval') throw new Error('Live approval unavailable');
      const commandId = 'live-approve-once';
      const inspected = await bridge.inspectCommand(
        {
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'respond_interaction',
          commandId,
          sessionId,
          expectedRevision: query.session.revision,
          interaction,
          response: { kind: 'approval', decision: 'approve_once' },
        },
        { targetSessionId: sessionId },
      );
      if (inspected.kind !== 'accepted') throw new Error('Live approval response not accepted');
      const committed = await inspected.decision.commit(commandEvidence(sessionId, commandId));
      expect(committed.preparedExecution).toBeUndefined();
      await expect(
        committed.activation?.(() => {
          throw new Error('Injected live activation failure');
        }),
      ).rejects.toThrow('Injected live activation failure');

      const settled = await Promise.race([
        runPromise.then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        ),
        Bun.sleep(500).then(() => 'timed_out' as const),
      ]);
      expect(settled).toBe('resolved');
      expect(coordinator.getState().turn).toMatchObject({ status: 'aborted', abortCause: 'error' });
      expect(coordinator.getState().terminalOutcome).toMatchObject({
        status: 'unknown',
        safeRetry: false,
        recoveryEntry: 'reconcile',
      });
    } finally {
      coordinator.executeTurn = originalExecuteTurn;
      await bridge.close();
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('a projection failure settles the durable Turn and leaves the same bridge queryable', async () => {
    const sessionId = 'retained-bridge-projection-failure';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    const coordinator = access.ensure({ ...identity(sessionId), sandboxAvailable: false });
    const bridge = createFixtureBridge(sessionId, fixture, access);
    const controller = new AbortController();
    const originalRevision = coordinator.revisionForEvent;
    let injected = false;
    try {
      await bridge.recoverSession(sessionId, () => {});
      const inspected = await bridge.inspectCommand(
        startCommand(sessionId, coordinator.getState().revision),
        { targetSessionId: sessionId },
      );
      if (inspected.kind !== 'accepted') throw new Error('start was not accepted');
      const committed = await inspected.decision.commit(commandEvidence(sessionId));
      const published: import('@kite-ai/runtime-contract').RuntimeNotification[] = [];
      await committed.activation?.((event) => published.push(event));
      // Corrupt the consumer's event-metadata lookup, not the durable journal.
      coordinator.revisionForEvent = () => {
        injected = true;
        return undefined;
      };
      await committed.preparedExecution?.execution?.run(controller.signal, (reason) =>
        controller.abort(reason),
      );
      expect(injected).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(coordinator.isTurnActive()).toBe(false);
      expect(coordinator.getState().turn.status).toBe('aborted');
      expect(coordinator.getState().terminalOutcome).toMatchObject({
        status: 'unknown',
        safeRetry: false,
        recoveryEntry: 'reconcile',
      });
      expect(published.at(-1)).toMatchObject({
        durability: 'durable',
        revision: coordinator.getState().revision,
      });
      await expect(
        bridge.query({
          schema: 'kite.runtime-query.v1',
          type: 'get_session_projection',
          sessionId,
        }),
      ).resolves.toMatchObject({
        status: 'ok',
        session: { revision: coordinator.getState().revision },
      });
    } finally {
      coordinator.revisionForEvent = originalRevision;
      await bridge.close();
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('persists an explicit failure when the State runner exits with an active Turn', async () => {
    const sessionId = 'retained-active-runner-exit';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    const coordinator = access.ensure(identity(sessionId));
    if (fixture.runtime.status !== 'available') {
      throw new Error('test model runtime unavailable');
    }
    const modelEffects = fixture.runtime.modelEffects as unknown as {
      executePrimaryModelEffect: (...args: never[]) => Promise<unknown>;
    };
    const originalPrimaryEffect = modelEffects.executePrimaryModelEffect;
    modelEffects.executePrimaryModelEffect = async () => ({ kind: 'completed', value: [] });
    try {
      const events: RuntimeEvent[] = [];
      for await (const event of coordinator.executeTurn(
        {
          task: 'Exercise a runner that returns without a terminal fact.',
          userId: 'tui-user',
          threadId: sessionId,
          workspace: retainedWorkspace,
          recoveryIdentityKey: 'a'.repeat(64),
          config: config(),
          model: createChatModel(config()),
          modelInvocationRuntime: { ...fixture.runtime, builtinToolCatalog },
          capabilityExecution,
          interactionMode: 'accept_edits',
          phase: 'building',
          sandboxBackend: 'none',
        },
        { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      )) {
        events.push(event);
      }

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'run.error',
          message: 'Runtime State runner exited without a durable Turn terminal.',
        }),
      );
      expect(events.at(-1)).toEqual(
        expect.objectContaining({ type: 'turn.aborted', cause: 'error' }),
      );
      expect(coordinator.getState().turn.status).toBe('aborted');
      expect(
        fixture.store.sessions
          .loadEventsStrict(sessionId)
          .slice(-2)
          .map(({ event }) => event.type),
      ).toEqual(['run.error', 'turn.aborted']);
    } finally {
      modelEffects.executePrimaryModelEffect = originalPrimaryEffect;
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('routes primary and compaction model effects through the App coordinator once', async () => {
    const primarySessionId = 'retained-primary-route';
    const primaryFixture = createFixture(primarySessionId);
    const primaryAccess = primaryFixture.binding.access();
    const primaryCoordinator = primaryAccess.ensure(identity(primarySessionId));
    if (primaryFixture.runtime.status !== 'available') {
      throw new Error('test model runtime unavailable');
    }
    const modelEffects = primaryFixture.runtime.modelEffects as unknown as {
      executePrimaryModelEffect: (...args: never[]) => Promise<unknown>;
    };
    const originalPrimaryEffect = modelEffects.executePrimaryModelEffect;
    let primaryCalls = 0;
    modelEffects.executePrimaryModelEffect = async () => {
      primaryCalls += 1;
      return { kind: 'completed', value: [] };
    };
    try {
      const primaryDependencies = dependencies(primaryFixture.store, primaryFixture.runtime);
      await expect(
        createAppRuntimeEffectExecutor({
          ...primaryDependencies,
          modelEffectCoordinator: undefined,
        })({ type: 'call_model' }, primaryCoordinator.getState(), undefined, {
          reservationIds: [],
          persistEvent: async () => true,
          persistEvents: async () => true,
        }),
      ).rejects.toThrow('Model effect coordinator is unavailable');
      expect(primaryCalls).toBe(0);
      const retainedExecutor = primaryCoordinator.createRuntimeEffectPort(primaryDependencies);
      const executionContext = {
        reservationIds: [],
        persistEvent: async () => true,
        persistEvents: async () => true,
      };
      await expect(
        retainedExecutor(
          { type: 'call_model' },
          primaryCoordinator.getState(),
          undefined,
          executionContext,
        ),
      ).resolves.toEqual([]);
      expect(primaryCalls).toBe(1);

      modelEffects.executePrimaryModelEffect = originalPrimaryEffect;
      await expect(
        retainedExecutor({ type: 'call_model' }, primaryCoordinator.getState()),
      ).rejects.toThrow('execution context is unavailable');
      expect(primaryCalls).toBe(1);
      modelEffects.executePrimaryModelEffect = async () => {
        primaryCalls += 1;
        return { kind: 'completed', value: [] };
      };

      expect(primaryCalls).toBe(1);
    } finally {
      modelEffects.executePrimaryModelEffect = originalPrimaryEffect;
      await primaryAccess.close();
      primaryFixture.storage.close();
      rmSync(primaryFixture.root, { recursive: true, force: true });
    }

    const remainingSessionId = 'retained-remaining-route';
    const remainingFixture = createFixture(remainingSessionId, requestedState(remainingSessionId));
    const remainingAccess = remainingFixture.binding.access();
    const remainingCoordinator = remainingAccess.ensure(identity(remainingSessionId));
    if (remainingFixture.runtime.status !== 'available') {
      throw new Error('test model runtime unavailable');
    }
    const remainingModelEffects = remainingFixture.runtime.modelEffects as unknown as {
      executePrimaryModelEffect: (...args: never[]) => Promise<unknown>;
    };
    const originalRemainingPrimary = remainingModelEffects.executePrimaryModelEffect;
    let remainingPrimaryCalls = 0;
    remainingModelEffects.executePrimaryModelEffect = async () => {
      remainingPrimaryCalls += 1;
      return { kind: 'completed', value: [] };
    };
    try {
      const compactor = async ({
        state: current,
        sourceRevision,
        projectionEnvironment,
      }: Parameters<NonNullable<RuntimeExecutorDependencies['testContextCompactor']>>[0]) =>
        checkpointFor(current, sourceRevision, projectionEnvironment);
      const events = await remainingCoordinator.executePendingCompaction({
        dependencies: dependencies(remainingFixture.store, remainingFixture.runtime, compactor),
      });
      expect(
        events.some(
          (event) =>
            event.type === 'context.compaction_completed' ||
            event.type === 'context.compaction_failed',
        ),
      ).toBe(true);
      expect(remainingPrimaryCalls).toBe(0);
    } finally {
      remainingModelEffects.executePrimaryModelEffect = originalRemainingPrimary;
      await remainingAccess.close();
      remainingFixture.storage.close();
      rmSync(remainingFixture.root, { recursive: true, force: true });
    }
  });

  test('owns auto-review in the App coordinator', async () => {
    const state = autoReviewState('retained-auto-review-owner');
    let gatewayCalls = 0;
    const model = createChatModel(config());
    const harness = createTestModelInvocationHarness({
      workspace: state.session.workspace,
      state,
      transport: async () => ({
        message: {
          role: 'assistant' as const,
          content: [
            {
              type: 'text' as const,
              text: '{"decision":"approve_once","reason":"retained reviewer accepted"}',
            },
          ],
        },
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null },
        providerMetadata: { responseId: 'retained-review-response' },
      }),
      operationExecution: {
        execute: async (attempt) => {
          gatewayCalls += 1;
          expect(attempt.operationId).toBe(BUILTIN_MODEL_OPERATION_BY_PURPOSE_.auto_review);
          expect(attempt.purpose).toBe('auto_review');
          return attempt.attempt();
        },
      },
    });
    const modelEffectCoordinator = new BuiltinModelEffectCoordinator(harness.gateway);
    const dependencies: RuntimeExecutorDependencies = {
      config: config(),
      model,
      modelInvocationGateway: harness.gateway,
      modelEffectCoordinator,
      builtinToolCatalog,
      capabilityExecution,
    };
    const retainedExecutor = createAppRuntimeEffectExecutor(dependencies);
    const events = await retainedExecutor(
      { type: 'run_auto_review', reviewId: 'retained-review-1', toolCallId: 'reviewed-shell' },
      state,
      undefined,
      {
        reservationIds: [],
        getState: harness.persistence.getState,
        persistEvent: async (event) => harness.persistence.persistEvents([event]),
        persistEvents: harness.persistence.persistEvents,
      },
    );

    expect(gatewayCalls).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'auto_review.completed',
        result: expect.objectContaining({ approved: true, grant: 'approve_once' }),
      }),
    ]);

    expect(gatewayCalls).toBe(1);
  });

  test.each([
    ['reject', false, false],
    ['ask_user', true, true],
  ] as const)('projects reviewer %s as a distinct Runtime outcome', async (_decision, askUser, escalated) => {
    const state = autoReviewState(`retained-auto-review-${_decision}`);
    const dependencies: RuntimeExecutorDependencies = {
      config: config(),
      model: createChatModel(config()),
      modelInvocationGateway: {} as NonNullable<
        RuntimeExecutorDependencies['modelInvocationGateway']
      >,
      modelEffectCoordinator: {
        reviewToolApproval: async () => ({
          ok: true,
          suggestion: {
            approved: false,
            ...(askUser ? { requiresUserApproval: true as const } : {}),
            grant: 'approve_once' as const,
            reason: askUser ? 'user intent is required' : 'reviewer rejected the operation',
          },
        }),
      } as unknown as NonNullable<RuntimeExecutorDependencies['modelEffectCoordinator']>,
      builtinToolCatalog,
      capabilityExecution,
    };

    const events = await createAppRuntimeEffectExecutor(dependencies)(
      { type: 'run_auto_review', reviewId: 'retained-review-1', toolCallId: 'reviewed-shell' },
      state,
    );

    expect(events[0]).toMatchObject({
      type: 'auto_review.completed',
      result: { approved: false, ...(escalated ? { escalatedToUser: true } : {}) },
    });
    // Escalation keeps the same durable review identity; it must not synthesize
    // a second approval.requested event.
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
  });

  test('runs deterministic verification without model dispatch', async () => {
    const state = verificationState('retained-verification-owner');
    let gatewayCalls = 0;
    let responseSourceCalls = 0;
    const harness = createTestModelInvocationHarness({
      workspace: state.session.workspace,
      state,
      transport: async () => {
        responseSourceCalls += 1;
        return {
          message: {
            role: 'assistant' as const,
            content: [
              {
                type: 'text' as const,
                text: '{"outcome":"passed","summary":"retained verification passed"}',
              },
            ],
          },
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null },
          providerMetadata: { responseId: 'retained-verification-response' },
        };
      },
      operationExecution: {
        execute: async (attempt) => {
          gatewayCalls += 1;
          return attempt.attempt();
        },
      },
    });
    const modelEffectCoordinator = new BuiltinModelEffectCoordinator(harness.gateway);
    const dependencies: RuntimeExecutorDependencies = {
      config: config(),
      model: createChatModel(config()),
      modelInvocationGateway: harness.gateway,
      modelEffectCoordinator,
      builtinToolCatalog,
      capabilityExecution,
    };
    const retainedExecutor = createAppRuntimeEffectExecutor(dependencies);
    const effect = {
      type: 'run_verification' as const,
      verificationId: 'retained-verification-1',
    };
    const events = await retainedExecutor(effect, state, undefined, {
      reservationIds: [],
      getState: harness.persistence.getState,
      persistEvent: async (event) => harness.persistence.persistEvents([event]),
      persistEvents: harness.persistence.persistEvents,
    });

    expect(gatewayCalls).toBe(0);
    expect(responseSourceCalls).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'verification.check_completed',
        result: expect.objectContaining({ outcome: 'passed' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'verification.completed', outcome: 'passed' }),
    );
  });

  test.each([
    ['missing child continuation', { subagentId: 'missing-child' }],
    ['invalid builtin tool', { toolName: 'unknown_builtin' }],
  ] as const)('rejects %s before reviewer or Host dispatch', async (_label, options) => {
    const state = autoReviewState(`retained-auto-review-${_label}`, options);
    let reviewerCalls = 0;
    let gatewayCalls = 0;
    const dependencies: RuntimeExecutorDependencies = {
      config: config(),
      model: createChatModel(config()),
      modelInvocationGateway: {
        invoke: async () => {
          gatewayCalls += 1;
          throw new Error('invalid review input must not reach the Gateway');
        },
      } as unknown as NonNullable<RuntimeExecutorDependencies['modelInvocationGateway']>,
      modelEffectCoordinator: {
        reviewToolApproval: async () => {
          reviewerCalls += 1;
          throw new Error('invalid review input must not reach the reviewer');
        },
      } as unknown as NonNullable<RuntimeExecutorDependencies['modelEffectCoordinator']>,
      builtinToolCatalog,
      capabilityExecution,
    };

    const events = await createAppRuntimeEffectExecutor(dependencies)(
      { type: 'run_auto_review', reviewId: 'retained-review-1', toolCallId: 'reviewed-shell' },
      state,
    );

    expect(reviewerCalls).toBe(0);
    expect(gatewayCalls).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'auto_review.completed',
        result: expect.objectContaining({ approved: false }),
      }),
    ]);
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
  });
});
