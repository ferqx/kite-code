import type { KernelEvent } from '../../events';
import { sha256Hex } from '../../hash';
import { closeToolRecoveryScope, recordToolOwnedProgress } from '../../recovery';
import {
  eventRecord,
  nonEmptyStringField,
  numberField,
  recordField,
  stringField,
  updateTasks,
} from '../../reducer-utils';
import type {
  AgentPlan,
  AgentState,
  AgentTaskState,
  PlanArtifactRef,
  PlanCompletionEvidence,
  PlanDocument,
  PlanStep,
} from '../../state';

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const SAFE_STEP_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SAFE_REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const SHA256_DIGEST = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function planStatus(value: unknown): PlanStep['status'] | undefined {
  return value === 'pending' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'skipped'
    ? value
    : undefined;
}

function isPlanStep(value: unknown): value is PlanStep {
  if (!isRecord(value)) return false;
  const keys = Object.hasOwn(value, 'note')
    ? ['id', 'title', 'status', 'note']
    : ['id', 'title', 'status'];
  return (
    hasExactKeys(value, keys) &&
    typeof value.id === 'string' &&
    SAFE_STEP_ID.test(value.id) &&
    typeof value.title === 'string' &&
    value.title === value.title.trim() &&
    value.title.length >= 1 &&
    value.title.length <= 160 &&
    !/[\r\n]/u.test(value.title) &&
    planStatus(value.status) !== undefined &&
    (value.note === undefined || typeof value.note === 'string')
  );
}

function isAgentPlanTransport(value: unknown): value is AgentPlan {
  if (!isRecord(value) || !hasExactKeys(value, ['name', 'description', 'status', 'steps'])) {
    return false;
  }
  return (
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    planStatus(value.status) !== undefined &&
    Array.isArray(value.steps) &&
    value.steps.every((step) => {
      if (!isRecord(step) || !hasOnlyKeys(step, ['id', 'step', 'status', 'note'])) return false;
      return (
        typeof step.step === 'string' &&
        planStatus(step.status) !== undefined &&
        (step.id === undefined || typeof step.id === 'string') &&
        (step.note === undefined || typeof step.note === 'string')
      );
    })
  );
}

function emptyPlanCompletionEvidence(): PlanCompletionEvidence {
  return { schemaVersion: 1, verification: [], execution: [], skipped: [], unresolved: [] };
}

function isPlanCompletionEvidence(value: unknown): value is PlanCompletionEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'verification', 'execution', 'skipped', 'unresolved']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.verification) ||
    !Array.isArray(value.execution) ||
    !Array.isArray(value.skipped) ||
    !Array.isArray(value.unresolved)
  )
    return false;
  return (
    value.verification.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['verificationId', 'outcome']) &&
        typeof entry.verificationId === 'string' &&
        SAFE_REFERENCE.test(entry.verificationId) &&
        (entry.outcome === 'passed' || entry.outcome === 'waived'),
    ) &&
    value.execution.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['toolCallId', 'outcome']) &&
        typeof entry.toolCallId === 'string' &&
        SAFE_REFERENCE.test(entry.toolCallId) &&
        entry.outcome === 'succeeded',
    ) &&
    value.skipped.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['stepId', 'reasonCode']) &&
        typeof entry.stepId === 'string' &&
        SAFE_REFERENCE.test(entry.stepId) &&
        typeof entry.reasonCode === 'string' &&
        SAFE_REASON_CODE.test(entry.reasonCode),
    ) &&
    value.unresolved.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, ['kind', 'referenceId']) &&
        (entry.kind === 'failure' || entry.kind === 'approval') &&
        typeof entry.referenceId === 'string' &&
        SAFE_REFERENCE.test(entry.referenceId),
    )
  );
}

function computePlanStructuralDigest(
  document: Pick<PlanDocument, 'title' | 'bodyMarkdown' | 'steps'>,
) {
  const normalize = (value: string) => value.replace(/\r\n/g, '\n').trim();
  return sha256Hex(
    JSON.stringify({
      title: normalize(document.title),
      bodyMarkdown: normalize(document.bodyMarkdown),
      steps: document.steps.map(({ id, title }) => ({ id, title: normalize(title) })),
    }),
  );
}

