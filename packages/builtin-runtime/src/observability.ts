import type {
  ObservabilityFailureFact,
  ObservabilityFailureKind,
  ObservabilityMetricDraft,
  ObservabilityModelFact,
  ObservabilityReceiptFact,
  ObservabilityReleaseFact,
  ObservabilityResourceFact,
  ObservabilityRuntimeFact,
  ObservabilityTaskStageFact,
  ObservabilityToolStatus,
} from '@kite-ai/runtime-contract';
import { OBSERVABILITY_METRIC_DRAFT_SCHEMA_ } from '@kite-ai/runtime-contract';

const SAFE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,47}$/;

/** Only release-controlled aliases can ever be emitted. Arbitrary names collapse. */
export class LowCardinalityAliasMapper {
  readonly #allowed: ReadonlySet<string>;
  readonly #retained: ReadonlySet<string>;

  constructor(allowedAliases: readonly string[], limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Alias limit must be positive.');
    for (const alias of allowedAliases) {
      if (!SAFE_ALIAS_PATTERN.test(alias)) throw new Error(`Unsafe controlled alias: ${alias}.`);
    }
    this.#allowed = new Set(allowedAliases);
    this.#retained = new Set(allowedAliases.slice(0, limit));
  }

  map(value: string | undefined): string {
    if (!value || !this.#allowed.has(value)) return 'custom/unknown';
    return this.#retained.has(value) ? value : 'other';
  }
}

export interface BuiltinObservabilityProjector {
  mapRuntimeFact(fact: ObservabilityRuntimeFact): readonly ObservabilityMetricDraft[];
  mapFailure(
    failure: ObservabilityFailureFact,
    observedAt: string,
  ): readonly ObservabilityMetricDraft[];
  mapExecutionReceipt(
    receipt: ObservabilityReceiptFact,
    observedAt: string,
  ): readonly ObservabilityMetricDraft[];
  mapModelObservation(input: ObservabilityModelFact): readonly ObservabilityMetricDraft[];
  mapAppResource(input: ObservabilityResourceFact): readonly ObservabilityMetricDraft[];
  mapReleaseProjection(input: ObservabilityReleaseFact): readonly ObservabilityMetricDraft[];
  mapAgentTaskStage(input: ObservabilityTaskStageFact): readonly ObservabilityMetricDraft[];
}

export function createBuiltinObservabilityProjector(
  input: {
    releaseRouteAliases?: readonly string[];
    modelVisibleCapabilityAliases?: readonly string[];
    routeCardinalityLimit?: number;
    capabilityCardinalityLimit?: number;
  } = {},
): BuiltinObservabilityProjector {
  const routes = new LowCardinalityAliasMapper(
    input.releaseRouteAliases ?? [],
    input.routeCardinalityLimit ?? 16,
  );
  const capabilities = new LowCardinalityAliasMapper(
    input.modelVisibleCapabilityAliases ?? [],
    input.capabilityCardinalityLimit ?? 32,
  );

  const projector: BuiltinObservabilityProjector = {
    mapRuntimeFact(fact) {
      switch (fact.type) {
        case 'turn.completed':
          return [draft('turn_total', fact.observedAt, { outcome: 'completed' })];
        case 'turn.aborted':
          return [
            draft('turn_total', fact.observedAt, {
              outcome: fact.cause === 'user' ? 'cancelled' : 'failed',
            }),
          ];
        case 'model.responded':
          return projector.mapModelObservation({
            observedAt: fact.observedAt,
            outcome: 'success',
            ...(fact.durationMs === undefined ? {} : { durationMs: fact.durationMs }),
            ...(fact.inputTokens === undefined ? {} : { inputTokens: fact.inputTokens }),
            ...(fact.outputTokens === undefined ? {} : { outputTokens: fact.outputTokens }),
          });
        case 'model.retry':
          return projector.mapModelObservation({ observedAt: fact.observedAt, outcome: 'retry' });
        case 'tool.finished':
          return toolSamples(
            fact.observedAt,
            fact.outcome.status,
            capabilities.map(fact.capabilityAlias),
            fact.outcome.totalActiveMs,
            fact.outcome.failureKind,
          );
        case 'tool.failed':
        case 'tool.rejected':
        case 'tool.cancelled':
        case 'approval.rejected':
        case 'auto_review.completed':
          return [
            ...toolSamples(
              fact.observedAt,
              fact.outcome.status,
              'custom/unknown',
              fact.outcome.totalActiveMs,
              fact.outcome.failureKind,
            ),
          ];
        case 'skill.activation_started':
          return [draft('skill_total', fact.observedAt, { outcome: 'started' })];
        case 'skill.frame_closed':
          return [draft('skill_total', fact.observedAt, { outcome: fact.status })];
        case 'plan.drafted':
          return [draft('plan_total', fact.observedAt, { outcome: 'drafted' })];
        case 'plan.completed':
          return [draft('plan_total', fact.observedAt, { outcome: 'completed' })];
        case 'verification.completed':
          return [draft('verification_total', fact.observedAt, { outcome: fact.outcome })];
        case 'verification.waived':
          return [draft('verification_total', fact.observedAt, { outcome: 'waived' })];
        case 'context.compaction_completed':
          return compactionSamples(fact.observedAt, 'completed', fact.durationMs);
        case 'context.compaction_failed':
          return compactionSamples(fact.observedAt, 'failed', fact.durationMs);
        case 'context.hard_blocked':
          return [draft('runtime_hard_block_total', fact.observedAt, { reason: 'runtime' })];
        case 'context.compaction_reset':
          return [
            draft('runtime_recovery_total', fact.observedAt, {
              source: 'checkpoint',
              outcome: 'reset',
            }),
          ];
        case 'context.hard_block_cleared':
          return [
            draft('runtime_recovery_total', fact.observedAt, {
              source: 'hard_block',
              outcome: 'cleared',
            }),
          ];
        case 'runtime.action_ignored':
          return [
            draft('runtime_late_terminal_rejection_total', fact.observedAt, {
              reason: 'late_or_stale_action',
            }),
          ];
        case 'runtime.cancellation_diagnostic':
          return [
            draft('runtime_cancel_incomplete_total', fact.observedAt, {
              reason: 'cancellation',
            }),
            ...(fact.unconfirmedDescendantCount > 0
              ? [
                  draft(
                    'runtime_orphan_total',
                    fact.observedAt,
                    {
                      resource: 'shell_descendant',
                    },
                    fact.unconfirmedDescendantCount,
                  ),
                ]
              : []),
          ];
        case 'run.completed':
        case 'run.error':
          return [
            draft('run_total', fact.observedAt, {
              outcome: fact.outcome,
              reason: fact.reason,
            }),
            ...(fact.failureKind
              ? projector.mapFailure({ kind: fact.failureKind }, fact.observedAt)
              : []),
          ];
        case 'resource_budget.reconciled':
          return [
            draft(
              'resource_active_invocations',
              fact.observedAt,
              { resource: 'tool' },
              fact.activeToolInvocations,
            ),
            draft(
              'resource_active_invocations',
              fact.observedAt,
              { resource: 'shell_invocation' },
              fact.activeShellInvocations,
            ),
          ];
        case 'resource_budget.waiter_timed_out':
          return [draft('concurrency_saturation_total', fact.observedAt, { resource: 'unknown' })];
      }
    },

    mapFailure(failure, observedAt) {
      switch (failure.kind) {
        case 'process_limit_exceeded':
          return [
            draft('process_tree_limit_termination_total', observedAt, { outcome: 'terminated' }),
          ];
        case 'cancel_incomplete':
          return [draft('runtime_cancel_incomplete_total', observedAt, { reason: 'cancellation' })];
        case 'resource_saturated':
          return [draft('concurrency_saturation_total', observedAt, { resource: 'unknown' })];
      }
    },

    mapExecutionReceipt(receipt, observedAt) {
      const outcome =
        receipt.status === 'succeeded'
          ? 'success'
          : receipt.status === 'running' || receipt.status === 'recorded'
            ? 'active'
            : receipt.status;
      return [
        draft('mcp_total', observedAt, {
          outcome,
          capability: capabilities.map(receipt.capabilityAlias),
        }),
      ];
    },

    mapModelObservation(input) {
      const route = routes.map(input.routeAlias);
      const samples: ObservabilityMetricDraft[] = [
        draft('model_request_total', input.observedAt, { outcome: input.outcome, route }),
      ];
      if (input.durationMs !== undefined) {
        samples.push(
          draft(
            'model_duration_ms',
            input.observedAt,
            { outcome: input.outcome, route },
            input.durationMs,
          ),
        );
      }
      if (input.inputTokens !== undefined) {
        samples.push(
          draft(
            'model_tokens_total',
            input.observedAt,
            { resource: 'input', route },
            input.inputTokens,
          ),
        );
      }
      if (input.outputTokens !== undefined) {
        samples.push(
          draft(
            'model_tokens_total',
            input.observedAt,
            { resource: 'output', route },
            input.outputTokens,
          ),
        );
      }
      return samples;
    },

    mapAppResource(input) {
      const samples: ObservabilityMetricDraft[] = [];
      const gauge = (
        name: 'resource_active_invocations' | 'resource_reserved_invocations',
        value: number | undefined,
        resource: string,
      ) => {
        if (value !== undefined) samples.push(draft(name, input.observedAt, { resource }, value));
      };
      gauge('resource_active_invocations', input.activeToolInvocations, 'tool');
      gauge('resource_active_invocations', input.activeShellInvocations, 'shell_invocation');
      gauge('resource_reserved_invocations', input.reservedToolInvocations, 'tool');
      gauge('resource_reserved_invocations', input.reservedShellInvocations, 'shell_invocation');
      if (input.processTreeHighWater !== undefined) {
        samples.push(
          draft('process_tree_high_water', input.observedAt, undefined, input.processTreeHighWater),
        );
      }
      if (input.processTreeLimitTerminated) {
        samples.push(
          draft('process_tree_limit_termination_total', input.observedAt, {
            outcome: 'terminated',
          }),
        );
      }
      if (input.readBatchSize !== undefined) {
        samples.push(draft('read_batch_size', input.observedAt, undefined, input.readBatchSize));
      }
      if (input.concurrencyWaitMs !== undefined) {
        samples.push(
          draft(
            'concurrency_wait_ms',
            input.observedAt,
            {
              resource: input.concurrencyResource ?? 'unknown',
              outcome: input.concurrencyOutcome ?? 'unknown',
            },
            input.concurrencyWaitMs,
          ),
        );
      }
      if (input.concurrencyOutcome === 'timed_out') {
        samples.push(
          draft('concurrency_saturation_total', input.observedAt, {
            resource: input.concurrencyResource ?? 'unknown',
          }),
        );
      }
      if (input.approvalSiblingOutcome) {
        samples.push(
          draft('approval_sibling_total', input.observedAt, {
            outcome: input.approvalSiblingOutcome,
          }),
        );
      }
      const directGauge = (
        name:
          | 'runtime_rss_bytes'
          | 'runtime_listener_count'
          | 'runtime_fd_count'
          | 'runtime_handle_count',
        value: number | undefined,
      ) => {
        if (value !== undefined) samples.push(draft(name, input.observedAt, undefined, value));
      };
      directGauge('runtime_rss_bytes', input.rssBytes);
      directGauge('runtime_listener_count', input.listenerCount);
      directGauge('runtime_fd_count', input.fileDescriptorCount);
      directGauge('runtime_handle_count', input.handleCount);
      if (input.eventLoopLagMs !== undefined) {
        samples.push(
          draft('runtime_event_loop_lag_ms', input.observedAt, undefined, input.eventLoopLagMs),
        );
      }
      if (input.artifactBytes !== undefined) {
        samples.push(
          draft(
            'artifact_bytes_total',
            input.observedAt,
            { source: 'runtime' },
            input.artifactBytes,
          ),
        );
      }
      if (input.sessionLogBytes !== undefined) {
        samples.push(
          draft(
            'session_log_bytes_total',
            input.observedAt,
            { source: 'session_logger' },
            input.sessionLogBytes,
          ),
        );
      }
      if (input.budgetExhaustedResource) {
        samples.push(
          draft('budget_exhausted_total', input.observedAt, {
            resource: input.budgetExhaustedResource,
          }),
        );
      }
      return samples;
    },

    mapReleaseProjection(input) {
      return [
        draft('release_rollout_total', input.observedAt, {
          profile: input.profile,
          cohort: input.cohort,
          outcome: input.outcome,
        }),
      ];
    },

    mapAgentTaskStage(input) {
      return [
        draft('agent_task_stage_total', input.observedAt, {
          stage: input.stage,
          outcome: input.outcome,
        }),
      ];
    },
  };
  return Object.freeze(projector);
}

function toolSamples(
  observedAt: string,
  outcome: ObservabilityToolStatus,
  capability: string,
  durationMs?: number,
  failureKind?: ObservabilityFailureKind,
): readonly ObservabilityMetricDraft[] {
  return [
    draft('tool_total', observedAt, { outcome, capability }),
    ...(durationMs === undefined
      ? []
      : [draft('tool_duration_ms', observedAt, { outcome, capability }, durationMs)]),
    ...(failureKind ? createFailureDrafts(failureKind, observedAt) : []),
  ];
}

function createFailureDrafts(
  failureKind: ObservabilityFailureKind,
  observedAt: string,
): readonly ObservabilityMetricDraft[] {
  switch (failureKind) {
    case 'process_limit_exceeded':
      return [draft('process_tree_limit_termination_total', observedAt, { outcome: 'terminated' })];
    case 'cancel_incomplete':
      return [draft('runtime_cancel_incomplete_total', observedAt, { reason: 'cancellation' })];
    case 'resource_saturated':
      return [draft('concurrency_saturation_total', observedAt, { resource: 'unknown' })];
    default:
      return [];
  }
}

function compactionSamples(
  observedAt: string,
  outcome: 'completed' | 'failed',
  durationMs?: number,
): readonly ObservabilityMetricDraft[] {
  return [
    draft('compaction_total', observedAt, {
      outcome,
      ...(outcome === 'failed' ? { reason: 'compaction' } : {}),
    }),
    ...(durationMs === undefined
      ? []
      : [draft('compaction_duration_ms', observedAt, { outcome }, durationMs)]),
  ];
}

function draft(
  name: string,
  observedAt: string,
  attributes?: Readonly<Record<string, string>>,
  value?: number,
): ObservabilityMetricDraft {
  return Object.freeze({
    schema: OBSERVABILITY_METRIC_DRAFT_SCHEMA_,
    name,
    ...(value === undefined ? {} : { value }),
    observedAt,
    ...(attributes ? { attributes: Object.freeze({ ...attributes }) } : {}),
  });
}
