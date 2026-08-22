import {
  COMPLETION_GUARD_V1,
  COMPLETION_GUARD_V2,
  type CompletionGuardBlocked,
  type CompletionGuardDecision,
  decideCompletionV1,
  decideCompletionV2,
  type PlanIdentityV1,
} from '../../completion';
import type { KernelEvent } from '../../events';
import {
  asJsonObject,
  eventRecord,
  nonEmptyStringField,
  recordField,
  stringField,
} from '../../reducer-utils';
import type { AgentRunTerminalOutcome, AgentState, AgentTerminalReasonCode } from '../../state';

const TERMINAL_REASON_CODES = new Set<string>([
  'completed',
  'artifact_invalid',
  'profile_invalid',
  'digest_invalid',
  'workspace_untrusted',
  'sandbox_unavailable',
  'network_unavailable',
  'worktree_unavailable',
  'model_retry_exhausted',
  'provider_unavailable',
  'mcp_unavailable',
  'persistence_unavailable',
  'budget_exhausted',
  'resource_saturated',
  'tool_concurrency_saturated',
  'shell_concurrency_saturated',
  'process_limit_exceeded',
  'cancel_incomplete',
  'compaction_unqualified',
  'compaction_failed',
  'verification_failed',
  'verification_inconclusive',
  'mandatory_policy_unavailable',
  'blocked',
  'unknown',
]);

function terminalReasonCode(value: unknown): value is AgentTerminalReasonCode {
  return typeof value === 'string' && TERMINAL_REASON_CODES.has(value);
}

function terminalStatus(value: unknown): value is AgentRunTerminalOutcome['status'] {
  return (
    value === 'completed' ||
    value === 'aborted' ||
    value === 'blocked' ||
    value === 'unknown' ||
    value === 'budget_exhausted' ||
    value === 'resource_saturated'
  );
}

function knownExternalEffects(
  value: unknown,
): value is AgentRunTerminalOutcome['knownExternalEffects'] {
  return value === 'none' || value === 'known' || value === 'unknown';
}

function recoveryEntry(value: unknown): value is AgentRunTerminalOutcome['recoveryEntry'] {
  return (
    value === 'none' ||
    value === 'retry' ||
    value === 'reconcile' ||
    value === 'new_run' ||
    value === 'operator_action'
  );
}

function samePlanIdentity(left: PlanIdentityV1 | undefined, right: PlanIdentityV1): boolean {
  return (
    left?.planId === right.planId &&
    left.version === right.version &&
    left.structuralDigest === right.structuralDigest
  );
}

function planIdentity(value: unknown): PlanIdentityV1 | undefined {
  const candidate = recordField({ value }, 'value');
  const planId = nonEmptyStringField(candidate ?? {}, 'planId');
  const version = candidate?.version;
  const structuralDigest = nonEmptyStringField(candidate ?? {}, 'structuralDigest');
  return planId && typeof version === 'number' && Number.isSafeInteger(version) && version >= 1
    ? structuralDigest
      ? { planId, version, structuralDigest }
      : undefined
    : undefined;
}

function hasPlanDocument(state: AgentState): boolean {
  const task = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
  return task?.planning != null && 'document' in task.planning;
}

