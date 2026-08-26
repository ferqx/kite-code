import { assertCurrentRuntimeEvent } from './codec';
import {
  CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS,
  type RuntimeEvent,
  type RuntimeEventType,
} from './events';
import { isToolOutcome, toolOutcomeMetricStatus } from './normalization';

export const OBSERVABILITY_RUNTIME_FACT_SCHEMA_ = 'kite.observability-runtime-fact.v1' as const;

export type KernelObservabilityToolStatus =
  | 'success'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'timed_out'
  | 'exhausted'
  | 'unknown';

export type KernelObservabilityFailureKind =
  | 'process_limit_exceeded'
  | 'cancel_incomplete'
  | 'resource_saturated';

export type KernelObservabilityReason =
  | 'completed'
  | 'model'
  | 'policy'
  | 'tool'
  | 'provider'
  | 'sandbox'
  | 'runtime'
  | 'budget'
  | 'resource'
  | 'compaction'
  | 'verification'
  | 'cancellation'
  | 'unknown';

interface KernelObservabilityFactBase {
  readonly schema: typeof OBSERVABILITY_RUNTIME_FACT_SCHEMA_;
  readonly observedAt: string;
}

export interface KernelObservabilityToolOutcomeFact {
  readonly status: KernelObservabilityToolStatus;
  readonly totalActiveMs?: number;
  readonly failureKind?: KernelObservabilityFailureKind;
}

export type KernelObservabilityRuntimeFact =
  | (KernelObservabilityFactBase & { readonly type: 'turn.completed' })
  | (KernelObservabilityFactBase & {
      readonly type: 'turn.aborted';
      readonly cause: 'user' | 'runtime';
    })
  | (KernelObservabilityFactBase & {
      readonly type: 'model.responded';
      readonly durationMs?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    })
  | (KernelObservabilityFactBase & { readonly type: 'model.retry' })
  | (KernelObservabilityFactBase & {
      readonly type: 'tool.finished';
      readonly capabilityAlias?: string;
      readonly outcome: KernelObservabilityToolOutcomeFact;
    })
  | (KernelObservabilityFactBase & {
      readonly type: 'tool.failed' | 'tool.rejected' | 'tool.cancelled';
      readonly outcome: KernelObservabilityToolOutcomeFact;
    })
  | (KernelObservabilityFactBase & {
      readonly type: 'approval.rejected' | 'auto_review.completed';
      readonly outcome: KernelObservabilityToolOutcomeFact;
    })
  | (KernelObservabilityFactBase & { readonly type: 'skill.activation_started' })
  | (KernelObservabilityFactBase & {
      readonly type: 'skill.frame_closed';
      readonly status: 'closed' | 'invalidated';
    })
  | (KernelObservabilityFactBase & {
      readonly type: 'plan.drafted' | 'plan.completed';
    })
  | (KernelObservabilityFactBase & {
      readonly type: 'verification.completed';
      readonly outcome: 'passed' | 'failed' | 'inconclusive';
    })
  | (KernelObservabilityFactBase & { readonly type: 'verification.waived' })
  | (KernelObservabilityFactBase & {
      readonly type: 'context.compaction_completed' | 'context.compaction_failed';
      readonly durationMs?: number;
    })
  | (KernelObservabilityFactBase & { readonly type: 'context.hard_blocked' })
  | (KernelObservabilityFactBase & { readonly type: 'context.compaction_reset' })
  | (KernelObservabilityFactBase & { readonly type: 'context.hard_block_cleared' })
  | (KernelObservabilityFactBase & { readonly type: 'runtime.action_ignored' })
  | (KernelObservabilityFactBase & {
      readonly type: 'runtime.cancellation_diagnostic';
      readonly unconfirmedDescendantCount: number;
    })
  | (KernelObservabilityFactBase & {
      readonly type: 'run.completed' | 'run.error';
      readonly outcome: 'completed' | 'failed' | 'cancelled' | 'unknown';
      readonly reason: KernelObservabilityReason;
      readonly failureKind?: KernelObservabilityFailureKind;
    })
  | (KernelObservabilityFactBase & {
      readonly type: 'resource_budget.reconciled';
      readonly activeToolInvocations: number;
      readonly activeShellInvocations: number;
    })
  | (KernelObservabilityFactBase & {
      readonly type: 'resource_budget.waiter_timed_out';
    });