function isPlanArtifactRef(value: unknown, plan: PlanDocument): value is PlanArtifactRef {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifactId',
      'taskId',
      'planId',
      'version',
      'fileName',
      'relativePath',
      'displayPath',
      'structuralDigest',
      'byteLength',
    ])
  )
    return false;
  return (
    value.artifactId === `${plan.planId}:v${plan.version}` &&
    typeof value.taskId === 'string' &&
    SAFE_SEGMENT.test(value.taskId) &&
    value.planId === plan.planId &&
    value.version === plan.version &&
    value.fileName === `v${plan.version}.md` &&
    typeof value.relativePath === 'string' &&
    value.relativePath.length > 0 &&
    typeof value.displayPath === 'string' &&
    value.displayPath.length > 0 &&
    value.structuralDigest === plan.structuralDigest &&
    Number.isInteger(value.byteLength) &&
    (value.byteLength as number) >= 0
  );
}

function isPlanDocument(value: unknown): value is PlanDocument {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      'planSchemaVersion',
      'planId',
      'version',
      'title',
      'bodyMarkdown',
      'steps',
      'structuralDigest',
      'createdAtTurnId',
      'updatedAtTurnId',
      'supersedesPlanVersion',
      'replanReason',
      'completionEvidence',
      'artifact',
    ]) ||
    value.planSchemaVersion !== 2 ||
    typeof value.planId !== 'string' ||
    !SAFE_SEGMENT.test(value.planId) ||
    !Number.isInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.title !== 'string' ||
    value.title !== value.title.trim() ||
    value.title.length < 1 ||
    value.title.length > 120 ||
    /[\r\n]/u.test(value.title) ||
    typeof value.bodyMarkdown !== 'string' ||
    value.bodyMarkdown !== value.bodyMarkdown.trim() ||
    value.bodyMarkdown.length < 20 ||
    value.bodyMarkdown.length > 30_000 ||
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > 12 ||
    !value.steps.every(isPlanStep) ||
    new Set(value.steps.map((step) => (step as PlanStep).id)).size !== value.steps.length ||
    typeof value.structuralDigest !== 'string' ||
    !SHA256_DIGEST.test(value.structuralDigest) ||
    typeof value.createdAtTurnId !== 'string' ||
    value.createdAtTurnId.length < 1 ||
    typeof value.updatedAtTurnId !== 'string' ||
    value.updatedAtTurnId.length < 1 ||
    !isPlanCompletionEvidence(value.completionEvidence) ||
    (value.supersedesPlanVersion !== undefined &&
      (!Number.isInteger(value.supersedesPlanVersion) ||
        (value.supersedesPlanVersion as number) < 1)) ||
    (value.replanReason !== undefined &&
      (typeof value.replanReason !== 'string' || value.replanReason.length > 500))
  )
    return false;
  const plan = value as unknown as PlanDocument;
  return (
    computePlanStructuralDigest(plan) === plan.structuralDigest &&
    (value.artifact === undefined || isPlanArtifactRef(value.artifact, plan))
  );
}

function agentPlanTransportMatchesDocument(value: unknown, document: PlanDocument): boolean {
  if (
    !isAgentPlanTransport(value) ||
    value.name !== document.title ||
    value.description !== document.bodyMarkdown ||
    value.status !== 'pending' ||
    value.steps.length !== document.steps.length
  )
    return false;
  return value.steps.every((candidate, index) => {
    const step = document.steps[index];
    return (
      step !== undefined &&
      candidate.id === step.id &&
      candidate.step === step.title &&
      candidate.status === step.status &&
      candidate.note === step.note &&
      Object.hasOwn(candidate, 'note') === (step.note !== undefined)
    );
  });
}

function planStepsFromAgentPlanUpdate(
  value: unknown,
  document: PlanDocument,
): PlanStep[] | undefined {
  if (!isAgentPlanTransport(value) || value.name !== document.title) return undefined;
  if (value.description !== document.bodyMarkdown || value.steps.length !== document.steps.length)
    return undefined;
  const steps: PlanStep[] = [];
  for (const [index, candidate] of value.steps.entries()) {
    if (candidate.id == null) return undefined;
    const step: PlanStep = {
      id: candidate.id,
      title: candidate.step,
      status: candidate.status,
      ...(candidate.note === undefined ? {} : { note: candidate.note }),
    };
    const existing = document.steps[index];
    if (!existing || !isPlanStep(step) || step.id !== existing.id || step.title !== existing.title)
      return undefined;
    steps.push(step);
  }
  return new Set(steps.map((step) => step.id)).size === steps.length ? steps : undefined;
}

