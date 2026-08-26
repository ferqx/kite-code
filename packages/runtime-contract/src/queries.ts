import type { RuntimeCommandErrorCode } from './commands';
import type {
  RuntimeCheckpointProjection,
  RuntimeContextProjection,
  RuntimeRewindPreviewProjection,
  RuntimeSessionProjection,
} from './projections';
import { hasExactKeys, isIdentifier, isRecord } from './validation';

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
    default:
      return false;
  }
}

export function assertRuntimeQuery(value: unknown): asserts value is RuntimeQuery {
  if (!isRuntimeQuery(value)) throw new TypeError('Invalid RuntimeQuery');
}