/** Event discriminants with an explicit zero-metric decision. */
const IGNORED_RUNTIME_EVENT_TYPES_ = [
  'resource_budget.configured',
  'resource_budget.reserved',
  'resource_budget.dispatch_started',
  'resource_budget.released',
  'resource_budget.unknown',
  'resource_budget.waiter_enqueued',
  'resource_budget.waiter_promoted',
  'resource_budget.waiter_cancelled',
  'context.compaction_requested',
  'capability.bindings_issued',
  'capability.search_completed',
  'skill.catalog_refreshed',
  'capability.invocation_recorded',
  'capability.execution_started',
  'capability.execution_result_recorded',
  'capability.execution_succeeded',
  'capability.execution_failed',
  'capability.execution_unknown',
  'capability.reconciliation_resolved',
  'verification.requested',
  'verification.started',
  'verification.check_completed',
  'verification.repair_requested',
  'verification.replan_requested',
  'verification.compensation_requested',
  'verification.compensation_completed',
  'tool.queued',
  'tool.started',
  'tool.progress',
  'network.admission_decided',
  'user_input.requested',
  'user_input.answered',
  'plan.review_requested',
  'plan.approved',
  'plan.revision_requested',
  'plan.review_cancelled',
  'plan.replan_requested',
  'task.started',
  'planning.entered',
  'planning.exited',
  'task.completed',
  'task.cancelled',
  'approval.requested',
  'approval.granted',
  'approval.batch_released',
  'approval.session_grants_cleared',
  'provider.action_required',
  'provider.action_started',
  'provider.action_completed',
  'provider.action_deferred',
  'provider.action_failed',
  'provider.admission_required',
  'provider.admission_retry_requested',
  'provider.admission_retry_failed',
  'provider.admission_satisfied',
  'provider.admission_waived',
  'provider.admission_cancelled',
  // Decode-only legacy model-admission telemetry; no current producer emits it.
  'interaction_mode.changed',
  'auto_review.requested',
  'user_input.cancelled',
  'turn.started',
  'user.message_appended',
  'user.command_invoked',
  'model.requested',
  'model.invocation_prepared',
  'model.invocation_attempt_started',
  'model.invocation_completed',
  'model.invocation_interrupted',
  'model.invocation_evidence_unavailable',
  'provider.readiness_intent_recorded',
  'provider.readiness_waiter_registered',
  'provider.readiness_attempt_started',
  'provider.readiness_succeeded',
  'provider.readiness_failed',
  'capability.filesystem_intent_recorded',
  'capability.filesystem_mutation_ready',
  'capability.sandbox_preparation_intent_recorded',
  'capability.sandbox_preparation_ready',
  'capability.sandbox_execution_dispatch_intent_recorded',
  'capability.sandbox_execution_supervisor_started',
  'capability.sandbox_disposal_started',
  'capability.sandbox_disposal_completed',
  'capability.sandbox_preparation_abandonment_started',
  'capability.sandbox_preparation_abandonment_completed',
  'capability.subagent_dispatch_intent_recorded',
  'capability.subagent_handle_recorded',
  'capability.subagent_observation_recorded',
  'capability.subagent_cleanup_started',
  'capability.subagent_cleanup_completed',
  'model.reasoning_delta',
  'model.reasoning_completed',
  'model.text_delta',
  'model.cache_metrics',
  'model.context_metrics',
  'provider.admission_status',
  'completion.blocked',
  'plan.progress_updated',
  'approval.command_replaced',
  'tool.file_change',
  'tool.retry_recorded',
  'subagent.started',
  'subagent.step',
  'subagent.tool_result',
  'subagent.completed',
  'subagent.failed',
  'subagent.cache_metrics',
  'subagent.suspended',
  'subagent.approval_deferred',
  'subagent.recovery_journal_merged',
  // Rewind intent/result identity is operational recovery evidence, not a
  // metric payload. Never project checkpoint or command fields into facts.
  'session.rewind_requested',
  'session.rewind_completed',
  'session.rewind_failed',
] as const satisfies readonly RuntimeEventType[];

export const OBSERVABILITY_IGNORED_RUNTIME_EVENT_TYPES_ = Object.freeze(
  IGNORED_RUNTIME_EVENT_TYPES_,
);

/** Every current State event must have one explicit observability decision. */
export const OBSERVABILITY_HANDLED_RUNTIME_EVENT_TYPES_ = Object.freeze([
  'turn.completed',
  'turn.aborted',
  'model.responded',
  'model.retry',
  'tool.finished',
  'tool.failed',
  'tool.rejected',
  'tool.cancelled',
  'approval.rejected',
  'auto_review.completed',
  'skill.activation_started',
  'skill.frame_closed',
  'plan.drafted',
  'plan.completed',
  'verification.completed',
  'verification.waived',
  'context.compaction_completed',
  'context.compaction_failed',
  'context.hard_blocked',
  'context.compaction_reset',
  'context.hard_block_cleared',
  'runtime.action_ignored',
  'runtime.cancellation_diagnostic',
  'run.completed',
  'run.error',
  'resource_budget.reconciled',
  'resource_budget.waiter_timed_out',
] as const satisfies readonly RuntimeEventType[]);