function planDocumentToAgentPlan(document: PlanDocument): AgentPlan {
  return {
    name: document.title,
    description: document.bodyMarkdown,
    status: 'pending',
    steps: document.steps.map((step) => ({
      id: step.id,
      step: step.title,
      status: step.status,
      ...(step.note === undefined ? {} : { note: step.note }),
    })),
  };
}

function samePlanArtifactRef(
  left: PlanArtifactRef | undefined,
  right: PlanArtifactRef | undefined,
) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.artifactId === right.artifactId &&
    left.taskId === right.taskId &&
    left.planId === right.planId &&
    left.version === right.version &&
    left.fileName === right.fileName &&
    left.relativePath === right.relativePath &&
    left.displayPath === right.displayPath &&
    left.structuralDigest === right.structuralDigest &&
    left.byteLength === right.byteLength
  );
}

function mergePlanSteps(current: readonly PlanStep[], incoming: readonly PlanStep[]): PlanStep[] {
  const updates = new Map(incoming.map((step) => [step.id, step]));
  return current.map((step) => {
    const update = updates.get(step.id);
    return update ? { ...step, status: update.status, note: update.note ?? step.note } : step;
  });
}

function hasTerminalStepRollback(existing: readonly PlanStep[], updated: readonly PlanStep[]) {
  const updatedById = new Map(updated.map((step) => [step.id, step]));
  return existing.some((step) => {
    if (step.status !== 'completed' && step.status !== 'skipped') return false;
    return updatedById.get(step.id)?.status !== step.status;
  });
}

function planDocumentFromTransport(
  plan: AgentPlan,
  payload: Readonly<Record<string, unknown>>,
  turnId: string,
  supersedesPlanVersion?: number,
  replanReason?: string,
): PlanDocument | undefined {
  const planId = nonEmptyStringField(payload, 'planId');
  const version = numberField(payload, 'version');
  const structuralDigest = nonEmptyStringField(payload, 'structuralHash');
  const taskId = nonEmptyStringField(payload, 'taskId');
  const artifact = recordField(payload, 'artifact') as PlanArtifactRef | undefined;
  if (!planId || version === undefined || !structuralDigest || !taskId) return undefined;
  if (!isAgentPlanTransport(plan)) return undefined;
  const steps: PlanStep[] = plan.steps.map((step) => ({
    id: typeof step.id === 'string' ? step.id : '',
    title: step.step,
    status: step.status,
    ...(step.note === undefined ? {} : { note: step.note }),
  }));
  const document: PlanDocument = {
    planSchemaVersion: 2,
    planId,
    version,
    title: plan.name,
    bodyMarkdown: plan.description,
    steps,
    createdAtTurnId: turnId,
    updatedAtTurnId: turnId,
    completionEvidence: emptyPlanCompletionEvidence(),
    structuralDigest,
    ...(artifact === undefined ? {} : { artifact }),
    ...(supersedesPlanVersion === undefined ? {} : { supersedesPlanVersion }),
    ...(replanReason === undefined ? {} : { replanReason }),
  };
  return isPlanDocument(document) ? document : undefined;
}

function activeRecoveryFailureIds(state: AgentState, includeExhausted = false): string[] {
  return state.toolRecovery.order.filter((id) => {
    const failure = state.toolRecovery.failures[id];
    return (
      failure !== undefined &&
      (failure.status === 'unresolved' || (includeExhausted && failure.status === 'exhausted')) &&
      failure.taskId === (state.activeTaskId ?? undefined) &&
      failure.turnId === state.turn.turnId
    );
  });
}

function samePlanIdentity(
  left:
    | { readonly planId: string; readonly version: number; readonly structuralDigest: string }
    | undefined,
  right:
    | { readonly planId: string; readonly version: number; readonly structuralDigest: string }
    | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.planId === right.planId &&
    left.version === right.version &&
    left.structuralDigest === right.structuralDigest
  );
}

function activeTask(state: AgentState): AgentTaskState | undefined {
  return state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
}

function planningIdentity(state: AgentState) {
  const task = activeTask(state);
  const planning = task?.planning;
  return planning && 'document' in planning && planning.document !== undefined
    ? {
        planId: planning.document.planId,
        version: planning.document.version,
        structuralDigest: planning.document.structuralDigest,
      }
    : undefined;
}

function belongsToActiveTask(state: AgentState, taskId: string | undefined): boolean {
  return taskId === undefined || state.activeTaskId === null || taskId === state.activeTaskId;
}

