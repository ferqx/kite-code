import { createHash } from 'node:crypto';
import {
  createCapabilitySnapshot,
  type SkillCatalogSnapshot,
} from '@kite-ai/builtin-runtime/skills';
import type { CapabilitySnapshot } from '@kite-ai/runtime-contract';
import type {
  CrossSessionFollowupAdmission,
  ResourceBudget,
} from '@kite-ai/runtime-host/kernel-adapter';
import { encodeCurrentAgentStateJson } from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeAgentArtifactRef,
  RuntimeFollowupRunStartMutation,
} from '@kite-ai/runtime-host/storage';
import {
  CHILD_SESSION_TASK_USER_GOAL,
  childDelegatedUpperBoundDigest,
} from '@kite-ai/runtime-host/storage';
import type { RuntimeEvent, RuntimeState } from '../state-runtime';

const sha256 = (value: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const derived = (kind: 'run' | 'task', submissionId: string): string =>
  `followup_${kind}_${createHash('sha256')
    .update(JSON.stringify(['kite.child-followup-turn.v1', kind, submissionId]))
    .digest('hex')}`;

export interface VerifiedChildFollowupCheckpoint {
  readonly ref: RuntimeAgentArtifactRef<'subagent_checkpoint'>;
  readonly canonicalJson: string;
  readonly terminalRevision: number;
}

export interface ChildFollowupTurnPlan {
  readonly events: readonly RuntimeEvent[];
  readonly mutation: RuntimeFollowupRunStartMutation;
  readonly budget: ResourceBudget;
  readonly deadlineAt: string;
  readonly firstAttemptTimeoutMs?: number;
}

/** The target grant uses a current directory read at exactly this State revision. */
export function verifiedTargetFollowupCatalog(input: {
  readonly state: Readonly<RuntimeState>;
  readonly observedTargetRevision: number;
  readonly mcpSnapshot: Readonly<CapabilitySnapshot> | null;
  readonly skillCatalog: Readonly<SkillCatalogSnapshot> | null;
}): boolean {
  if (input.observedTargetRevision !== input.state.revision) return false;
  const mcp = input.mcpSnapshot;
  const skill = input.skillCatalog?.capabilities ?? null;
  if (
    (mcp && createCapabilitySnapshot([...mcp.descriptors]).revision !== mcp.revision) ||
    (skill && createCapabilitySnapshot([...skill.descriptors]).revision !== skill.revision)
  )
    return false;
  const current = createCapabilitySnapshot([
    ...(mcp?.descriptors ?? []),
    ...(skill?.descriptors ?? []),
  ]);
  return current.revision === input.state.capabilities.catalogRevision;
}

/** Build one zero-Tool child Run from a settled checkpoint and source-owned backup. */
export function planChildFollowupTurn(input: {
  readonly state: Readonly<RuntimeState>;
  readonly admission: Readonly<CrossSessionFollowupAdmission>;
  readonly sourceAdmissionRef: RuntimeAgentArtifactRef<'agent_followup_admission'>;
  readonly sourceAdmissionDigest: string;
  readonly checkpoint?: VerifiedChildFollowupCheckpoint;
  readonly nowMs: number;
  /** Exact model-visible target tools after role, original grant and catalog attenuation. */
  readonly allowedTools?: readonly string[];
  readonly targetPolicy: Readonly<{
    workspaceDigest: string;
    interactionModeRevision: number;
    capabilityDigest: string;
    phaseCeiling: 'planning' | 'building';
  }>;
}): ChildFollowupTurnPlan {
  const { state, admission, checkpoint } = input;
  const origin = state.childSessionOrigin;
  const independent = admission.policy.executionMode === 'independent_turn_v2';
  const checkpointPayload = checkpoint
    ? (JSON.parse(checkpoint.canonicalJson) as Record<string, unknown>)
    : null;
  const checkpointDigest = checkpoint ? sha256(checkpoint.canonicalJson) : null;
  const checkpointTaskId = checkpointPayload?.terminalTaskId;
  if (
    (origin?.terminal?.status !== 'completed' &&
      !(independent && origin?.terminal?.status === 'unknown')) ||
    (state.terminalOutcome?.status !== 'completed' &&
      !(independent && state.terminalOutcome?.status === 'unknown')) ||
    (state.turn.status !== 'completed' &&
      !(
        independent &&
        state.turn.status === 'aborted' &&
        state.terminalOutcome?.status === 'unknown'
      )) ||
    state.activeTaskId !== null ||
    state.activeFollowupTurn ||
    state.session.threadId !== admission.targetSessionId ||
    origin.parentSessionId !== admission.sourceSessionId ||
    input.targetPolicy.workspaceDigest !== state.session.canonicalWorkspaceDigest ||
    input.targetPolicy.interactionModeRevision !== state.interactionModeRevision ||
    input.targetPolicy.capabilityDigest !== state.capabilities.catalogRevision ||
    (admission.policy.phaseCeiling === 'planning' &&
      input.targetPolicy.phaseCeiling !== 'planning') ||
    (!checkpoint && !independent) ||
    (checkpoint &&
      (checkpoint.ref.kind !== 'subagent_checkpoint' ||
        checkpoint.ref.integrityIdentifier !== checkpointDigest ||
        checkpoint.ref.artifactId !== `pa_${checkpointDigest?.slice(7)}` ||
        checkpoint.ref.byteLength !== Buffer.byteLength(checkpoint.canonicalJson, 'utf8') ||
        checkpointPayload?.artifactFormatVersion !== 1 ||
        checkpointPayload.childSessionId !== state.session.threadId ||
        checkpointPayload.terminalRevision !== checkpoint.terminalRevision ||
        checkpoint.terminalRevision > state.revision ||
        checkpointPayload.terminalRunId !== state.turn.turnId ||
        checkpointPayload.terminalStatus !== 'completed' ||
        typeof checkpointTaskId !== 'string' ||
        state.tasks[checkpointTaskId]?.status !== 'completed' ||
        JSON.stringify(checkpointPayload.transcript) !== JSON.stringify(state.transcript))) ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0 ||
    (!independent &&
      (!Number.isSafeInteger(admission.policy.firstAttemptTimeoutMs) ||
        (admission.policy.firstAttemptTimeoutMs ?? 0) <= 0))
  )
    throw new Error('Child followup lacks a current settled checkpoint and restricted policy.');
  const sourceRevision = checkpoint ? undefined : state.revision;
  const sourceStateDigest = checkpoint ? undefined : sha256(encodeCurrentAgentStateJson(state));
  const remaining = (admission.deadlineAt === null ? Infinity : admission.deadlineAt) - input.nowMs;
  if (!independent && remaining < (admission.policy.firstAttemptTimeoutMs ?? 0) + 5_000)
    throw new Error('Child followup funding deadline cannot cover its first Model attempt.');
  const upper = admission.executableUpperBound;
  const durationOnlyChildRun = independent && upper.durationOnlyChildRun === true;
  if (
    (durationOnlyChildRun
      ? Object.values(upper.counters).some((value) => value !== 0)
      : upper.counters.turns < 1 ||
        upper.counters.modelRequests < 1 ||
        upper.counters.inputTokens < 1 ||
        upper.counters.outputTokens < 1) ||
    upper.counters.toolInvocations !== 0
  )
    throw new Error('Child followup source backup lacks a bounded turn envelope.');
  if (independent) {
    const allowed = input.allowedTools;
    if (
      admission.policy.targetRole !== origin.role ||
      admission.policy.targetGrantDigest !== origin.grantDigest ||
      upper.independentFollowupTurn !== true ||
      upper.unboundedToolInvocations !== true ||
      upper.gauges.elapsedRunMs !== 30 * 60_000 ||
      (!durationOnlyChildRun && upper.counters.artifactBytes < 1) ||
      !allowed ||
      allowed.length === 0 ||
      new Set(allowed).size !== allowed.length ||
      allowed.some((name) => !name || name === 'task')
    )
      throw new Error('Child followup lacks a role-bound independent turn grant.');
  } else if (upper.counters.artifactBytes !== 0) {
    throw new Error('Legacy child followup source backup is not zero-Tool.');
  }
  const duration = independent
    ? 30 * 60_000
    : Math.min(remaining, upper.gauges.elapsedRunMs || remaining);
  if (
    !Number.isSafeInteger(duration) ||
    duration < (independent ? 1 : (admission.policy.firstAttemptTimeoutMs ?? 0) + 5_000)
  )
    throw new Error('Child followup delegated duration is unavailable.');
  const budget: ResourceBudget = {
    version: 1,
    maxRunDurationMs: duration,
    maxTurns: durationOnlyChildRun ? 0 : 1,
    maxModelRequests: durationOnlyChildRun ? 0 : independent ? upper.counters.modelRequests : 1,
    maxToolInvocations: 0,
    ...(independent ? { unboundedToolInvocations: true as const } : {}),
    ...(durationOnlyChildRun ? { durationOnlyChildRun: true as const } : {}),
    maxRunInputTokens: durationOnlyChildRun ? 0 : upper.counters.inputTokens,
    maxRunOutputTokens: durationOnlyChildRun
      ? 0
      : independent
        ? upper.counters.outputTokens
        : Math.min(upper.counters.outputTokens, admission.policy.maxOutputTokens ?? 0),
    maxArtifactBytes: durationOnlyChildRun ? 0 : independent ? upper.counters.artifactBytes : 0,
    maxConcurrentSubagents: 0,
    maxConcurrentWriters: durationOnlyChildRun
      ? Number.MAX_SAFE_INTEGER
      : independent
        ? upper.gauges.activeWriters
        : 0,
    maxConcurrentToolInvocations: independent ? Number.MAX_SAFE_INTEGER : 0,
    maxConcurrentShellInvocations: independent ? Number.MAX_SAFE_INTEGER : 0,
    maxConcurrencyWaitMs: independent ? duration : 1,
  };
  const targetRunId = derived('run', admission.submissionId);
  const taskId = derived('task', admission.submissionId);
  const startedAt = new Date(input.nowMs).toISOString();
  const deadlineAt = new Date(input.nowMs + duration).toISOString();
  const grantCanonicalJson = JSON.stringify({
    schema: independent ? 'kite.child-followup-grant.v2' : 'kite.child-followup-grant.v1',
    sourceSessionId: admission.sourceSessionId,
    targetSessionId: admission.targetSessionId,
    submissionId: admission.submissionId,
    targetRunId,
    taskId,
    ...(checkpoint ? { checkpointRef: checkpoint.ref } : { sourceRevision, sourceStateDigest }),
    ...(independent && state.terminalOutcome?.status === 'unknown'
      ? { priorOutcomeUnknown: true }
      : {}),
    originRole: origin.role,
    workspaceDigest: input.targetPolicy.workspaceDigest,
    interactionModeRevision: input.targetPolicy.interactionModeRevision,
    capabilityDigest: input.targetPolicy.capabilityDigest,
    phaseCeiling: input.targetPolicy.phaseCeiling,
    sourceAdmissionRef: input.sourceAdmissionRef,
    sourceAdmissionDigest: input.sourceAdmissionDigest,
    ...(independent ? { sourceBackupUpperDigest: childDelegatedUpperBoundDigest(upper) } : {}),
    denyTools: !independent,
    allowedTools: independent ? [...input.allowedTools!] : [],
    budget: { ...budget, deadlineAt },
    ...(independent ? {} : { firstAttemptTimeoutMs: admission.policy.firstAttemptTimeoutMs }),
  });
  const grantDigest = sha256(grantCanonicalJson);
  const grantRef: RuntimeAgentArtifactRef<'agent_followup_grant'> = {
    artifactId: `pa_${grantDigest.slice(7)}`,
    kind: 'agent_followup_grant',
    integrityIdentifier: grantDigest,
    byteLength: Buffer.byteLength(grantCanonicalJson, 'utf8'),
  };
  const mutation: RuntimeFollowupRunStartMutation = {
    sourceSessionId: admission.sourceSessionId,
    submissionId: admission.submissionId,
    targetRunId,
    taskId,
    phase: input.targetPolicy.phaseCeiling,
    ...(checkpoint ? { checkpointRef: checkpoint.ref } : { sourceRevision, sourceStateDigest }),
    grantDigest,
    grant: { ref: grantRef, canonicalJson: grantCanonicalJson, createdAt: input.nowMs },
  };
  const events: readonly RuntimeEvent[] = [
    {
      type: 'agent.followup_turn_prepared',
      sourceSessionId: admission.sourceSessionId,
      submissionId: admission.submissionId,
      targetRunId,
      taskId,
      ...(checkpoint ? { checkpointRef: checkpoint.ref } : { sourceRevision, sourceStateDigest }),
      grantRef,
      grantDigest,
    },
    { type: 'resource_budget.configured', runId: targetRunId, startedAt, deadlineAt, budget },
    { type: 'task.started', taskId, userGoal: CHILD_SESSION_TASK_USER_GOAL, turnId: targetRunId },
    { type: 'turn.started', turnId: targetRunId },
  ];
  return Object.freeze({
    events: Object.freeze(events),
    mutation: Object.freeze(mutation),
    budget: Object.freeze(budget),
    deadlineAt,
    ...(independent ? {} : { firstAttemptTimeoutMs: admission.policy.firstAttemptTimeoutMs }),
  });
}
