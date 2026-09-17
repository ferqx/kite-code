import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type {
  InteractionMode,
  ListRuntimeLogEventsRequest,
  ListRuntimeLogSessionsRequest,
  RuntimeClientEvent,
  RuntimeHistoryRecordIdentity,
  RuntimeHistorySessionTranscript,
  RuntimeLogSessionEntry,
  RuntimeLogSessionPage,
} from '@kite-ai/runtime-contract';
import {
  assertListRuntimeLogSessionsRequest,
  isRuntimeClientEventIdentitySatisfied,
} from '@kite-ai/runtime-contract';
import { runtimeHostCurrentStateEventTypes } from '@kite-ai/runtime-host';
import type { RuntimeLogQueryPort } from '@kite-ai/runtime-host/storage';
import type { RuntimeEvent } from '../bootstrap/runtime/state-runtime';
import { projectRuntimeLogEventPage } from '../logs/runtime-log-presentation';
import { childRuntimeToolCallId } from '../runtime/tool-execution/subagent-tool-identity';
import { projectRuntimeClientEvent, projectRuntimeModelResponseRequestId } from './event-projector';
import { projectRuntimeClientText, projectRuntimeSessionTitle } from './safe-text';

type RuntimeLogQuerySource =
  | RuntimeLogQueryPort<RuntimeEvent>
  | (() => RuntimeLogQueryPort<RuntimeEvent>);

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
          const displayName = projectRuntimeSessionTitle(first.content);
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
  const indexed = withLogs(source, (reader) =>
    reader.getSession ? { entry: reader.getSession(sessionId) } : undefined,
  );
  if (indexed) return indexed.entry ? mapLogSession(indexed.entry) : undefined;
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

type HistoricalSource = Readonly<{ sequence: number; event: RuntimeEvent }>;
type HistoricalRecord = {
  sequence: number;
  events: readonly RuntimeClientEvent[];
  identity?: RuntimeHistoryRecordIdentity;
};

