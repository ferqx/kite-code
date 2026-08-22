/**
 * Secret-free observation DTOs shared by the Kernel projection, Builtin
 * observability projector and App bridge.  These are deliberately not Runtime
 * Events: they contain no State, event envelope identity, receipt identity or
 * free-form content.
 */

export const OBSERVABILITY_METRIC_DRAFT_SCHEMA_V1 = 'kite.observability-metric-draft.v1' as const;

type ObservabilityRuntimeFactSchemaV1 = 'kite.observability-runtime-fact.v1';

export type ObservabilityToolStatusV1 =
  | 'success'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'timed_out'
  | 'exhausted'
  | 'unknown';

export type ObservabilityFailureKindV1 =
  | 'process_limit_exceeded'
  | 'cancel_incomplete'
  | 'resource_saturated';

export type ObservabilityReasonV1 =
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

export type ObservabilityMetricDraftAttributesV1 = Readonly<Record<string, string>>;

/** Host owns the metric-name allowlist and validates this draft at creation. */
export interface ObservabilityMetricDraftV1 {
  readonly schema: typeof OBSERVABILITY_METRIC_DRAFT_SCHEMA_V1;
  readonly name: string;
  readonly value?: number;
  readonly observedAt: string;
  readonly attributes?: ObservabilityMetricDraftAttributesV1;
}

interface ObservabilityFactBaseV1 {
  readonly schema: ObservabilityRuntimeFactSchemaV1;
  readonly observedAt: string;
}

export interface ObservabilityToolOutcomeFactV1 {
  readonly status: ObservabilityToolStatusV1;
  readonly totalActiveMs?: number;
  readonly failureKind?: ObservabilityFailureKindV1;
}

export type ObservabilityRuntimeFactV1 =
  | (ObservabilityFactBaseV1 & { readonly type: 'turn.completed' })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'turn.aborted';
      readonly cause: 'user' | 'runtime';
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'model.responded';
      readonly durationMs?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    })
  | (ObservabilityFactBaseV1 & { readonly type: 'model.retry' })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'tool.finished';
      readonly capabilityAlias?: string;
      readonly outcome: ObservabilityToolOutcomeFactV1;
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'tool.failed' | 'tool.rejected' | 'tool.cancelled';
      readonly outcome: ObservabilityToolOutcomeFactV1;
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'approval.rejected' | 'auto_review.completed';
      readonly outcome: ObservabilityToolOutcomeFactV1;
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'skill.activation_started';
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'skill.frame_closed';
      readonly status: 'closed' | 'invalidated';
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'plan.drafted' | 'plan.completed';
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'verification.completed';
      readonly outcome: 'passed' | 'failed' | 'inconclusive';
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'verification.waived';
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'context.compaction_completed' | 'context.compaction_failed';
      readonly durationMs?: number;
    })
  | (ObservabilityFactBaseV1 & { readonly type: 'context.hard_blocked' })
  | (ObservabilityFactBaseV1 & { readonly type: 'context.compaction_reset' })
  | (ObservabilityFactBaseV1 & { readonly type: 'context.hard_block_cleared' })
  | (ObservabilityFactBaseV1 & { readonly type: 'runtime.action_ignored' })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'runtime.cancellation_diagnostic';
      readonly unconfirmedDescendantCount: number;
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'run.completed' | 'run.error';
      readonly outcome: 'completed' | 'failed' | 'cancelled' | 'unknown';
      readonly reason: ObservabilityReasonV1;
      readonly failureKind?: ObservabilityFailureKindV1;
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'resource_budget.reconciled';
      readonly activeToolInvocations: number;
      readonly activeShellInvocations: number;
    })
  | (ObservabilityFactBaseV1 & {
      readonly type: 'resource_budget.waiter_timed_out';
    });

export interface ObservabilityFailureFactV1 {
  readonly kind: ObservabilityFailureKindV1;
}

export interface ObservabilityReceiptFactV1 {
  readonly status: 'recorded' | 'running' | 'succeeded' | 'failed' | 'unknown';
  readonly capabilityAlias?: string;
}

export interface ObservabilityModelFactV1 {
  readonly observedAt: string;
  readonly routeAlias?: string;
  readonly outcome: 'success' | 'failed' | 'retry' | 'timeout';
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ObservabilityResourceFactV1 {
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

export interface ObservabilityReleaseFactV1 {
  readonly observedAt: string;
  readonly profile: 'internal' | 'limited' | 'canary' | 'ga';
  readonly cohort: 'internal' | 'limited' | 'canary' | 'general' | 'unknown';
  readonly outcome: 'admitted' | 'blocked' | 'rolled_back';
}

export interface ObservabilityTaskStageFactV1 {
  readonly observedAt: string;
  readonly stage: 'checks' | 'human_accepted' | 'integrated' | 'reverted';
  readonly outcome: 'passed' | 'failed' | 'completed';
}
