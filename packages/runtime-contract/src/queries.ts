import type { RuntimeCommandErrorCode } from './commands';
import type {
  RuntimeCheckpointProjection,
  RuntimeContextProjection,
  RuntimeRewindPreviewProjection,
  RuntimeRunPageCursor,
  RuntimeRunPhase,
  RuntimeRunProjection,
  RuntimeRunStatus,
  RuntimeSessionProjection,
} from './projections';
import { hasExactKeys, isIdentifier, isNonNegativeSafeInteger, isRecord } from './validation';

export const RUNTIME_QUERY_SCHEMA_ = 'kite.runtime-query.v1' as const;

export type RuntimeQuery =
  | { readonly schema: typeof RUNTIME_QUERY_SCHEMA_; readonly type: 'list_sessions' }
  | {
      readonly schema: typeof RUNTIME_QUERY_SCHEMA_;
      readonly type: 'get_session_projection';
      readonly sessionId: string;
    }
  | {
      readonly schema: typeof RUNTIME_QUERY_SCHEMA_;
      readonly type: 'get_context_status';
      readonly sessionId: string;
    }
  | {
      readonly schema: typeof RUNTIME_QUERY_SCHEMA_;
      readonly type: 'list_checkpoints';
      readonly sessionId: string;
    }
  | {
      readonly schema: typeof RUNTIME_QUERY_SCHEMA_;
      readonly type: 'get_rewind_preview';
      readonly sessionId: string;
      readonly checkpointId: string;
    }
  | {
      readonly schema: typeof RUNTIME_QUERY_SCHEMA_;
      readonly type: 'get_run';
      readonly sessionId: string;
      readonly runId: string;
    }
  | {
      readonly schema: typeof RUNTIME_QUERY_SCHEMA_;
      readonly type: 'list_runs';
      readonly sessionId: string;
      readonly status?: RuntimeRunStatus;
      readonly phase?: RuntimeRunPhase;
      readonly cursor?: RuntimeRunPageCursor;
      readonly limit: number;
    };

export type RuntimeQueryResult =
  | {
      readonly status: 'ok';
      readonly queryType: RuntimeQuery['type'];
      readonly revision?: number;
      readonly sessions?: readonly RuntimeSessionProjection[];
      readonly session?: RuntimeSessionProjection;
      readonly context?: RuntimeContextProjection;
      readonly checkpoints?: readonly RuntimeCheckpointProjection[];
      readonly rewindPreview?: RuntimeRewindPreviewProjection;
      readonly run?: RuntimeRunProjection;
      readonly runs?: readonly RuntimeRunProjection[];
      readonly nextRunCursor?: RuntimeRunPageCursor;
    }
  | {
      readonly status: 'not_found' | 'rejected' | 'unavailable';
      readonly queryType: RuntimeQuery['type'];
      readonly code: RuntimeCommandErrorCode;
    };

export function isRuntimeQuery(value: unknown): value is RuntimeQuery {
  if (
    !isRecord(value) ||
    value.schema !== RUNTIME_QUERY_SCHEMA_ ||
    typeof value.type !== 'string'
  ) {
    return false;
  }
  switch (value.type) {
    case 'list_sessions':
      return hasExactKeys(value, ['schema', 'type']);
    case 'get_session_projection':
    case 'get_context_status':
    case 'list_checkpoints':
      return hasExactKeys(value, ['schema', 'type', 'sessionId']) && isIdentifier(value.sessionId);
    case 'get_rewind_preview':
      return (
        hasExactKeys(value, ['schema', 'type', 'sessionId', 'checkpointId']) &&
        isIdentifier(value.sessionId) &&
        isIdentifier(value.checkpointId)
      );
    case 'get_run':
      return (
        hasExactKeys(value, ['schema', 'type', 'sessionId', 'runId']) &&
        isIdentifier(value.sessionId) &&
        isIdentifier(value.runId)
      );
    case 'list_runs': {
      const optional = ['status', 'phase', 'cursor'].filter((key) => Object.hasOwn(value, key));
      return (
        hasExactKeys(value, ['schema', 'type', 'sessionId', 'limit', ...optional]) &&
        isIdentifier(value.sessionId) &&
        isNonNegativeSafeInteger(value.limit) &&
        value.limit >= 1 &&
        value.limit <= 200 &&
        (!Object.hasOwn(value, 'status') || isRunStatus(value.status)) &&
        (!Object.hasOwn(value, 'phase') ||
          value.phase === 'planning' ||
          value.phase === 'building') &&
        (!Object.hasOwn(value, 'cursor') || isRunCursor(value.cursor))
      );
    }
    default:
      return false;
  }
}

function isRunStatus(value: unknown): value is RuntimeRunStatus {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'waiting' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'unknown'
  );
}

function isRunCursor(value: unknown): value is RuntimeRunPageCursor {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['createdRevision', 'runId']) &&
    isNonNegativeSafeInteger(value.createdRevision) &&
    isIdentifier(value.runId)
  );
}

export function assertRuntimeQuery(value: unknown): asserts value is RuntimeQuery {
  if (!isRuntimeQuery(value)) throw new TypeError('Invalid RuntimeQuery');
}
