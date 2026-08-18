import type { RuntimeEvent, RuntimeEventInput } from '@/core/runtime/events';
import { isRuntimeEventEnvelope } from '@/core/runtime/events';
import type { ClassifiedFailure } from '@/core/runtime/failures';
import { toolOutcomeMetricStatusV1 } from '@/core/runtime/tool-outcome';
import { canonicalToolOutcomeV1 } from '@/core/runtime/tool-outcome-events';
import type { ExecutionReceipt } from '@/protocol/capabilities';
import { createMetricSampleV1, type MetricSampleV1 } from './metrics';

const SAFE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,47}$/;

/** Only release-controlled aliases can ever be emitted. Arbitrary names collapse. */
export class LowCardinalityAliasMapperV1 {
  readonly #allowed: ReadonlySet<string>;
  readonly #retained = new Set<string>();

  constructor(allowedAliases: readonly string[], limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Alias limit must be positive.');
    for (const alias of allowedAliases) {
      if (!SAFE_ALIAS_PATTERN.test(alias)) throw new Error(`Unsafe controlled alias: ${alias}.`);
    }
    this.#allowed = new Set(allowedAliases);
    for (const alias of allowedAliases.slice(0, limit)) this.#retained.add(alias);
  }

  map(value: string | undefined): string {
    if (!value || !this.#allowed.has(value)) return 'custom/unknown';
    if (this.#retained.has(value)) return value;
    return 'other';
  }
}

export interface ModelMetricObservationV1 {
  observedAt: string;
  routeAlias?: string;
  outcome: 'success' | 'failed' | 'retry' | 'timeout';
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AppResourceObservationV1 {
  observedAt: string;
  activeToolInvocations?: number;
  activeShellInvocations?: number;
  reservedToolInvocations?: number;
  reservedShellInvocations?: number;
  processTreeHighWater?: number;
  processTreeLimitTerminated?: boolean;
  readBatchSize?: number;
  concurrencyWaitMs?: number;
  concurrencyResource?: 'tool' | 'shell_invocation';
  concurrencyOutcome?: 'admitted' | 'timed_out' | 'cancelled';
  approvalSiblingOutcome?: 'cancelled' | 'not_dispatched';
  rssBytes?: number;
  eventLoopLagMs?: number;
  listenerCount?: number;
  fileDescriptorCount?: number;
  handleCount?: number;
  artifactBytes?: number;
  sessionLogBytes?: number;
  budgetExhaustedResource?:
    | 'run_duration'
    | 'turn'
    | 'model_request'
    | 'tool'
    | 'token'
    | 'artifact';
}

export interface ReleaseMetricProjectionV1 {
  observedAt: string;
  profile: 'internal' | 'limited' | 'canary' | 'ga';
  cohort: 'internal' | 'limited' | 'canary' | 'general' | 'unknown';
  outcome: 'admitted' | 'blocked' | 'rolled_back';
}

export interface AgentTaskStageObservationV1 {
  observedAt: string;
  stage: 'checks' | 'human_accepted' | 'integrated' | 'reverted';
  outcome: 'passed' | 'failed' | 'completed';
}

export class ProductionMetricMapperV1 {
  readonly #routes: LowCardinalityAliasMapperV1;
  readonly #capabilities: LowCardinalityAliasMapperV1;

  constructor(
    input: {
      releaseRouteAliases?: readonly string[];
      modelVisibleCapabilityAliases?: readonly string[];
      routeCardinalityLimit?: number;
      capabilityCardinalityLimit?: number;
    } = {},
  ) {
    this.#routes = new LowCardinalityAliasMapperV1(
      input.releaseRouteAliases ?? [],
      input.routeCardinalityLimit ?? 16,
    );
    this.#capabilities = new LowCardinalityAliasMapperV1(
      input.modelVisibleCapabilityAliases ?? [],
      input.capabilityCardinalityLimit ?? 32,
    );
  }

  mapRuntimeEvent(input: RuntimeEventInput, fallbackObservedAt: string): MetricSampleV1[] {
    const event = isRuntimeEventEnvelope(input) ? input.payload : input;
    const observedAt = isRuntimeEventEnvelope(input) ? input.occurredAt : fallbackObservedAt;
    return this.#mapRuntimePayload(event, observedAt);
  }

  mapFailure(failure: ClassifiedFailure, observedAt: string): MetricSampleV1[] {
    switch (failure.kind) {
      case 'process_limit_exceeded':
        return [
          createMetricSampleV1({
            name: 'process_tree_limit_termination_total',
            observedAt,
            attributes: { outcome: 'terminated' },
          }),
        ];
      case 'cancel_incomplete':
        return [
          createMetricSampleV1({
            name: 'runtime_cancel_incomplete_total',
            observedAt,
            attributes: { reason: 'cancellation' },
          }),
        ];
      case 'resource_saturated':
        return [
          createMetricSampleV1({
            name: 'concurrency_saturation_total',
            observedAt,
            attributes: { resource: 'unknown' },
          }),
        ];
      default:
        return [];
    }
  }

  mapExecutionReceipt(receipt: ExecutionReceipt, observedAt: string): MetricSampleV1[] {
    const outcome =
      receipt.status === 'succeeded'
        ? 'success'
        : receipt.status === 'running' || receipt.status === 'recorded'
          ? 'active'
          : receipt.status;
    return [
      createMetricSampleV1({
        name: 'mcp_total',
        observedAt,
        attributes: {
          outcome,
          capability: this.#capabilities.map(receipt.capabilityId),
        },
      }),
    ];
  }

  mapModelObservation(input: ModelMetricObservationV1): MetricSampleV1[] {
    const route = this.#routes.map(input.routeAlias);
    const samples = [
      createMetricSampleV1({
        name: 'model_request_total',
        observedAt: input.observedAt,
        attributes: { outcome: input.outcome, route },
      }),
    ];
    if (input.durationMs !== undefined) {
      samples.push(
        createMetricSampleV1({
          name: 'model_duration_ms',
          value: input.durationMs,
          observedAt: input.observedAt,
          attributes: { outcome: input.outcome, route },
        }),
      );
    }
    if (input.inputTokens !== undefined) {
      samples.push(
        createMetricSampleV1({
          name: 'model_tokens_total',
          value: input.inputTokens,
          observedAt: input.observedAt,
          attributes: { resource: 'input', route },
        }),
      );
    }
    if (input.outputTokens !== undefined) {
      samples.push(
        createMetricSampleV1({
          name: 'model_tokens_total',
          value: input.outputTokens,
          observedAt: input.observedAt,
          attributes: { resource: 'output', route },
        }),
      );
    }
    return samples;
  }

  mapAppResource(input: AppResourceObservationV1): MetricSampleV1[] {
    const samples: MetricSampleV1[] = [];
    const gauge = (
      name: 'resource_active_invocations' | 'resource_reserved_invocations',
      value: number | undefined,
      resource: string,
    ) => {
      if (value !== undefined)
        samples.push(
          createMetricSampleV1({
            name,
            value,
            observedAt: input.observedAt,
            attributes: { resource },
          }),
        );
    };
    gauge('resource_active_invocations', input.activeToolInvocations, 'tool');
    gauge('resource_active_invocations', input.activeShellInvocations, 'shell_invocation');
    gauge('resource_reserved_invocations', input.reservedToolInvocations, 'tool');
    gauge('resource_reserved_invocations', input.reservedShellInvocations, 'shell_invocation');
    if (input.processTreeHighWater !== undefined)
      samples.push(
        createMetricSampleV1({
          name: 'process_tree_high_water',
          value: input.processTreeHighWater,
          observedAt: input.observedAt,
        }),
      );
    if (input.processTreeLimitTerminated)
      samples.push(
        createMetricSampleV1({
          name: 'process_tree_limit_termination_total',
          observedAt: input.observedAt,
          attributes: { outcome: 'terminated' },
        }),
      );
    if (input.readBatchSize !== undefined)
      samples.push(
        createMetricSampleV1({
          name: 'read_batch_size',
          value: input.readBatchSize,
          observedAt: input.observedAt,
        }),
      );
    if (input.concurrencyWaitMs !== undefined)
      samples.push(
        createMetricSampleV1({
          name: 'concurrency_wait_ms',
          value: input.concurrencyWaitMs,
          observedAt: input.observedAt,
          attributes: {
            resource: input.concurrencyResource ?? 'unknown',
            outcome: input.concurrencyOutcome ?? 'unknown',
          },
        }),
      );
    if (input.concurrencyOutcome === 'timed_out')
      samples.push(
        createMetricSampleV1({
          name: 'concurrency_saturation_total',
          observedAt: input.observedAt,
          attributes: { resource: input.concurrencyResource ?? 'unknown' },
        }),
      );
    if (input.approvalSiblingOutcome)
      samples.push(
        createMetricSampleV1({
          name: 'approval_sibling_total',
          observedAt: input.observedAt,
          attributes: { outcome: input.approvalSiblingOutcome },
        }),
      );
    const directGauge = (
      name:
        | 'runtime_rss_bytes'
        | 'runtime_listener_count'
        | 'runtime_fd_count'
        | 'runtime_handle_count',
      value: number | undefined,
    ) => {
      if (value !== undefined) {
        samples.push(createMetricSampleV1({ name, value, observedAt: input.observedAt }));
      }
    };
    directGauge('runtime_rss_bytes', input.rssBytes);
    directGauge('runtime_listener_count', input.listenerCount);
    directGauge('runtime_fd_count', input.fileDescriptorCount);
    directGauge('runtime_handle_count', input.handleCount);
    if (input.eventLoopLagMs !== undefined) {
      samples.push(
        createMetricSampleV1({
          name: 'runtime_event_loop_lag_ms',
          value: input.eventLoopLagMs,
          observedAt: input.observedAt,
        }),
      );
    }
    if (input.artifactBytes !== undefined) {
      samples.push(
        createMetricSampleV1({
          name: 'artifact_bytes_total',
          value: input.artifactBytes,
          observedAt: input.observedAt,
          attributes: { source: 'runtime' },
        }),
      );
    }
    if (input.sessionLogBytes !== undefined) {
      samples.push(
        createMetricSampleV1({
          name: 'session_log_bytes_total',
          value: input.sessionLogBytes,
          observedAt: input.observedAt,
          attributes: { source: 'session_logger' },
        }),
      );
    }
    if (input.budgetExhaustedResource) {
      samples.push(
        createMetricSampleV1({
          name: 'budget_exhausted_total',
          observedAt: input.observedAt,
          attributes: { resource: input.budgetExhaustedResource },
        }),
      );
    }
    return samples;
  }

  mapReleaseProjection(input: ReleaseMetricProjectionV1): MetricSampleV1[] {
    return [
      createMetricSampleV1({
        name: 'release_rollout_total',
        observedAt: input.observedAt,
        attributes: { profile: input.profile, cohort: input.cohort, outcome: input.outcome },
      }),
    ];
  }

  mapAgentTaskStage(input: AgentTaskStageObservationV1): MetricSampleV1[] {
    return [
      createMetricSampleV1({
        name: 'agent_task_stage_total',
        observedAt: input.observedAt,
        attributes: { stage: input.stage, outcome: input.outcome },
      }),
    ];
  }

  #mapRuntimePayload(event: RuntimeEvent, observedAt: string): MetricSampleV1[] {
    switch (event.type) {
      case 'turn.completed':
        return [
          createMetricSampleV1({
            name: 'turn_total',
            observedAt,
            attributes: { outcome: 'completed' },
          }),
        ];
      case 'turn.aborted':
        return [
          createMetricSampleV1({
            name: 'turn_total',
            observedAt,
            attributes: { outcome: event.cause === 'user' ? 'cancelled' : 'failed' },
          }),
        ];
      case 'model.responded':
        return this.mapModelObservation({
          observedAt,
          outcome: 'success',
          durationMs: event.durationMs,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        });
      case 'model.retry':
        return this.mapModelObservation({ observedAt, outcome: 'retry' });
      case 'tool.finished': {
        const outcomeV1 = canonicalToolOutcomeV1(event);
        return [
          createMetricSampleV1({
            name: 'tool_total',
            observedAt,
            attributes: {
              outcome: toolOutcomeMetricStatusV1(outcomeV1),
              capability: this.#capabilities.map(event.name),
            },
          }),
          ...(outcomeV1.timing.totalActiveMs != null
            ? [
                createMetricSampleV1({
                  name: 'tool_duration_ms',
                  value: outcomeV1.timing.totalActiveMs,
                  observedAt,
                  attributes: {
                    outcome: toolOutcomeMetricStatusV1(outcomeV1),
                    capability: this.#capabilities.map(event.name),
                  },
                }),
              ]
            : []),
        ];
      }
      case 'tool.failed': {
        const outcomeV1 = canonicalToolOutcomeV1(event);
        return [
          createMetricSampleV1({
            name: 'tool_total',
            observedAt,
            attributes: {
              outcome: toolOutcomeMetricStatusV1(outcomeV1),
              capability: 'custom/unknown',
            },
          }),
          ...(outcomeV1.timing.totalActiveMs != null
            ? [
                createMetricSampleV1({
                  name: 'tool_duration_ms',
                  value: outcomeV1.timing.totalActiveMs,
                  observedAt,
                  attributes: {
                    outcome: toolOutcomeMetricStatusV1(outcomeV1),
                    capability: 'custom/unknown',
                  },
                }),
              ]
            : []),
          ...(event.failure ? this.mapFailure(event.failure, observedAt) : []),
        ];
      }
      case 'tool.rejected': {
        const outcomeV1 = canonicalToolOutcomeV1(event);
        return [
          createMetricSampleV1({
            name: 'tool_total',
            observedAt,
            attributes: {
              outcome: toolOutcomeMetricStatusV1(outcomeV1),
              capability: 'custom/unknown',
            },
          }),
          ...(outcomeV1.timing.totalActiveMs != null
            ? [
                createMetricSampleV1({
                  name: 'tool_duration_ms',
                  value: outcomeV1.timing.totalActiveMs,
                  observedAt,
                  attributes: {
                    outcome: toolOutcomeMetricStatusV1(outcomeV1),
                    capability: 'custom/unknown',
                  },
                }),
              ]
            : []),
          ...(event.failure ? this.mapFailure(event.failure, observedAt) : []),
        ];
      }
      case 'tool.cancelled': {
        const outcomeV1 = canonicalToolOutcomeV1(event);
        return [
          createMetricSampleV1({
            name: 'tool_total',
            observedAt,
            attributes: {
              outcome: toolOutcomeMetricStatusV1(outcomeV1),
              capability: 'custom/unknown',
            },
          }),
          ...(outcomeV1.timing.totalActiveMs != null
            ? [
                createMetricSampleV1({
                  name: 'tool_duration_ms',
                  value: outcomeV1.timing.totalActiveMs,
                  observedAt,
                  attributes: {
                    outcome: toolOutcomeMetricStatusV1(outcomeV1),
                    capability: 'custom/unknown',
                  },
                }),
              ]
            : []),
        ];
      }
      case 'approval.rejected':
      case 'auto_review.completed': {
        if (
          event.type === 'auto_review.completed' &&
          (!event.result.ok || event.result.approved || event.result.escalatedToUser)
        ) {
          return [];
        }
        const outcomeV1 = canonicalToolOutcomeV1(event);
        const outcome = toolOutcomeMetricStatusV1(outcomeV1);
        return [
          createMetricSampleV1({
            name: 'tool_total',
            observedAt,
            attributes: { outcome, capability: 'custom/unknown' },
          }),
          ...(outcomeV1.timing.totalActiveMs != null
            ? [
                createMetricSampleV1({
                  name: 'tool_duration_ms',
                  value: outcomeV1.timing.totalActiveMs,
                  observedAt,
                  attributes: { outcome, capability: 'custom/unknown' },
                }),
              ]
            : []),
        ];
      }
      case 'skill.activation_started':
        return [
          createMetricSampleV1({
            name: 'skill_total',
            observedAt,
            attributes: { outcome: 'started' },
          }),
        ];
      case 'skill.frame_closed':
        return [
          createMetricSampleV1({
            name: 'skill_total',
            observedAt,
            attributes: { outcome: event.status },
          }),
        ];
      case 'plan.drafted':
        return [
          createMetricSampleV1({
            name: 'plan_total',
            observedAt,
            attributes: { outcome: 'drafted' },
          }),
        ];
      case 'plan.completed':
        return [
          createMetricSampleV1({
            name: 'plan_total',
            observedAt,
            attributes: { outcome: 'completed' },
          }),
        ];
      case 'verification.completed':
        return [
          createMetricSampleV1({
            name: 'verification_total',
            observedAt,
            attributes: { outcome: event.outcome },
          }),
        ];
      case 'verification.waived':
        return [
          createMetricSampleV1({
            name: 'verification_total',
            observedAt,
            attributes: { outcome: 'waived' },
          }),
        ];
      case 'context.compaction_completed':
        return [
          createMetricSampleV1({
            name: 'compaction_total',
            observedAt,
            attributes: { outcome: 'completed' },
          }),
          ...(event.durationMs === undefined
            ? []
            : [
                createMetricSampleV1({
                  name: 'compaction_duration_ms',
                  value: event.durationMs,
                  observedAt,
                  attributes: { outcome: 'completed' },
                }),
              ]),
        ];
      case 'context.compaction_failed':
        return [
          createMetricSampleV1({
            name: 'compaction_total',
            observedAt,
            attributes: { outcome: 'failed', reason: 'compaction' },
          }),
          ...(event.durationMs === undefined
            ? []
            : [
                createMetricSampleV1({
                  name: 'compaction_duration_ms',
                  value: event.durationMs,
                  observedAt,
                  attributes: { outcome: 'failed' },
                }),
              ]),
        ];
      case 'context.hard_blocked':
        return [
          createMetricSampleV1({
            name: 'runtime_hard_block_total',
            observedAt,
            attributes: { reason: 'runtime' },
          }),
        ];
      case 'context.compaction_reset':
        return [
          createMetricSampleV1({
            name: 'runtime_recovery_total',
            observedAt,
            attributes: { source: 'checkpoint', outcome: 'reset' },
          }),
        ];
      case 'context.hard_block_cleared':
        return [
          createMetricSampleV1({
            name: 'runtime_recovery_total',
            observedAt,
            attributes: { source: 'hard_block', outcome: 'cleared' },
          }),
        ];
      case 'runtime.action_ignored':
        return [
          createMetricSampleV1({
            name: 'runtime_late_terminal_rejection_total',
            observedAt,
            attributes: { reason: 'late_or_stale_action' },
          }),
        ];
      case 'runtime.cancellation_diagnostic':
        return [
          createMetricSampleV1({
            name: 'runtime_cancel_incomplete_total',
            observedAt,
            attributes: { reason: 'cancellation' },
          }),
          ...(event.unconfirmedDescendantCount > 0
            ? [
                createMetricSampleV1({
                  name: 'runtime_orphan_total',
                  value: event.unconfirmedDescendantCount,
                  observedAt,
                  attributes: { resource: 'shell_descendant' },
                }),
              ]
            : []),
        ];
      case 'run.completed':
        return [
          createMetricSampleV1({
            name: 'run_total',
            observedAt,
            attributes: {
              outcome: event.outcome?.status ?? 'completed',
              reason: event.outcome ? lowCardinalityReason(event.outcome.reasonCode) : 'completed',
            },
          }),
        ];
      case 'run.error':
        return [
          createMetricSampleV1({
            name: 'run_total',
            observedAt,
            attributes: {
              outcome: event.outcome?.status ?? 'failed',
              reason: lowCardinalityReason(
                event.outcome?.reasonCode ?? event.failure?.kind ?? 'unknown',
              ),
            },
          }),
          ...(event.failure ? this.mapFailure(event.failure, observedAt) : []),
        ];
      case 'resource_budget.reconciled':
        return [
          createMetricSampleV1({
            name: 'resource_active_invocations',
            value: event.actual.gauges.activeToolInvocations,
            observedAt,
            attributes: { resource: 'tool' },
          }),
          createMetricSampleV1({
            name: 'resource_active_invocations',
            value: event.actual.gauges.activeShellInvocations,
            observedAt,
            attributes: { resource: 'shell_invocation' },
          }),
        ];
      case 'resource_budget.waiter_timed_out':
        return [
          createMetricSampleV1({
            name: 'concurrency_saturation_total',
            observedAt,
            attributes: { resource: 'unknown' },
          }),
        ];

      case 'resource_budget.configured':
      case 'resource_budget.reserved':
      case 'resource_budget.dispatch_started':
      case 'resource_budget.released':
      case 'resource_budget.unknown':
      case 'resource_budget.waiter_enqueued':
      case 'resource_budget.waiter_promoted':
      case 'resource_budget.waiter_cancelled':
      case 'context.compaction_requested':
      case 'capability.bindings_issued':
      case 'capability.search_completed':
      case 'skill.catalog_refreshed':
      case 'capability.invocation_recorded':
      case 'capability.execution_started':
      case 'capability.execution_result_recorded':
      case 'capability.execution_succeeded':
      case 'capability.execution_failed':
      case 'capability.execution_unknown':
      case 'capability.reconciliation_resolved':
      case 'verification.requested':
      case 'verification.started':
      case 'verification.check_completed':
      case 'verification.repair_requested':
      case 'verification.replan_requested':
      case 'verification.compensation_requested':
      case 'verification.compensation_completed':
      case 'tool.queued':
      case 'tool.started':
      case 'tool.progress':
      case 'network.admission_decided':
      case 'mcp.egress_decided':
      case 'user_input.requested':
      case 'user_input.answered':
      case 'plan.review_requested':
      case 'plan.approved':
      case 'plan.revision_requested':
      case 'plan.review_cancelled':
      case 'plan.replan_requested':
      case 'task.started':
      case 'planning.entered':
      case 'planning.exited':
      case 'task.completed':
      case 'task.cancelled':
      case 'approval.requested':
      case 'approval.granted':
      case 'provider.action_required':
      case 'provider.action_started':
      case 'provider.action_completed':
      case 'provider.action_deferred':
      case 'provider.action_failed':
      case 'provider.admission_required':
      case 'provider.admission_retry_requested':
      case 'provider.admission_retry_failed':
      case 'provider.admission_satisfied':
      case 'provider.admission_waived':
      case 'provider.admission_cancelled':
      case 'authorization.changed':
      case 'interaction_mode.changed':
      case 'auto_review.requested':
      case 'user_input.cancelled':
      case 'turn.started':
      case 'user.message_appended':
      case 'user.command_invoked':
      case 'model.requested':
      case 'model.invocation_prepared':
      case 'model.invocation_attempt_started':
      case 'model.invocation_completed':
      case 'model.invocation_interrupted':
      case 'model.invocation_evidence_unavailable':
      case 'provider.readiness_intent_recorded':
      case 'provider.readiness_waiter_registered':
      case 'provider.readiness_attempt_started':
      case 'provider.readiness_succeeded':
      case 'provider.readiness_failed':
      case 'capability.filesystem_intent_recorded':
      case 'capability.filesystem_mutation_ready':
      case 'capability.sandbox_preparation_intent_recorded':
      case 'capability.sandbox_preparation_ready':
      case 'capability.sandbox_execution_dispatch_intent_recorded':
      case 'capability.sandbox_execution_supervisor_started':
      case 'capability.sandbox_disposal_started':
      case 'capability.sandbox_disposal_completed':
      case 'capability.sandbox_preparation_abandonment_started':
      case 'capability.sandbox_preparation_abandonment_completed':
      case 'capability.subagent_dispatch_intent_recorded':
      case 'capability.subagent_handle_recorded':
      case 'capability.subagent_observation_recorded':
      case 'capability.subagent_cleanup_started':
      case 'capability.subagent_cleanup_completed':
      case 'model.reasoning_delta':
      case 'model.reasoning_completed':
      case 'model.text_delta':
      case 'model.cache_metrics':
      case 'model.context_metrics':
      case 'provider.data_policy_status':
      case 'completion.blocked':
      case 'plan.progress_updated':
      case 'approval.command_replaced':
      case 'tool.file_change':
      case 'tool.retry_recorded':
      case 'subagent.started':
      case 'subagent.step':
      case 'subagent.tool_result':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.cache_metrics':
      case 'subagent.suspended':
      case 'subagent.approval_deferred':
      case 'subagent.recovery_journal_merged':
        return [];
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }
}

function lowCardinalityReason(value: string): string {
  if (value === 'completed') return 'completed';
  if (value.includes('model')) return 'model';
  if (value.includes('policy') || value.includes('approval') || value.includes('workspace'))
    return 'policy';
  if (value.includes('tool')) return 'tool';
  if (value.includes('provider') || value.includes('mcp') || value.includes('network'))
    return 'provider';
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
  )
    return 'runtime';
  return 'unknown';
}
