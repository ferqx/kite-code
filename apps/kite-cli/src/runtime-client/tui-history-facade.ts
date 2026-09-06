import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type {
  AcceptedPresentationEnvelope,
  RuntimeClientEvent,
  RuntimeHistoryRecordIdentity,
  RuntimeHistorySessionTranscript,
} from '@kite-ai/runtime-contract';
import { assertAcceptedPresentationEnvelope } from '@kite-ai/runtime-contract';
import type { SessionData, SessionInfo } from '#kite-cli/session-types';

/** History has no live transport generation; one deterministic local
 * generation keeps replay fencing explicit without pretending it is a live
 * connection. */
const HISTORY_CONNECTION_GENERATION = 1;

function formatLocalDateTime(timestamp: number): string {
  // Runtime Store/History timestamps are epoch milliseconds. Multiplying by 1000 produced
  // five-digit years and could make an otherwise valid Session row fail bounded TUI layout.
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '(unknown)';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function recoveryInterrupt(
  events: readonly AcceptedPresentationEnvelope[],
): SessionData['interrupt'] {
  const pending = new Map<string, SessionData['interrupt']>();
  for (const envelope of events) {
    const event = envelope.event;
    switch (event.type) {
      case 'approval.queued':
        pending.set(event.interaction.interactionId, {
          kind: 'approval',
          callId: event.interaction.interactionId,
        });
        break;
      case 'input.requested':
        pending.set(event.interaction.interactionId, {
          kind: 'input',
          callId: event.interaction.interactionId,
        });
        break;
      case 'plan.review_requested':
        pending.set(event.interaction.interactionId, { kind: 'plan_review' });
        break;
      case 'approval.granted':
      case 'approval.rejected':
      case 'input.answered':
      case 'input.cancelled':
      case 'plan.approved':
      case 'interaction.settled':
        pending.delete(event.interactionId);
        break;
      default:
        break;
    }
  }
  return pending.values().next().value ?? null;
}

function sourceId(
  event: RuntimeClientEvent,
  field: 'runId' | 'taskId' | 'turnId',
): string | undefined {
  const value = (event as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function durableHistoryEnvelope(
  sessionId: string,
  revision: number,
  event: RuntimeClientEvent,
  identity: RuntimeHistoryRecordIdentity = {},
): AcceptedPresentationEnvelope {
  const envelope = Object.freeze({
    sessionId,
    connectionGeneration: HISTORY_CONNECTION_GENERATION,
    durability: 'durable' as const,
    revision,
    ...((sourceId(event, 'runId') ?? identity.runId)
      ? { runId: sourceId(event, 'runId') ?? identity.runId }
      : {}),
    ...((sourceId(event, 'taskId') ?? identity.taskId)
      ? { taskId: sourceId(event, 'taskId') ?? identity.taskId }
      : {}),
    ...((sourceId(event, 'turnId') ?? identity.turnId)
      ? { turnId: sourceId(event, 'turnId') ?? identity.turnId }
      : {}),
    event,
  });
  try {
    assertAcceptedPresentationEnvelope(envelope);
  } catch {
    throw new TypeError(
      `Invalid history presentation envelope: ${event.type} run=${envelope.runId ?? '-'} task=${envelope.taskId ?? '-'} turn=${envelope.turnId ?? '-'}`,
    );
  }
  return envelope;
}

/**
 * Preserve durable source sequence when available. The flattened transcript
 * fallback is deterministic and is used only by an older current-format
 * history response that omitted grouped records.
 */
function historyEnvelopes(
  transcript: RuntimeHistorySessionTranscript,
): AcceptedPresentationEnvelope[] {
  const records =
    transcript.records.length > 0
      ? transcript.records
      : [{ sequence: 1, events: transcript.events }];
  return records.flatMap((record, recordIndex) => {
    const revision = Number.isSafeInteger(record.sequence) ? record.sequence : recordIndex + 1;
    return record.events.map((event) =>
      durableHistoryEnvelope(transcript.session.sessionId, revision, event, record.identity),
    );
  });
}

/** TUI-only mapper; history remains display/recovery evidence, never settlement authority. */
export function createTuiHistoryFacade(history: RuntimeHistoryClient): {
  listPersistedSessions(query?: string): Promise<SessionInfo[]>;
  loadPersistedSession(sessionId: string): Promise<SessionData | null>;
} {
  return Object.freeze({
    async listPersistedSessions(query = ''): Promise<SessionInfo[]> {
      try {
        const entries: SessionInfo[] = [];
        let cursor: { readonly updatedAt: number; readonly sessionId: string } | undefined;
        for (;;) {
          const page = await history.listSessions({
            limit: 100,
            ...(cursor ? { cursor } : {}),
            ...(query ? { query } : {}),
          });
          entries.push(
            ...page.entries.map((session) => ({
              threadId: session.sessionId,
              name: session.displayName,
              updatedAt: formatLocalDateTime(session.updatedAt),
              needsSmartName: session.needsSmartName,
            })),
          );
          if (!page.hasMore) return entries;
          if (!page.nextCursor) throw new Error('Runtime history session cursor is invalid.');
          cursor = page.nextCursor;
        }
      } catch {
        // Discovery is advisory. An unavailable or corrupt current history
        // never becomes an unsafe Store fallback.
        return [];
      }
    },
    async loadPersistedSession(sessionId: string): Promise<SessionData | null> {
      const transcript = await history.loadSession(sessionId);
      const runtimeEvents = historyEnvelopes(transcript);
      return {
        threadId: transcript.session.sessionId,
        messages: [],
        runtimeEvents,
        interrupt:
          transcript.recovery === 'pending_interaction' ? recoveryInterrupt(runtimeEvents) : null,
        modelProvider: transcript.session.model?.provider ?? '',
        modelName: transcript.session.model?.name ?? '',
        thinkingLevel: null,
        plan: null,
        interactionMode: transcript.interactionMode,
        recovery: transcript.recovery,
      };
    },
  });
}
