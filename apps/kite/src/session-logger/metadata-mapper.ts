import {
  runtimeHostStateCanonicalToolOutcome as canonicalToolOutcome,
  type StateRuntimeEvent as RuntimeEvent,
  type StateToolOutcome as ToolOutcome,
} from '@kite/runtime-host';
import type { MetadataEventRecord, MetadataFields, SessionMetadataContext } from './types';

const BUILTIN_TOOL_KINDS = new Set([
  'ask_user',
  'edit_file',
  'glob',
  'read_file',
  'read_mcp_resource',
  'request_plan_review',
  'search_content',
  'search_files',
  'shell_execute',
  'skill',
  'task',
  'update_plan',
  'write_file',
  'write_plan',
]);

const SAFE_LOW_CARDINALITY_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_RELEASE_VERSION = /^[0-9][0-9a-z.-]{0,31}$/;
const SAFE_RELEASE_PROFILES = new Set(['limited', 'internal', 'canary', 'ga']);

function safeIdentifier(value: string | undefined): string | undefined {
  return value && SAFE_LOW_CARDINALITY_IDENTIFIER.test(value) ? value : undefined;
}

function safeReleaseVersion(value: string | undefined): string | undefined {
  return value && SAFE_RELEASE_VERSION.test(value) ? value : undefined;
}

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Tool names are treated as untrusted. Built-ins retain their stable kind,
 * dynamic MCP tools collapse to one category, and everything else becomes
 * `other` so a malicious/provider-defined name cannot smuggle content.
 */
export function metadataToolKind(name: string): string {
  if (name.startsWith('mcp__')) return 'mcp_tool';
  return BUILTIN_TOOL_KINDS.has(name) ? name : 'other';
}

function statusForRuntimeEvent(event: RuntimeEvent): MetadataEventRecord['status'] {
  const outcomeStatus = (outcome: ToolOutcome): MetadataEventRecord['status'] => {
    switch (outcome.status) {
      case 'success':
        return 'ok';
      case 'cancelled':
        return 'cancelled';
      case 'unknown':
        return 'unknown';
      default:
        return 'error';
    }
  };
  switch (event.type) {
    case 'tool.finished':
    case 'tool.failed':
    case 'tool.rejected':
    case 'tool.retry_recorded':
    case 'tool.cancelled':
    case 'approval.rejected':
      return outcomeStatus(canonicalToolOutcome(event));
    case 'auto_review.completed':
      return event.result.ok && !event.result.approved && !event.result.escalatedToUser
        ? outcomeStatus(canonicalToolOutcome(event))
        : 'ok';
    case 'run.error':
    case 'context.compaction_failed':
    case 'context.hard_blocked':
    case 'subagent.failed':
    case 'provider.action_failed':
    case 'provider.admission_retry_failed':
      return 'error';
    case 'turn.aborted':
    case 'task.cancelled':
    case 'plan.review_cancelled':
    case 'user_input.cancelled':
    case 'provider.admission_cancelled':
    case 'resource_budget.waiter_cancelled':
      return 'cancelled';
    case 'resource_budget.unknown':
    case 'capability.execution_unknown':
      return 'unknown';
    case 'provider.action_required':
    case 'provider.admission_required':
    case 'subagent.suspended':
    case 'runtime.action_ignored':
      return 'blocked';
    case 'provider.admission_status':
      return event.status === 'ready' ? 'ok' : 'blocked';
    case 'runtime.cancellation_diagnostic':
      return 'error';
    case 'model.invocation_interrupted':
      if (event.dispatchCertainty === 'unknown') return 'unknown';
      if (event.reasonCode === 'cancelled' || event.reasonCode === 'cancelled_before_dispatch') {
        return 'cancelled';
      }
      return 'error';
    case 'model.invocation_evidence_unavailable':
      return 'unknown';
    default:
      return 'ok';
  }
}

