import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import type { SupportedChatModel } from '@kite-ai/builtin-runtime/model';
import type {
  AgentPhase,
  RuntimeCheckpointProjection,
  RuntimeCommandReceipt,
  RuntimeRewindPreviewProjection,
  RuntimeSessionProjection,
  SkillManifest,
} from '@kite-ai/runtime-contract';
import type { AgentConfig } from '#kite-cli/config';
import type { SessionDeps, SessionManager } from '#kite-cli/runtime/session';
import type {
  McpRecoveryController,
  SessionListProjection,
  SessionPresentationAction,
  SessionStatusProjection,
  SessionUserInputProvider,
} from '#kite-cli/runtime/session/contracts';
import type { AppShellExecutor } from '#kite-cli/sandbox/composition';
import type { SessionData, SessionInfo } from '#kite-cli/session-types';
import type {
  ContextCompactionResult,
  RuntimePresentationEvent,
} from '#kite-cli/tui/runtime-presentation';

/** The only Runtime/History values needed by the current TUI presentation. */
export interface TuiSessionFacade {
  readonly threadId: string;
  readonly workspace: string;
  readonly agentLoopActive: boolean;
  pendingInterrupt: boolean;
  readonly name: string;
  eventBuffer: RuntimePresentationEvent[];
  config: AgentConfig;
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
    initialSkillActivations?: Array<{ skillId: string; input: Record<string, unknown> }>,
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
  provider: SessionUserInputProvider;
  config: AgentConfig;
  model?: SupportedChatModel;
}

/** Closed client facade used by TUI code; no SessionManager passthrough. */
export interface TuiRuntimeClientFacade {
  createSession(workspace: string): string;
  registerSession(sessionId: string, workspace: string): TuiSessionFacade;
  hasRuntime(sessionId: string): boolean;
  getRuntime(sessionId: string): TuiSessionFacade | undefined;
  forkRecoveredSessionForContinuation(sessionId: string): TuiSessionFacade | undefined;
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
  setSessionConfig(
    threadId: string,
    config: AgentConfig,
    options?: { persist?: boolean; asDefault?: boolean },
  ): boolean;
  getDefaultConfig(): AgentConfig;
  buildContextStatusSnapshot(
    threadId: string,
  ): ReturnType<SessionManager['buildContextStatusSnapshot']>;
  handleContextDisplay(threadId: string): string;
  handleContextCompaction(
    threadId: string,
    instructions?: string,
    onProgress?: Parameters<SessionManager['handleContextCompaction']>[2],
    onCommand?: Parameters<SessionManager['handleContextCompaction']>[3],
  ): Promise<ContextCompactionResult>;
  handleContextReset(threadId: string): Promise<ContextCompactionResult>;
  generateAndPersistSessionName(threadId: string, task: string): Promise<string | null>;
  getSessionProjection(threadId: string): Promise<RuntimeSessionProjection | null>;
  listRewindCheckpoints(threadId: string): Promise<readonly RuntimeCheckpointProjection[]>;
  previewRewind(
    threadId: string,
    snapshotId: string,
  ): Promise<RuntimeRewindPreviewProjection | null>;
  executeRewind(input: {
    sourceThreadId: string;
    snapshotId: string;
    scope: 'code_and_conversation' | 'code_only' | 'conversation_only';
    workspace: string;
  }): Promise<Awaited<ReturnType<SessionManager['executeRewind']>>>;
  clearSessionCommandGrants(threadId: string): Promise<RuntimeCommandReceipt>;
  updateSkillManifests(manifests: SkillManifest[]): void;
  updateMcpRuntimeProvider(provider: McpRuntimeProvider | null): void;
  updateMcpRecoveryController(controller: McpRecoveryController | null): void;
}

export interface TuiRuntimeClientDependencies {
  readonly workspace: string;
  readonly config: SessionDeps['config'];
  readonly provider: SessionDeps['provider'];
  readonly skillManifests: SessionDeps['skillManifests'];
  readonly skillOptions: SessionDeps['skillOptions'];
  readonly mcpManager: SessionDeps['mcpManager'];
  readonly mcpRecoveryController?: SessionDeps['mcpRecoveryController'];
  readonly checkpointPath: SessionDeps['checkpointPath'];
  readonly observabilityBridge?: SessionDeps['observabilityBridge'];
  readonly shellExecutor?: AppShellExecutor;
  readonly flushPresentation?: SessionDeps['flushPresentation'];
}

export type TuiRuntimeClientFacadeFactory = (
  dependencies: TuiRuntimeClientDependencies,
) => TuiRuntimeClientFacade;
