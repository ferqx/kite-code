import { createHash } from 'node:crypto';
import {
  AGENT_API_LIMITS,
  type AgentApiCheckpoint,
  type AgentApiCheckpointPage,
  type AgentApiCheckpointPreview,
  type AgentApiHistoryItem,
  type AgentApiHistoryPage,
  type AgentApiProblem,
  type AgentApiSession,
  type AgentApiSessionPage,
  type AgentApiWorkspacePage,
  agentApiCheckpointPageSchema,
  agentApiCheckpointPreviewSchema,
  agentApiHistoryPageSchema,
  agentApiIdentifierSchema,
  agentApiSessionPageSchema,
  agentApiSessionSchema,
  agentApiTimestampSchema,
  agentApiWorkspacePageSchema,
  encodeAgentApiResponse,
  utf8ByteLength,
} from '@kite-ai/agent-api-contract';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type {
  RuntimeLogEventEntry,
  RuntimeLogSessionEntry,
  RuntimeQuery,
  RuntimeQueryResult,
  RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';

const DEFAULT_PAGE_LIMIT = 50;
const SESSION_JOIN_CONCURRENCY = 8;
const CURSOR_CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u;

export interface AgentApiCheckpointPageCursor {
  readonly revision: number;
  readonly checkpointId: string;
}

export interface AgentApiCheckpointMetadata {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly eventPosition: number;
  /** Seconds since Unix epoch. */
  readonly createdAt: number;
  readonly affectedFileCount: number;
}

export interface AgentApiCheckpointReadPort {
  list(input: {
    readonly sessionId: string;
    readonly cursor?: AgentApiCheckpointPageCursor;
    readonly limit: number;
  }): {
    readonly entries: readonly AgentApiCheckpointMetadata[];
    readonly nextCursor?: AgentApiCheckpointPageCursor;
    readonly hasMore: boolean;
  };
  get(sessionId: string, checkpointId: string): AgentApiCheckpointMetadata | undefined;
}

export interface AgentApiDirectoryReadPort {
  list(): readonly {
    readonly workspaceId: string;
    readonly displayName: string;
    readonly sessions: readonly {
      readonly sessionId: string;
      readonly name: string;
      readonly updatedAt: number;
      readonly lastSequence: number;
    }[];
  }[];
}

/** One Public context owns one private in-process Runtime logical connection. */
export interface AgentApiReadContext extends AsyncDisposable {
  query(query: RuntimeQuery): Promise<RuntimeQueryResult>;
  readonly history: Pick<RuntimeHistoryClient, 'listSessions' | 'listEvents'>;
  readonly checkpoints: AgentApiCheckpointReadPort;
  /** Present only for a service-scoped read principal such as the local Browser. */
  readonly directory?: AgentApiDirectoryReadPort;
  close(): Promise<void>;
}

export type AgentApiReadErrorCode = Extract<
  AgentApiProblem['code'],
  | 'checkpoint_unavailable'
  | 'cursor_invalidated'
  | 'invalid_cursor'
  | 'invalid_request'
  | 'not_found'
  | 'temporarily_unavailable'
>;

export type AgentApiReadDispatchResult =
  | { readonly matched: false }
  | {
      readonly matched: true;
      readonly result:
        | { readonly ok: true; readonly body: unknown; readonly etag?: string }
        | {
            readonly ok: false;
            readonly status: 400 | 404 | 409 | 503;
            readonly code: AgentApiReadErrorCode;
            readonly retryable: boolean;
          };
    };

interface SessionCursorPayload {
  readonly schema: 'kite.agent-api.cursor.sessions.v1';
  readonly collection: 'sessions';
  readonly lifecycle: string | null;
  readonly status: string | null;
  readonly updated_at: number;
  readonly session_id: string;
}

interface HistoryCursorPayload {
  readonly schema: 'kite.agent-api.cursor.history.v1';
  readonly collection: 'history';
  readonly session_id: string;
  readonly through_sequence: number;
  readonly through_event_digest: string;
  readonly scan_sequence: number;
  /** null means scan_sequence was consumed completely. */
  readonly public_ordinal: number | null;
}

interface CheckpointCursorPayload {
  readonly schema: 'kite.agent-api.cursor.checkpoints.v1';
  readonly collection: 'checkpoints';
  readonly session_id: string;
  readonly revision: number;
  readonly checkpoint_id: string;
}

interface WorkspaceCursorPayload {
  readonly schema: 'kite.agent-api.cursor.workspaces.v1';
  readonly collection: 'workspaces';
  readonly workspace_id: string;
}

interface WorkspaceSessionCursorPayload {
  readonly schema: 'kite.agent-api.cursor.workspace-sessions.v1';
  readonly collection: 'workspace_sessions';
  readonly workspace_id: string;
  readonly lifecycle: string | null;
  readonly status: string | null;
  readonly session_id: string;
}

class ReadFailure extends Error {
  readonly status: 400 | 404 | 409 | 503;
  readonly code: AgentApiReadErrorCode;
  readonly retryable: boolean;

  constructor(
    status: 400 | 404 | 409 | 503,
    code: AgentApiReadErrorCode,
    retryable = status === 503,
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export async function dispatchAgentApiReadRequest(input: {
  readonly request: Request;
  readonly url: URL;
  readonly context: AgentApiReadContext;
}): Promise<AgentApiReadDispatchResult> {
  if (input.request.method !== 'GET') return { matched: false };
  const route = parseReadRoute(input.url.pathname);
  if (!route) return { matched: false };
  try {
    switch (route.kind) {
      case 'workspaces':
        return matched(await listWorkspaces(input.context, input.url));
      case 'workspace_sessions':
        return matched(await listWorkspaceSessions(input.context, input.url, route.workspaceId));
      case 'sessions':
        return matched(await listSessions(input.context, input.url));
      case 'session':
        requireNoQuery(input.url);
        return matched(await getSession(input.context, route.sessionId));
      case 'history':
        return matched(await listHistory(input.context, input.url, route.sessionId));
      case 'checkpoints':
        return matched(await listCheckpoints(input.context, input.url, route.sessionId));
      case 'checkpoint_preview':
        requireNoQuery(input.url);
        return matched(await previewCheckpoint(input.context, route.sessionId, route.checkpointId));
    }
  } catch (error) {
    const failure = normalizeFailure(error);
    return {
      matched: true,
      result: {
        ok: false,
        status: failure.status,
        code: failure.code,
        retryable: failure.retryable,
      },
    };
  }
}

export function isAgentApiReadRequest(request: Request, url: URL): boolean {
  return request.method === 'GET' && parseReadRoute(url.pathname) !== undefined;
}

function matched(
  result: Extract<AgentApiReadDispatchResult, { matched: true }>['result'],
): AgentApiReadDispatchResult {
  return { matched: true, result };
}

function parseReadRoute(pathname: string):
  | { readonly kind: 'sessions' }
  | { readonly kind: 'workspaces' }
  | { readonly kind: 'workspace_sessions'; readonly workspaceId: string }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'history'; readonly sessionId: string }
  | { readonly kind: 'checkpoints'; readonly sessionId: string }
  | {
      readonly kind: 'checkpoint_preview';
      readonly sessionId: string;
      readonly checkpointId: string;
    }
  | undefined {
  if (pathname === '/v1/sessions') return { kind: 'sessions' };
  const segments = pathname.split('/');
  if (pathname === '/v1/workspaces') return { kind: 'workspaces' };
  if (
    segments.length === 5 &&
    segments[0] === '' &&
    segments[1] === 'v1' &&
    segments[2] === 'workspaces' &&
    segments[4] === 'sessions'
  ) {
    const workspaceId = decodeIdentifier(segments[3]);
    return workspaceId ? { kind: 'workspace_sessions', workspaceId } : undefined;
  }
  if (
    segments.length < 4 ||
    segments[0] !== '' ||
    segments[1] !== 'v1' ||
    segments[2] !== 'sessions'
  ) {
    return undefined;
  }
  const sessionId = decodeIdentifier(segments[3]);
  if (!sessionId) return undefined;
  if (segments.length === 4) return { kind: 'session', sessionId };
  if (segments.length === 5 && segments[4] === 'history') return { kind: 'history', sessionId };
  if (segments.length === 5 && segments[4] === 'checkpoints') {
    return { kind: 'checkpoints', sessionId };
  }
  if (segments.length === 7 && segments[4] === 'checkpoints' && segments[6] === 'preview') {
    const checkpointId = decodeIdentifier(segments[5]);
    return checkpointId ? { kind: 'checkpoint_preview', sessionId, checkpointId } : undefined;
  }
  return undefined;
}

async function listWorkspaces(
  context: AgentApiReadContext,
  url: URL,
): Promise<{ readonly ok: true; readonly body: AgentApiWorkspacePage }> {
  const directory = requireDirectory(context);
  const query = exactQuery(url, ['cursor', 'limit']);
  const limit = pageLimit(query.get('limit'));
  const entries = [...directory.list()];
  const encodedCursor = query.get('cursor');
  let start = 0;
  if (encodedCursor) {
    const cursor = decodeWorkspaceCursor(encodedCursor);
    const index = entries.findIndex((entry) => entry.workspaceId === cursor.workspace_id);
    if (index < 0) throw new ReadFailure(409, 'cursor_invalidated', false);
    start = index + 1;
  }
  const selected = entries.slice(start, start + limit);
  const hasMore = start + selected.length < entries.length;
  const nextCursor =
    hasMore && selected.length > 0
      ? encodeCursor({
          schema: 'kite.agent-api.cursor.workspaces.v1',
          collection: 'workspaces',
          workspace_id: selected.at(-1)!.workspaceId,
        } satisfies WorkspaceCursorPayload)
      : undefined;
  return {
    ok: true,
    body: encodeAgentApiResponse(agentApiWorkspacePageSchema, {
      schema: 'kite.agent-api.workspace-page.v1',
      items: selected.map((entry) => ({
        schema: 'kite.agent-api.workspace.v1' as const,
        workspace_id: entry.workspaceId,
        display_name: shortText(entry.displayName),
        session_count: entry.sessions.length,
      })),
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    }),
  };
}

async function listWorkspaceSessions(
  context: AgentApiReadContext,
  url: URL,
  workspaceId: string,
): Promise<{ readonly ok: true; readonly body: AgentApiSessionPage }> {
  const directory = requireDirectory(context);
  const workspace = directory.list().find((entry) => entry.workspaceId === workspaceId);
  if (!workspace) throw new ReadFailure(404, 'not_found', false);
  const query = exactQuery(url, ['cursor', 'lifecycle', 'limit', 'status']);
  const lifecycle = optionalEnum(query.get('lifecycle'), ['open', 'closed', 'unavailable']);
  const status = optionalEnum(query.get('status'), [
    'idle',
    'queued',
    'running',
    'waiting',
    'error',
    'unavailable',
  ]);
  const projected = await mapConcurrent(
    workspace.sessions,
    SESSION_JOIN_CONCURRENCY,
    async (entry) => {
      const result = await querySession(context, entry.sessionId);
      return result
        ? projectSession(result, {
            sessionId: entry.sessionId,
            displayName: entry.name,
            updatedAt: entry.updatedAt,
            lastSequence: entry.lastSequence,
            needsSmartName: false,
          })
        : undefined;
    },
  );
  const filtered = projected.filter((item): item is AgentApiSession => {
    if (!item) return false;
    return (
      (lifecycle === undefined || item.lifecycle === lifecycle) &&
      (status === undefined || item.status === status)
    );
  });
  const encodedCursor = query.get('cursor');
  let start = 0;
  if (encodedCursor) {
    const cursor = decodeWorkspaceSessionCursor(encodedCursor, workspaceId, lifecycle, status);
    const index = filtered.findIndex((entry) => entry.session_id === cursor.session_id);
    if (index < 0) throw new ReadFailure(409, 'cursor_invalidated', false);
    start = index + 1;
  }
  const limit = pageLimit(query.get('limit'));
  const selected = filtered.slice(start, start + limit);
  const hasMore = start + selected.length < filtered.length;
  const nextCursor =
    hasMore && selected.length > 0
      ? encodeCursor({
          schema: 'kite.agent-api.cursor.workspace-sessions.v1',
          collection: 'workspace_sessions',
          workspace_id: workspaceId,
          lifecycle: lifecycle ?? null,
          status: status ?? null,
          session_id: selected.at(-1)!.session_id,
        } satisfies WorkspaceSessionCursorPayload)
      : undefined;
  return {
    ok: true,
    body: encodeAgentApiResponse(agentApiSessionPageSchema, {
      schema: 'kite.agent-api.session-page.v1',
      workspace_id: workspaceId,
      items: selected,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    }),
  };
}

function requireDirectory(context: AgentApiReadContext): AgentApiDirectoryReadPort {
  if (!context.directory) throw new ReadFailure(404, 'not_found', false);
  return context.directory;
}

async function listSessions(
  context: AgentApiReadContext,
  url: URL,
): Promise<{ readonly ok: true; readonly body: AgentApiSessionPage }> {
  const query = exactQuery(url, ['cursor', 'lifecycle', 'limit', 'status']);
  const lifecycle = optionalEnum(query.get('lifecycle'), ['open', 'closed', 'unavailable']);
  const status = optionalEnum(query.get('status'), [
    'idle',
    'queued',
    'running',
    'waiting',
    'error',
    'unavailable',
  ]);
  const limit = pageLimit(query.get('limit'));
  const encodedCursor = query.get('cursor');
  const cursor = encodedCursor ? decodeSessionCursor(encodedCursor, lifecycle, status) : undefined;
  const source = await context.history.listSessions({
    limit: Math.min(limit, 100),
    ...(cursor ? { cursor: { updatedAt: cursor.updated_at, sessionId: cursor.session_id } } : {}),
  });
  const projected = await mapConcurrent(source.entries, SESSION_JOIN_CONCURRENCY, async (entry) => {
    const result = await querySession(context, entry.sessionId);
    if (result === undefined) return undefined;
    return projectSession(result, entry);
  });
  const items = projected.filter((item): item is AgentApiSession => {
    if (!item) return false;
    return (
      (lifecycle === undefined || item.lifecycle === lifecycle) &&
      (status === undefined || item.status === status)
    );
  });
  const nextCursor =
    source.hasMore && source.nextCursor
      ? encodeCursor({
          schema: 'kite.agent-api.cursor.sessions.v1',
          collection: 'sessions',
          lifecycle: lifecycle ?? null,
          status: status ?? null,
          updated_at: source.nextCursor.updatedAt,
          session_id: source.nextCursor.sessionId,
        } satisfies SessionCursorPayload)
      : undefined;
  const body = encodeAgentApiResponse(agentApiSessionPageSchema, {
    schema: 'kite.agent-api.session-page.v1',
    items,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  });
  return { ok: true, body };
}

async function getSession(
  context: AgentApiReadContext,
  sessionId: string,
): Promise<{ readonly ok: true; readonly body: AgentApiSession; readonly etag: string }> {
  requireVisibleSession(context, sessionId);
  const projection = await querySession(context, sessionId);
  if (!projection) throw new ReadFailure(404, 'not_found', false);
  const session = projectSession(projection);
  return { ok: true, body: session, etag: sessionEtag(session.session_id, session.revision) };
}

async function listHistory(
  context: AgentApiReadContext,
  url: URL,
  sessionId: string,
): Promise<{ readonly ok: true; readonly body: AgentApiHistoryPage }> {
  requireVisibleSession(context, sessionId);
  const query = exactQuery(url, ['after_sequence', 'cursor', 'limit']);
  const limit = pageLimit(query.get('limit'));
  const encodedCursor = query.get('cursor');
  const requestedAfterSequence = optionalRevision(query.get('after_sequence'));
  if (encodedCursor && requestedAfterSequence !== undefined) {
    throw new ReadFailure(400, 'invalid_request', false);
  }
  const cursor = encodedCursor ? decodeHistoryCursor(encodedCursor, sessionId) : undefined;
  const afterSequence = cursor
    ? cursor.public_ordinal === null
      ? cursor.scan_sequence
      : Math.max(0, cursor.scan_sequence - 1)
    : requestedAfterSequence;
  const page = await historyPage(context, {
    sessionId,
    limit: Math.min(limit, AGENT_API_LIMITS.maxHistoryItems),
    ...(afterSequence === undefined ? {} : { afterSequence }),
    ...(cursor ? { beforeSequence: cursor.through_sequence + 1 } : {}),
  });
  const throughSequence = cursor?.through_sequence ?? page.observedLastSequence;
  if (cursor) await verifyHistoryBoundary(context, cursor, page.observedLastSequence);
  const expanded = page.entries.flatMap((entry) =>
    projectHistoryEntry(entry).map((item) => ({ item, entry })),
  );
  const afterFiltered = expanded.filter(({ item }) => {
    if (!cursor || cursor.public_ordinal === null) return true;
    return (
      item.sequence > cursor.scan_sequence ||
      (item.sequence === cursor.scan_sequence && item.public_ordinal > cursor.public_ordinal)
    );
  });
  const selected = afterFiltered.slice(0, limit);
  let boundaryDigest = cursor?.through_event_digest;
  const buildCandidate = async (itemCount: number) => {
    const candidateItems = selected.slice(0, itemCount);
    const hasUnreturnedPublicItem = afterFiltered.length > candidateItems.length;
    const hasMore = hasUnreturnedPublicItem || page.hasMore;
    let nextCursor: string | undefined;
    if (hasMore) {
      const lastPublic = candidateItems.at(-1)?.item;
      const partialSource = hasUnreturnedPublicItem && lastPublic !== undefined;
      const scanSequence = partialSource
        ? lastPublic.sequence
        : (page.entries.at(-1)?.sequence ?? cursor?.scan_sequence ?? 0);
      const publicOrdinal = partialSource ? lastPublic.public_ordinal : null;
      boundaryDigest ??= await historyBoundaryDigest(context, sessionId, throughSequence);
      nextCursor = encodeCursor({
        schema: 'kite.agent-api.cursor.history.v1',
        collection: 'history',
        session_id: sessionId,
        through_sequence: throughSequence,
        through_event_digest: boundaryDigest,
        scan_sequence: scanSequence,
        public_ordinal: publicOrdinal,
      } satisfies HistoryCursorPayload);
    }
    const candidate = {
      schema: 'kite.agent-api.history-page.v1' as const,
      session_id: sessionId,
      through_sequence: throughSequence,
      items: candidateItems.map(({ item }) => item),
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    };
    return {
      body: candidate,
      bytes: utf8ByteLength(JSON.stringify(candidate)),
    };
  };
  const full = await buildCandidate(selected.length);
  if (full.bytes <= AGENT_API_LIMITS.maxMessageBytes) {
    return { ok: true, body: encodeAgentApiResponse(agentApiHistoryPageSchema, full.body) };
  }
  let lower = 1;
  let upper = selected.length - 1;
  let bounded: Awaited<ReturnType<typeof buildCandidate>> | undefined;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = await buildCandidate(middle);
    if (candidate.bytes <= AGENT_API_LIMITS.maxMessageBytes) {
      bounded = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  if (!bounded) throw new ReadFailure(503, 'temporarily_unavailable');
  return { ok: true, body: encodeAgentApiResponse(agentApiHistoryPageSchema, bounded.body) };
}

async function listCheckpoints(
  context: AgentApiReadContext,
  url: URL,
  sessionId: string,
): Promise<{ readonly ok: true; readonly body: AgentApiCheckpointPage }> {
  requireVisibleSession(context, sessionId);
  const query = exactQuery(url, ['cursor', 'limit']);
  const limit = pageLimit(query.get('limit'));
  const encodedCursor = query.get('cursor');
  const cursor = encodedCursor ? decodeCheckpointCursor(encodedCursor, sessionId) : undefined;
  if (!(await querySession(context, sessionId))) throw new ReadFailure(404, 'not_found', false);
  const page = context.checkpoints.list({
    sessionId,
    limit,
    ...(cursor
      ? { cursor: { revision: cursor.revision, checkpointId: cursor.checkpoint_id } }
      : {}),
  });
  const items = page.entries.map(projectCheckpoint);
  const nextCursor =
    page.hasMore && page.nextCursor
      ? encodeCursor({
          schema: 'kite.agent-api.cursor.checkpoints.v1',
          collection: 'checkpoints',
          session_id: sessionId,
          revision: page.nextCursor.revision,
          checkpoint_id: page.nextCursor.checkpointId,
        } satisfies CheckpointCursorPayload)
      : undefined;
  return {
    ok: true,
    body: encodeAgentApiResponse(agentApiCheckpointPageSchema, {
      schema: 'kite.agent-api.checkpoint-page.v1',
      session_id: sessionId,
      items,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    }),
  };
}

async function previewCheckpoint(
  context: AgentApiReadContext,
  sessionId: string,
  checkpointId: string,
): Promise<{ readonly ok: true; readonly body: AgentApiCheckpointPreview; readonly etag: string }> {
  requireVisibleSession(context, sessionId);
  const metadata = context.checkpoints.get(sessionId, checkpointId);
  if (!metadata) throw new ReadFailure(404, 'not_found', false);
  const result = await runtimeQuery(context, {
    schema: 'kite.runtime-query.v1',
    type: 'get_rewind_preview',
    sessionId,
    checkpointId,
  });
  if (result.status !== 'ok') {
    if (result.code === 'checkpoint_unavailable') {
      throw new ReadFailure(409, 'checkpoint_unavailable', false);
    }
    if (result.status === 'not_found') throw new ReadFailure(404, 'not_found', false);
    throw new ReadFailure(503, 'temporarily_unavailable');
  }
  if (!result.rewindPreview || result.revision === undefined) {
    throw new ReadFailure(503, 'temporarily_unavailable');
  }
  const body = encodeAgentApiResponse(agentApiCheckpointPreviewSchema, {
    schema: 'kite.agent-api.checkpoint-preview.v1',
    checkpoint: projectCheckpoint(metadata),
    current_revision: result.revision,
    files: {
      changed: result.rewindPreview.files.length,
      conflicted: result.rewindPreview.conflictCount,
      additions: result.rewindPreview.addedLines,
      deletions: result.rewindPreview.removedLines,
    },
    conflict_summaries: [],
  });
  return { ok: true, body, etag: sessionEtag(sessionId, result.revision) };
}

async function querySession(
  context: AgentApiReadContext,
  sessionId: string,
): Promise<RuntimeSessionProjection | undefined> {
  const result = await runtimeQuery(context, {
    schema: 'kite.runtime-query.v1',
    type: 'get_session_projection',
    sessionId,
  });
  if (result.status === 'ok') {
    if (result.session) return result.session;
    throw new ReadFailure(503, 'temporarily_unavailable');
  }
  if (result.status === 'not_found' || result.code === 'session_not_found') return undefined;
  throw new ReadFailure(503, 'temporarily_unavailable');
}

async function runtimeQuery(
  context: AgentApiReadContext,
  query: RuntimeQuery,
): Promise<RuntimeQueryResult> {
  try {
    return await context.query(query);
  } catch (error) {
    const protocol = objectValue(error, 'protocol');
    const protocolCode = directString(objectValue(protocol, 'data'), 'code');
    if (protocolCode === 'unauthorized') {
      return { status: 'not_found', queryType: query.type, code: 'session_not_found' };
    }
    throw new ReadFailure(503, 'temporarily_unavailable');
  }
}

async function historyPage(
  context: AgentApiReadContext,
  request: Omit<Parameters<RuntimeHistoryClient['listEvents']>[0], 'direction'>,
) {
  try {
    return await context.history.listEvents({ ...request, direction: 'forward' });
  } catch (error) {
    const code = directString(error, 'code');
    if (code === 'session_not_found') throw new ReadFailure(404, 'not_found', false);
    throw new ReadFailure(503, 'temporarily_unavailable');
  }
}

function projectSession(
  projection: RuntimeSessionProjection,
  fallback?: RuntimeLogSessionEntry,
): AgentApiSession {
  const active = projection.interactionQueue.interactions.find(
    (interaction) => interaction.interactionId === projection.interactionQueue.activeInteractionId,
  );
  const updatedAt =
    exactTimestamp(projection.updatedAt) ??
    (fallback ? timestampFromUnix(fallback.updatedAt) : undefined);
  const model =
    projection.model &&
    validIdentifier(projection.model.provider) &&
    validIdentifier(projection.model.name)
      ? {
          provider: projection.model.provider,
          name: projection.model.name,
          ...(projection.model.reasoningEnabled === undefined
            ? {}
            : { reasoning_enabled: projection.model.reasoningEnabled }),
        }
      : undefined;
  return encodeAgentApiResponse(agentApiSessionSchema, {
    schema: 'kite.agent-api.session.v1',
    session_id: projection.sessionId,
    revision: projection.revision,
    ...(projection.displayName || fallback?.displayName
      ? { display_name: shortText(projection.displayName ?? fallback!.displayName) }
      : {}),
    lifecycle: projection.lifecycle,
    status: sessionStatus(projection, active !== undefined),
    ...(active
      ? {
          active_interaction: {
            interaction_id: active.interactionId,
            session_revision: projection.revision,
            kind: active.kind,
          },
        }
      : {}),
    ...(model ? { model } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(fallback ? { last_sequence: fallback.lastSequence } : {}),
  });
}

function sessionStatus(
  projection: RuntimeSessionProjection,
  hasActiveInteraction: boolean,
): AgentApiSession['status'] {
  if (projection.lifecycle === 'unavailable') return 'unavailable';
  if (hasActiveInteraction) return 'waiting';
  switch (projection.activeWork?.status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'failed':
      return 'error';
    default:
      return 'idle';
  }
}

function projectCheckpoint(metadata: AgentApiCheckpointMetadata): AgentApiCheckpoint {
  return {
    schema: 'kite.agent-api.checkpoint.v1',
    checkpoint_id: metadata.checkpointId,
    session_id: metadata.sessionId,
    revision: metadata.revision,
    scope: metadata.affectedFileCount > 0 ? 'conversation_and_workspace' : 'conversation_only',
    created_at: timestampFromUnix(metadata.createdAt),
  };
}

function projectHistoryEntry(entry: RuntimeLogEventEntry): AgentApiHistoryItem[] {
  const occurredAt = exactTimestamp(entry.occurredAt) ?? timestampFromUnix(entry.createdAt);
  const fields = entry.detail?.fields;
  if (entry.type === 'user.message_appended') {
    const messageId = stringValue(fields?.message_id);
    const text = stringValue(fields?.content);
    if (!messageId || text === undefined) return [];
    return [
      {
        schema: 'kite.agent-api.history-item.v1',
        session_id: entry.sessionId,
        sequence: entry.sequence,
        public_ordinal: 0,
        occurred_at: occurredAt,
        content: { type: 'user.message', message_id: messageId, text: boundedUtf8(text, 65_536) },
      },
    ];
  }
  if (entry.type === 'model.responded') {
    const messageId = stringValue(fields?.message_id);
    const requestId = stringValue(fields?.request_id);
    const reasoning = stringValue(fields?.reasoning_text);
    const text = stringValue(fields?.text);
    const items: AgentApiHistoryItem[] = [];
    if (requestId && reasoning) {
      items.push({
        schema: 'kite.agent-api.history-item.v1',
        session_id: entry.sessionId,
        sequence: entry.sequence,
        public_ordinal: 0,
        occurred_at: occurredAt,
        content: {
          type: 'model.reasoning',
          request_id: requestId,
          text: boundedUtf8(reasoning, 65_536),
        },
      });
    }
    if (messageId && text) {
      items.push({
        schema: 'kite.agent-api.history-item.v1',
        session_id: entry.sessionId,
        sequence: entry.sequence,
        public_ordinal: 1,
        occurred_at: occurredAt,
        content: {
          type: 'model.message',
          message_id: messageId,
          text: boundedUtf8(text, 65_536),
        },
      });
    }
    return items;
  }
  if (entry.type.startsWith('tool.')) {
    const toolCallId = stringValue(fields?.tool_call_id);
    const label = stringValue(fields?.label);
    if (!toolCallId || !label) return [];
    const statuses: Readonly<
      Record<string, 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>
    > = {
      'tool.queued': 'queued',
      'tool.started': 'running',
      'tool.finished': 'completed',
      'tool.failed': 'failed',
      'tool.rejected': 'failed',
      'tool.cancelled': 'cancelled',
    };
    const status = statuses[entry.type];
    if (!status) return [];
    return [
      {
        schema: 'kite.agent-api.history-item.v1',
        session_id: entry.sessionId,
        sequence: entry.sequence,
        public_ordinal: 0,
        occurred_at: occurredAt,
        content: {
          type: 'tool.lifecycle',
          tool_call_id: toolCallId,
          label: shortText(label),
          status,
        },
      },
    ];
  }
  return [];
}

async function verifyHistoryBoundary(
  context: AgentApiReadContext,
  cursor: HistoryCursorPayload,
  observedLastSequence: number,
): Promise<void> {
  if (observedLastSequence < cursor.through_sequence) {
    throw new ReadFailure(409, 'cursor_invalidated', false);
  }
  const digest = await historyBoundaryDigest(context, cursor.session_id, cursor.through_sequence);
  if (digest !== cursor.through_event_digest) {
    throw new ReadFailure(409, 'cursor_invalidated', false);
  }
}

async function historyBoundaryDigest(
  context: AgentApiReadContext,
  sessionId: string,
  throughSequence: number,
): Promise<string> {
  if (throughSequence === 0) return digestText('kite.agent-api.history.empty.v1');
  const page = await historyPage(context, {
    sessionId,
    afterSequence: throughSequence - 1,
    beforeSequence: throughSequence + 1,
    limit: 1,
  });
  const boundary = page.entries[0];
  if (!boundary || boundary.sequence !== throughSequence) {
    throw new ReadFailure(409, 'cursor_invalidated', false);
  }
  return digestText(`kite.agent-api.history.boundary.v1\0${boundary.eventId}`);
}

function exactQuery(url: URL, allowed: readonly string[]): URLSearchParams {
  const allowedSet = new Set(allowed);
  const seen = new Set<string>();
  for (const [name] of url.searchParams) {
    if (!allowedSet.has(name) || seen.has(name))
      throw new ReadFailure(400, 'invalid_request', false);
    seen.add(name);
  }
  return url.searchParams;
}

function requireNoQuery(url: URL): void {
  if (url.search.length !== 0) throw new ReadFailure(400, 'invalid_request', false);
}

function requireVisibleSession(context: AgentApiReadContext, sessionId: string): void {
  if (
    context.directory &&
    !context.directory
      .list()
      .some((workspace) => workspace.sessions.some((session) => session.sessionId === sessionId))
  ) {
    throw new ReadFailure(404, 'not_found', false);
  }
}

function pageLimit(value: string | null): number {
  if (value === null) return DEFAULT_PAGE_LIMIT;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new ReadFailure(400, 'invalid_request', false);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > AGENT_API_LIMITS.maxPageLimit) {
    throw new ReadFailure(400, 'invalid_request', false);
  }
  return parsed;
}

function optionalRevision(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new ReadFailure(400, 'invalid_request', false);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ReadFailure(400, 'invalid_request', false);
  return parsed;
}

function optionalEnum<Value extends string>(
  value: string | null,
  allowed: readonly Value[],
): Value | undefined {
  if (value === null) return undefined;
  return allowed.includes(value as Value)
    ? (value as Value)
    : (() => {
        throw new ReadFailure(400, 'invalid_request', false);
      })();
}

function encodeCursor(
  payload:
    | SessionCursorPayload
    | HistoryCursorPayload
    | CheckpointCursorPayload
    | WorkspaceCursorPayload
    | WorkspaceSessionCursorPayload,
): string {
  const canonical = JSON.stringify(payload);
  const sealed = JSON.stringify({ ...payload, checksum: cursorChecksum(canonical) });
  const encoded = Buffer.from(sealed, 'utf8').toString('base64url');
  if (encoded.length > AGENT_API_LIMITS.maxCursorBytes) {
    throw new ReadFailure(503, 'temporarily_unavailable');
  }
  return encoded;
}

function decodeWorkspaceCursor(value: string): WorkspaceCursorPayload {
  const record = cursorRecord(value);
  exactKeys(record, ['checksum', 'collection', 'schema', 'workspace_id']);
  const payload: WorkspaceCursorPayload = {
    schema: literal(record.schema, 'kite.agent-api.cursor.workspaces.v1'),
    collection: literal(record.collection, 'workspaces'),
    workspace_id: identifier(record.workspace_id),
  };
  verifyCursor(record.checksum, payload);
  return payload;
}

function decodeWorkspaceSessionCursor(
  value: string,
  workspaceId: string,
  lifecycle: string | undefined,
  status: string | undefined,
): WorkspaceSessionCursorPayload {
  const record = cursorRecord(value);
  exactKeys(record, [
    'checksum',
    'collection',
    'lifecycle',
    'schema',
    'session_id',
    'status',
    'workspace_id',
  ]);
  const payload: WorkspaceSessionCursorPayload = {
    schema: literal(record.schema, 'kite.agent-api.cursor.workspace-sessions.v1'),
    collection: literal(record.collection, 'workspace_sessions'),
    workspace_id: identifier(record.workspace_id),
    lifecycle: nullableString(record.lifecycle),
    status: nullableString(record.status),
    session_id: identifier(record.session_id),
  };
  verifyCursor(record.checksum, payload);
  if (
    payload.workspace_id !== workspaceId ||
    payload.lifecycle !== (lifecycle ?? null) ||
    payload.status !== (status ?? null)
  ) {
    throw new ReadFailure(400, 'invalid_cursor', false);
  }
  return payload;
}

function decodeSessionCursor(
  value: string,
  lifecycle: string | undefined,
  status: string | undefined,
): SessionCursorPayload {
  const record = cursorRecord(value);
  exactKeys(record, [
    'checksum',
    'collection',
    'lifecycle',
    'schema',
    'session_id',
    'status',
    'updated_at',
  ]);
  const payload: SessionCursorPayload = {
    schema: literal(record.schema, 'kite.agent-api.cursor.sessions.v1'),
    collection: literal(record.collection, 'sessions'),
    lifecycle: nullableString(record.lifecycle),
    status: nullableString(record.status),
    updated_at: safeRevision(record.updated_at),
    session_id: identifier(record.session_id),
  };
  verifyCursor(record.checksum, payload);
  if (payload.lifecycle !== (lifecycle ?? null) || payload.status !== (status ?? null)) {
    throw new ReadFailure(400, 'invalid_cursor', false);
  }
  return payload;
}

function decodeHistoryCursor(value: string, sessionId: string): HistoryCursorPayload {
  const record = cursorRecord(value);
  exactKeys(record, [
    'checksum',
    'collection',
    'public_ordinal',
    'scan_sequence',
    'schema',
    'session_id',
    'through_event_digest',
    'through_sequence',
  ]);
  const payload: HistoryCursorPayload = {
    schema: literal(record.schema, 'kite.agent-api.cursor.history.v1'),
    collection: literal(record.collection, 'history'),
    session_id: identifier(record.session_id),
    through_sequence: safeRevision(record.through_sequence),
    through_event_digest: digest(record.through_event_digest),
    scan_sequence: safeRevision(record.scan_sequence),
    public_ordinal: record.public_ordinal === null ? null : safeRevision(record.public_ordinal),
  };
  verifyCursor(record.checksum, payload);
  if (payload.session_id !== sessionId || payload.scan_sequence > payload.through_sequence) {
    throw new ReadFailure(400, 'invalid_cursor', false);
  }
  return payload;
}

function decodeCheckpointCursor(value: string, sessionId: string): CheckpointCursorPayload {
  const record = cursorRecord(value);
  exactKeys(record, [
    'checksum',
    'checkpoint_id',
    'collection',
    'revision',
    'schema',
    'session_id',
  ]);
  const payload: CheckpointCursorPayload = {
    schema: literal(record.schema, 'kite.agent-api.cursor.checkpoints.v1'),
    collection: literal(record.collection, 'checkpoints'),
    session_id: identifier(record.session_id),
    revision: safeRevision(record.revision),
    checkpoint_id: identifier(record.checkpoint_id),
  };
  verifyCursor(record.checksum, payload);
  if (payload.session_id !== sessionId) throw new ReadFailure(400, 'invalid_cursor', false);
  return payload;
}

function cursorRecord(value: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > AGENT_API_LIMITS.maxCursorBytes) {
    throw new ReadFailure(400, 'invalid_cursor', false);
  }
  try {
    const bytes = Buffer.from(value, 'base64url');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new ReadFailure(400, 'invalid_cursor', false);
  }
}

function verifyCursor(
  candidate: unknown,
  payload:
    | SessionCursorPayload
    | HistoryCursorPayload
    | CheckpointCursorPayload
    | WorkspaceCursorPayload
    | WorkspaceSessionCursorPayload,
): void {
  if (
    typeof candidate !== 'string' ||
    !CURSOR_CHECKSUM_PATTERN.test(candidate) ||
    candidate !== cursorChecksum(JSON.stringify(payload))
  ) {
    throw new ReadFailure(400, 'invalid_cursor', false);
  }
}

function cursorChecksum(canonical: string): string {
  return digestText(`kite.agent-api.cursor.checksum.v1\0${canonical}`);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new ReadFailure(400, 'invalid_cursor', false);
  }
}

function literal<Value extends string>(value: unknown, expected: Value): Value {
  if (value !== expected) throw new ReadFailure(400, 'invalid_cursor', false);
  return expected;
}

function nullableString(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new ReadFailure(400, 'invalid_cursor', false);
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !validIdentifier(value)) {
    throw new ReadFailure(400, 'invalid_cursor', false);
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !CURSOR_CHECKSUM_PATTERN.test(value)) {
    throw new ReadFailure(400, 'invalid_cursor', false);
  }
  return value;
}

function safeRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ReadFailure(400, 'invalid_cursor', false);
  }
  return value as number;
}

function decodeIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return validIdentifier(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function validIdentifier(value: string): boolean {
  return agentApiIdentifierSchema.safeParse(value).success;
}

function exactTimestamp(value: string | undefined): string | undefined {
  return value && agentApiTimestampSchema.safeParse(value).success ? value : undefined;
}

function timestampFromUnix(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ReadFailure(503, 'temporarily_unavailable');
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  try {
    const timestamp = new Date(milliseconds).toISOString();
    if (!agentApiTimestampSchema.safeParse(timestamp).success) throw new Error();
    return timestamp;
  } catch {
    throw new ReadFailure(503, 'temporarily_unavailable');
  }
}

function shortText(value: string): string {
  return boundedUtf8(value.replace(/[\r\n]/gu, ' '), AGENT_API_LIMITS.maxShortTextBytes);
}

function boundedUtf8(value: string, maximum: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result;
}

function sessionEtag(sessionId: string, revision: number): string {
  return `"session:${sessionId}:rev:${revision}"`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function directString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function objectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeFailure(error: unknown): ReadFailure {
  return error instanceof ReadFailure ? error : new ReadFailure(503, 'temporarily_unavailable');
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  project: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await project(values[index]!, index);
      }
    }),
  );
  return results;
}