function isResolvedRecoveryFailure(state: AgentState, call: AgentState['tools']['calls'][string]) {
  const failureId = call.outcome?.lineage?.failureInstanceId;
  return failureId !== undefined && state.toolRecovery.failures[failureId]?.status === 'recovered';
}

function projectPlanCompletionEvidence(
  state: AgentState,
  steps: readonly PlanStep[],
  skippedReasonCodes: Readonly<Record<string, string>> = {},
): PlanCompletionEvidence {
  const task = activeTask(state);
  const previous =
    task?.planning.kind === 'executing' ? task.planning.document.completionEvidence : undefined;
  const priorSkipped = new Map(
    (previous?.skipped ?? []).map((entry) => [entry.stepId, entry.reasonCode]),
  );
  const verification = Object.values(state.verification.records)
    .filter(
      (record) =>
        belongsToActiveTask(state, record.taskId) &&
        (record.status === 'passed' || record.status === 'waived'),
    )
    .map((record) => ({
      verificationId: record.verificationId,
      outcome: record.status as 'passed' | 'waived',
    }))
    .sort((left, right) => left.verificationId.localeCompare(right.verificationId));
  const calls = Object.values(state.tools.calls).filter(
    (call) =>
      call.sideEffect === true &&
      belongsToActiveTask(state, call.taskId) &&
      (call.status === 'succeeded' || !isResolvedRecoveryFailure(state, call)),
  );
  const execution = calls
    .filter((call) => call.status === 'succeeded' && call.result?.ok === true)
    .map((call) => ({ toolCallId: call.toolCallId, outcome: 'succeeded' as const }))
    .sort((left, right) => left.toolCallId.localeCompare(right.toolCallId));
  const unresolved = Object.values(state.tools.calls)
    .filter((call) => belongsToActiveTask(state, call.taskId))
    .reduce<Array<PlanCompletionEvidence['unresolved'][number]>>((entries, call) => {
      if (call.status === 'awaiting_approval') {
        entries.push({ kind: 'approval', referenceId: call.toolCallId });
      }
      if (
        ['failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status) &&
        call.sideEffect === true &&
        !isResolvedRecoveryFailure(state, call)
      ) {
        entries.push({ kind: 'failure', referenceId: call.toolCallId });
      }
      return entries;
    }, [])
    .sort((left, right) =>
      `${left.kind}:${left.referenceId}`.localeCompare(`${right.kind}:${right.referenceId}`),
    );
  const skipped = steps
    .filter((step) => step.status === 'skipped')
    .map((step) => ({
      stepId: step.id,
      reasonCode: skippedReasonCodes[step.id] ?? priorSkipped.get(step.id) ?? '',
    }))
    .sort((left, right) => left.stepId.localeCompare(right.stepId));
  return { schemaVersion: 1, verification, execution, skipped, unresolved };
}

function planCompletionBlocker(state: AgentState, evidence: PlanCompletionEvidence): string | null {
  if (
    state.interactions.kind !== 'idle' ||
    Object.values(state.tools.calls).some(
      (call) =>
        belongsToActiveTask(state, call.taskId) &&
        [
          'awaiting_user_input',
          'awaiting_review',
          'awaiting_approval',
          'awaiting_auto_review',
        ].includes(call.status),
    )
  )
    return 'plan_unresolved_blocker';
  if (
    Object.values(state.verification.records).some(
      (record) =>
        belongsToActiveTask(state, record.taskId) &&
        record.mode === 'required' &&
        record.status !== 'passed' &&
        record.status !== 'waived',
    )
  )
    return 'plan_verification_required';
  if (evidence.skipped.some((entry) => !SAFE_REASON_CODE.test(entry.reasonCode)))
    return 'plan_skipped_reason_required';
  if (evidence.unresolved.length > 0) return 'plan_unresolved_blocker';
  const calls = Object.values(state.tools.calls).filter(
    (call) =>
      call.sideEffect === true &&
      belongsToActiveTask(state, call.taskId) &&
      (call.status === 'succeeded' || !isResolvedRecoveryFailure(state, call)),
  );
  if (
    (activeTask(state)?.sideEffectsStarted === true && evidence.execution.length === 0) ||
    calls.some(
      (call) =>
        call.status !== 'succeeded' ||
        call.result?.ok !== true ||
        !evidence.execution.some((entry) => entry.toolCallId === call.toolCallId),
    )
  )
    return 'plan_effect_evidence_required';
  return null;
}

function planCompletionEvidenceMatchesRuntime(
  state: AgentState,
  steps: readonly PlanStep[],
  evidence: unknown,
): evidence is PlanCompletionEvidence {
  if (!isPlanCompletionEvidence(evidence)) return false;
  const reasonCodes = Object.fromEntries(
    evidence.skipped.map((entry) => [entry.stepId, entry.reasonCode]),
  );
  return (
    JSON.stringify(projectPlanCompletionEvidence(state, steps, reasonCodes)) ===
    JSON.stringify(evidence)
  );
}

/** Lifecycle facts are reduced only by this fixed core reducer. */
export function reduceLifecycleState(state: AgentState, event: KernelEvent): AgentState {
  const payload = eventRecord(event);
  switch (event.type) {
    case 'task.started': {
      const taskId = nonEmptyStringField(payload, 'taskId');
      const turnId = nonEmptyStringField(payload, 'turnId');
      const userGoal = stringField(payload, 'userGoal');
      if (!taskId || !turnId || userGoal === undefined) return state;
      const task: AgentTaskState = {
        taskId,
        userGoal,
        status: 'active',
        startedAtTurnId: turnId,
        sideEffectsStarted: false,
        planning: { kind: 'building_without_plan' },
        planHistory: [],
      };
      return {
        ...state,
        activeTaskId: taskId,
        tasks: { ...state.tasks, [taskId]: task },
        interactions: { kind: 'idle' },
      };
    }
    case 'task.completed': {
      const taskId = nonEmptyStringField(payload, 'taskId');
      const turnId = nonEmptyStringField(payload, 'turnId');
      if (!taskId || !turnId) return state;
      const current = state.tasks[taskId];
      if (!current || state.activeTaskId !== taskId) return state;
      const completed = {
        ...current,
        status: 'completed' as const,
        completedAtTurnId: turnId,
        executionMode: undefined,
      };
      return {
        ...state,
        toolRecovery: closeToolRecoveryScope(state.toolRecovery, {
          kind: 'task',
          taskId,
        }),
        activeTaskId: null,
        tasks: { ...state.tasks, [taskId]: completed },
      };
    }
    case 'task.cancelled': {
      const taskId = nonEmptyStringField(payload, 'taskId');
      if (!taskId) return state;
      const current = state.tasks[taskId];
      if (!current || state.activeTaskId !== taskId) return state;
      const cancelled = {
        ...current,
        status: 'cancelled' as const,
        executionMode: undefined,
      };
      return {
        ...state,
        toolRecovery: closeToolRecoveryScope(state.toolRecovery, {
          kind: 'task',
          taskId,
        }),
        activeTaskId: null,
        tasks: { ...state.tasks, [taskId]: cancelled },
      };
    }
    case 'turn.started': {
      const turnId = nonEmptyStringField(payload, 'turnId');
      if (!turnId) return state;
      const preservePlannedCorrection =
        state.completionGuard.guardVersion === 'completion_guard_v2' &&
        samePlanIdentity(state.completionGuard.planIdentity, planningIdentity(state));
      return {
        ...state,
        toolRecovery: closeToolRecoveryScope(state.toolRecovery, {
          kind: 'turn',
          turnId: state.turn.turnId,
        }),
        completionGuard: preservePlannedCorrection
          ? state.completionGuard
          : { correctionAttempts: 0 },
        terminalOutcome: undefined,
        turn: { turnId, turnIndex: state.turn.turnIndex + 1, status: 'active' },
      };
    }
    case 'planning.entered': {
      const taskId = nonEmptyStringField(payload, 'taskId');
      const task = taskId && taskId === state.activeTaskId ? state.tasks[taskId] : undefined;
      if (
        !taskId ||
        !task ||
        task.status !== 'active' ||
        task.sideEffectsStarted ||
        task.planning.kind !== 'building_without_plan'
      )
        return state;
      return updateTasks(state, taskId, (current) =>
        current ? { ...current, planning: { kind: 'planning_empty' } } : current!,
      );
    }
    case 'planning.exited': {
      // The current State implementation derives phase from planning state;
      // this legacy notification is deliberately a no-op.
      return state;
    }
    case 'plan.review_requested': {
      const task = activeTask(state);
      if (!task || task.taskId !== nonEmptyStringField(payload, 'taskId')) return state;
      const planning = task.planning;
      const document =
        planning.kind === 'planning_draft' || planning.kind === 'replanning_draft'
          ? planning.document
          : undefined;
      const planId = nonEmptyStringField(payload, 'planId');
      const version = numberField(payload, 'version');
      const structuralDigest = nonEmptyStringField(payload, 'structuralDigest');
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      if (
        !document ||
        !isPlanDocument(document) ||
        !planId ||
        version === undefined ||
        !structuralDigest ||
        !interactionId ||
        !toolCallId ||
        planId !== document.planId ||
        version !== document.version ||
        structuralDigest !== document.structuralDigest ||
        !agentPlanTransportMatchesDocument(payload.plan, document)
      )
        return state;
      const nextPlanning = {
        kind: 'awaiting_review' as const,
        document,
        interactionId,
        exitToolCallId: toolCallId,
      };
      const next = updateTasks(state, task.taskId, (current) =>
        current ? { ...current, planning: nextPlanning } : current!,
      );
      const call = next.tools.calls[toolCallId];
      const nextTools = call
        ? {
            ...next.tools,
            calls: {
              ...next.tools.calls,
              [toolCallId]: { ...call, status: 'awaiting_review' as const },
            },
          }
        : next.tools;
      const reviewPlan = planDocumentToAgentPlan(document);
      return {
        ...next,
        tools: nextTools,
        interactions: {
          kind: 'awaiting_review',
          interactionId,
          toolCallId,
          planId: document.planId,
          version: document.version,
          structuralDigest: document.structuralDigest,
          plan: reviewPlan,
          planSummary: `${document.title}\n\n${document.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')}`,
          ...(document.artifact ? { artifact: document.artifact } : {}),
        },
      };
    }
    case 'plan.approved': {
      const task = activeTask(state);
      const planning = task?.planning;
      const interaction = state.interactions;
      const planId = nonEmptyStringField(payload, 'planId');
      const version = numberField(payload, 'version');
      const structuralDigest = nonEmptyStringField(payload, 'structuralDigest');
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const executionMode = stringField(payload, 'executionMode');
      if (
        !task ||
        !planning ||
        planning.kind !== 'awaiting_review' ||
        interaction.kind !== 'awaiting_review' ||
        !planId ||
        version === undefined ||
        !structuralDigest ||
        !interactionId ||
        !toolCallId ||
        (executionMode !== 'auto' && executionMode !== 'accept_edits') ||
        interaction.interactionId !== interactionId ||
        toolCallId !== interaction.toolCallId ||
        planId !== interaction.planId ||
        version !== interaction.version ||
        structuralDigest !== interaction.structuralDigest
      )
        return state;
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [task.taskId]: {
            ...task,
            executionMode,
            planning: {
              kind: 'executing',
              document: planning.document,
              executionMode,
              approvedAtTurnId: state.turn.turnId,
            },
          },
        },
        interactions: { kind: 'idle' },
      };
    }
    case 'plan.revision_requested':
    case 'plan.review_cancelled': {
      const task = activeTask(state);
      const planning = task?.planning;
      const interaction = state.interactions;
      const planId = nonEmptyStringField(payload, 'planId');
      const version = numberField(payload, 'version');
      const structuralDigest = nonEmptyStringField(payload, 'structuralDigest');
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const feedback =
        event.type === 'plan.revision_requested'
          ? stringField(payload, 'feedback')
          : stringField(payload, 'reason');
      if (
        planning?.kind !== 'awaiting_review' ||
        interaction.kind !== 'awaiting_review' ||
        !planId ||
        version === undefined ||
        !structuralDigest ||
        !interactionId ||
        !toolCallId ||
        feedback === undefined ||
        interaction.interactionId !== interactionId ||
        toolCallId !== interaction.toolCallId ||
        planId !== interaction.planId ||
        version !== interaction.version ||
        structuralDigest !== interaction.structuralDigest
      )
        return state;
      return {
        ...updateTasks(state, task?.taskId ?? '', (current) =>
          current
            ? {
                ...current,
                planning: {
                  kind: 'planning_draft',
                  document: planning.document,
                  revisionFeedback: feedback,
                },
              }
            : current!,
        ),
        interactions: { kind: 'idle' },
      };
    }
    case 'plan.replan_requested': {
      const task = activeTask(state);
      const planning = task?.planning;
      const supersedesPlanVersion = numberField(payload, 'supersedesPlanVersion');
      const reason = stringField(payload, 'reason');
      if (
        !task ||
        !planning ||
        planning.kind !== 'executing' ||
        supersedesPlanVersion === undefined ||
        !Number.isSafeInteger(supersedesPlanVersion) ||
        !reason
      )
        return state;
      const nextPlanning = {
        kind: 'replanning_draft' as const,
        document: planning.document,
        supersedesPlanVersion,
        replanReason: reason,
      };
      const next = {
        ...updateTasks(state, task.taskId, (current) =>
          current
            ? {
                ...current,
                planning: nextPlanning,
                planHistory: [...current.planHistory, planning.document],
              }
            : current!,
        ),
        interactions: { kind: 'idle' as const },
      };
      const resolvesFailureIds = activeRecoveryFailureIds(state, true);
      return resolvesFailureIds.length === 0
        ? next
        : {
            ...next,
            toolRecovery: recordToolOwnedProgress(state.toolRecovery, {
              kind: 'replanned',
              referenceId: `${planning.document.planId}:${planning.document.version + 1}`,
              resolvesFailureIds,
            }),
          };
    }
    case 'plan.drafted': {
      const taskId = nonEmptyStringField(payload, 'taskId');
      const task = activeTask(state);
      if (!task || task.taskId !== taskId || task.status !== 'active') return state;
      const planning = task.planning;
      if (
        planning.kind !== 'planning_empty' &&
        planning.kind !== 'planning_draft' &&
        planning.kind !== 'replanning_draft'
      )
        return state;
      const draftDocument =
        planning.kind === 'planning_draft' || planning.kind === 'replanning_draft'
          ? planning.document
          : undefined;
      const plan = payload.plan as AgentPlan;
      const planId = nonEmptyStringField(payload, 'planId');
      const version = numberField(payload, 'version');
      const structuralHash = nonEmptyStringField(payload, 'structuralHash');
      const artifact = recordField(payload, 'artifact') as PlanArtifactRef | undefined;
      const supersedesPlanVersion = numberField(payload, 'supersedesPlanVersion');
      const replanReason = stringField(payload, 'replanReason');
      if (!planId || version === undefined || !structuralHash || !artifact) return state;
      const reusesCanonicalDocument =
        draftDocument !== undefined &&
        planId === draftDocument.planId &&
        version === draftDocument.version &&
        structuralHash === draftDocument.structuralDigest;
      if (reusesCanonicalDocument) {
        if (
          !isPlanDocument(draftDocument) ||
          !agentPlanTransportMatchesDocument(plan, draftDocument) ||
          !samePlanArtifactRef(artifact, draftDocument.artifact) ||
          supersedesPlanVersion !== draftDocument.supersedesPlanVersion ||
          replanReason !== draftDocument.replanReason
        )
          return state;
        return state;
      }
      const matchesNewRevisionScope =
        planning.kind === 'planning_empty'
          ? version === 1 && supersedesPlanVersion === undefined && replanReason === undefined
          : planning.kind === 'planning_draft'
            ? planId === planning.document.planId &&
              version === planning.document.version + 1 &&
              supersedesPlanVersion === planning.document.supersedesPlanVersion &&
              replanReason === planning.document.replanReason
            : planning.document.version >= planning.supersedesPlanVersion &&
              (planning.document.version === planning.supersedesPlanVersion ||
                (planning.document.supersedesPlanVersion === planning.supersedesPlanVersion &&
                  planning.document.replanReason === planning.replanReason)) &&
              planId === planning.document.planId &&
              version === planning.document.version + 1 &&
              supersedesPlanVersion === planning.supersedesPlanVersion &&
              replanReason === planning.replanReason;
      if (!matchesNewRevisionScope || artifact.taskId !== taskId) return state;
      const effectiveSupersedesPlanVersion =
        supersedesPlanVersion ??
        (planning.kind === 'replanning_draft'
          ? planning.supersedesPlanVersion
          : draftDocument?.supersedesPlanVersion);
      const effectiveReplanReason =
        replanReason ??
        (planning.kind === 'replanning_draft'
          ? planning.replanReason
          : draftDocument?.replanReason);
      const document = planDocumentFromTransport(
        plan,
        payload,
        state.turn.turnId,
        effectiveSupersedesPlanVersion,
        effectiveReplanReason,
      );
      if (!document || !isPlanArtifactRef(artifact, document)) return state;
      const nextPlanning =
        planning.kind === 'replanning_draft'
          ? {
              kind: 'replanning_draft' as const,
              document,
              supersedesPlanVersion: effectiveSupersedesPlanVersion!,
              replanReason: effectiveReplanReason!,
            }
          : { kind: 'planning_draft' as const, document };
      return updateTasks(state, taskId, (current) =>
        current ? { ...current, planning: nextPlanning } : current!,
      );
    }
    case 'plan.progress_updated': {
      const taskId = nonEmptyStringField(payload, 'taskId');
      const task = activeTask(state);
      if (!task || task.taskId !== taskId || task.planning.kind !== 'executing') return state;
      const executing = task.planning;
      const transportSteps = planStepsFromAgentPlanUpdate(payload.plan, executing.document);
      const planId = nonEmptyStringField(payload, 'planId');
      const version = numberField(payload, 'version');
      const structuralDigest = nonEmptyStringField(payload, 'structuralDigest');
      if (!transportSteps || !planId || version === undefined || !structuralDigest) return state;
      const updatedSteps = mergePlanSteps(executing.document.steps, transportSteps);
      if (
        planId !== executing.document.planId ||
        version !== executing.document.version ||
        structuralDigest !== executing.document.structuralDigest ||
        hasTerminalStepRollback(executing.document.steps, updatedSteps) ||
        !planCompletionEvidenceMatchesRuntime(state, updatedSteps, payload.completionEvidence)
      )
        return state;
      const updatedDocument: PlanDocument = {
        ...executing.document,
        steps: updatedSteps,
        updatedAtTurnId: state.turn.turnId,
        completionEvidence: payload.completionEvidence as PlanCompletionEvidence,
      };
      if (!isPlanDocument(updatedDocument)) return state;
      const updated = updateTasks(state, taskId, (current) =>
        current && current.planning.kind === 'executing'
          ? { ...current, planning: { ...current.planning, document: updatedDocument } }
          : current!,
      );
      const newlySkipped = updatedSteps.some(
        (step) =>
          step.status === 'skipped' &&
          executing.document.steps.find((previous) => previous.id === step.id)?.status !==
            'skipped',
      );
      const resolvesFailureIds = newlySkipped ? activeRecoveryFailureIds(state) : [];
      return resolvesFailureIds.length === 0
        ? updated
        : {
            ...updated,
            toolRecovery: recordToolOwnedProgress(state.toolRecovery, {
              kind: 'skipped',
              referenceId: nonEmptyStringField(payload, 'toolCallId') ?? '',
              resolvesFailureIds,
            }),
          };
    }
    case 'plan.completed': {
      const taskId = nonEmptyStringField(payload, 'taskId');
      const task = activeTask(state);
      if (!task || task.taskId !== taskId || task.planning.kind !== 'executing') return state;
      const executing = task.planning;
      const transportSteps = planStepsFromAgentPlanUpdate(payload.plan, executing.document);
      const planId = nonEmptyStringField(payload, 'planId');
      const version = numberField(payload, 'version');
      const structuralDigest = nonEmptyStringField(payload, 'structuralDigest');
      const plan = isRecord(payload.plan) ? payload.plan : undefined;
      if (
        !transportSteps ||
        !plan ||
        plan.status !== 'completed' ||
        !planId ||
        version === undefined ||
        !structuralDigest
      )
        return state;
      const updatedSteps = mergePlanSteps(executing.document.steps, transportSteps);
      if (
        planId !== executing.document.planId ||
        version !== executing.document.version ||
        structuralDigest !== executing.document.structuralDigest ||
        hasTerminalStepRollback(executing.document.steps, updatedSteps) ||
        updatedSteps.some((step) => step.status === 'pending' || step.status === 'in_progress') ||
        updatedSteps.every((step) => step.status === 'skipped') ||
        !planCompletionEvidenceMatchesRuntime(state, updatedSteps, payload.completionEvidence) ||
        planCompletionBlocker(state, payload.completionEvidence as PlanCompletionEvidence) !== null
      )
        return state;
      const completedDocument: PlanDocument = {
        ...executing.document,
        steps: updatedSteps,
        completionEvidence: payload.completionEvidence as PlanCompletionEvidence,
      };
      if (!isPlanDocument(completedDocument)) return state;
      return updateTasks(state, taskId, (current) =>
        current && current.planning.kind === 'executing'
          ? {
              ...current,
              executionMode: undefined,
              planning: {
                kind: 'completed',
                document: completedDocument,
                completedAtTurnId: state.turn.turnId,
              },
            }
          : current!,
      );
    }
    case 'user.command_invoked':
      return state;
    default:
      return state;
  }
}
