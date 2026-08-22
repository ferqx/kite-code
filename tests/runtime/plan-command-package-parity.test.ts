import { describe, expect, test } from 'bun:test';
import {
  decideCompletionV2,
  decideReadPlanCommandV1,
  decideUpdatePlanCommandV1,
  decideWritePlanCommandV1,
  type PlanCommandStateFactsV1,
  planCommandPhaseV1,
} from '@kite/agent-kernel';
import {
  createBuiltinPlanDocumentV2V1,
  type PlanArtifactContent,
  type PlanArtifactStore,
  projectBuiltinPublicPlanV2V1,
} from '@kite/builtin-runtime/planning';
import type { PlanDocument, PlanningState } from '@kite/runtime-contract';
import type { RuntimeState } from '@kite/runtime-host';
import { createRuntimeHostState26InitialStateV1 } from '@kite/runtime-host';
import {
  readPlanAction,
  updatePlanAction,
  writePlanAction,
} from '#app/bootstrap/runtime/plan-runtime';

const recoveryIdentityKey = '0'.repeat(64);

function stateWithPlanning(planning: PlanningState, sideEffectsStarted = false): RuntimeState {
  const base = createRuntimeHostState26InitialStateV1({
    recoveryIdentityKey,
    threadId: 'plan-parity',
    userId: 'user',
    workspace: '/tmp',
  });
  const taskId = 'task-parity';
  return {
    ...base,
    activeTaskId: taskId,
    tasks: {
      [taskId]: {
        taskId,
        userGoal: 'Preserve plan command behavior.',
        status: 'active',
        startedAtTurnId: base.turn.turnId,
        sideEffectsStarted,
        planning,
        planHistory: [],
      },
    },
  };
}

function stateWithoutTask(): RuntimeState {
  const base = createRuntimeHostState26InitialStateV1({
    recoveryIdentityKey,
    threadId: 'plan-parity-no-task',
    userId: 'user',
    workspace: '/tmp',
  });
  return { ...base, activeTaskId: null, tasks: {} };
}

function planDocument(): PlanDocument {
  return createBuiltinPlanDocumentV2V1({
    taskId: 'task-parity',
    turnId: 'turn-1',
    title: saveCommand.title,
    bodyMarkdown: saveCommand.body_markdown,
    steps: [
      { id: 'inspect', title: 'Inspect the current behavior' },
      { id: 'implement', title: 'Implement the package seam' },
    ],
  });
}

function compareLegacyDecision(
  legacy:
    | ReturnType<typeof readPlanAction>
    | ReturnType<typeof writePlanAction>
    | ReturnType<typeof updatePlanAction>,
  candidate: { readonly accepted: boolean; readonly diagnostic?: string; readonly mode?: string },
  expectedMode?: string,
): void {
  expect(legacy.ok).toBe(candidate.accepted);
  if (!legacy.ok && !candidate.accepted) expect(candidate.diagnostic).toBe(legacy.stderr);
  if (legacy.ok && candidate.accepted && expectedMode !== undefined) {
    expect(candidate.mode).toBe(expectedMode);
  }
}

function facts(state: RuntimeState): PlanCommandStateFactsV1 {
  const taskId = state.activeTaskId == null ? undefined : state.activeTaskId;
  const planning =
    taskId == null ? ({ kind: 'building_without_plan' } as const) : state.tasks[taskId]!.planning;
  return {
    taskId,
    planning,
    phase: planCommandPhaseV1(planning),
    sideEffectsStarted: taskId == null ? false : state.tasks[taskId]!.sideEffectsStarted,
  };
}

function artifactStore(): PlanArtifactStore & { saved?: PlanDocument } {
  const store = {
    saved: undefined as PlanDocument | undefined,
    write(taskId: string, plan: PlanDocument) {
      this.saved = plan;
      return {
        artifactId: `${plan.planId}:v${plan.version}`,
        taskId,
        planId: plan.planId,
        version: plan.version,
        fileName: `v${plan.version}.md`,
        relativePath: `plans/${taskId}/${plan.planId}/v${plan.version}.md`,
        displayPath: `/tmp/plans/${taskId}/${plan.planId}/v${plan.version}.md`,
        structuralDigest: plan.structuralDigest,
        byteLength: 0,
      };
    },
    read(ref: Parameters<PlanArtifactStore['read']>[0]): PlanArtifactContent {
      if (!this.saved) throw new Error('missing fake artifact');
      return {
        taskId: ref.taskId,
        plan: this.saved,
        markdown: '',
        artifact: ref,
      };
    },
  };
  return store;
}

const saveCommand = {
  action: 'save' as const,
  title: 'Preserve plan behavior',
  body_markdown: 'A sufficiently detailed plan body for parity verification.',
  steps: [{ id: 'inspect', title: 'Inspect the current behavior' }],
};

