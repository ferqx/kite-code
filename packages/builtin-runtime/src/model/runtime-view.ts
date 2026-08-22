/**
 * Structural, read-only view of the Runtime facts consumed by Builtin model semantics.
 *
 * This is deliberately not a persisted state schema and owns no Kernel authority. The
 * Core State 25 object satisfies this view structurally at the Builtin invocation seam.
 */
export type BuiltinToolEffectClassV1 =
  | 'read_only'
  | 'plan_only'
  | 'workspace_write'
  | 'external_side_effect'
  | 'unknown';

export type BuiltinAgentPhaseV1 = 'planning' | 'building';
export type BuiltinInteractionModeV1 = 'accept_edits' | 'auto' | 'full';
export type BuiltinAuthorizationModeV1 = 'default' | 'full_access';
export type BuiltinSandboxBackendV1 =
  | 'seatbelt'
  | 'bubblewrap'
  | 'windows_restricted_token'
  | 'none';

export interface BuiltinPlanDocumentViewV1 {
  readonly planId: string;
  readonly version: number;
  readonly structuralDigest: string;
  readonly steps: readonly {
    readonly id: string;
    readonly status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  }[];
}

export type BuiltinPlanningStateViewV1 =
  | { readonly kind: 'building_without_plan' }
  | { readonly kind: 'planning_empty' }
  | {
      readonly kind: 'planning_draft' | 'replanning_draft';
      readonly document: BuiltinPlanDocumentViewV1;
      readonly revisionFeedback?: string;
    }
  | {
      readonly kind: 'awaiting_review' | 'executing' | 'completed';
      readonly document: BuiltinPlanDocumentViewV1;
    }
  | { readonly kind: 'cancelled'; readonly document?: BuiltinPlanDocumentViewV1 };

export interface BuiltinContextCheckpointViewV1 {
  readonly compactionId: string;
  readonly modelInvocationId?: string;
  readonly version: 1;
  readonly sourceRevision: number;
  readonly sourceDigest: string;
  readonly coveredThroughMessageId: string;
  readonly coveredThroughTurnId: string;
  readonly summary: string;
  readonly inputTokensBefore: number;
  readonly inputTokensAfter: number;
  readonly reason: 'manual' | 'auto';
  readonly createdAt: string;
  readonly baseCheckpointId?: string;
}

export interface BuiltinContextTokenEstimateViewV1 {
  readonly systemTokens: number;
  readonly toolSchemaTokens: number;
  readonly transcriptTokens: number;
  readonly summaryTokens: number;
  readonly dynamicRuntimeTokens: number;
  readonly framingTokens: number;
  readonly totalInputTokens: number;
}

export interface BuiltinContextFailureViewV1 {
  readonly reason?: 'manual' | 'auto';
  readonly retryable: boolean;
  readonly requestedAtTurnId?: string;
}

export interface BuiltinContextRuntimeViewV1 {
  readonly activeCheckpoint?: BuiltinContextCheckpointViewV1;
  readonly pendingCompaction?: {
    readonly compactionId: string;
    readonly reason: 'manual' | 'auto';
    readonly requestedAtRevision: number;
    readonly requestedAtTurnId: string;
    readonly force: boolean;
    readonly estimate: BuiltinContextTokenEstimateViewV1;
    readonly customInstructions?: string;
  };
  readonly lastFailure?: BuiltinContextFailureViewV1;
  readonly lastCompactionTurnIndex?: number;
  readonly autoGuard: {
    readonly recentAutomaticCompactions: readonly {
      readonly turnIndex: number;
      readonly reductionRatio: number;
      readonly tokensAfter: number;
    }[];
    readonly consecutiveLowGain: number;
    readonly disabledUntilManualAction: boolean;
    readonly recoveryAttempted: boolean;
  };
}

export interface BuiltinTranscriptMessageMetaV1 {
  readonly messageId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly createdAt: string;
}

export type BuiltinTranscriptMessageV1 =
  | (BuiltinTranscriptMessageMetaV1 & { readonly kind: 'user'; readonly content: string })
  | (BuiltinTranscriptMessageMetaV1 & { readonly kind: 'runtime'; readonly content: string })
  | (BuiltinTranscriptMessageMetaV1 & {
      readonly kind: 'assistant';
      readonly content?: string;
      readonly reasoningText?: string;
      readonly toolCalls: readonly {
        readonly id: string;
        readonly name: string;
        readonly args: unknown;
        readonly canonicalInvocationFingerprint?: string;
      }[];
    })
  | (BuiltinTranscriptMessageMetaV1 & {
      readonly kind: 'tool';
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
      readonly ok: boolean;
      readonly resultMeta?: object;
    });

export interface BuiltinRuntimeStateViewV1 {
  readonly activeTaskId: string | null;
  readonly tasks: Readonly<
    Record<
      string,
      {
        readonly taskId: string;
        readonly sideEffectsStarted: boolean;
        readonly planning: BuiltinPlanningStateViewV1;
        readonly executionMode?: 'auto' | 'accept_edits';
      }
    >
  >;
  readonly revision: number;
  readonly session: { readonly workspace: string };
  readonly turn: {
    readonly turnId: string;
    readonly turnIndex: number;
    readonly status?: 'active' | 'completed' | 'aborted';
  };
  readonly transcript: { readonly messages: readonly BuiltinTranscriptMessageV1[] };
  readonly context: BuiltinContextRuntimeViewV1;
  readonly interactions: { readonly kind: string };
  readonly tools: {
    readonly calls: Readonly<
      Record<
        string,
        {
          readonly toolCallId: string;
          readonly modelMessageId: string;
          readonly args: unknown;
          readonly status: string;
          readonly effectClass?: BuiltinToolEffectClassV1;
        }
      >
    >;
  };
  readonly authorization?: { readonly mode: BuiltinAuthorizationModeV1 };
  readonly mode: BuiltinInteractionModeV1;
}

export function getBuiltinActiveTaskV1(state: BuiltinRuntimeStateViewV1) {
  return state.activeTaskId ? (state.tasks[state.activeTaskId] ?? null) : null;
}

export function getBuiltinActivePlanningV1(
  state: BuiltinRuntimeStateViewV1,
): BuiltinPlanningStateViewV1 {
  return getBuiltinActiveTaskV1(state)?.planning ?? { kind: 'building_without_plan' };
}

export function getBuiltinEffectiveInteractionModeV1(
  state: BuiltinRuntimeStateViewV1,
): BuiltinInteractionModeV1 {
  return getBuiltinActiveTaskV1(state)?.executionMode ?? state.mode;
}

export function getBuiltinAgentPhaseV1(planning: BuiltinPlanningStateViewV1): BuiltinAgentPhaseV1 {
  return planning.kind === 'planning_empty' ||
    planning.kind === 'planning_draft' ||
    planning.kind === 'replanning_draft' ||
    planning.kind === 'awaiting_review'
    ? 'planning'
    : 'building';
}