function metadataForRuntimeEvent(event: RuntimeEvent): MetadataFields {
  const toolOutcomeMetadata = (outcome: ToolOutcome): MetadataFields => ({
    toolOutcomeStatus: outcome.status,
    ...(outcome.failure ? { toolOutcomeDetailCode: outcome.failure.detailCode } : {}),
    toolDispatchState: outcome.dispatchState,
    toolExternalEffects: outcome.externalEffects,
    toolRecoveryDisposition: outcome.recovery.disposition,
    ...(outcome.timing.queueMs != null ? { toolQueueMs: outcome.timing.queueMs } : {}),
    ...(outcome.timing.executionMs != null ? { toolExecutionMs: outcome.timing.executionMs } : {}),
    ...(outcome.timing.approvalWaitMs != null
      ? { toolApprovalWaitMs: outcome.timing.approvalWaitMs }
      : {}),
    ...(outcome.timing.totalActiveMs != null
      ? { toolTotalActiveMs: outcome.timing.totalActiveMs }
      : {}),
    ...(outcome.unknownFields
      ? {
          unknownFieldObserved: outcome.unknownFields.hasUnknown,
          unknownFieldCount: outcome.unknownFields.count,
          unknownFieldToolClass: outcome.unknownFields.toolClass,
        }
      : {}),
  });
  switch (event.type) {
    case 'tool.queued':
    case 'tool.finished':
      return {
        toolKind: metadataToolKind(event.name),
        ...(event.type === 'tool.finished' && event.result.toolTokenCount != null
          ? { outputTokens: event.result.toolTokenCount }
          : {}),
        ...(event.type === 'tool.finished' ? toolOutcomeMetadata(canonicalToolOutcome(event)) : {}),
      };
    case 'tool.failed':
      return {
        ...(event.failure ? { failureKind: event.failure.kind } : {}),
        ...toolOutcomeMetadata(canonicalToolOutcome(event)),
      };
    case 'tool.rejected':
      return {
        ...(event.failure ? { failureKind: event.failure.kind } : {}),
        ...toolOutcomeMetadata(canonicalToolOutcome(event)),
      };
    case 'tool.cancelled':
      return toolOutcomeMetadata(canonicalToolOutcome(event));
    case 'tool.retry_recorded':
      return {
        failureKind: event.failure.kind,
        retryAttempt: event.retryAttempt,
        retryMaxAttempts: 1,
        ...toolOutcomeMetadata(canonicalToolOutcome(event)),
      };
    case 'approval.requested':
      return {
        toolKind: metadataToolKind(event.approval.tool),
        approvalType: event.approval.risk,
      };
    case 'approval.granted':
      return { approvalType: 'tool', approvalResult: event.grant };
    case 'approval.rejected':
      return {
        approvalType: 'tool',
        approvalResult: 'rejected',
        ...(event.failure ? { failureKind: event.failure.kind } : {}),
        ...toolOutcomeMetadata(canonicalToolOutcome(event)),
      };
    case 'auto_review.requested':
      return {
        toolKind: metadataToolKind(event.toolName),
        approvalType: 'auto_review',
      };
    case 'auto_review.completed':
      return {
        approvalType: 'auto_review',
        approvalResult: event.result.approved
          ? 'approved'
          : event.result.ok && event.result.escalatedToUser
            ? 'escalated'
            : 'rejected',
        durationMs: event.result.durationMs,
        ...(event.result.ok && !event.result.approved && !event.result.escalatedToUser
          ? toolOutcomeMetadata(canonicalToolOutcome(event))
          : {}),
      };
    case 'verification.requested':
      return { verificationType: event.mode };
    case 'verification.started':
      return {
        verificationType: 'attempt',
        retryAttempt: event.attempt,
      };
    case 'verification.check_completed':
      return { verificationType: 'check', verificationResult: event.result.outcome };
    case 'verification.completed':
      return { verificationType: 'run', verificationResult: event.outcome };
    case 'verification.waived':
      return { verificationType: 'run', verificationResult: 'waived' };
    case 'verification.repair_requested':
      return {
        verificationType: 'repair',
        retryAttempt: event.repairAttempt,
      };
    case 'verification.replan_requested':
      return { verificationType: 'replan' };
    case 'verification.compensation_requested':
      return { verificationType: 'compensation' };
    case 'verification.compensation_completed':
      return {
        verificationType: 'compensation',
        verificationResult: event.outcome,
      };
    case 'context.compaction_requested':
      return { compactionInputTokensBefore: event.estimate.totalInputTokens };
    case 'context.compaction_completed':
      return {
        durationMs: event.durationMs,
        compactionInputTokensBefore: event.checkpoint.inputTokensBefore,
        compactionInputTokensAfter: event.checkpoint.inputTokensAfter,
      };
    case 'context.compaction_failed':
      return {
        durationMs: event.durationMs,
        compactionFailureKind: event.errorKind,
      };
    case 'model.responded':
      return {
        durationMs: event.durationMs,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
    case 'model.retry':
      return {
        durationMs: event.delayMs,
        retryAttempt: event.attempt,
        retryMaxAttempts: event.maxAttempts,
      };
    case 'model.cache_metrics':
      return {
        inputTokens: event.inputTokens,
        cacheHitTokens: event.cacheHitTokens,
        cacheMissTokens: event.cacheMissTokens,
      };
    case 'model.context_metrics':
      return { inputTokens: event.totalInputTokens };
    case 'run.error':
      return event.failure ? { failureKind: event.failure.kind } : {};
    case 'runtime.cancellation_diagnostic':
      return { failureKind: event.failure.kind };
    case 'provider.admission_status':
      return {
        capabilityKind: 'provider_admission',
        approvalResult: event.reason,
        ...(safeIdentifier(event.admissionRevision)
          ? { providerAdmissionRevision: safeIdentifier(event.admissionRevision) }
          : {}),
      };
    case 'provider.action_required':
      return { capabilityKind: 'mcp_provider', approvalType: event.action };
    case 'provider.action_completed':
      return { capabilityKind: 'mcp_provider', approvalResult: 'completed' };
    case 'provider.action_deferred':
      return { capabilityKind: 'mcp_provider', approvalResult: 'deferred' };
    case 'provider.action_failed':
      return {
        capabilityKind: 'mcp_provider',
        approvalResult: event.failureCode,
      };
    case 'provider.admission_required':
      return { capabilityKind: 'mcp_provider', approvalType: 'required' };
    case 'provider.admission_satisfied':
      return { capabilityKind: 'mcp_provider', approvalResult: 'satisfied' };
    case 'provider.admission_waived':
      return { capabilityKind: 'mcp_provider', approvalResult: 'waived' };
    case 'provider.admission_cancelled':
      return { capabilityKind: 'mcp_provider', approvalResult: 'cancelled' };
    case 'capability.invocation_recorded':
    case 'capability.execution_started':
    case 'capability.execution_result_recorded':
    case 'capability.execution_succeeded':
    case 'capability.execution_failed':
    case 'capability.execution_unknown':
    case 'capability.reconciliation_resolved':
      return { capabilityKind: 'runtime_capability' };
    case 'subagent.step':
    case 'subagent.tool_result':
      return { toolKind: metadataToolKind(event.subagent.toolName) };
    case 'subagent.completed':
    case 'subagent.failed':
      return { durationMs: event.subagent.durationMs };
    case 'subagent.cache_metrics':
      return {
        inputTokens: event.subagent.inputTokens,
        cacheHitTokens: event.subagent.cacheHitTokens,
        cacheMissTokens: event.subagent.cacheMissTokens,
      };
    default:
      return {};
  }
}

/**
 * Build a production record directly from typed Runtime fields. Do not replace
 * this with JSON serialization/scrubbing: omission is the security boundary.
 */
export function mapRuntimeMetadata(event: RuntimeEvent): MetadataEventRecord {
  return {
    schemaVersion: 1,
    eventType: event.type,
    timestamp: timestamp(),
    status: statusForRuntimeEvent(event),
    metadata: metadataForRuntimeEvent(event),
  };
}

export function mapSessionBoundaryMetadata(
  eventType: 'session.start' | 'session.end',
  status: MetadataEventRecord['status'],
  context: SessionMetadataContext = {},
): MetadataEventRecord {
  const releaseVersion = safeReleaseVersion(context.releaseVersion);
  const releaseCohort = safeIdentifier(context.releaseCohort);
  const releaseProfile = SAFE_RELEASE_PROFILES.has(context.releaseProfile ?? '')
    ? context.releaseProfile
    : undefined;
  return {
    schemaVersion: 1,
    eventType,
    timestamp: timestamp(),
    status,
    metadata: {
      ...(releaseVersion ? { releaseVersion } : {}),
      ...(releaseProfile ? { releaseProfile } : {}),
      ...(releaseCohort ? { releaseCohort } : {}),
    },
  };
}
