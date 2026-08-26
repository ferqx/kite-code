export const RUNTIME_PROJECTION_SCHEMA_ = 'kite.runtime-projection.v1' as const;

export interface RuntimeEvidenceSummary {
  readonly kind: string;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'unavailable';
  readonly digest?: string;
}

export interface RuntimeInteractionBase {
  readonly interactionId: string;
  /** The committed Session revision that must fence settlement. */
  readonly sessionRevision: number;
  readonly title?: string;
  readonly summary?: string;
}

export interface RuntimeApprovalInteraction extends RuntimeInteractionBase {
  readonly kind: 'approval';
  /** State 27 queue generation; a response for another generation is invalid. */
  readonly generation: number;
  readonly grants: readonly ('approve_once' | 'same_command')[];
}

export interface RuntimeInputInteraction extends RuntimeInteractionBase {
  readonly kind: 'input';
  readonly question: string;
  readonly allowFreeText: boolean;
  readonly options?: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }[];
}

export interface RuntimePlanReviewInteraction extends RuntimeInteractionBase {
  readonly kind: 'plan_review';
  readonly plan: {
    readonly planId: string;
    readonly version: number;
    readonly structuralDigest: string;
  };
}

export interface RuntimeProviderActionInteraction extends RuntimeInteractionBase {
  readonly kind: 'provider_action';
  readonly provider: {
    readonly providerId: string;
    /** Directory revision is an identity fence, not a provider configuration body. */
    readonly directoryRevision?: string;
  };
  readonly action: 'login' | 'approve' | 'retry';
}

export interface RuntimeVerificationInteraction extends RuntimeInteractionBase {
  readonly kind: 'verification';
  readonly verification: {
    readonly verificationId: string;
    readonly revision: string;
  };
}

/**
 * Closed, client-safe interaction vocabulary. It deliberately excludes cwd,
 * raw command/provider payloads, grant subjects, binding digests, and child
 * identities. Host settlement must compare this identity against State 27.
 */
export type RuntimeClientInteraction =
  | RuntimeApprovalInteraction
  | RuntimeInputInteraction
  | RuntimePlanReviewInteraction
  | RuntimeProviderActionInteraction
  | RuntimeVerificationInteraction;

/** @deprecated Use RuntimeClientInteraction. */
export type RuntimeInteractionProjection = RuntimeClientInteraction;

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
  /** Count only; grant subjects and bindings never cross the client boundary. */
  readonly sessionCommandGrantCount?: number;
  readonly activeWork?: RuntimeWorkProjection;
}

export interface RuntimeCheckpointProjection {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly eventPosition: number;
  readonly createdAt: number;
  readonly targetMessage?: string;
  readonly targetMessageCreatedAt?: number;
  readonly affectedFileCount: number;
}

/** Bounded local rewind effect preview; paths remain presentation data, not Store locators. */
export interface RuntimeRewindPreviewProjection {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly files: readonly {
    readonly path: string;
    readonly addedLines: number;
    readonly removedLines: number;
  }[];
  readonly lineStatsAvailable: boolean;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly conflictCount: number;
  readonly failureCount: number;
}

export interface RuntimeContextProjection {
  readonly sessionId: string;
  readonly revision: number;
  readonly usedTokens?: number;
  readonly availableTokens?: number;
  readonly compactionAvailable: boolean;
}
