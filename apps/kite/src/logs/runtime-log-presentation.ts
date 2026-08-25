import type {
  RuntimeLogEventDetail,
  RuntimeLogEventEntry,
  RuntimeLogEventPage,
} from '@kite-ai/runtime-contract';
import {
  type StateRuntimeEvent as RuntimeEvent,
  runtimeHostStateAssertCurrentRuntimeEvent,
} from '@kite-ai/runtime-host';
import type { RuntimeLogEventReadPage, RuntimeLogEventRecord } from '@kite-ai/runtime-host/storage';

const MAX_PRESENTATION_TEXT_CODE_POINTS = 4_000;
const SECRET_PATTERNS = [
  /\b(?:authorization|api[_ -]?key|token|secret|password)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
];

function stripControlCharacters(value: string): string {
  const visible: string[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    )
      continue;
    visible.push(character);
  }
  return visible.join('');
}

function safeText(value: string): string {
  let text = stripControlCharacters(value);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  const points = Array.from(text);
  return points.length > MAX_PRESENTATION_TEXT_CODE_POINTS
    ? `${points.slice(0, MAX_PRESENTATION_TEXT_CODE_POINTS).join('')}…`
    : text;
}

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

/**
 * App-owned projection boundary for durable Runtime events. It admits the
 * exact current discriminant table and never serializes arbitrary event data.
 */
export function projectRuntimeLogEvent(
  record: RuntimeLogEventRecord<RuntimeEvent>,
): RuntimeLogEventEntry {
  const event = record.event;
  runtimeHostStateAssertCurrentRuntimeEvent(event);
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
      return {
        ...base,
        summary: content || 'User message',
        detail: content ? { kind: 'message', fields: { content } } : base.detail,
      };
    }
    case 'tool.started':
    case 'tool.finished':
    case 'tool.failed':
    case 'tool.cancelled':
    case 'tool.rejected':
    case 'tool.queued':
      return { ...base, detail: { kind: 'tool' } };
    case 'model.invocation_attempt_started':
    case 'model.invocation_completed':
    case 'model.invocation_interrupted':
      return { ...base, detail: { kind: 'model' } };
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