function completionDecisionForVersion(
  state: AgentState,
  version: string,
): CompletionGuardDecision | undefined {
  if (version === COMPLETION_GUARD_V1) return decideCompletionV1(state);
  if (version === COMPLETION_GUARD_V2) {
    try {
      return decideCompletionV2(state);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function blockedEventMatchesDecision(
  payload: Readonly<Record<string, unknown>>,
  decision: Extract<CompletionGuardDecision, { status: 'blocked' }>,
): boolean {
  if (
    stringField(payload, 'guardVersion') !== decision.version ||
    stringField(payload, 'code') !== decision.code ||
    stringField(payload, 'nextAction') !== decision.nextAction ||
    stringField(payload, 'planning') !== decision.planning ||
    payload.correctionAttempt !== decision.correctionAttempt
  )
    return false;
  return decision.version === COMPLETION_GUARD_V1
    ? true
    : samePlanIdentity(planIdentity(payload.planIdentity), decision.planIdentity);
}

function completionOutcome(
  payload: Readonly<Record<string, unknown>>,
): AgentRunTerminalOutcome | undefined {
  const outcome = recordField(payload, 'outcome');
  if (outcome?.version !== 1 || !terminalReasonCode(outcome.reasonCode)) {
    return undefined;
  }
  const status = outcome.status;
  const externalEffects = outcome.knownExternalEffects;
  const recovery = outcome.recoveryEntry;
  if (
    !terminalStatus(status) ||
    !knownExternalEffects(externalEffects) ||
    !recoveryEntry(recovery) ||
    typeof outcome.safeRetry !== 'boolean' ||
    typeof outcome.pendingVerification !== 'boolean'
  ) {
    return undefined;
  }
  return {
    version: 1,
    status,
    reasonCode: outcome.reasonCode,
    knownExternalEffects: externalEffects,
    safeRetry: outcome.safeRetry,
    recoveryEntry: recovery,
    pendingVerification: outcome.pendingVerification,
  };
}

/** Completion truth is produced by this fixed reducer, never by a provider. */
export function reduceCompletionState(state: AgentState, event: KernelEvent): AgentState {
  const payload = eventRecord(event);
  switch (event.type) {
    case 'turn.completed': {
      const turnId = nonEmptyStringField(payload, 'turnId');
      return turnId && turnId === state.turn.turnId
        ? { ...state, turn: { ...state.turn, status: 'completed' } }
        : state;
    }
    case 'turn.aborted': {
      const turnId = nonEmptyStringField(payload, 'turnId');
      const reason = nonEmptyStringField(payload, 'reason');
      const cause = stringField(payload, 'cause');
      return turnId && reason && turnId === state.turn.turnId
        ? {
            ...state,
            turn: {
              ...state.turn,
              turnId,
              status: 'aborted',
              abortReason: reason,
              ...(cause === 'error' || cause === 'user' ? { abortCause: cause } : {}),
            },
          }
        : state;
    }
    case 'run.completed': {
      const turnId = nonEmptyStringField(payload, 'turnId');
      if (!turnId || turnId !== state.turn.turnId) return state;
      const activeTask = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
      if (!activeTask) return state;
      const version = stringField(payload, 'completionGuardVersion') ?? COMPLETION_GUARD_V1;
      if (hasPlanDocument(state) && version !== COMPLETION_GUARD_V2) return state;
      const decision = completionDecisionForVersion(state, version);
      if (decision?.status !== 'accepted') return state;
      if (
        decision.version === COMPLETION_GUARD_V2 &&
        !samePlanIdentity(planIdentity(payload.planIdentity), decision.planIdentity)
      )
        return state;
      const outcome = completionOutcome(payload);
      if (!outcome) return state;
      const completed = {
        ...activeTask,
        status: 'completed' as const,
        completedAtTurnId: turnId,
        executionMode: undefined,
      };
      return {
        ...state,
        terminalOutcome: outcome,
        activeTaskId: null,
        tasks: { ...state.tasks, [activeTask.taskId]: completed },
      };
    }
    case 'run.error': {
      const outcome = completionOutcome(payload);
      if (!outcome) return state;
      return {
        ...state,
        terminalOutcome: outcome,
      };
    }
    case 'completion.blocked': {
      const turnId = nonEmptyStringField(payload, 'turnId');
      const version = stringField(payload, 'guardVersion');
      if (!turnId || turnId !== state.turn.turnId || !version) return state;
      if (hasPlanDocument(state) && version !== COMPLETION_GUARD_V2) return state;
      const decision = completionDecisionForVersion(state, version);
      if (decision?.status !== 'blocked') return state;
      if (!blockedEventMatchesDecision(payload, decision)) return state;
      const blocked = decision as CompletionGuardBlocked;
      return {
        ...state,
        completionGuard: asJsonObject({
          correctionAttempts: blocked.correctionAttempt,
          guardVersion: blocked.version,
          ...(blocked.version === COMPLETION_GUARD_V2
            ? { planIdentity: blocked.planIdentity }
            : {}),
        }),
        transcript: { ...state.transcript, final: undefined },
      };
    }
    // Diagnostics are durable notifications but not State26 completion facts.
    case 'runtime.action_ignored':
    case 'provider.data_policy_status':
      return state;
    default:
      return state;
  }
}
