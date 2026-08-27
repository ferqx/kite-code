import type {
  AgentPhase,
  AgentPlan,
  ContextCompactionProgressPhase,
  ContextStatusSnapshot,
  RuntimeCheckpointProjection,
  RuntimeClientEvent,
  RuntimeCommandReceipt,
  RuntimeInteractionQueueProjection,
  RuntimeRewindPreviewProjection,
  RuntimeSessionProjection,
  WorkspaceAccess,
} from '@kite-ai/runtime-contract';
import type { SessionData, SessionInfo } from '#kite-cli/session-types';
import type { RuntimePresentationEvent } from '#kite-cli/tui/runtime-presentation';

/** Presentation-only action emitted by the Native Runtime client adapter. */
export type SessionPresentationAction =
  | { readonly type: 'RUNTIME_EVENT'; readonly event: RuntimeClientEvent }
  | {
      /**
       * Authoritative activity reconciliation for a Runtime snapshot. A
       * snapshot is not a synthetic lifecycle event: it may restore the
       * currently active interaction or prove that no work remains after a
       * subscription gap.
       */
      readonly type: 'RECONCILE_RUNTIME_PROJECTION';
      readonly active: boolean;
      readonly interactionQueue: RuntimeInteractionQueueProjection;
    }
  | { readonly type: 'LOCAL_TEXT'; readonly text: string; readonly isError?: boolean }
  | { readonly type: 'SET_EXITED' }
  | {
      readonly type: 'SET_INTERACTION_MODE';
      readonly mode: 'accept_edits' | 'auto' | 'full';
    }
  | {
      readonly type: 'SET_COMPACTION_PROGRESS';
      readonly phase: ContextCompactionProgressPhase;
      readonly source: 'manual' | 'automatic';
    }
  | {
      readonly type: 'SET_COMPACTION_PROGRESS';
      readonly phase?: undefined;
      readonly source?: never;
    };

/** The service's safe session status projection, kept client-side for rendering only. */
export interface SessionStatusProjection {
  phase: AgentPhase;
  plan: AgentPlan | null;
  pendingPlan: AgentPlan | null;
  workspaceAccess: WorkspaceAccess;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRate: number;
  totalTokens: number;
  currentNode: string | null;
  modelProvider: string;
  modelName: string;
  thinkingMode: string;
  reasoningEnabled?: boolean;
  retryState: { attempt: number; maxAttempts: number; error: string; delayMs: number } | null;
  contextSnapshot?: ContextStatusSnapshot;
}

export interface SessionListProjection {
  threadId: string;
  name: string;
  workspace: string;
  active: boolean;
  running: boolean;
  pendingInterrupt: boolean;
  interrupt: null;
  plan: AgentPlan | null;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  status: SessionStatusProjection;
  turns: [];
  pendingToolCalls: Record<string, never>;
}

/** Explicit client-safe context status DTO; no SessionManager method inference. */
export type TuiContextStatusSnapshot = ContextStatusSnapshot | undefined;

/** Explicit client-safe compaction result DTO; concrete service types stay private. */
export interface TuiContextCompactionResult {
  readonly events: RuntimeClientEvent[];
  readonly text: string;
  readonly isError?: boolean;
  readonly failureCode?: 'runtime_control_unavailable';
}

export type TuiContextCompactionProgress = (
  phase: ContextCompactionProgressPhase | undefined,
) => void;

/** The only local command fact exposed to the TUI compaction presentation callback. */
export interface TuiContextCompactionCommandEvent {
  readonly type: 'user.command_invoked';
  readonly commandId: string;
  readonly command: string;
}

export type TuiContextCompactionCommand = (event: TuiContextCompactionCommandEvent) => void;

export interface TuiRewindFileOutcome {
  readonly restored: readonly string[];
  readonly deleted: readonly string[];
  readonly failed: readonly { readonly path: string; readonly error: string }[];
  readonly conflicts: readonly {
    readonly path: string;
    readonly reason: 'modified_after_kite_write' | 'unverified_postimage';
  }[];
}

/** Explicit client-safe rewind result DTO; no SessionManager return-type inference. */
export interface TuiRewindResult {
  readonly targetThreadId: string;
  readonly recoveredData: SessionData | null;
  readonly fileOutcome: TuiRewindFileOutcome | null;
}

export interface TuiRewindRequest {
  readonly sourceThreadId: string;
  readonly snapshotId: string;
  readonly scope: 'code_and_conversation' | 'code_only' | 'conversation_only';
  readonly workspace: string;
}

export interface TuiInitialSkillActivation {
  readonly skillId: string;
  readonly input: Record<string, unknown>;
}

export interface TuiModelRouteProjection {
  readonly provider: string;
  readonly name: string;
  readonly reasoningEnabled: boolean;
}

