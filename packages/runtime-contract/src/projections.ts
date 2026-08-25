export const RUNTIME_PROJECTION_SCHEMA_ = 'kite.runtime-projection.v1' as const;

export interface RuntimeEvidenceSummary {
  readonly kind: string;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'unavailable';
  readonly digest?: string;
}

export interface RuntimeInteractionProjection {
  readonly interactionId: string;
  readonly kind: 'approval' | 'input' | 'plan_review' | 'provider_action' | 'verification';
  readonly title?: string;
  readonly summary?: string;
}

export interface RuntimeTurnProjection {
  readonly turnId: string;
  readonly status: 'queued' | 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed';
  readonly summary?: string;
  readonly interaction?: RuntimeInteractionProjection;
  readonly evidence?: readonly RuntimeEvidenceSummary[];
}

export interface RuntimeWorkProjection {
  readonly workId: string;
  readonly phase: 'planning' | 'building';
  readonly status: 'queued' | 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed';
  readonly title?: string;
  readonly activeTurn?: RuntimeTurnProjection;
}

export interface RuntimeSessionProjection {
  readonly schema: typeof RUNTIME_PROJECTION_SCHEMA_;
  readonly sessionId: string;
  readonly revision: number;
  readonly displayName?: string;
  readonly workspace?: string;
  readonly updatedAt?: string;
  readonly lifecycle: 'open' | 'closed' | 'unavailable';
  readonly activeWork?: RuntimeWorkProjection;
}

export interface RuntimeCheckpointProjection {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly createdAt?: string;
  readonly summary?: string;
}

export interface RuntimeContextProjection {
  readonly sessionId: string;
  readonly revision: number;
  readonly usedTokens?: number;
  readonly availableTokens?: number;
  readonly compactionAvailable: boolean;
}
