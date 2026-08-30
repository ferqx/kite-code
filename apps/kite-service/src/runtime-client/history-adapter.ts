import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type {
  InteractionMode,
  ListRuntimeLogEventsRequest,
  ListRuntimeLogSessionsRequest,
  RuntimeClientEvent,
  RuntimeHistorySessionTranscript,
  RuntimeLogSessionEntry,
  RuntimeLogSessionPage,
} from '@kite-ai/runtime-contract';
import { assertListRuntimeLogSessionsRequest } from '@kite-ai/runtime-contract';
import { runtimeHostCurrentStateEventTypes } from '@kite-ai/runtime-host';
import type { RuntimeLogQueryPort } from '@kite-ai/runtime-host/storage';
import type { RuntimeEvent } from '../bootstrap/runtime/state-runtime';
import { projectRuntimeLogEventPage } from '../logs/runtime-log-presentation';
import type { WebObserverHistoryPort } from '../web-observer/core';
import { projectRuntimeClientEvent, projectRuntimeModelResponseRequestId } from './event-projector';
import { projectRuntimeClientText } from './safe-text';

type RuntimeLogQuerySource =
  | RuntimeLogQueryPort<RuntimeEvent>
  | (() => RuntimeLogQueryPort<RuntimeEvent>);

const MAX_OBSERVER_HISTORY_RECORDS = 4_096;

export interface KiteRuntimeHistoryCompatibilitySession {
  readonly threadId: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly needsSmartName: boolean;
}

export interface KiteRuntimeHistoryCompatibility {
  listSessions(): readonly KiteRuntimeHistoryCompatibilitySession[];
  importSession(sessionId: string): Readonly<{ status: string; error?: unknown }>;
}

function withLogs<Result>(
  source: RuntimeLogQuerySource,
  read: (logs: RuntimeLogQueryPort<RuntimeEvent>) => Result,
): Result {
  const logs = typeof source === 'function' ? source() : source;
  try {
    return read(logs);
  } finally {
    if (typeof source === 'function') logs.close();
  }
}

