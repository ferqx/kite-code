import { expect, test } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
  createRuntimeHostCapabilityExecutionPortFromSnapshot,
  type RuntimeHostExecutionServices,
  resolveProjectIdentity,
} from '@kite-ai/runtime-host';
import {
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  INTERNAL_RESOURCE_BUDGET_,
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
import type {
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from '../../src/bootstrap/runtime/state-runtime';
import { createChildSessionAcceptanceStage } from '../../src/bootstrap/runtime/subagent/child-session-acceptance';
import { createChildSessionOrchestrator } from '../../src/bootstrap/runtime/subagent/child-session-orchestrator';

const labels = ['A', 'B', 'C'] as const;
type Label = (typeof labels)[number];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error('Expected child state did not become durable.');
}

async function exerciseThreeChildren(recoverAccepted: boolean): Promise<void> {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-three-children-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  const gates = Object.fromEntries(labels.map((label) => [label, deferred()])) as Record<
    Label,
    ReturnType<typeof deferred>
  >;
  const modelCalls: Label[] = [];
  model.setResponses(
    labels.map(() => ({
      response: async ({ messages }: { messages: readonly unknown[] }) => {
        const rendered = JSON.stringify(messages);
        const matches = labels.filter((label) => rendered.includes(`PRIVATE_TASK_${label}`));
        expect(matches).toHaveLength(1);
        const label = matches[0]!;
        for (const other of labels.filter((value) => value !== label))
          expect(rendered).not.toContain(`PRIVATE_TASK_${other}`);
        modelCalls.push(label);
        await gates[label].promise;
        return { message: { content: `PRIVATE_RESULT_${label}` } };
      },
    })),
  );
  const owner = await createKiteSessionAppServerStorageComposition({
    databasePath: join(home, 'kite-session.sqlite'),
    hostInstanceId: 'three-child-host',
  });
  const parentSessionId = 'three-child-parent';
  const parentRunId = 'three-child-parent-run';
  const now = Date.now();
  const deadlineAt = new Date(now + 120_000).toISOString();
  const project = resolveProjectIdentity(workspace);
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  const capabilitySnapshot = registry.snapshot();
  const builtinToolCatalog = createBuiltinToolCatalogProjection(capabilitySnapshot);
  const capabilities = createRuntimeHostCapabilityExecutionPortFromSnapshot(capabilitySnapshot);
  const backends = createKiteHomeBuiltinArtifactBackends(owner.artifactStore);
  const modelRuntimeFactory = createInstalledKiteRuntimeCompositionFactory(
    createKiteModelOperationExecutionPort(capabilities, builtinToolCatalog),
    backends,
  );
  const services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState> = new EffectSupervisor(
    owner.storage,
  ).services;
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
    userId: 'three-child-user',
    workspace,
    projectId: project.projectId,
    canonicalWorkspaceDigest: project.workspaceDigest,
    interactionMode: 'accept_edits',
    recoveryIdentityKey,
    sandboxAvailable: true,
    modelArtifactEvidence: modelRuntimeFactory(workspace).evidence,
    capabilityArtifactEvidence: modelRuntimeFactory(workspace).capabilityArtifacts,
  };
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
    startCommandId: 'start-three-child-parent',
    phase: 'building' as const,
    status: 'queued' as const,
    createdRevision: 1,
    lastRevision: 1,
    createdAtMs: now,
  };
  const taskArtifacts = new SubagentTaskArtifactStore({ backend: backends.subagentTask });
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
      modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
      features: { resourceBudget: true },
      sandbox: { enabled: false },
    },
    shellExecutor: async ({ command }: { command: string }) => ({
      ok: true as const,
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
    }),
    interactionMode: 'accept_edits' as const,
    sandboxBackend: 'none' as const,
    skillOptions: {
      userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
      userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
      projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
      projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
    },
    initialSkillActivations: [],
  };
  const childWork: Promise<void>[] = [];
  const orchestrator = createChildSessionOrchestrator({
    detachedScope: new AsyncResource('three-child-test-scope'),
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
    enqueueSessionWork: async (_sessionId, work) => {
      const promise = work();
      childWork.push(promise.then(() => undefined));
      return await promise;
    },
  });
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
          commandId: 'create-three-child-parent',
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
    const sharedToolEffectLease = parentCoordinator.session.beginEffect({
      type: 'run_tools',
      toolCallIds: labels.map((label) => `task-tool-${label}`),
    });
    const accepted = new Map<Label, Parameters<typeof orchestrator.onAccepted>[0]>();
    for (const [index, label] of labels.entries()) {
      const parentInvocationId = `parent-invocation-${label}`;
      const parentToolCallId = `task-tool-${label}`;
      const childInvocationId = `child-invocation-${label}`;
      const reservationId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const transient = createZeroResourceUsage('versioned_upper_bound', `test-task-${label}`);
      transient.counters.toolInvocations = 1;
      transient.counters.artifactBytes = 1024 * 1024;
      owner.runWithSessionExecution(parentSessionId, () =>
        parentCoordinator.control.processEventBatch([
          {
            type: 'tool.queued',
            toolCallId: parentToolCallId,
            name: 'task',
            args: {
              name: `Reviewer ${label}`,
              subagent_type: 'review',
              task: `PRIVATE_TASK_${label}`,
              background: true,
              result_disposition: 'required',
            },
            modelMessageId: `parent-message-${label}`,
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
              reservationId,
              runId: parentRunId,
              invocationId: `tool:${parentToolCallId}`,
              resourceKind: 'subagent',
              executableUpperBound: transient,
              state: 'reserved',
            },
          },
          { type: 'resource_budget.dispatch_started', reservationId },
        ]),
      );
      const task = owner.runWithSessionExecution(parentSessionId, () =>
        taskArtifacts.write({
          owner: { parentInvocationId, parentAttempt: 1, parentToolCallId, childInvocationId },
          task: `PRIVATE_TASK_${label}`,
        }),
      );
      const grant = new SubagentGrantAuthority().issueStart({
        parentInvocationId,
        parentToolCallId,
        parentAttempt: 1,
        capabilityRevision: '1'.repeat(64),
        admissionDigest: '2'.repeat(64),
        effectiveEffectsDigest: '3'.repeat(64),
        childInvocationId,
        role: 'review',
        taskArtifact: task.ref,
        taskDigest: task.taskDigest,
        capabilityCeiling: {
          allowedTools: ['read_file'],
          bindingIds: [],
          bindingRevision: '4'.repeat(64),
          ceilingDigest: '5'.repeat(64),
        },
        authorization: {
          authorizationDigest: '6'.repeat(64),
          interactionMode: 'accept_edits',
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
      const stage = createChildSessionAcceptanceStage({
        getState: () => parentCoordinator.getState(),
        effectLeases: {
          tryAcquireEffectLease: services.leases.tryAcquire,
          releaseEffectLease: services.leases.release,
        },
        commit: async (events, requiredEffectLease, sealedGrant) =>
          parentCoordinator.session.commitBackgroundChildAcceptance(
            sharedToolEffectLease,
            events,
            { ...requiredEffectLease, sessionId: parentSessionId },
            sealedGrant,
          ),
        onAccepted: (child) => {
          accepted.set(label, child);
        },
      });
      stage.stage({
        grant,
        name: `Reviewer ${label}`,
        role: 'review',
        originRunId: parentRunId,
        originTurnId: parentRunId,
        disposition: 'required',
      });
      const capabilityResult = {
        status: 'success' as const,
        content: [{ type: 'text', text: `Accepted child ${label}.` }],
      };
      const artifact = owner.runWithSessionExecution(parentSessionId, () =>
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
              artifact,
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
                authority: {
                  dispatchState: 'started',
                  externalEffects: 'none',
                },
              }),
            },
          ]),
        ),
      ).toBe(true);
      await Bun.sleep(0);
      expect(accepted.get(label)).toBeDefined();
    }
    const childIds = labels.map((label) => accepted.get(label)!.childThreadId);
    const assertChildAccounting = () => {
      const parentBudget = owner.loadCurrentSnapshot(parentSessionId)?.resourceBudget;
      if (parentBudget?.status !== 'active') throw new Error('Parent budget is unavailable.');
      for (const childId of childIds) {
        const reservationId = owner.readChildSessionIntent(childId)?.delegatedReservationId;
        if (!reservationId) throw new Error('Child has no persisted delegation.');
        const reservation = parentBudget.reservations[reservationId];
        expect(reservation?.state).toBe('reconciled');
        expect(Object.values(reservation!.actual!.counters)).toEqual(Array(6).fill(0));
        const childBudget = owner.loadCurrentSnapshot(childId)?.resourceBudget;
        if (childBudget?.status !== 'active') throw new Error('Child budget is unavailable.');
        expect(childBudget.reconciledUsage.counters.modelRequests).toBeGreaterThan(0);
      }
    };
    expect(new Set(childIds).size).toBe(3);
    expect(owner.listCurrentSessions('', 10).map((entry) => entry.threadId)).toEqual([
      parentSessionId,
    ]);
    if (recoverAccepted) {
      for (const label of labels) {
        expect(
          owner.readChildSessionIntent(accepted.get(label)!.childThreadId)?.childSessionCreated,
        ).toBe(false);
      }
      const sweep = await orchestrator.schedulePendingRecovery();
      expect(sweep).toMatchObject({ scheduled: 3, recoveryRequired: [] });
      // All three Provider calls remain gated while the recovery scan has returned.
      await until(() => modelCalls.length === 3);
      expect(new Set(modelCalls)).toEqual(new Set(labels));
      for (const [ordinal, label] of (['B', 'A', 'C'] as const).entries()) {
        gates[label].resolve();
        await until(
          () =>
            owner.readChildSessionIntent(accepted.get(label)!.childThreadId)
              ?.parentClaimSettledEventId != null,
        );
        expect(
          owner.storage.sessions
            .loadEventsStrict(parentSessionId)
            .filter(({ event }) => event.type === 'subagent.child_terminal_imported'),
        ).toHaveLength(ordinal + 1);
      }
      expect(await sweep.completion).toMatchObject({ processed: 3, recoveryRequired: [] });
      expect(await orchestrator.recoverPending()).toMatchObject({
        processed: 0,
        recoveryRequired: [],
      });
      expect(modelCalls).toHaveLength(3);
      assertChildAccounting();
      for (const label of labels) {
        const childId = accepted.get(label)!.childThreadId;
        expect(owner.readChildSessionIntent(childId)?.parentClaimSettledEventId).toBeTruthy();
        expect(
          owner.storage.sessions
            .loadEventsStrict(childId)
            .filter(({ event }) => event.type === 'subagent.child_terminal_sealed'),
        ).toHaveLength(1);
      }
      expect(owner.listCurrentSessions('', 10).map((entry) => entry.threadId)).toEqual([
        parentSessionId,
      ]);
      return;
    }
    const starts = labels.map((label) => orchestrator.onAccepted(accepted.get(label)!));
    await until(() => modelCalls.length === 3);
    expect(new Set(modelCalls)).toEqual(new Set(labels));
    const authorities = labels.map((label) =>
      owner.readChildExecutionAuthority(parentSessionId, accepted.get(label)!.childThreadId),
    );
    expect(
      new Set(
        authorities.map((value, index) => `${childIds[index]}:${value?.controllerGeneration}`),
      ).size,
    ).toBe(3);
    for (const label of labels) {
      const childId = accepted.get(label)!.childThreadId;
      expect(owner.readSessionLineage(childId)).toEqual({ parentSessionId });
      expect(owner.readChildSessionIntent(childId)?.dispatchAckEventId).toBeTruthy();
      expect(
        owner.storage.sessions.loadEventsStrict(childId).map(({ event }) => event.type),
      ).not.toContain('user.message_appended');
      expect(owner.readChildExecutionAuthority(parentSessionId, childId)).toMatchObject({
        status: 'active',
        controllerGeneration: 1,
      });
    }
    const siblingRevisions = Object.fromEntries(
      labels.map((label) => [
        label,
        owner.loadCurrentSnapshot(accepted.get(label)!.childThreadId)?.revision,
      ]),
    );
    const siblingAuthorities = Object.fromEntries(
      labels.map((label) => [
        label,
        owner.readChildExecutionAuthority(parentSessionId, accepted.get(label)!.childThreadId),
      ]),
    );
    const imports = () =>
      owner.storage.sessions
        .loadEventsStrict(parentSessionId)
        .filter(({ event }) => event.type === 'subagent.child_terminal_imported');
    for (const [ordinal, label] of (['B', 'A', 'C'] as const).entries()) {
      gates[label].resolve();
      await until(
        () =>
          owner.readChildSessionIntent(accepted.get(label)!.childThreadId)
            ?.parentClaimSettledEventId != null,
      );
      expect(imports()).toHaveLength(ordinal + 1);
      expect(imports().at(-1)?.event).toMatchObject({
        parentInvocationId: `parent-invocation-${label}`,
        childInvocationId: `child-invocation-${label}`,
        childThreadId: accepted.get(label)!.childThreadId,
        status: 'completed',
      });
      expect(
        parentCoordinator.getState().capabilities.invocations[`parent-invocation-${label}`]
          ?.subagentProviderLifecycle?.childSession?.terminalImport?.status,
      ).toBe('completed');
      for (const pending of labels.filter(
        (value) => !(['B', 'A', 'C'] as const).slice(0, ordinal + 1).includes(value),
      )) {
        const pendingId = accepted.get(pending)!.childThreadId;
        expect(owner.readChildSessionIntent(pendingId)?.parentClaimSettledEventId).toBeNull();
        expect(owner.loadCurrentSnapshot(pendingId)?.revision).toBe(siblingRevisions[pending]);
        expect(owner.readChildExecutionAuthority(parentSessionId, pendingId)).toEqual(
          siblingAuthorities[pending]!,
        );
      }
    }
    await Promise.all(starts);
    await Promise.all(childWork);
    expect(modelCalls).toHaveLength(3);
    expect(new Set(modelCalls)).toEqual(new Set(labels));
    expect(imports()).toHaveLength(3);
    assertChildAccounting();
    for (const label of labels) {
      const childId = accepted.get(label)!.childThreadId;
      expect(owner.loadCurrentSnapshot(childId)?.childSessionOrigin?.terminal?.status).toBe(
        'completed',
      );
      expect(
        owner.storage.sessions
          .loadEventsStrict(childId)
          .filter(({ event }) => event.type === 'subagent.child_terminal_sealed'),
      ).toHaveLength(1);
      expect(owner.readChildSessionIntent(childId)?.parentClaimSettledEventId).toBeTruthy();
      const terminal = owner.loadCurrentSnapshot(childId)?.childSessionOrigin?.terminal;
      if (!terminal) throw new Error('Completed child has no sealed result.');
      const result = owner.runWithSessionExecution(parentSessionId, () =>
        modelRuntimeFactory(workspace).childResultArtifacts.read(
          terminal.resultRef,
          `child-invocation-${label}`,
        ),
      );
      expect(result.summary).toContain(`PRIVATE_RESULT_${label}`);
      for (const other of labels.filter((value) => value !== label))
        expect(result.summary).not.toContain(`PRIVATE_RESULT_${other}`);
      expect(await orchestrator.taskControl?.readTask(`child-invocation-${label}`)).toMatchObject({
        status: 'completed',
      });
    }
    expect(owner.listCurrentSessions('', 10).map((entry) => entry.threadId)).toEqual([
      parentSessionId,
    ]);
    expect(await orchestrator.recoverPending()).toMatchObject({
      processed: 0,
      recoveryRequired: [],
    });
    expect(imports()).toHaveLength(3);
    expect(modelCalls).toHaveLength(3);
  } finally {
    for (const label of labels) gates[label].resolve();
    await Promise.allSettled(childWork);
    await coordinators.close();
    owner.disposeStorage();
    model.assertComplete({ allowUnconsumedResponses: true });
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test(
  'three required child Sessions isolate execution and settle each exact parent claim',
  () => exerciseThreeChildren(false),
  30_000,
);

test(
  'recovery sweep resumes three accepted child intents exactly once',
  () => exerciseThreeChildren(true),
  30_000,
);
