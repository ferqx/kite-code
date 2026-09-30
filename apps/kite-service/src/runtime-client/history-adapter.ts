import { createHash } from 'node:crypto';
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

export type KiteChildHistoryLogOpener = (
  parentSessionId: string,
  childSessionId: string,
) => Pick<RuntimeLogQueryPort<RuntimeEvent>, 'getSession' | 'listEvents' | 'close'>;

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

function mapCurrentSession(
  reader: RuntimeLogQueryPort<RuntimeEvent>,
  entry: Parameters<typeof mapLogSession>[0],
): RuntimeLogSessionEntry {
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
      entries.push(...page.entries.map((entry) => mapCurrentSession(reader, entry)));
      if (!page.hasMore) {
        const needle = query?.trim().toLocaleLowerCase();
        return needle
          ? entries.filter((entry) => currentSessionMatchesQuery(reader, entry, needle))
          : entries;
      }
      if (
        !page.nextCursor ||
        (cursor &&
          (page.nextCursor.updatedAt > cursor.updatedAt ||
            (page.nextCursor.updatedAt === cursor.updatedAt &&
              page.nextCursor.sessionId >= cursor.sessionId)))
      )
        throw new Error('Runtime history session pagination did not advance.');
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

function searchCurrentSessionPage(
  source: RuntimeLogQuerySource,
  request: ListRuntimeLogSessionsRequest,
): RuntimeLogSessionPage {
  assertListRuntimeLogSessionsRequest(request);
  const needle = request.query!.trim().toLocaleLowerCase();
  return withLogs(source, (reader) => {
    const matches: RuntimeLogSessionEntry[] = [];
    let cursor = request.cursor;
    for (;;) {
      const page = reader.listSessions({
        limit: 100,
        ...(cursor ? { cursor } : {}),
        ...(request.workspaceDigest ? { workspaceDigest: request.workspaceDigest } : {}),
      });
      for (const entry of page.entries) {
        const projected = mapCurrentSession(reader, entry);
        if (!currentSessionMatchesQuery(reader, projected, needle)) continue;
        matches.push(projected);
        if (matches.length > request.limit) {
          const last = matches[request.limit - 1]!;
          return {
            entries: matches.slice(0, request.limit),
            hasMore: true,
            nextCursor: { updatedAt: last.updatedAt, sessionId: last.sessionId },
          };
        }
      }
      if (!page.hasMore) return { entries: matches, hasMore: false };
      if (
        !page.nextCursor ||
        (cursor &&
          (page.nextCursor.updatedAt > cursor.updatedAt ||
            (page.nextCursor.updatedAt === cursor.updatedAt &&
              page.nextCursor.sessionId >= cursor.sessionId)))
      )
        throw new Error('Runtime history session pagination did not advance.');
      cursor = page.nextCursor;
    }
  });
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
):
  | {
      entry: RuntimeLogSessionEntry;
      historyGeneration?: number;
      historyRewriteGeneration?: number;
      historyInstanceId?: string;
    }
  | undefined {
  const indexed = withLogs(source, (reader) =>
    reader.getSession ? { entry: reader.getSession(sessionId) } : undefined,
  );
  if (indexed)
    return indexed.entry
      ? {
          entry: mapLogSession(indexed.entry),
          ...(indexed.entry.historyGeneration === undefined
            ? {}
            : { historyGeneration: indexed.entry.historyGeneration }),
          ...(indexed.entry.historyRewriteGeneration === undefined
            ? {}
            : {
                historyRewriteGeneration: indexed.entry.historyRewriteGeneration,
                historyInstanceId: indexed.entry.historyInstanceId,
              }),
        }
      : undefined;
  const entry = allCurrentSessions(source).find((candidate) => candidate.sessionId === sessionId);
  return entry ? { entry } : undefined;
}

/** Resolve the current scoped metadata before reusing a worker projection. */
export function resolveKiteHistorySession(
  source: RuntimeLogQuerySource,
  sessionId: string,
  throughSequence?: number,
): {
  entry: RuntimeLogSessionEntry;
  historyGeneration?: number;
  historyRewriteGeneration?: number;
  historyInstanceId?: string;
} {
  const current = findCurrentSession(source, sessionId);
  if (!current)
    throw Object.assign(new Error('Runtime Session was not found.'), { code: 'session_not_found' });
  if (
    throughSequence !== undefined &&
    (!Number.isSafeInteger(throughSequence) ||
      throughSequence < 0 ||
      throughSequence > current.entry.lastSequence)
  )
    throw new Error('Runtime history snapshot sequence is invalid.');
  return {
    ...current,
    entry:
      throughSequence === undefined
        ? current.entry
        : { ...current.entry, lastSequence: throughSequence },
  };
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
  occurredAt?: string;
};

function canonicalOccurredAt(value: unknown): value is string {
  if (typeof value !== 'string' || (value.length !== 20 && value.length !== 24)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return canonical === value || canonical === `${value.slice(0, -1)}.000Z`;
}

// Desktop and Native History read a fixed sequence across multiple protocol pages.
// Keep the projected transcript so a later page does not scan and project the
// entire durable journal again. The key includes the authorized child scope;
// callers still resolve the current Session through that scoped reader first.
const HISTORY_CACHE_MAX_ENTRIES = 256;
const HISTORY_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const HISTORY_CACHE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const HISTORY_CACHE_TTL_MS = 30_000;

type CachedHistory = Readonly<{
  transcript: RuntimeHistorySessionTranscript;
  historyGeneration?: number;
  appendProof?: { rewriteGeneration: number; instanceId: string };
  rawPrefixDigest?: string;
  bytes: number;
  expiresAt: number;
}>;

type HistoryPrefixFingerprinter = (
  sessionId: string,
  throughSequence: number,
  parentSessionId?: string,
) => string | null;

class HistoryTranscriptCache {
  readonly #entries = new Map<string, CachedHistory>();
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(maxBytes = HISTORY_CACHE_MAX_BYTES) {
    this.#maxBytes = maxBytes;
  }

  get(
    key: string,
    historyGeneration?: number,
    fingerprintPrefix?: () => string | null,
    appendProof?: { rewriteGeneration: number; instanceId: string },
  ): RuntimeHistorySessionTranscript | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#delete(key);
      return undefined;
    }
    if (
      !Number.isSafeInteger(historyGeneration) ||
      !Number.isSafeInteger(entry.historyGeneration) ||
      historyGeneration! < 0 ||
      entry.historyGeneration! < 0
    ) {
      this.#delete(key);
      return undefined;
    }
    let retainedEntry = entry;
    const unchangedPrefix =
      !!appendProof &&
      !!entry.appendProof &&
      appendProof.instanceId === entry.appendProof.instanceId &&
      Number.isSafeInteger(appendProof.rewriteGeneration) &&
      appendProof.rewriteGeneration >= 0 &&
      appendProof.rewriteGeneration === entry.appendProof.rewriteGeneration &&
      historyGeneration! >= entry.historyGeneration!;
    if (entry.historyGeneration !== historyGeneration && !unchangedPrefix) {
      if (!fingerprintPrefix || !entry.rawPrefixDigest) {
        this.#delete(key);
        return undefined;
      }
      let currentDigest: string | null = null;
      try {
        currentDigest = fingerprintPrefix();
      } catch {
        // A failed proof falls back to the ordinary bounded journal read.
      }
      if (currentDigest !== entry.rawPrefixDigest) {
        this.#delete(key);
        return undefined;
      }
      retainedEntry = { ...entry, historyGeneration };
    }
    retainedEntry = { ...retainedEntry, historyGeneration };
    this.#entries.delete(key);
    this.#entries.set(key, retainedEntry);
    return entry.transcript;
  }

  set(
    key: string,
    transcript: RuntimeHistorySessionTranscript,
    retain: boolean,
    historyGeneration?: number,
    rawPrefixDigest?: string,
    appendProof?: { rewriteGeneration: number; instanceId: string },
  ): RuntimeHistorySessionTranscript {
    // The JSON byte count bounds retained payload size, not actual JS heap use.
    // Replace the old snapshot even when the new one is too large to retain.
    this.#delete(key);
    const content = JSON.stringify({
      records: transcript.records,
      interactionMode: transcript.interactionMode,
      recovery: transcript.recovery,
    });
    const snapshotDigest = createHash('sha256').update(content).digest('hex');
    const withDigest = { ...transcript, snapshotDigest };
    // records and flattened events share objects in memory but occupy separate
    // fields on the wire; double the encoded content to avoid under-accounting.
    const bytes = Buffer.byteLength(content, 'utf8') * 2 + 4_096;
    if (!retain || bytes > HISTORY_CACHE_MAX_ENTRY_BYTES) return withDigest;
    this.#entries.set(key, {
      transcript: withDigest,
      historyGeneration,
      appendProof,
      rawPrefixDigest,
      bytes,
      expiresAt: Date.now() + HISTORY_CACHE_TTL_MS,
    });
    this.#bytes += bytes;
    while (this.#entries.size > HISTORY_CACHE_MAX_ENTRIES || this.#bytes > this.#maxBytes) {
      this.#delete(this.#entries.keys().next().value!);
    }
    return withDigest;
  }

  #delete(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#bytes -= entry.bytes;
    this.#entries.delete(key);
  }
}

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
function createKiteRuntimeHistoryClientWithCache(
  logs: RuntimeLogQuerySource,
  compatibility: KiteRuntimeHistoryCompatibility | undefined,
  openChildLogs: KiteChildHistoryLogOpener | undefined,
  cache: HistoryTranscriptCache,
  parentScope?: string,
  limits?: Readonly<{
    maxSourceBytes?: number;
    maxProjectedBytes?: number;
    maxRecords?: number;
    maxCacheBytes?: number;
    fingerprintEventRows?: HistoryPrefixFingerprinter;
  }>,
): RuntimeHistoryClient {
  return Object.freeze({
    async listSessions(request: ListRuntimeLogSessionsRequest): Promise<RuntimeLogSessionPage> {
      if (request.workspaceDigest)
        return withLogs(logs, (reader) =>
          createKiteRuntimePagedHistoryClient(reader).listSessions(request),
        );
      if (!compatibility && request.query?.trim()) return searchCurrentSessionPage(logs, request);
      if (!compatibility && !request.query?.trim()) {
        assertListRuntimeLogSessionsRequest(request);
        return withLogs(logs, (reader) => {
          const { query: _query, ...pageRequest } = request;
          const page = reader.listSessions(pageRequest);
          return {
            entries: page.entries.map((entry) => mapCurrentSession(reader, entry)),
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            hasMore: page.hasMore,
          };
        });
      }
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
      let current = findCurrentSession(logs, sessionId);
      let session = current?.entry;
      if (!session && compatibility) {
        const imported = compatibility.importSession(sessionId);
        if (imported.status === 'failed' || imported.status === 'conflict') {
          throw imported.error instanceof Error
            ? imported.error
            : new Error(`Runtime session import failed: ${sessionId}`);
        }
        current = findCurrentSession(logs, sessionId);
        session = current?.entry;
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
      // A continuation carries the first page's fixed watermark. Resolve the
      // Session (and, for children, its exact parent) before consulting cache.
      // A Store-owned event generation allows a fresh navigation to reuse the
      // projection only when no event row has changed, including same-sequence
      // repair. Readers without that generation still rescan the first page.
      const cacheKey = JSON.stringify([
        parentScope ?? null,
        sessionId,
        current?.historyInstanceId ?? null,
        session.lastSequence,
      ]);
      const appendProof =
        current?.historyRewriteGeneration !== undefined && current.historyInstanceId
          ? {
              rewriteGeneration: current.historyRewriteGeneration,
              instanceId: current.historyInstanceId,
            }
          : undefined;
      if (throughSequence !== undefined && !compatibility) {
        // A pinned load can also be a new request, not only a page continuation.
        // Check the durable generation so same-sequence rewrites are visible.
        const cached = cache.get(
          cacheKey,
          current?.historyGeneration,
          limits?.fingerprintEventRows
            ? () => limits.fingerprintEventRows!(sessionId, session.lastSequence, parentScope)
            : undefined,
          appendProof,
        );
        if (cached) return { ...cached, session };
      } else if (
        throughSequence === undefined &&
        !compatibility &&
        current?.historyGeneration !== undefined
      ) {
        const cached = cache.get(
          cacheKey,
          current.historyGeneration,
          limits?.fingerprintEventRows
            ? () => limits.fingerprintEventRows!(sessionId, session.lastSequence, parentScope)
            : undefined,
          appendProof,
        );
        if (cached) return { ...cached, session };
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
            beforeSequence: session.lastSequence + 1,
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
              ...(canonicalOccurredAt(record.occurredAt) ? { occurredAt: record.occurredAt } : {}),
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
            if (
              record.event.type === 'task.completed' ||
              record.event.type === 'task.failed' ||
              record.event.type === 'task.cancelled'
            ) {
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
      const transcript: RuntimeHistorySessionTranscript = {
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
      let rawPrefixDigest: string | undefined;
      if (
        !compatibility &&
        !appendProof &&
        limits?.fingerprintEventRows &&
        Number.isSafeInteger(current?.historyGeneration) &&
        current!.historyGeneration! >= 0
      ) {
        try {
          rawPrefixDigest =
            limits.fingerprintEventRows(sessionId, session.lastSequence, parentScope) ?? undefined;
        } catch {
          // A failed proof must not fail an otherwise valid journal read.
        }
      }
      return cache.set(
        cacheKey,
        transcript,
        !compatibility &&
          (!!appendProof || !limits?.fingerprintEventRows || rawPrefixDigest !== undefined),
        current?.historyGeneration,
        rawPrefixDigest,
        appendProof,
      );
    },
    ...(openChildLogs
      ? {
          loadChildSession: (
            parentSessionId: string,
            childSessionId: string,
            throughSequence?: number,
          ) => {
            if (!parentSessionId || !childSessionId || parentSessionId === childSessionId)
              throw new Error('Child Session history scope is invalid.');
            const scopedLogs = () => {
              const reader = openChildLogs(parentSessionId, childSessionId);
              return {
                getSession: (sessionId: string) => reader.getSession?.(sessionId) ?? null,
                listEvents: (request: Parameters<typeof reader.listEvents>[0]) =>
                  reader.listEvents(request),
                close: () => reader.close(),
                // The indexed child read is the only authorized discovery path.
                listSessions: () => {
                  throw new Error('Child Session listing is unavailable.');
                },
              } as RuntimeLogQueryPort<RuntimeEvent>;
            };
            return createKiteRuntimeHistoryClientWithCache(
              scopedLogs,
              undefined,
              undefined,
              cache,
              parentSessionId,
              limits,
            ).loadSession(childSessionId, throughSequence);
          },
        }
      : {}),
  });
}

export function createKiteRuntimeHistoryClient(
  logs: RuntimeLogQuerySource,
  compatibility?: KiteRuntimeHistoryCompatibility,
  openChildLogs?: KiteChildHistoryLogOpener,
): RuntimeHistoryClient {
  return createKiteRuntimeHistoryClientWithCache(
    logs,
    compatibility,
    openChildLogs,
    new HistoryTranscriptCache(),
  );
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
  openChildLogs?: KiteChildHistoryLogOpener,
  limits?: Readonly<{
    maxSourceBytes?: number;
    maxProjectedBytes?: number;
    maxRecords?: number;
    maxCacheBytes?: number;
    fingerprintEventRows?: HistoryPrefixFingerprinter;
  }>,
): RuntimeHistoryClient {
  return createKiteRuntimeHistoryClientWithCache(
    logs,
    undefined,
    openChildLogs,
    new HistoryTranscriptCache(limits?.maxCacheBytes),
    undefined,
    limits,
  );
}
