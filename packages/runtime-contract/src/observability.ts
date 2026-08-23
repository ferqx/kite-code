/**
 * Secret-free observation DTOs shared by the Kernel projection, Builtin
 * observability projector and App bridge.  These are deliberately not Runtime
 * Events: they contain no State, event envelope identity, receipt identity or
 * free-form content.
 */

export const OBSERVABILITY_METRIC_DRAFT_SCHEMA_ = 'kite.observability-metric-draft.v1' as const;

type ObservabilityRuntimeFactSchema = 'kite.observability-runtime-fact.v1';

export type ObservabilityToolStatus =
  | 'success'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'timed_out'
  | 'exhausted'
  | 'unknown';

export type ObservabilityFailureKind =
  | 'process_limit_exceeded'
  | 'cancel_incomplete'
  | 'resource_saturated';

export type ObservabilityReason =
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

export type ObservabilityMetricDraftAttributes = Readonly<Record<string, string>>;

/** Host owns the metric-name allowlist and validates this draft at creation. */
export interface ObservabilityMetricDraft {
  readonly schema: typeof OBSERVABILITY_METRIC_DRAFT_SCHEMA_;
  readonly name: string;
  readonly value?: number;
  readonly observedAt: string;
  readonly attributes?: ObservabilityMetricDraftAttributes;
}

interface ObservabilityFactBase {
  readonly schema: ObservabilityRuntimeFactSchema;
  readonly observedAt: string;
}

export interface ObservabilityToolOutcomeFact {
  readonly status: ObservabilityToolStatus;
  readonly totalActiveMs?: number;
  readonly failureKind?: ObservabilityFailureKind;
}

export type ObservabilityRuntimeFact =
  | (ObservabilityFactBase & { readonly type: 'turn.completed' })
  | (ObservabilityFactBase & {
      readonly type: 'turn.aborted';
      readonly cause: 'user' | 'runtime';
    })
  | (ObservabilityFactBase & {
      readonly type: 'model.responded';
      readonly durationMs?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    })
  | (ObservabilityFactBase & { readonly type: 'model.retry' })
  | (ObservabilityFactBase & {
      readonly type: 'tool.finished';
      readonly capabilityAlias?: string;
      readonly outcome: ObservabilityToolOutcomeFact;
    })
  | (ObservabilityFactBase & {
      readonly type: 'tool.failed' | 'tool.rejected' | 'tool.cancelled';
      readonly outcome: ObservabilityToolOutcomeFact;
    })
  | (ObservabilityFactBase & {
      readonly type: 'approval.rejected' | 'auto_review.completed';
      readonly outcome: ObservabilityToolOutcomeFact;
    })
  | (ObservabilityFactBase & {
      readonly type: 'skill.activation_started';
    })
  | (ObservabilityFactBase & {
      readonly type: 'skill.frame_closed';
      readonly status: 'closed' | 'invalidated';
    })
  | (ObservabilityFactBase & {
      readonly type: 'plan.drafted' | 'plan.completed';
    })
  | (ObservabilityFactBase & {
      readonly type: 'verification.completed';
      readonly outcome: 'passed' | 'failed' | 'inconclusive';
    })
  | (ObservabilityFactBase & {
      readonly type: 'verification.waived';
    })
  | (ObservabilityFactBase & {
      readonly type: 'context.compaction_completed' | 'context.compaction_failed';
      readonly durationMs?: number;
    })
  | (ObservabilityFactBase & { readonly type: 'context.hard_blocked' })
  | (ObservabilityFactBase & { readonly type: 'context.compaction_reset' })
  | (ObservabilityFactBase & { readonly type: 'context.hard_block_cleared' })
  | (ObservabilityFactBase & { readonly type: 'runtime.action_ignored' })
  | (ObservabilityFactBase & {
      readonly type: 'runtime.cancellation_diagnostic';
      readonly unconfirmedDescendantCount: number;
    })
  | (ObservabilityFactBase & {
      readonly type: 'run.completed' | 'run.error';
      readonly outcome: 'completed' | 'failed' | 'cancelled' | 'unknown';
      readonly reason: ObservabilityReason;
      readonly failureKind?: ObservabilityFailureKind;
    })
  | (ObservabilityFactBase & {
      readonly type: 'resource_budget.reconciled';
      readonly activeToolInvocations: number;
      readonly activeShellInvocations: number;
    })
  | (ObservabilityFactBase & {
      readonly type: 'resource_budget.waiter_timed_out';
    });

export interface ObservabilityFailureFact {
  readonly kind: ObservabilityFailureKind;
}

export interface ObservabilityReceiptFact {
  readonly status: 'recorded' | 'running' | 'succeeded' | 'failed' | 'unknown';
  readonly capabilityAlias?: string;
}

export interface ObservabilityModelFact {
  readonly observedAt: string;
  readonly routeAlias?: string;
  readonly outcome: 'success' | 'failed' | 'retry' | 'timeout';
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ObservabilityResourceFact {
  readonly observedAt: string;
  readonly activeToolInvocations?: number;
  readonly activeShellInvocations?: number;
  readonly reservedToolInvocations?: number;
  readonly reservedShellInvocations?: number;
  readonly processTreeHighWater?: number;
  readonly processTreeLimitTerminated?: boolean;
  readonly readBatchSize?: number;
  readonly concurrencyWaitMs?: number;
  readonly concurrencyResource?: 'tool' | 'shell_invocation';
  readonly concurrencyOutcome?: 'admitted' | 'timed_out' | 'cancelled';
  readonly approvalSiblingOutcome?: 'cancelled' | 'not_dispatched';
  readonly rssBytes?: number;
  readonly eventLoopLagMs?: number;
  readonly listenerCount?: number;
  readonly fileDescriptorCount?: number;
  readonly handleCount?: number;
  readonly artifactBytes?: number;
  readonly sessionLogBytes?: number;
  readonly budgetExhaustedResource?:
    | 'run_duration'
    | 'turn'
    | 'model_request'
    | 'tool'
    | 'token'
    | 'artifact';
}

export interface ObservabilityReleaseFact {
  readonly observedAt: string;
  readonly profile: 'internal' | 'limited' | 'canary' | 'ga';
  readonly cohort: 'internal' | 'limited' | 'canary' | 'general' | 'unknown';
  readonly outcome: 'admitted' | 'blocked' | 'rolled_back';
}

export interface ObservabilityTaskStageFact {
  readonly observedAt: string;
  readonly stage: 'checks' | 'human_accepted' | 'integrated' | 'reverted';
  readonly outcome: 'passed' | 'failed' | 'completed';
}
