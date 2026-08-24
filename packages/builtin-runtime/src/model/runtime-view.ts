/**
 * Structural, read-only view of the Runtime facts consumed by Builtin model semantics.
 *
 * This is deliberately not a persisted state schema and owns no Kernel authority. The
 * Core State 27 object satisfies this view structurally at the Builtin invocation seam.
 */
export type BuiltinToolEffectClass =
  | 'read_only'
  | 'plan_only'
  | 'workspace_write'
  | 'external_side_effect'
  | 'unknown';

export type BuiltinAgentPhase = 'planning' | 'building';
export type BuiltinInteractionMode = 'accept_edits' | 'auto' | 'full';
export type BuiltinSandboxBackend = 'seatbelt' | 'bubblewrap' | 'windows_restricted_token' | 'none';

export interface BuiltinPlanDocumentView {
  readonly planId: string;
  readonly version: number;
  readonly structuralDigest: string;
  readonly steps: readonly {
    readonly id: string;
    readonly status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  }[];
}

export type BuiltinPlanningStateView =
  | { readonly kind: 'building_without_plan' }
  | { readonly kind: 'planning_empty' }
  | {
      readonly kind: 'planning_draft' | 'replanning_draft';
      readonly document: BuiltinPlanDocumentView;
      readonly revisionFeedback?: string;
    }
  | {
      readonly kind: 'awaiting_review' | 'executing' | 'completed';
      readonly document: BuiltinPlanDocumentView;
    }
  | { readonly kind: 'cancelled'; readonly document?: BuiltinPlanDocumentView };

export interface BuiltinContextCheckpointView {
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

export interface BuiltinContextTokenEstimateView {
  readonly systemTokens: number;
  readonly toolSchemaTokens: number;
  readonly transcriptTokens: number;
  readonly summaryTokens: number;
  readonly dynamicRuntimeTokens: number;
  readonly framingTokens: number;
  readonly totalInputTokens: number;
}

export interface BuiltinContextFailureView {
  readonly reason?: 'manual' | 'auto';
  readonly retryable: boolean;
  readonly requestedAtTurnId?: string;
}

export interface BuiltinContextRuntimeView {
  readonly activeCheckpoint?: BuiltinContextCheckpointView;
  readonly pendingCompaction?: {
    readonly compactionId: string;
    readonly reason: 'manual' | 'auto';
    readonly requestedAtRevision: number;
    readonly requestedAtTurnId: string;
    readonly force: boolean;
    readonly estimate: BuiltinContextTokenEstimateView;
    readonly customInstructions?: string;
  };
  readonly lastFailure?: BuiltinContextFailureView;
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

export interface BuiltinTranscriptMessageMeta {
  readonly messageId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly createdAt: string;
}

export type BuiltinTranscriptMessage =
  | (BuiltinTranscriptMessageMeta & { readonly kind: 'user'; readonly content: string })
  | (BuiltinTranscriptMessageMeta & { readonly kind: 'runtime'; readonly content: string })
  | (BuiltinTranscriptMessageMeta & {
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
  | (BuiltinTranscriptMessageMeta & {
      readonly kind: 'tool';
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
      readonly ok: boolean;
      readonly resultMeta?: object;
    });

export interface BuiltinRuntimeStateView {
  readonly activeTaskId: string | null;
  readonly tasks: Readonly<
    Record<
      string,
      {
        readonly taskId: string;
        readonly sideEffectsStarted: boolean;
        readonly planning: BuiltinPlanningStateView;
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
  readonly transcript: { readonly messages: readonly BuiltinTranscriptMessage[] };
  readonly context: BuiltinContextRuntimeView;
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
          readonly effectClass?: BuiltinToolEffectClass;
        }
      >
    >;
  };
  readonly mode: BuiltinInteractionMode;
}

export function getBuiltinActiveTask(state: BuiltinRuntimeStateView) {
  return state.activeTaskId ? (state.tasks[state.activeTaskId] ?? null) : null;
}

export function getBuiltinActivePlanning(state: BuiltinRuntimeStateView): BuiltinPlanningStateView {
  return getBuiltinActiveTask(state)?.planning ?? { kind: 'building_without_plan' };
}

export function getBuiltinEffectiveInteractionMode(
  state: BuiltinRuntimeStateView,
): BuiltinInteractionMode {
  return getBuiltinActiveTask(state)?.executionMode ?? state.mode;
}

export function getBuiltinAgentPhase(planning: BuiltinPlanningStateView): BuiltinAgentPhase {
  return planning.kind === 'planning_empty' ||
    planning.kind === 'planning_draft' ||
    planning.kind === 'replanning_draft' ||
    planning.kind === 'awaiting_review'
    ? 'planning'
    : 'building';
}