/** Rebuild only ownership proven by the bounded durable journal being loaded. */
function repairLegacyHistoryOwnership(
  records: readonly HistoricalRecord[],
  sources: readonly HistoricalSource[],
): HistoricalRecord[] {
  const invocations = new Map<string, Array<{ parentToolCallId: string; sequence: number }>>();
  const children = new Map<string, Array<{ invocationId: string; sequence: number }>>();
  for (const { sequence, event } of sources) {
    if (event.type === 'capability.invocation_recorded') {
      const candidates = invocations.get(event.invocationId) ?? [];
      candidates.push({ parentToolCallId: event.toolCallId, sequence });
      invocations.set(event.invocationId, candidates);
    } else if (event.type === 'capability.subagent_dispatch_intent_recorded') {
      const candidates = children.get(event.childInvocationId) ?? [];
      candidates.push({ invocationId: event.invocationId, sequence });
      children.set(event.childInvocationId, candidates);
    }
  }
  const parentForChild = (childId: string, throughSequence: number): string | undefined => {
    const allParents = new Set<string>();
    const parentsAtSequence = new Set<string>();
    for (const child of children.get(childId) ?? []) {
      for (const invocation of invocations.get(child.invocationId) ?? []) {
        allParents.add(invocation.parentToolCallId);
        if (child.sequence <= throughSequence && invocation.sequence <= throughSequence) {
          parentsAtSequence.add(invocation.parentToolCallId);
        }
      }
    }
    return allParents.size === 1 && parentsAtSequence.size === 1
      ? [...parentsAtSequence][0]
      : undefined;
  };
  const taskToolIds = new Set(
    sources.flatMap(({ event }) =>
      event.type === 'tool.queued' && event.name === 'task' ? [event.toolCallId] : [],
    ),
  );
  const provenParentTasks = new Set(
    [...children.keys()]
      .map((childId) => parentForChild(childId, Number.POSITIVE_INFINITY))
      .filter((id): id is string => id !== undefined && taskToolIds.has(id)),
  );
  const durableToolIds = new Set(
    sources.flatMap(({ event }) =>
      event.type.startsWith('tool.') && 'toolCallId' in event ? [event.toolCallId] : [],
    ),
  );
  const stepToolIds = new Map<string, Set<string>>();
  const toolSteps = new Map<
    string,
    Array<{ subagentId: string; parentToolCallId: string; sequence: number }>
  >();
  for (const { sequence, event } of sources) {
    if (event.type !== 'subagent.step' || !event.subagent.modelInvocationId) continue;
    const parentToolCallId = parentForChild(event.subagent.id, sequence);
    if (!parentToolCallId) continue;
    const toolId = childRuntimeToolCallId({
      parentToolCallId,
      subagentId: event.subagent.id,
      modelInvocationId: event.subagent.modelInvocationId,
      modelToolCallId: event.subagent.toolCallId,
      toolName: event.subagent.toolName,
      args: event.subagent.toolArgs,
    });
    if (durableToolIds.has(toolId)) {
      const key = JSON.stringify([event.subagent.id, event.subagent.stepId]);
      const ids = stepToolIds.get(key) ?? new Set<string>();
      ids.add(toolId);
      stepToolIds.set(key, ids);
    }
    const candidates = toolSteps.get(toolId) ?? [];
    candidates.push({ subagentId: event.subagent.id, parentToolCallId, sequence });
    toolSteps.set(toolId, candidates);
  }
  const ownerForTool = (toolId: string, sequence: number) => {
    const candidates = (toolSteps.get(toolId) ?? []).filter((entry) => entry.sequence <= sequence);
    const owners = new Set(
      candidates.map((entry) => `${entry.subagentId}\0${entry.parentToolCallId}`),
    );
    if (owners.size !== 1) return undefined;
    const candidate = candidates[0]!;
    return { subagentId: candidate.subagentId, parentToolCallId: candidate.parentToolCallId };
  };
  return records.map((record) => ({
    ...record,
    events: record.events.map((projected): RuntimeClientEvent => {
      if (projected.type === 'subagent.step') {
        // The model call id differs from the durable child Tool id. Match the
        // existing Tool exactly so clients can fold its step into that row.
        const ids = stepToolIds.get(JSON.stringify([projected.subagentId, projected.stepId]));
        if (ids?.size === 1) return { ...projected, toolCallId: [...ids][0]! };
        return projected;
      }
      if (projected.type === 'subagent.started') {
        if (projected.parentToolCallId !== undefined) return projected;
        const parentToolCallId = parentForChild(projected.subagentId, record.sequence);
        return parentToolCallId === undefined ? projected : { ...projected, parentToolCallId };
      }
      if (
        projected.type === 'tool.queued' ||
        projected.type === 'tool.finished' ||
        projected.type === 'tool.failed' ||
        projected.type === 'tool.rejected' ||
        projected.type === 'tool.cancelled'
      ) {
        const owner = ownerForTool(projected.toolId, record.sequence);
        if (owner === undefined) {
          // Older journals hid even the parent Task. Only a uniquely proven
          // dispatch relationship may restore its history entry.
          return projected.presentation === 'hidden' &&
            projected.presentationOwner === undefined &&
            provenParentTasks.has(projected.toolId)
            ? { ...projected, presentation: 'standalone' }
            : projected;
        }
        if (
          projected.presentationOwner !== undefined &&
          (projected.presentationOwner.subagentId !== owner.subagentId ||
            projected.presentationOwner.parentToolCallId !== owner.parentToolCallId)
        )
          return projected;
        return { ...projected, presentationOwner: owner, presentation: 'hidden' };
      }
      return projected;
    }),
  }));
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
  options: { readonly stableRunId?: string } = {},
): readonly RuntimeClientEvent[] {
  if (event.type !== 'model.responded') {
    const projected = projectRuntimeClientEvent(event, { sessionRevision });
    if (!projected) return [];
    if (options.stableRunId && projected.type === 'run.terminal') {
      return [{ ...projected, runId: options.stableRunId }];
    }
    return [projected];
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

/** App-owned bridge from the raw decoded log port to fixed client-safe history DTOs. */
export function createKiteRuntimeHistoryClient(
  logs: RuntimeLogQuerySource,
  compatibility?: KiteRuntimeHistoryCompatibility,
): RuntimeHistoryClient {
  return Object.freeze({
    async listSessions(request: ListRuntimeLogSessionsRequest): Promise<RuntimeLogSessionPage> {
      if (request.workspaceDigest)
        return withLogs(logs, (reader) =>
          createKiteRuntimePagedHistoryClient(reader).listSessions(request),
        );
      return mergedSessionPage(logs, request, compatibility);
    },
    async listEvents(request: ListRuntimeLogEventsRequest) {
      return withLogs(logs, (reader) => projectRuntimeLogEventPage(reader.listEvents(request)));
    },
    async loadSession(
      sessionId: string,
      throughSequence?: number,
    ): Promise<RuntimeHistorySessionTranscript> {
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
      if (!session)
        throw Object.assign(new Error(`Runtime session was not found: ${sessionId}`), {
          code: 'session_not_found',
        });
      if (throughSequence !== undefined) {
        if (
          !Number.isSafeInteger(throughSequence) ||
          throughSequence < 0 ||
          throughSequence > session.lastSequence
        ) {
          throw new Error('Runtime history snapshot sequence is invalid.');
        }
        session = { ...session, lastSequence: throughSequence };
      }
      const records = withLogs(logs, (reader) => {
        const all: HistoricalRecord[] = [];
        const sources: HistoricalSource[] = [];
        const pendingIdentityRecords: number[] = [];
        let afterSequence: number | undefined;
        let stableRunId: string | undefined;
        let activeTaskId: string | undefined;
        let activeTurnId: string | undefined;
        let previousEventType: RuntimeEvent['type'] | undefined;
        const openTurnIds = new Set<string>();
        for (;;) {
          const page = reader.listEvents({
            sessionId,
            ...(afterSequence === undefined ? {} : { afterSequence }),
            ...(throughSequence === undefined ? {} : { beforeSequence: throughSequence + 1 }),
            direction: 'forward',
            limit: 200,
          });
          for (const record of page.entries) {
            if (afterSequence !== undefined && record.sequence <= afterSequence) {
              throw new Error('Runtime history pagination did not advance.');
            }
            afterSequence = record.sequence;
            sources.push({ sequence: record.sequence, event: record.event });
            if (record.event.type === 'task.started') {
              activeTaskId = record.event.taskId;
              // `task.started.turnId` identifies the State turn which admitted
              // the task.  For a planning Start Turn it is intentionally the
              // predecessor State turn: the new user message and canonical
              // `turn.started` fact are committed later in the same batch.
              // Do not use it as the presentation Turn for records before
              // that canonical turn fact arrives; live delivery already uses
              // the admitted descriptor identity for the whole batch.
            } else if (record.event.type === 'turn.started') {
              openTurnIds.add(record.event.turnId);
              activeTurnId = record.event.turnId;
              if (previousEventType !== 'provider.action_completed' || stableRunId === undefined) {
                stableRunId = record.event.turnId;
              }
            }
            if (activeTurnId !== undefined && pendingIdentityRecords.length > 0) {
              const joinedIdentity: RuntimeHistoryRecordIdentity = {
                ...(stableRunId === undefined ? {} : { runId: stableRunId }),
                ...(activeTaskId === undefined ? {} : { taskId: activeTaskId }),
                turnId: activeTurnId,
              };
              for (const index of pendingIdentityRecords.splice(0)) {
                all[index]!.identity = joinedIdentity;
              }
            }
            // A user message is the admission fact for the next Turn.  The
            // prior Turn remains in `activeTurnId` until its successor
            // `turn.started` reducer fact arrives, so never inherit that
            // predecessor for a prompt record.
            const recordTurnId =
              record.event.type === 'user.message_appended'
                ? undefined
                : 'turnId' in record.event && typeof record.event.turnId === 'string'
                  ? record.event.turnId
                  : activeTurnId;
            const recordTaskId =
              'taskId' in record.event && typeof record.event.taskId === 'string'
                ? record.event.taskId
                : activeTaskId;
            const identity: RuntimeHistoryRecordIdentity = {
              ...(stableRunId === undefined ? {} : { runId: stableRunId }),
              ...(recordTaskId === undefined ? {} : { taskId: recordTaskId }),
              ...(recordTurnId === undefined ? {} : { turnId: recordTurnId }),
            };
            const events = projectRuntimeHistoryEvents(record.event, record.sequence, {
              ...(stableRunId === undefined ? {} : { stableRunId }),
            });
            all.push({
              sequence: record.sequence,
              events,
              ...(Object.keys(identity).length === 0 ? {} : { identity }),
            });
            if (events.some((event) => !isRuntimeClientEventIdentitySatisfied(event, identity))) {
              pendingIdentityRecords.push(all.length - 1);
            }
            if (
              record.event.type === 'turn.completed' ||
              record.event.type === 'turn.aborted' ||
              record.event.type === 'run.completed'
            ) {
              openTurnIds.delete(record.event.turnId);
            } else if (record.event.type === 'run.error' && record.event.turnId) {
              openTurnIds.delete(record.event.turnId);
            }
            if (record.event.type === 'task.completed' || record.event.type === 'task.cancelled') {
              activeTaskId = undefined;
            }
            previousEventType = record.event.type;
          }
          if (!page.hasMore) {
            for (const index of pendingIdentityRecords) {
              const pending = all[index]!;
              // Keep each unresolved record independently addressable. A
              // single fallback identity would merge unrelated legacy turns
              // and make replay attach their messages/tools to one timeline.
              const identitySequence = pending.sequence;
              pending.identity = {
                runId: `legacy-run-${identitySequence}`,
                taskId: `legacy-task-${identitySequence}`,
                turnId: `legacy-turn-${identitySequence}`,
              };
            }
            return {
              records: repairLegacyHistoryOwnership(all, sources),
              restartRequired: openTurnIds.size > 0,
            };
          }
          if (page.nextCursor === undefined || page.nextCursor !== afterSequence) {
            throw new Error('Runtime history pagination cursor is invalid.');
          }
        }
      });
      const events = records.records.flatMap((record) => record.events);
      return {
        session,
        records: records.records,
        events,
        interactionMode: interactionModeFor(events),
        recovery: records.restartRequired
          ? 'restart_required'
          : pendingHistoricalInteraction(events)
            ? 'pending_interaction'
            : 'normal',
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
