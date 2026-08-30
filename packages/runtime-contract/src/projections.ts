export const RUNTIME_PROJECTION_SCHEMA_ = 'kite.runtime-projection.v1' as const;
export const RUNTIME_RUN_PROJECTION_SCHEMA_ = 'kite.runtime-run.v1' as const;

export type RuntimeRunPhase = 'planning' | 'building';
export type RuntimeRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface RuntimeRunTerminalProjection {
  readonly reasonCode: string;
  readonly safeRetry: boolean;
  readonly recoveryEntry: 'none' | 'retry' | 'reconcile' | 'new_run' | 'operator_action';
  readonly outcomeId?: string;
}

/** Client-safe projection of the Store 8 canonical Run row. */
export interface RuntimeRunProjection {
  readonly schema: typeof RUNTIME_RUN_PROJECTION_SCHEMA_;
  readonly sessionId: string;
  readonly runId: string;
  readonly originSessionId?: string;
  readonly originRunId?: string;
  readonly phase: RuntimeRunPhase;
  readonly status: RuntimeRunStatus;
  readonly createdRevision: number;
  readonly lastRevision: number;
  readonly createdAtMs: number;
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
  readonly terminal?: RuntimeRunTerminalProjection;
}

export interface RuntimeRunPageCursor {
  readonly createdRevision: number;
  readonly runId: string;
}

export interface RuntimeEvidenceSummary {
  readonly kind: string;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'unavailable';
  readonly digest?: string;
}

export interface RuntimeInteractionBase {
  readonly interactionId: string;
  /** Current Session CAS revision that must fence settlement of this projection. */
  readonly sessionRevision: number;
  readonly title?: string;
  readonly summary?: string;
}

export interface RuntimeApprovalInteraction extends RuntimeInteractionBase {
  readonly kind: 'approval';
  /** State 27 queue generation; a response for another generation is invalid. */
  readonly generation: number;
  readonly grants: readonly ('approve_once' | 'same_command')[];
  /** Bounded original command shown for an informed approval decision. */
  readonly command?: string;
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
 * Closed, client-safe interaction vocabulary. Approval carries the bounded
 * command the user is deciding on, but still excludes cwd, provider payloads,
 * grant subjects, binding digests, and child identities. Host settlement must
 * compare this identity against State 27.
 */
export type RuntimeClientInteraction =
  | RuntimeApprovalInteraction
  | RuntimeInputInteraction
  | RuntimePlanReviewInteraction
  | RuntimeProviderActionInteraction
  | RuntimeVerificationInteraction;

/** Exact stable interaction identity; current Session settlement CAS is intentionally excluded. */
export function sameRuntimeClientInteractionIdentity(
  left: RuntimeClientInteraction,
  right: RuntimeClientInteraction,
): boolean {
  if (
    left.kind !== right.kind ||
    left.interactionId !== right.interactionId ||
    left.title !== right.title ||
    left.summary !== right.summary
  ) {
    return false;
  }
  switch (left.kind) {
    case 'approval':
      return (
        right.kind === 'approval' &&
        left.generation === right.generation &&
        sameStrings(left.grants, right.grants) &&
        left.command === right.command
      );
    case 'input':
      return (
        right.kind === 'input' &&
        left.question === right.question &&
        left.allowFreeText === right.allowFreeText &&
        sameInputOptions(left.options, right.options)
      );
    case 'plan_review':
      return (
        right.kind === 'plan_review' &&
        left.plan.planId === right.plan.planId &&
        left.plan.version === right.plan.version &&
        left.plan.structuralDigest === right.plan.structuralDigest
      );
    case 'provider_action':
      return (
        right.kind === 'provider_action' &&
        left.action === right.action &&
        left.provider.providerId === right.provider.providerId &&
        left.provider.directoryRevision === right.provider.directoryRevision
      );
    case 'verification':
      return (
        right.kind === 'verification' &&
        left.verification.verificationId === right.verification.verificationId &&
        left.verification.revision === right.verification.revision
      );
  }
}

function sameInputOptions(
  left: RuntimeInputInteraction['options'],
  right: RuntimeInputInteraction['options'],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every(
      (option, index) =>
        option.id === right[index]?.id &&
        option.label === right[index]?.label &&
        option.description === right[index]?.description,
    )
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** @deprecated Use RuntimeClientInteraction. */
export type RuntimeInteractionProjection = RuntimeClientInteraction;

/** Complete, ordered client-safe interaction state at one Session revision. */
export interface RuntimeInteractionQueueProjection {
  readonly revision: number;
  readonly activeInteractionId?: string;
  readonly interactions: readonly RuntimeClientInteraction[];
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
  /** Safe selected route; provider credentials and endpoint configuration never cross. */
  readonly model?: {
    readonly provider: string;
    readonly name: string;
    readonly reasoningEnabled?: boolean;
  };
  /** Count only; grant subjects and bindings never cross the client boundary. */
  readonly sessionCommandGrantCount?: number;
  /** Authoritative replacement set; array order is the pending interaction order. */
  readonly interactionQueue: RuntimeInteractionQueueProjection;
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
