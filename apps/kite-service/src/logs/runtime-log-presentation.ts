import type {
  RuntimeLogEventDetail,
  RuntimeLogEventEntry,
  RuntimeLogEventPage,
} from '@kite-ai/runtime-contract';
import {
  type StateRuntimeEvent as RuntimeEvent,
  runtimeHostStateAssertReadableRuntimeEvent,
} from '@kite-ai/runtime-host';
import type { RuntimeLogEventReadPage, RuntimeLogEventRecord } from '@kite-ai/runtime-host/storage';
import { projectRuntimeClientText as safeText } from '../runtime-client/safe-text';

function stringField(event: RuntimeEvent, key: string): string | undefined {
  const value = (event as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? safeText(value) : undefined;
}

function categoryFor(type: RuntimeEvent['type']): RuntimeLogEventEntry['category'] {
  if (type.startsWith('user.') || type.startsWith('turn.') || type.startsWith('run.'))
    return 'turn';
  if (type.startsWith('model.')) return 'model';
  if (type.startsWith('tool.') || type.startsWith('capability.')) return 'tool';
  if (
    type.startsWith('approval.') ||
    type.startsWith('user_input.') ||
    type.startsWith('auto_review.')
  )
    return 'interaction';
  if (type.startsWith('subagent.')) return 'subagent';
  if (type.startsWith('verification.')) return 'verification';
  if (type.startsWith('runtime.') || type.startsWith('resource_budget.')) return 'recovery';
  if (type.startsWith('session.')) return 'session';
  return 'other';
}

function statusFor(type: RuntimeEvent['type']): RuntimeLogEventEntry['status'] {
  if (/(?:failed|error|rejected|unknown|timed_out)$/u.test(type)) return 'failed';
  if (/(?:cancelled|aborted)$/u.test(type)) return 'cancelled';
  if (
    /(?:requested|required|queued|deferred|suspended|waiter_registered|waiter_enqueued)$/u.test(
      type,
    )
  )
    return 'waiting';
  if (/(?:started|entered|progress_updated|dispatch_started)$/u.test(type)) return 'running';
  if (
    /(?:completed|succeeded|finished|granted|answered|satisfied|released|reconciled|waived)$/u.test(
      type,
    )
  )
    return 'ok';
  return 'unknown';
}

function artifactDetail(event: RuntimeEvent): RuntimeLogEventDetail | undefined {
  for (const value of Object.values(event as unknown as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as { kind?: unknown; artifactId?: unknown };
    if (typeof candidate.kind === 'string' && typeof candidate.artifactId === 'string') {
      return {
        kind: 'artifact',
        artifact: { kind: safeText(candidate.kind), availability: 'available' },
      };
    }
  }
  return undefined;
}

function toolRejectionSummary(reasonCode: string | undefined): string {
  switch (reasonCode) {
    case 'approval_rejected':
      return 'Tool execution was rejected by the user before dispatch.';
    case 'mandatory_policy_unavailable':
    case 'persistence_unavailable':
      return 'Tool execution was rejected because a required safety boundary was unavailable.';
    default:
      return 'Tool execution was rejected by policy before dispatch.';
  }
}

/**
 * App-owned projection boundary for durable Runtime events. It admits the
 * exact current discriminant table and never serializes arbitrary event data.
 */
export function projectRuntimeLogEvent(
  record: RuntimeLogEventRecord<RuntimeEvent>,
): RuntimeLogEventEntry {
  const event = record.event;
  runtimeHostStateAssertReadableRuntimeEvent(event);
  const base: RuntimeLogEventEntry = {
    sessionId: record.sessionId,
    sequence: record.sequence,
    eventId: record.eventId,
    ...(record.causationId ? { causationId: record.causationId } : {}),
    ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
    createdAt: record.createdAt,
    type: event.type,
    category: categoryFor(event.type),
    status: statusFor(event.type),
    summary: event.type.replaceAll('.', ' '),
    detail: { kind: 'unavailable' },
  };
  switch (event.type) {
    case 'user.message_appended': {
      const content = stringField(event, 'content');
      const messageId = stringField(event, 'messageId');
      return {
        ...base,
        summary: content || 'User message',
        detail:
          content && messageId
            ? { kind: 'message', fields: { content, message_id: messageId } }
            : base.detail,
      };
    }
    case 'model.responded': {
      const messageId = stringField(event, 'messageId');
      const requestId = stringField(event, 'invocationId') ?? messageId;
      const text = stringField(event, 'text');
      const reasoningText = stringField(event, 'reasoningText');
      return {
        ...base,
        summary: text || 'Model response',
        detail:
          messageId && requestId
            ? {
                kind: 'model',
                fields: {
                  message_id: messageId,
                  request_id: requestId,
                  ...(text ? { text } : {}),
                  ...(reasoningText ? { reasoning_text: reasoningText } : {}),
                },
              }
            : base.detail,
      };
    }
    case 'tool.queued':
    case 'tool.started':
    case 'tool.finished':
    case 'tool.failed':
    case 'tool.cancelled':
      return {
        ...base,
        detail: {
          kind: 'tool',
          fields: {
            tool_call_id: event.toolCallId,
            label: 'name' in event ? safeText(String(event.name), 256) : 'Tool',
          },
        },
      };
    case 'tool.rejected': {
      const reasonCode = event.failure?.kind;
      const summary = toolRejectionSummary(reasonCode);
      return {
        ...base,
        summary,
        detail: {
          kind: 'tool',
          fields: {
            tool_call_id: event.toolCallId,
            label: 'Tool',
            ...(reasonCode ? { reason_code: reasonCode } : {}),
            rejection_summary: summary,
          },
        },
      };
    }
    case 'model.invocation_attempt_started':
    case 'model.invocation_completed':
    case 'model.invocation_interrupted':
      return { ...base, detail: { kind: 'model' } };
    case 'model.invocation_prepared':
      return {
        ...base,
        detail: {
          kind: 'model',
          fields: {
            invocation_id: event.invocationId,
            purpose: event.purpose,
          },
        },
      };
    case 'user_input.requested':
    case 'user_input.answered':
    case 'user_input.cancelled':
    case 'approval.requested':
    case 'approval.granted':
    case 'approval.batch_released':
    case 'approval.session_grants_cleared':
    case 'approval.rejected':
      return { ...base, detail: { kind: 'interaction' } };
    case 'subagent.started':
    case 'subagent.completed':
    case 'subagent.failed':
    case 'subagent.suspended':
      return { ...base, detail: { kind: 'subagent' } };
    case 'verification.requested':
    case 'verification.started':
    case 'verification.completed':
    case 'verification.check_completed':
      return { ...base, detail: { kind: 'verification' } };
    default:
      return { ...base, detail: artifactDetail(event) ?? base.detail };
  }
}

export function projectRuntimeLogEventPage(
  page: RuntimeLogEventReadPage<RuntimeEvent>,
): RuntimeLogEventPage {
  return {
    entries: page.entries.map(projectRuntimeLogEvent),
    hasMore: page.hasMore,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    observedLastSequence: page.observedLastSequence,
  };
}