describe('RMV1 plan package candidate differential', () => {
  test('Builtin document/public projection matches the legacy facade save corpus', () => {
    const state = stateWithPlanning({ kind: 'planning_empty' });
    const store = artifactStore();
    const legacy = writePlanAction({ state, artifacts: store }, 'save-1', saveCommand);
    const candidateDocument = createBuiltinPlanDocumentV2V1({
      taskId: state.activeTaskId!,
      turnId: state.turn.turnId,
      title: saveCommand.title,
      bodyMarkdown: saveCommand.body_markdown,
      steps: saveCommand.steps,
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    const drafted = legacy.runtimeEvents.find((event) => event.type === 'plan.drafted');
    expect(drafted?.type).toBe('plan.drafted');
    if (drafted?.type !== 'plan.drafted') return;
    expect(drafted.plan).toEqual(projectBuiltinPublicPlanV2V1(candidateDocument));
    expect(drafted.planId).toBe(candidateDocument.planId);
    expect(drafted.version).toBe(candidateDocument.version);
    expect(drafted.structuralHash).toBe(candidateDocument.structuralDigest);

    const completedDocument: PlanDocument = {
      ...candidateDocument,
      steps: candidateDocument.steps.map((step) => ({ ...step, status: 'completed' as const })),
    };
    const kernelCompletion = decideCompletionV2(
      stateWithPlanning({
        kind: 'completed',
        document: completedDocument,
        completedAtTurnId: state.turn.turnId,
      }),
    );
    expect(kernelCompletion).toMatchObject({
      status: 'accepted',
      version: 'completion_guard_v2',
      planIdentity: {
        planId: candidateDocument.planId,
        version: candidateDocument.version,
        structuralDigest: candidateDocument.structuralDigest,
      },
    });
  });

  test('mechanically compares read/write admission corpus with the legacy facade', () => {
    const draft = planDocument();
    const readState = stateWithPlanning({ kind: 'planning_draft', document: draft });
    const readCases = [
      {
        state: stateWithoutTask(),
        command: { plan_id: 'missing-task' },
        expectedMode: undefined,
      },
      {
        state: readState,
        command: { plan_id: 'wrong-plan', version: 1 },
        expectedMode: undefined,
      },
      {
        state: readState,
        command: { plan_id: draft.planId, version: 1, structural_digest: 'b'.repeat(64) },
        expectedMode: undefined,
      },
      {
        state: readState,
        command: { plan_id: draft.planId, version: 1, structural_digest: draft.structuralDigest },
        expectedMode: 'read_artifact',
      },
    ] as const;
    for (const entry of readCases) {
      const store = artifactStore();
      store.saved = draft;
      const legacy = readPlanAction({ state: entry.state, artifacts: store }, entry.command);
      const candidate = decideReadPlanCommandV1(facts(entry.state), entry.command);
      compareLegacyDecision(legacy, candidate, entry.expectedMode);
    }

    const writeStateCases = [
      {
        state: stateWithoutTask(),
        command: saveCommand,
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning({ kind: 'building_without_plan' }),
        command: saveCommand,
        expectedMode: 'auto_enter',
      },
      {
        state: stateWithPlanning({ kind: 'planning_empty' }),
        command: saveCommand,
        expectedMode: 'draft_save',
      },
      {
        state: stateWithPlanning({ kind: 'planning_empty' }, true),
        command: saveCommand,
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning({ kind: 'planning_draft', document: draft }),
        command: { ...saveCommand, title: 'Changed without identity' },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning({ kind: 'planning_draft', document: draft }),
        command: {
          ...saveCommand,
          plan_id: draft.planId,
          version: draft.version,
          structural_digest: 'b'.repeat(64),
        },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning({ kind: 'planning_draft', document: draft }),
        command: {
          action: 'submit' as const,
          plan_id: draft.planId,
          version: draft.version,
          structural_digest: draft.structuralDigest,
        },
        expectedMode: 'submit_existing',
      },
      {
        state: stateWithPlanning({ kind: 'planning_draft', document: draft }),
        command: {
          ...saveCommand,
          plan_id: draft.planId,
          version: draft.version,
          structural_digest: draft.structuralDigest,
          expected_version: 99,
        },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning({
          kind: 'executing',
          document: draft,
          executionMode: 'auto',
          approvedAtTurnId: 'turn-2',
        }),
        command: {
          ...saveCommand,
          plan_id: draft.planId,
          version: draft.version,
          structural_digest: draft.structuralDigest,
          replan_reason: 'model_requested',
        },
        expectedMode: 'replan_save',
      },
      {
        state: stateWithPlanning({
          kind: 'replanning_draft',
          document: { ...draft, version: 2, supersedesPlanVersion: 1, replanReason: 'review' },
          supersedesPlanVersion: 1,
          replanReason: 'review',
        }),
        command: {
          action: 'submit' as const,
          plan_id: draft.planId,
          version: 2,
          structural_digest: draft.structuralDigest,
        },
        expectedMode: 'replanning_save',
      },
      {
        state: stateWithPlanning({ kind: 'planning_empty' }),
        command: {
          action: 'submit' as const,
          plan_id: 'not-saved',
          version: 1,
          structural_digest: draft.structuralDigest,
        },
        expectedMode: undefined,
      },
    ] as const;
    for (const entry of writeStateCases) {
      const store = artifactStore();
      store.saved = draft;
      const legacy = writePlanAction(
        { state: entry.state, artifacts: store },
        'write-corpus',
        entry.command,
      );
      const candidate = decideWritePlanCommandV1(facts(entry.state), entry.command);
      compareLegacyDecision(legacy, candidate, entry.expectedMode);
    }
  });

  test('keeps legacy read rejection diagnostic for digest drift', () => {
    const planning: PlanningState = {
      kind: 'planning_draft',
      document: createBuiltinPlanDocumentV2V1({
        taskId: 'task-parity',
        turnId: 'turn-1',
        title: saveCommand.title,
        bodyMarkdown: saveCommand.body_markdown,
        steps: saveCommand.steps,
      }),
    };
    const state = stateWithPlanning(planning);
    const legacy = readPlanAction(
      { state, artifacts: artifactStore() },
      { plan_id: planning.document.planId, version: 1, structural_digest: 'b'.repeat(64) },
    );
    const candidate = decideReadPlanCommandV1(facts(state), {
      plan_id: planning.document.planId,
      version: 1,
      structural_digest: 'b'.repeat(64),
    });
    expect(candidate.accepted).toBe(false);
    expect(legacy.ok).toBe(false);
    if (!legacy.ok && !candidate.accepted) expect(candidate.diagnostic).toBe(legacy.stderr);
  });

  test.each([
    {
      name: 'write identity required',
      state: () =>
        stateWithPlanning({
          kind: 'planning_draft',
          document: createBuiltinPlanDocumentV2V1({
            ...saveCommand,
            taskId: 'task-parity',
            turnId: 'turn-1',
            title: saveCommand.title,
            bodyMarkdown: saveCommand.body_markdown,
            steps: saveCommand.steps,
          }),
        }),
      command: { ...saveCommand, title: 'Changed after save' },
      decide: decideWritePlanCommandV1,
    },
    {
      name: 'side effects started',
      state: () => stateWithPlanning({ kind: 'planning_empty' }, true),
      command: saveCommand,
      decide: decideWritePlanCommandV1,
    },
  ])('keeps legacy write rejection diagnostic for $name', ({ state, command, decide }) => {
    const current = state();
    const legacy = writePlanAction(
      { state: current, artifacts: artifactStore() },
      'write-1',
      command,
    );
    const candidate = decide(facts(current), command);
    expect(candidate.accepted).toBe(false);
    expect(legacy.ok).toBe(false);
    if (!legacy.ok && !candidate.accepted) expect(candidate.diagnostic).toBe(legacy.stderr);
  });

  test('keeps update_plan pending-completion diagnostic and mode decision aligned', () => {
    const document = createBuiltinPlanDocumentV2V1({
      ...saveCommand,
      taskId: 'task-parity',
      turnId: 'turn-1',
      title: saveCommand.title,
      bodyMarkdown: saveCommand.body_markdown,
      steps: saveCommand.steps,
    });
    const planning: PlanningState = {
      kind: 'executing',
      document,
      executionMode: 'auto',
      approvedAtTurnId: 'turn-2',
    };
    const state = stateWithPlanning(planning);
    const command = {
      plan_id: document.planId,
      version: document.version,
      structural_digest: document.structuralDigest,
      updates: [],
      complete_plan: true,
    };
    const legacy = updatePlanAction({ state, artifacts: artifactStore() }, 'update-1', command);
    const candidate = decideUpdatePlanCommandV1(facts(state), command);
    expect(candidate).toMatchObject({ accepted: false, code: 'plan_pending_steps' });
    expect(legacy).toMatchObject({
      ok: false,
      stderr: 'Cannot complete plan while steps are pending or in progress.',
    });
    if (!legacy.ok && !candidate.accepted) expect(candidate.diagnostic).toBe(legacy.stderr);
  });

  test('mechanically compares update admission corpus and next-step projection', () => {
    const draft = planDocument();
    const identity = {
      plan_id: draft.planId,
      version: draft.version,
      structural_digest: draft.structuralDigest,
    };
    const executing = (document = draft): PlanningState => ({
      kind: 'executing',
      document,
      executionMode: 'auto',
      approvedAtTurnId: 'turn-2',
    });
    type UpdateCorpusCommand = {
      plan_id: string;
      version?: number;
      structural_digest?: string;
      updates: Array<{
        step_id: string;
        status: 'pending' | 'in_progress' | 'completed' | 'skipped';
        note?: string;
        reason_code?: string;
      }>;
      complete_plan?: boolean;
    };
    const updateCases: Array<{
      state: RuntimeState;
      command: UpdateCorpusCommand;
      expectedMode?: string;
    }> = [
      {
        state: stateWithoutTask(),
        command: { ...identity, updates: [] },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning({ kind: 'planning_empty' }),
        command: { ...identity, updates: [] },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning({ kind: 'building_without_plan' }),
        command: { ...identity, updates: [] },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning(executing()),
        command: { plan_id: draft.planId, updates: [] },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning(executing()),
        command: { ...identity, structural_digest: 'b'.repeat(64), updates: [] },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning(executing()),
        command: {
          ...identity,
          updates: [
            { step_id: 'inspect', status: 'in_progress' as const },
            { step_id: 'inspect', status: 'in_progress' as const },
          ],
        },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning(executing()),
        command: { ...identity, updates: [{ step_id: 'missing', status: 'completed' as const }] },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning(
          executing({
            ...draft,
            steps: [
              { id: 'inspect', title: 'Inspect the current behavior', status: 'completed' },
              { id: 'implement', title: 'Implement the package seam', status: 'pending' },
            ],
          }),
        ),
        command: { ...identity, updates: [{ step_id: 'inspect', status: 'pending' as const }] },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning(executing()),
        command: { ...identity, updates: [], complete_plan: true },
        expectedMode: undefined,
      },
      {
        state: stateWithPlanning(executing()),
        command: {
          ...identity,
          updates: [
            { step_id: 'inspect', status: 'skipped' as const, reason_code: 'not_needed' },
            { step_id: 'implement', status: 'skipped' as const, reason_code: 'not_needed' },
          ],
          complete_plan: true,
        },
        expectedMode: undefined,
      },
    ];

    for (const entry of updateCases) {
      const legacy = updatePlanAction(
        { state: entry.state, artifacts: artifactStore() },
        'update-corpus',
        entry.command,
      );
      const candidate = decideUpdatePlanCommandV1(facts(entry.state), entry.command);
      compareLegacyDecision(legacy, candidate, entry.expectedMode);
    }

    const progressCommand = {
      ...identity,
      updates: [{ step_id: 'inspect', status: 'in_progress' as const, note: 'started' }],
    };
    const progressState = stateWithPlanning(executing());
    const legacyProgress = updatePlanAction(
      { state: progressState, artifacts: artifactStore() },
      'update-progress',
      progressCommand,
    );
    const candidateProgress = decideUpdatePlanCommandV1(facts(progressState), progressCommand);
    compareLegacyDecision(legacyProgress, candidateProgress, 'progress_update');
    if (legacyProgress.ok && candidateProgress.accepted) {
      const event = legacyProgress.runtimeEvents.find(
        (item) => item.type === 'plan.progress_updated',
      );
      expect(event?.type).toBe('plan.progress_updated');
      if (event?.type === 'plan.progress_updated') {
        expect(candidateProgress.nextSteps).toEqual(
          event.plan.steps.map((step) => ({
            id: step.id ?? '',
            title: step.step,
            status: step.status,
            ...(step.note === undefined ? {} : { note: step.note }),
          })),
        );
      }
    }

    const completedDocument: PlanDocument = {
      ...draft,
      steps: draft.steps.map((step) => ({ ...step, status: 'completed' as const })),
    };
    const verificationState = stateWithPlanning(executing(completedDocument));
    const withRequiredVerification: RuntimeState = {
      ...verificationState,
      verification: {
        ...verificationState.verification,
        records: {
          required: {
            verificationId: 'required',
            mode: 'required',
            status: 'pending',
            spec: {} as never,
            requestedAt: '2026-08-10T00:00:00.000Z',
            attempts: 0,
            repairAttempts: 0,
            checkResults: {},
          },
        },
      },
    };
    const completionCommand = { ...identity, updates: [], complete_plan: true };
    const legacyCompletion = updatePlanAction(
      { state: withRequiredVerification, artifacts: artifactStore() },
      'update-completion-blocked',
      completionCommand,
    );
    const candidateCompletion = decideUpdatePlanCommandV1(
      { ...facts(withRequiredVerification), completionBlocker: 'plan_verification_required' },
      completionCommand,
    );
    compareLegacyDecision(legacyCompletion, candidateCompletion);
  });
});