export type TuiSubmittedInteractionAction =
  | {
      readonly type: 'approve';
      readonly interactionId: string;
      readonly generation: number;
      readonly grant: import('@kite-ai/runtime-contract').ShellApprovalGrant;
    }
  | { readonly type: 'reject'; readonly interactionId: string; readonly generation: number }
  | {
      readonly type: 'input';
      readonly interactionId: string;
      readonly text: string;
      /** Closed option identity; localized labels are presentation only. */
      readonly optionId?: string;
      readonly answers?: Record<string, string>;
    }
  | { readonly type: 'cancel'; readonly interactionId: string }
  | {
      readonly type: 'plan_review_decision';
      readonly interactionId: string;
      readonly decision:
        | { readonly kind: 'approve'; readonly nextMode: 'accept_edits' | 'auto' }
        | { readonly kind: 'revise'; readonly feedback: string }
        | { readonly kind: 'cancel'; readonly reason?: string };
    };

/** The only Runtime/History values needed by the current TUI presentation. */
export interface TuiSessionFacade {
  readonly threadId: string;
  readonly workspace: string;
  readonly agentLoopActive: boolean;
  pendingInterrupt: boolean;
  readonly name: string;
  eventBuffer: RuntimePresentationEvent[];
  readonly modelProvider: string;
  readonly modelName: string;
  readonly reasoningEnabled: boolean;
  conversationHistory: string[];
  thinkingLevel: string | null;
  interactionMode: 'accept_edits' | 'auto' | 'full';
  dormant: boolean;
  localReplayRecovery: boolean;
  tryReservePrompt(): boolean;
  waitForRunCompletion(): Promise<void>;
  runTask(
    task: string,
    dependencies: TuiSessionRunDependencies,
    requestedPhase?: AgentPhase,
    initialSkillActivations?: TuiInitialSkillActivation[],
  ): Promise<void>;
  abort(): void;
  setForeground(foreground: boolean): void;
  setInteractionMode(mode: 'accept_edits' | 'auto' | 'full'): void;
  setDormant(dormant: boolean): void;
  setLocalReplayRecovery(recovered: boolean): void;
  setInteractionModeMirror(mode: 'accept_edits' | 'auto' | 'full'): void;
  setThinkingLevel(level: string | null): void;
  setConversationHistory(history: readonly string[]): void;
  appendBufferedEvents(events: readonly RuntimePresentationEvent[]): void;
}

/** Explicit run input accepted by the current InProcess adapter. */
export interface TuiSessionRunDependencies {
  dispatch: (action: SessionPresentationAction) => void;
}

/** Closed client facade used by TUI code; no SessionManager passthrough. */
export interface TuiRuntimeClientFacade {
  submitUserAction(action: TuiSubmittedInteractionAction): Promise<void>;
  createSession(workspace: string): string;
  registerSession(sessionId: string, workspace: string): TuiSessionFacade;
  hasRuntime(sessionId: string): boolean;
  getRuntime(sessionId: string): TuiSessionFacade | undefined;
  forkRecoveredSessionForContinuation(sessionId: string): Promise<TuiSessionFacade | undefined>;
  getActiveId(): string;
  switchSession(fromId: string, toId: string): void;
  getSnapshot(
    previous?: ReadonlyArray<{ threadId: string; status: SessionStatusProjection }>,
  ): SessionListProjection[];
  listPersistedSessions(query?: string): Promise<SessionInfo[]>;
  loadPersistedSession(sessionId: string): Promise<SessionData | null>;
  waitForSessionReady(sessionId: string): Promise<void>;
  removeRuntime(sessionId: string): Promise<void>;
  deletePersistedSession(sessionId: string): Promise<void>;
  cancelRuntimeOperations(sessionId: string): Promise<void>;
  abortAll(): Promise<void>;
  dispose(): Promise<void>;
  shutdownObservability(timeoutMs: number): Promise<void>;
  setSnapshotCallback(callback: (threadId: string) => void): void;
  onInterruptPending(threadId: string): void;
  onStatusChange(threadId: string): void;
  setName(threadId: string, name: string): void;
  saveTokenStats(threadId: string, status: SessionStatusProjection, immediate?: boolean): void;
  applyPersistedModelRoute(
    threadId: string,
    provider?: string,
    name?: string,
  ): TuiModelRouteProjection;
  buildContextStatusSnapshot(threadId: string): TuiContextStatusSnapshot;
  handleContextDisplay(threadId: string): string;
  handleContextCompaction(
    threadId: string,
    instructions?: string,
    onProgress?: TuiContextCompactionProgress,
    onCommand?: TuiContextCompactionCommand,
  ): Promise<TuiContextCompactionResult>;
  handleContextReset(threadId: string): Promise<TuiContextCompactionResult>;
  generateAndPersistSessionName(threadId: string, task: string): Promise<string | null>;
  getSessionProjection(threadId: string): Promise<RuntimeSessionProjection | null>;
  listRewindCheckpoints(threadId: string): Promise<readonly RuntimeCheckpointProjection[]>;
  previewRewind(
    threadId: string,
    snapshotId: string,
  ): Promise<RuntimeRewindPreviewProjection | null>;
  executeRewind(input: TuiRewindRequest): Promise<TuiRewindResult>;
  clearSessionCommandGrants(threadId: string): Promise<RuntimeCommandReceipt>;
}

export interface TuiRuntimeClientDependencies {
  readonly workspace: string;
  readonly flushPresentation?: () => Promise<void>;
}

export type TuiRuntimeClientFacadeFactory = (
  dependencies: TuiRuntimeClientDependencies,
) => TuiRuntimeClientFacade;