export function assertObservabilityEventCoverage(): void {
  const declared = [
    ...OBSERVABILITY_HANDLED_RUNTIME_EVENT_TYPES_,
    ...OBSERVABILITY_IGNORED_RUNTIME_EVENT_TYPES_,
  ];
  if (declared.length !== Object.keys(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS).length) {
    throw new Error('Observability RuntimeEvent coverage count is out of date.');
  }
  const seen = new Set<string>();
  for (const type of declared) {
    if (seen.has(type)) throw new Error(`Observability RuntimeEvent coverage overlaps at ${type}.`);
    seen.add(type);
  }
  for (const type of Object.keys(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS)) {
    if (!seen.has(type)) throw new Error(`Observability RuntimeEvent coverage is missing ${type}.`);
  }
}

assertObservabilityEventCoverage();

const FAILURE_KINDS: ReadonlySet<string> = new Set([
  'process_limit_exceeded',
  'cancel_incomplete',
  'resource_saturated',
]);

/**
 * The sole Kernel-owned RuntimeEvent -> observability fact projection.
 * `occurredAt` is preferred for an envelope; the caller must explicitly supply
 * a fallback for an un-enveloped event. No State, Store, receipt identity or
 * free-form content is copied into the returned fact.
 */
export function projectRuntimeEventToObservabilityFact(
  input: unknown,
  fallbackObservedAt: string,
): KernelObservabilityRuntimeFact | undefined {
  const envelope = isEventEnvelopeInput(input) ? input : undefined;
  const event = envelope?.payload ?? (isRuntimeEventShape(input) ? input : undefined);
  if (!event) return undefined;
  const observedAt = envelope?.occurredAt ?? fallbackObservedAt;
  const type = event.type;
  const value = record(event);
  if (!value) return undefined;
  const base = { schema: OBSERVABILITY_RUNTIME_FACT_SCHEMA_, observedAt } as const;

  switch (type) {
    case 'turn.completed':
      return { ...base, type };
    case 'turn.aborted':
      return { ...base, type, cause: stringValue(value.cause) === 'user' ? 'user' : 'runtime' };
    case 'model.responded':
      return {
        ...base,
        type,
        ...(numberValue(value.durationMs) === undefined
          ? {}
          : { durationMs: numberValue(value.durationMs) }),
        ...(numberValue(value.inputTokens) === undefined
          ? {}
          : { inputTokens: numberValue(value.inputTokens) }),
        ...(numberValue(value.outputTokens) === undefined
          ? {}
          : { outputTokens: numberValue(value.outputTokens) }),
      };
    case 'model.retry':
      return { ...base, type };
    case 'tool.finished':
      return toolFact(base, type, value, true);
    case 'tool.failed':
    case 'tool.rejected':
    case 'tool.cancelled':
    case 'approval.rejected':
    case 'auto_review.completed':
      if (
        type === 'auto_review.completed' &&
        (!record(value.result)?.ok ||
          record(value.result)?.approved === true ||
          record(value.result)?.escalatedToUser === true)
      ) {
        return undefined;
      }
      return toolFact(base, type, value, false);
    case 'skill.activation_started':
      return { ...base, type };
    case 'skill.frame_closed':
      return {
        ...base,
        type,
        status: value.status === 'invalidated' ? 'invalidated' : 'closed',
      };
    case 'plan.drafted':
    case 'plan.completed':
      return { ...base, type };
    case 'verification.completed': {
      const outcome = stringValue(value.outcome);
      if (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'inconclusive') {
        return undefined;
      }
      return { ...base, type, outcome };
    }
    case 'verification.waived':
      return { ...base, type };
    case 'context.compaction_completed':
    case 'context.compaction_failed':
      return {
        ...base,
        type,
        ...(numberValue(value.durationMs) === undefined
          ? {}
          : { durationMs: numberValue(value.durationMs) }),
      };
    case 'context.hard_blocked':
    case 'context.compaction_reset':
    case 'context.hard_block_cleared':
    case 'runtime.action_ignored':
      return { ...base, type };
    case 'runtime.cancellation_diagnostic':
      return {
        ...base,
        type,
        unconfirmedDescendantCount: numberValue(value.unconfirmedDescendantCount) ?? 0,
      };
    case 'run.completed':
    case 'run.error': {
      const outcome = record(value.outcome);
      const status = stringValue(outcome?.status);
      const normalizedOutcome =
        status === 'failed' || status === 'cancelled' || status === 'unknown'
          ? status
          : status === 'completed'
            ? 'completed'
            : type === 'run.error'
              ? 'failed'
              : 'completed';
      const failure = record(value.failure);
      const failureKind = failureKindValue(failure?.kind);
      const reasonInput =
        stringValue(outcome?.reasonCode) ??
        stringValue(failure?.kind) ??
        (type === 'run.completed' && !outcome ? 'completed' : 'unknown');
      return {
        ...base,
        type,
        outcome: normalizedOutcome,
        reason: reasonValue(reasonInput),
        ...(failureKind ? { failureKind } : {}),
      };
    }
    case 'resource_budget.reconciled': {
      const actual = record(value.actual);
      const gauges = record(actual?.gauges);
      if (!gauges) return undefined;
      return {
        ...base,
        type,
        activeToolInvocations: numberValue(gauges.activeToolInvocations) ?? 0,
        activeShellInvocations: numberValue(gauges.activeShellInvocations) ?? 0,
      };
    }
    case 'resource_budget.waiter_timed_out':
      return { ...base, type };
    default:
      return undefined;
  }
}

