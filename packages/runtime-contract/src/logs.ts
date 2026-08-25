/**
 * Client-safe, storage-neutral DTOs for the durable Runtime event log.
 * The browser transport is deliberately not modelled here: these types also
 * serve local in-process readers and must never expose SQLite or Artifact
 * implementation details.
 */
export const RUNTIME_LOG_SESSION_PAGE_MIN_LIMIT = 1;
export const RUNTIME_LOG_SESSION_PAGE_MAX_LIMIT = 100;
export const RUNTIME_LOG_EVENT_PAGE_MIN_LIMIT = 1;
export const RUNTIME_LOG_EVENT_PAGE_MAX_LIMIT = 200;
export const RUNTIME_LOG_EVENT_FILTER_MAX_TYPES = 256;

export type RuntimeLogEventCategory =
  | 'session'
  | 'turn'
  | 'model'
  | 'tool'
  | 'interaction'
  | 'subagent'
  | 'verification'
  | 'recovery'
  | 'other';

export type RuntimeLogEventStatus =
  | 'ok'
  | 'running'
  | 'waiting'
  | 'cancelled'
  | 'failed'
  | 'unknown';

export type RuntimeLogErrorCode =
  | 'invalid_request'
  | 'session_not_found'
  | 'session_unavailable'
  | 'corrupt_event'
  | 'temporarily_unavailable';

export interface RuntimeLogError {
  readonly code: RuntimeLogErrorCode;
  /** A public, path-free and SQL-free diagnostic suitable for a local UI. */
  readonly message: string;
}

export interface RuntimeLogSessionCursor {
  readonly updatedAt: number;
  readonly sessionId: string;
}

export interface ListRuntimeLogSessionsRequest {
  readonly cursor?: RuntimeLogSessionCursor;
  readonly limit: number;
  readonly query?: string;
}

export interface RuntimeLogSessionEntry {
  readonly sessionId: string;
  readonly displayName: string;
  readonly updatedAt: number;
  readonly lastSequence: number;
  readonly model?: { readonly provider: string; readonly name: string };
}

export interface RuntimeLogSessionPage {
  readonly entries: readonly RuntimeLogSessionEntry[];
  readonly nextCursor?: RuntimeLogSessionCursor;
  readonly hasMore: boolean;
}

export interface ListRuntimeLogEventsRequest {
  readonly sessionId: string;
  readonly afterSequence?: number;
  readonly beforeSequence?: number;
  readonly direction: 'forward' | 'backward';
  readonly limit: number;
  /** Current RuntimeEvent discriminants; admission is performed by the reader. */
  readonly eventTypes?: readonly string[];
}

export interface RuntimeLogArtifactReference {
  readonly kind: string;
  readonly availability: 'available' | 'unavailable';
}

/** A fixed, JSON-safe detail vocabulary. No generic event object is allowed. */
export interface RuntimeLogEventDetail {
  readonly kind:
    | 'message'
    | 'model'
    | 'tool'
    | 'interaction'
    | 'subagent'
    | 'verification'
    | 'artifact'
    | 'unavailable';
  readonly fields?: Readonly<Record<string, string | number | boolean | null>>;
  readonly artifact?: RuntimeLogArtifactReference;
}

export interface RuntimeLogEventEntry {
  readonly sessionId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly causationId?: string;
  readonly occurredAt?: string;
  readonly createdAt: number;
  readonly type: string;
  readonly category: RuntimeLogEventCategory;
  readonly status: RuntimeLogEventStatus;
  readonly summary?: string;
  readonly detail?: RuntimeLogEventDetail;
}

export interface RuntimeLogEventPage {
  readonly entries: readonly RuntimeLogEventEntry[];
  readonly nextCursor?: number;
  readonly hasMore: boolean;
  readonly observedLastSequence: number;
}

export class RuntimeLogRequestValidationError extends Error {
  readonly code = 'invalid_request' as const;

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeLogRequestValidationError';
  }
}

function assertPageLimit(
  value: unknown,
  min: number,
  max: number,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new RuntimeLogRequestValidationError(
      `${label} must be an integer from ${min} to ${max}.`,
    );
  }
}

function assertSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new RuntimeLogRequestValidationError('sessionId must be a non-empty bounded string.');
  }
}

export function assertListRuntimeLogSessionsRequest(value: ListRuntimeLogSessionsRequest): void {
  assertPageLimit(
    value.limit,
    RUNTIME_LOG_SESSION_PAGE_MIN_LIMIT,
    RUNTIME_LOG_SESSION_PAGE_MAX_LIMIT,
    'limit',
  );
  if (value.query !== undefined && (typeof value.query !== 'string' || value.query.length > 256)) {
    throw new RuntimeLogRequestValidationError('query must be a string of at most 256 characters.');
  }
  if (value.cursor !== undefined) {
    if (!Number.isSafeInteger(value.cursor.updatedAt) || value.cursor.updatedAt < 0) {
      throw new RuntimeLogRequestValidationError(
        'cursor.updatedAt must be a non-negative integer.',
      );
    }
    assertSessionId(value.cursor.sessionId);
  }
}

export function assertListRuntimeLogEventsRequest(value: ListRuntimeLogEventsRequest): void {
  assertSessionId(value.sessionId);
  assertPageLimit(
    value.limit,
    RUNTIME_LOG_EVENT_PAGE_MIN_LIMIT,
    RUNTIME_LOG_EVENT_PAGE_MAX_LIMIT,
    'limit',
  );
  if (value.direction !== 'forward' && value.direction !== 'backward') {
    throw new RuntimeLogRequestValidationError('direction must be forward or backward.');
  }
  if (value.afterSequence !== undefined && value.beforeSequence !== undefined) {
    throw new RuntimeLogRequestValidationError(
      'afterSequence and beforeSequence are mutually exclusive.',
    );
  }
  for (const cursor of [value.afterSequence, value.beforeSequence]) {
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
      throw new RuntimeLogRequestValidationError('event cursor must be a non-negative integer.');
    }
  }
  if (
    value.eventTypes !== undefined &&
    (value.eventTypes.length > RUNTIME_LOG_EVENT_FILTER_MAX_TYPES ||
      value.eventTypes.some(
        (type) => typeof type !== 'string' || type.length === 0 || type.length > 160,
      ))
  ) {
    throw new RuntimeLogRequestValidationError(
      'eventTypes must contain bounded non-empty discriminants.',
    );
  }
}
