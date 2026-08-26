import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import type { SessionData, SessionInfo } from '#kite-cli/session-types';

function formatLocalDateTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return '(unknown)';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function recoveryInterrupt(events: readonly RuntimeClientEvent[]): SessionData['interrupt'] {
  const pending = new Map<string, SessionData['interrupt']>();
  for (const event of events) {
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
            cursor,
            limit: 100,
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
      return {
        threadId: transcript.session.sessionId,
        messages: [],
        runtimeEvents: transcript.events,
        interrupt:
          transcript.recovery === 'pending_interaction'
            ? recoveryInterrupt(transcript.events)
            : null,
        modelProvider: transcript.session.model?.provider ?? '',
        modelName: transcript.session.model?.name ?? '',
        thinkingLevel: null,
        plan: null,
        interactionMode: transcript.interactionMode,
      };
    },
  });
}
