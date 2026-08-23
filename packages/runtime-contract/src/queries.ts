import type { RuntimeCommandErrorCode } from './commands';
import type {
  RuntimeCheckpointProjection,
  RuntimeContextProjection,
  RuntimeSessionProjection,
} from './projections';

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
      readonly rewindPreview?: RuntimeCheckpointProjection;
    }
  | {
      readonly status: 'not_found' | 'rejected' | 'unavailable';
      readonly queryType: RuntimeQuery['type'];
      readonly code: RuntimeCommandErrorCode;
    };