export interface KernelObservabilityEventEnvelope {
  readonly payload: RuntimeEvent;
  readonly occurredAt: string;
}

function isEventEnvelopeInput(value: unknown): value is KernelObservabilityEventEnvelope {
  const candidate = record(value);
  return Boolean(
    candidate && typeof candidate.occurredAt === 'string' && isRuntimeEventShape(candidate.payload),
  );
}

function isRuntimeEventShape(value: unknown): value is RuntimeEvent {
  const candidate = record(value);
  const type = stringValue(candidate?.type);
  if (type === undefined || !Object.hasOwn(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS, type))
    return false;
  try {
    assertCurrentRuntimeEvent(value);
    return true;
  } catch {
    return false;
  }
}

function toolFact(
  base: {
    readonly schema: typeof OBSERVABILITY_RUNTIME_FACT_SCHEMA_;
    readonly observedAt: string;
  },
  type:
    | 'tool.finished'
    | 'tool.failed'
    | 'tool.rejected'
    | 'tool.cancelled'
    | 'approval.rejected'
    | 'auto_review.completed',
  value: Readonly<Record<string, unknown>>,
  includeCapabilityAlias: boolean,
): KernelObservabilityRuntimeFact | undefined {
  const outcome = value.outcome;
  if (!isToolOutcome(outcome)) return undefined;
  const failureKind = failureKindValue(outcome.failure?.kind);
  return {
    ...base,
    type,
    ...(includeCapabilityAlias && typeof value.name === 'string'
      ? { capabilityAlias: boundedAlias(value.name) }
      : {}),
    outcome: {
      status: toolOutcomeMetricStatus(outcome),
      ...(outcome.timing.totalActiveMs === undefined
        ? {}
        : { totalActiveMs: outcome.timing.totalActiveMs }),
      ...(failureKind ? { failureKind } : {}),
    },
  };
}

function failureKindValue(value: unknown): KernelObservabilityFailureKind | undefined {
  return typeof value === 'string' && FAILURE_KINDS.has(value)
    ? (value as KernelObservabilityFailureKind)
    : undefined;
}

function reasonValue(value: string | undefined): KernelObservabilityReason {
  if (!value) return 'unknown';
  if (value === 'completed') return 'completed';
  if (value.includes('model')) return 'model';
  if (value.includes('policy') || value.includes('approval') || value.includes('workspace')) {
    return 'policy';
  }
  if (value.includes('tool')) return 'tool';
  if (value.includes('provider') || value.includes('mcp') || value.includes('network')) {
    return 'provider';
  }
  if (value.includes('sandbox') || value.includes('worktree')) return 'sandbox';
  if (value.includes('budget')) return 'budget';
  if (value.includes('resource') || value.includes('process_limit')) return 'resource';
  if (value.includes('compaction')) return 'compaction';
  if (value.includes('verification')) return 'verification';
  if (value.includes('cancel')) return 'cancellation';
  if (
    value.includes('checkpoint') ||
    value.includes('transcript') ||
    value.includes('artifact') ||
    value.includes('profile') ||
    value.includes('digest') ||
    value.includes('persistence')
  ) {
    return 'runtime';
  }
  return 'unknown';
}

function boundedAlias(value: string): string | undefined {
  return /^[a-z0-9][a-z0-9._:-]{0,47}$/.test(value) ? value : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