function pendingHistoricalInteraction(events: readonly RuntimeClientEvent[]): boolean {
  const pending = new Set<string>();
  for (const event of events) {
    switch (event.type) {
      case 'approval.queued':
      case 'input.requested':
      case 'plan.review_requested':
        pending.add(event.interaction.interactionId);
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
  return pending.size > 0;
}

function interactionModeFor(events: readonly RuntimeClientEvent[]): InteractionMode {
  let mode: InteractionMode = 'auto';
  for (const event of events) {
    if (event.type === 'interaction_mode.changed') mode = event.mode;
  }
  return mode;
}

function mapLogSession(entry: {
  readonly sessionId: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly lastSequence: number;
  readonly model?: { readonly provider: string; readonly name: string };
}): RuntimeLogSessionEntry {
  return {
    sessionId: entry.sessionId,
    displayName: entry.name || entry.sessionId,
    needsSmartName: entry.name.length === 0,
    updatedAt: entry.updatedAt,
    lastSequence: entry.lastSequence,
    ...(entry.model ? { model: entry.model } : {}),
  };
}

function allCurrentSessions(
  source: RuntimeLogQuerySource,
  query?: string,
): RuntimeLogSessionEntry[] {
  return withLogs(source, (reader) => {
    const entries: RuntimeLogSessionEntry[] = [];
    let cursor: { readonly updatedAt: number; readonly sessionId: string } | undefined;
    for (;;) {
      const page = reader.listSessions({ cursor, limit: 100 });
      entries.push(
        ...page.entries.map((entry) => {
          const projected = mapLogSession(entry);
          if (!projected.needsSmartName) return projected;
          const first = reader.listEvents({
            sessionId: entry.sessionId,
            direction: 'forward',
            limit: 1,
            eventTypes: ['user.message_appended'],
          }).entries[0]?.event;
          if (first?.type !== 'user.message_appended') return projected;
          const displayName = projectRuntimeClientText(first.content, 80).trim();
          return displayName.length === 0
            ? projected
            : { ...projected, displayName, needsSmartName: false };
        }),
      );
      if (!page.hasMore) {
        const needle = query?.trim().toLocaleLowerCase();
        return needle
          ? entries.filter((entry) => currentSessionMatchesQuery(reader, entry, needle))
          : entries;
      }
      if (!page.nextCursor) throw new Error('Runtime history session pagination did not advance.');
      cursor = page.nextCursor;
    }
  });
}

function currentSessionMatchesQuery(
  reader: RuntimeLogQueryPort<RuntimeEvent>,
  entry: RuntimeLogSessionEntry,
  needle: string,
): boolean {
  if (
    entry.displayName.toLocaleLowerCase().includes(needle) ||
    entry.sessionId.toLocaleLowerCase().includes(needle)
  ) {
    return true;
  }
  const page = reader.listEvents({
    sessionId: entry.sessionId,
    direction: 'forward',
    limit: 1,
    eventTypes: ['user.message_appended'],
  });
  const first = page.entries[0]?.event;
  return (
    first?.type === 'user.message_appended' && first.content.toLocaleLowerCase().includes(needle)
  );
}

function mergedSessionPage(
  source: RuntimeLogQuerySource,
  request: ListRuntimeLogSessionsRequest,
  compatibility?: KiteRuntimeHistoryCompatibility,
): RuntimeLogSessionPage {
  assertListRuntimeLogSessionsRequest(request);
  // Compatibility discovery also initializes the exact current target when
  // a user has only a known legacy source. The subsequent log reader remains
  // strict and will still reject a malformed current target rather than fall
  // back to that source.
  const compatibilitySessions = compatibility?.listSessions() ?? [];
  const query = request.query?.trim().toLocaleLowerCase();
  const byId = new Map(
    allCurrentSessions(source, request.query).map((entry) => [entry.sessionId, entry]),
  );
  for (const legacy of compatibilitySessions) {
    if (byId.has(legacy.threadId)) continue;
    if (
      query &&
      !legacy.name.toLocaleLowerCase().includes(query) &&
      !legacy.threadId.toLocaleLowerCase().includes(query)
    ) {
      continue;
    }
    byId.set(legacy.threadId, {
      sessionId: legacy.threadId,
      displayName: legacy.name || legacy.threadId,
      needsSmartName: legacy.needsSmartName,
      updatedAt: legacy.updatedAt,
      lastSequence: 0,
    });
  }
  const candidates = [...byId.values()]
    .filter(
      (entry) =>
        !request.cursor ||
        entry.updatedAt < request.cursor.updatedAt ||
        (entry.updatedAt === request.cursor.updatedAt &&
          entry.sessionId.localeCompare(request.cursor.sessionId) < 0),
    )
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || right.sessionId.localeCompare(left.sessionId),
    );
  const selected = candidates.slice(0, request.limit);
  const hasMore = candidates.length > selected.length;
  const last = selected.at(-1);
  return {
    entries: selected,
    hasMore,
    ...(hasMore && last
      ? { nextCursor: { updatedAt: last.updatedAt, sessionId: last.sessionId } }
      : {}),
  };
}

function findCurrentSession(
  source: RuntimeLogQuerySource,
  sessionId: string,
): RuntimeLogSessionEntry | undefined {
  return allCurrentSessions(source).find((entry) => entry.sessionId === sessionId);
}

function stableReasoningSegmentId(
  event: Extract<RuntimeEvent, { type: 'model.responded' }>,
): string {
  const source = event.invocationId ?? event.messageId;
  let hash = 2_166_136_261;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `history-reasoning-${(hash >>> 0).toString(36)}`;
}

/**
 * Durable model completion folds the ephemeral live stream into one persisted
 * fact. Re-expand only its closed presentation sequence here so live and
 * replay share the same RuntimeClientEvent consumer path. The terminal keeps
 * its authoritative full summary so the reducer can finalize the preceding
 * cumulative delta without appending a duplicate block.
 */
export function projectRuntimeHistoryEvents(
  event: RuntimeEvent,
  sessionRevision: number,
): readonly RuntimeClientEvent[] {
  if (event.type !== 'model.responded') {
    const projected = projectRuntimeClientEvent(event, { sessionRevision });
    return projected ? [projected] : [];
  }
  const projected: RuntimeClientEvent[] = [];
  const requestId = projectRuntimeModelResponseRequestId(event);
  if (event.reasoningText) {
    const text = projectRuntimeClientText(event.reasoningText);
    if (text) {
      projected.push({
        type: 'reasoning.activity',
        requestId,
        state: 'completed',
        segmentId: stableReasoningSegmentId(event),
        text,
      });
    }
  }
  if (event.text) {
    const text = projectRuntimeClientText(event.text);
    if (text) projected.push({ type: 'model.text_delta', requestId, text });
  }
  const terminal = projectRuntimeClientEvent(event, { sessionRevision });
  if (terminal) projected.push(terminal);
  return projected;
}

/**
 * Current-format Web Observer History retains each durable source sequence.
 * It has no compatibility parameter, so a read can never import or write a
 * legacy Session as a side effect.
 */
export function createKiteRuntimeObserverHistoryPort(
  logs: RuntimeLogQuerySource,
): WebObserverHistoryPort {
  return Object.freeze({
    async loadSession(sessionId: string) {
      return withLogs(logs, (reader) => {
        const all: Array<{
          readonly sequence: number;
          readonly events: readonly RuntimeClientEvent[];
        }> = [];
        let afterSequence: number | undefined;
        let observedLastSequence: number | undefined;
        for (;;) {
          const page = reader.listEvents({
            sessionId,
            ...(afterSequence === undefined ? {} : { afterSequence }),
            direction: 'forward',
            limit: 200,
          });
          if (
            observedLastSequence !== undefined &&
            page.observedLastSequence !== observedLastSequence
          ) {
            throw new Error('Runtime observer history changed during the pinned read.');
          }
          observedLastSequence = page.observedLastSequence;
          for (const record of page.entries) {
            if (afterSequence !== undefined && record.sequence <= afterSequence) {
              throw new Error('Runtime observer history pagination did not advance.');
            }
            afterSequence = record.sequence;
            all.push({
              sequence: record.sequence,
              events: projectRuntimeHistoryEvents(record.event, record.sequence),
            });
            if (all.length > MAX_OBSERVER_HISTORY_RECORDS) {
              throw new Error('Runtime observer History exceeds its bounded record limit.');
            }
          }
          if (!page.hasMore) {
            return Object.freeze({
              sessionId,
              lastSequence: observedLastSequence,
              records: Object.freeze(all),
            });
          }
          if (page.nextCursor === undefined || page.nextCursor !== afterSequence) {
            throw new Error('Runtime observer history pagination cursor is invalid.');
          }
        }
      });
    },
  });
}

/** App-owned bridge from the raw decoded log port to fixed client-safe history DTOs. */
export function createKiteRuntimeHistoryClient(
  logs: RuntimeLogQuerySource,
  compatibility?: KiteRuntimeHistoryCompatibility,
): RuntimeHistoryClient {
  return Object.freeze({
    async listSessions(request: ListRuntimeLogSessionsRequest): Promise<RuntimeLogSessionPage> {
      return mergedSessionPage(logs, request, compatibility);
    },
    async listEvents(request: ListRuntimeLogEventsRequest) {
      return withLogs(logs, (reader) => projectRuntimeLogEventPage(reader.listEvents(request)));
    },
    async loadSession(sessionId: string): Promise<RuntimeHistorySessionTranscript> {
      compatibility?.listSessions();
      let session = findCurrentSession(logs, sessionId);
      if (!session && compatibility) {
        const imported = compatibility.importSession(sessionId);
        if (imported.status === 'failed' || imported.status === 'conflict') {
          throw imported.error instanceof Error
            ? imported.error
            : new Error(`Runtime session import failed: ${sessionId}`);
        }
        session = findCurrentSession(logs, sessionId);
      }
      if (!session) throw new Error(`Runtime session was not found: ${sessionId}`);
      const records = withLogs(logs, (reader) => {
        const all: Array<{
          readonly sequence: number;
          readonly events: readonly RuntimeClientEvent[];
        }> = [];
        let afterSequence: number | undefined;
        for (;;) {
          const page = reader.listEvents({
            sessionId,
            ...(afterSequence === undefined ? {} : { afterSequence }),
            direction: 'forward',
            limit: 200,
          });
          for (const record of page.entries) {
            if (afterSequence !== undefined && record.sequence <= afterSequence) {
              throw new Error('Runtime history pagination did not advance.');
            }
            afterSequence = record.sequence;
            all.push({
              sequence: record.sequence,
              events: projectRuntimeHistoryEvents(record.event, record.sequence),
            });
          }
          if (!page.hasMore) return all;
          if (page.nextCursor === undefined || page.nextCursor !== afterSequence) {
            throw new Error('Runtime history pagination cursor is invalid.');
          }
        }
      });
      const events = records.flatMap((record) => record.events);
      return {
        session,
        records,
        events,
        interactionMode: interactionModeFor(events),
        recovery: pendingHistoricalInteraction(events) ? 'pending_interaction' : 'normal',
      };
    },
  });
}

/**
 * Bounded current-format page façade for consumers that must never materialize a complete
 * Workspace directory or transcript. The injected log port remains the source of keyset and
 * sequence pagination; no compatibility discovery or smart-name scan is performed.
 */
export function createKiteRuntimePagedHistoryClient(
  logs: RuntimeLogQueryPort<RuntimeEvent>,
): Pick<RuntimeHistoryClient, 'listSessions' | 'listEvents'> {
  return Object.freeze({
    async listSessions(request: ListRuntimeLogSessionsRequest): Promise<RuntimeLogSessionPage> {
      assertListRuntimeLogSessionsRequest(request);
      return withLogs(logs, (reader) => {
        const page = reader.listSessions(request);
        return Object.freeze({
          entries: Object.freeze(page.entries.map(mapLogSession)),
          ...(page.nextCursor ? { nextCursor: Object.freeze(page.nextCursor) } : {}),
          hasMore: page.hasMore,
        });
      });
    },
    async listEvents(request: ListRuntimeLogEventsRequest) {
      return withLogs(logs, (reader) => projectRuntimeLogEventPage(reader.listEvents(request)));
    },
  });
}

/** Select the current Runtime event table inside the Service History owner, not a Worker root. */
export function createKiteRuntimePagedHistoryFromWorkspaceStore(
  openLogs: (currentEventTypes: readonly string[]) => RuntimeLogQueryPort<RuntimeEvent>,
): Pick<RuntimeHistoryClient, 'listSessions' | 'listEvents'> {
  return createKiteRuntimePagedHistoryClient(openLogs(runtimeHostCurrentStateEventTypes()));
}

/**
 * Current-format, query-only History surface for observer-only consumers.
 *
 * Unlike the terminal History journey, this entry point deliberately has no
 * compatibility source and therefore cannot discover or import a legacy
 * Session as a side effect of list/load. A missing legacy-only Session stays
 * unavailable until an authorized native client performs the explicit import.
 */
export function createKiteRuntimeObserverHistoryClient(
  logs: RuntimeLogQuerySource,
): RuntimeHistoryClient {
  return createKiteRuntimeHistoryClient(logs);
}
