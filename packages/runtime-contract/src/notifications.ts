import type { RuntimeSessionProjection } from './projections';

export const RUNTIME_NOTIFICATION_SCHEMA_ = 'kite.runtime-notification.v1' as const;

export interface RuntimeProjectionDelta {
  readonly kind: 'snapshot' | 'session' | 'work' | 'turn' | 'interaction' | 'evidence';
  readonly session: RuntimeSessionProjection;
  /** Neutral client notification projected by the App-owned adapter. */
  readonly event?: RuntimeNotificationEvent;
}

export type RuntimeNotificationEvent = Readonly<{ type: string } & Record<string, unknown>>;

export type RuntimeStreamPayload =
  | { readonly type: 'model_delta'; readonly text: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  | {
      readonly type: 'tool_progress';
      readonly toolId: string;
      readonly status: 'started' | 'progress' | 'completed' | 'failed';
      readonly summary?: string;
      readonly stream?: 'stdout' | 'stderr';
      readonly lineCount?: number;
    };

export type RuntimeNotification =
  | {
      readonly schema: typeof RUNTIME_NOTIFICATION_SCHEMA_;
      readonly durability: 'durable';
      readonly sessionId: string;
      readonly revision: number;
      readonly projection: RuntimeProjectionDelta;
    }
  | {
      readonly schema: typeof RUNTIME_NOTIFICATION_SCHEMA_;
      readonly durability: 'ephemeral';
      readonly sessionId: string;
      readonly workId: string;
      readonly turnId: string;
      readonly actorId: string;
      readonly attemptId: string;
      readonly compositionRevision: string;
      readonly streamId: string;
      readonly sequence: number;
      readonly payload: RuntimeStreamPayload;
    };

export interface RuntimeSubscription {
  readonly sessionId: string;
  readonly afterRevision?: number;
  readonly signal?: AbortSignal;
}
