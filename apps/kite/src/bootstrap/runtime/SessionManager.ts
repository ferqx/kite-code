import type { BuiltinToolCatalogProjectionV1 } from '@kite/builtin-runtime';
import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import {
  buildContextStatusReport,
  compactResetPreflight,
  contextCompactionTerminalNotice,
  createChatModel,
  createLocalCompactionDebugReporter,
  findSafeCompactionBoundary,
  inspectManualContextCompaction,
  manualContextCompactionEvent,
  resolveModelCapabilities,
} from '@kite/builtin-runtime/model';
import { sandboxSupportsFullModeV1 } from '@kite/builtin-runtime/sandbox';
import type {
  AgentPhase,
  ContextStatusSnapshot,
  SkillManifest,
  SkillScanOptions,
} from '@kite/runtime-contract';
import { getAgentPhase } from '@kite/runtime-contract';
import {
  runtimeHostStateActivePlanningV1 as getActivePlanning,
  runtimeHostStateActiveTaskV1 as getActiveTask,
  projectRuntimeObservabilityFactV1,
} from '@kite/runtime-host';
import { getFeatureFlags } from '#app/config/features';
import type { AgentConfig } from '#app/config/index';
import { createApprovedProviderDataAdmissionV1 } from '#app/config/provider-data-admission';
import { composeAppGitBrokerV1, resolveAppGitExecutableV1 } from '#app/git/composition';
import type { RuntimeMetricBridgeV1 } from '#app/observability/runtime-bridge';
import type { Action } from '#app/tui/App';
import { fullModeUnavailableReason } from '#app/tui/interaction-mode';
import { providerActionInput, providerAdmissionInput } from '#app/tui/mcp/runtime-interrupts';
import type { McpController } from '#app/tui/mcp/types';
import type { TuiAction, TuiInterruptPayload, TuiUserInputProvider } from '#app/tui/provider';
import { shouldProjectRunExited } from '#app/tui/run-lifecycle';
import type { SessionSnapshot, StatusState } from '#app/tui/types';
import { type AppShellExecutorV1, composeAppSandboxExecutorV1 } from '@/app/sandbox/composition';
import type {
  AuthorizedExecutionControlV1,
  RuntimeSessionCoordinatorAccessV1,
  RuntimeSessionCoordinatorIdentityV1,
  RuntimeSessionCoordinatorV1,
} from '../runtime/RuntimeSessionCoordinator';
import { previewFilesToCheckpoint, restoreFilesToCheckpoint } from './file-checkpoints';
import { buildRunAgentParams } from './runtime-agent-input';
import {
  type RuntimeExecutorDependencies,
  resolveRuntimeContextProjectionEnvironment,
} from './runtime-effect-dependencies';
import {
  deleteSession,
  generateSessionName,
  listSessions,
  loadSession,
  persistSessionName,
  searchSessions,
} from './session-persistence';
import { SessionRegistry } from './session-registry';
import type { RuntimeUserAction } from './state-actions';
import type { RuntimeActionProvider } from './state-runner';
import type {
  RuntimeEffect,
  RuntimeEvent,
  RuntimeState,
  StateSessionStorageV1,
} from './state-runtime';
import type { RuntimeTurnInputV1 } from './turn-coordinator';

function isRecoverableError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /timeout|timed out|rate limit|overloaded|\b429\b|\b5\d\d\b/.test(message);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAvailableRewindCheckpoint(
  store: StateSessionStorageV1,
  threadId: string,
  snapshotId: string,
): boolean {
  if (!store.getNamedSnapshotEntry(threadId, snapshotId)) return false;
  const snapshot = store.loadNamedSnapshot(threadId, snapshotId);
  return typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot);
}

type ModelRetry = {
  attempt?: unknown;
  maxAttempts?: unknown;
  error?: unknown;
  delayMs?: unknown;
};

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asModelRetry(value: unknown): {
  attempt: number;
  maxAttempts: number;
  error: string;
  delayMs: number;
} {
  if (!value || typeof value !== 'object') {
    return {
      attempt: 0,
      maxAttempts: 0,
      error: String(value),
      delayMs: 0,
    };
  }

  const retry = value as ModelRetry;
  const error = toErrorMessage(retry.error);
  return {
    attempt: asNumber(retry.attempt),
    maxAttempts: asNumber(retry.maxAttempts),
    error: error === '' ? String(value) : error,
    delayMs: asNumber(retry.delayMs),
  };
}

/** 取消竞态不应作为用户可见错误输出。 */
export function isSilentCancellationMismatch(event: RuntimeEvent): boolean {
  return (
    event.type === 'run.error' &&
    event.message === 'Runtime action does not match the active interaction.'
  );
}
export {
  admitInteractionModeTarget,
  fullModeUnavailableReason,
  resolveInteractionModeTarget,
} from '#app/tui/interaction-mode';

/** 可丢弃的缓冲事件类型（text/reason 为非关键信息，丢弃时不丢失用户可见状态） */
const DISPOSABLE_EVENT_TYPES = new Set([
  'text',
  'reason',
  'model.text_delta',
  'model.reasoning_delta',
  'model.reasoning_completed',
  'tool.progress',
]);

const PRESENTATION_FRAME_MS = 50;
const MAX_BUFFERED_TOOL_PROGRESS_CHARS = 16 * 1024;
const TOOL_PROGRESS_TRUNCATED_MARKER = '… progress truncated … ';

type ToolProgressEvent = Extract<RuntimeEvent, { type: 'tool.progress' }> & {
  lineCount?: number;
};

function toolProgressKey(event: ToolProgressEvent): string {
  return `${event.toolCallId}\0${event.stream}`;
}

function boundToolProgressChunk(chunk: string): string {
  if (chunk.length <= MAX_BUFFERED_TOOL_PROGRESS_CHARS) return chunk;
  const available = Math.max(
    1,
    MAX_BUFFERED_TOOL_PROGRESS_CHARS - TOOL_PROGRESS_TRUNCATED_MARKER.length,
  );
  let tail = chunk.slice(-available);
  const firstBoundary = tail.indexOf('\n');
  if (firstBoundary >= 0) tail = tail.slice(firstBoundary + 1);
  return `${TOOL_PROGRESS_TRUNCATED_MARKER}${tail}`;
}

function normalizeToolProgress(event: ToolProgressEvent): ToolProgressEvent {
  return {
    ...event,
    chunk: boundToolProgressChunk(event.chunk),
    lineCount: event.lineCount ?? event.chunk.split('\n').length,
  };
}

function mergeToolProgress(
  previous: ToolProgressEvent,
  next: ToolProgressEvent,
): ToolProgressEvent {
  const combined = `${previous.chunk}\n${next.chunk}`;
  return {
    ...next,
    chunk: boundToolProgressChunk(combined),
    lineCount:
      (previous.lineCount ?? previous.chunk.split('\n').length) +
      (next.lineCount ?? next.chunk.split('\n').length),
  };
}

/** 工厂依赖：注入到每个 SessionRuntime */
export interface SessionDeps {
  config: AgentConfig;
  provider: TuiUserInputProvider;
  skillManifests: SkillManifest[];
  skillOptions: SkillScanOptions | null;
  mcpManager: McpRuntimeProvider | null;
  /** Independent authorization source for one remote MCP content invocation. */
  mcpRecoveryController?: Pick<McpController, 'recover'> | null;
  /** checkpoint DB 路径，用于持久化 token 统计 / Checkpoint DB path for persisting token stats */
  checkpointPath: string;
  /** The only Store 4 production constructor, injected by apps/kite bootstrap. */
  openStateSessionStorage: (threadId?: string) => StateSessionStorageV1;
  /** Host-owned stable private identity for one State recovery journal. */
  resolveRecoveryIdentity: (threadId: string) => string;
  /** App-owned fresh identity allocator used only inside a new fork transaction. */
  allocateRecoveryIdentity: () => string;
  /** App projection of the Host's one frozen Builtin registry snapshot. */
  builtinToolCatalog: BuiltinToolCatalogProjectionV1;
  /** Host-owned Runtime SPI execution port; production bootstrap always injects it. */
  capabilityExecution?: RuntimeTurnInputV1['capabilityExecution'];
  /** Explicit App projection metadata port; no raw SQLite handle reaches TUI. */
  tokenStatsStorage: {
    save(
      sessionId: string,
      value: {
        cacheHitTokens: number;
        cacheMissTokens: number;
        totalTokens: number;
      },
    ): void;
    loadAll(): readonly {
      sessionId: string;
      value: {
        cacheHitTokens: number;
        cacheMissTokens: number;
        totalTokens: number;
      };
    }[];
    close(): void;
  };
  /** One shared metadata-only reporter for foreground, background and subagent Runtime events. */
  observabilityBridge?: RuntimeMetricBridgeV1;
  /** TUI-owned startup decision reused by every session and Shell invocation. */
  shellExecutor?: AppShellExecutorV1;
  /** Wait until Ink has committed and written the current presentation frame. */
  flushPresentation?: () => Promise<void>;
  /** App-owned concrete Model/Artifact/Subagent composition factory. */
  modelInvocationRuntimeFactory: (
    workspace: string,
  ) => RuntimeTurnInputV1['modelInvocationRuntime'];
  /** Optional TUI-only State coordinator supplied by Host bootstrap. */
  runtimeSessionCoordinator?: RuntimeSessionCoordinatorAccessV1;
}

export interface RuntimeProjectIdentityV1 {
  readonly projectId: string;
  readonly canonicalWorkspaceDigest: `sha256:${string}`;
}

export interface ContextCompactionCommandResult {
  events: RuntimeEvent[];
  text: string;
  isError?: boolean;
  /** Typed fail-closed reason when no live Runtime/Kernel control exists. */
  failureCode?: 'runtime_control_unavailable';
}

function contextCompactionRequiresLiveControl(): ContextCompactionCommandResult {
  return {
    events: [],
    text: 'Context compaction requires an active Runtime execution control.',
    isError: true,
    failureCode: 'runtime_control_unavailable',
  };
}

export interface PlanningModeExitResult {
  events: RuntimeEvent[];
  /** Runtime-authoritative phase after evaluating the exit request. */
  phase: AgentPhase;
}

/** 单会话运行时：持有独立的 AbortController、generator、缓冲 */
export class SessionRuntime {
  readonly threadId: string;
  readonly workspace: string;
  readonly projectId: string | undefined;
  readonly canonicalWorkspaceDigest: `sha256:${string}` | undefined;

  abortController: AbortController | null = null;
  private _activeExecutionSignal: AbortSignal | null = null;
  agentLoopActive = false;
  pendingInterrupt = false;
  eventBuffer: RuntimeEvent[] = [];
  /** true if loaded from DB and state not yet hydrated / 从 DB 加载但尚未加载完整状态 */
  dormant = false;
  /** TUI-only recovery projection hid an unfinished canonical interaction. */
  localReplayRecovery = false;
  static readonly MAX_BUFFER = 1000;

  conversationHistory: string[] = [];
  thinkingLevel: string | null = null;
  interactionMode: 'accept_edits' | 'auto' | 'full';
  config: AgentConfig;
  phase: AgentPhase = 'building';
  name: string;

  skillManifests: SkillManifest[];
  readonly skillOptions: SkillScanOptions | null;
  mcpManager: McpRuntimeProvider | null;
  mcpRecoveryController: Pick<McpController, 'recover'> | null;

  generator: AsyncGenerator<RuntimeEvent> | null = null;
  authorizedExecutionControl: AuthorizedExecutionControlV1 | null = null;
  /** Prevent repeated `/compact` commands from concurrently executing one pending checkpoint. */
  manualCompactionInFlightId: string | null = null;
  /** 当后台会话命中中断时通知 Manager 刷新快照 / Callback to notify Manager on background interrupt */
  notifyInterrupt: (() => void) | null = null;

  // ── 双模式代理：生成器始终使用 _proxyProvider，通过 _foreground 切换事件路由 ──
  private _foreground = true;
  private _foregroundWake: (() => void) | null = null;
  private _proxyProvider: Pick<TuiUserInputProvider, 'requestAction'>;
  /** 每实例独立的中断状态，不与 realProvider 共享 pendingResolve。中断永久等待用户处理 */
  private _pendingInterrupt: TuiInterruptPayload | null = null;
  private _pendingResolve: ((action: TuiAction) => void) | null = null;
  private _activeDispatch: ((action: Action) => void) | null = null;
  private _contentLoggingDisclosureShown = false;
  private readonly _observabilityBridge: RuntimeMetricBridgeV1 | undefined;
  private readonly _shellExecutor: AppShellExecutorV1 | undefined;
  /** Executor whose prepare() promise currently owns this run's startup boundary. */
  private _preparingShellExecutor: AppShellExecutorV1 | null = null;
  private readonly _flushPresentation: (() => Promise<void>) | undefined;
  private readonly _modelInvocationRuntimeFactory: SessionDeps['modelInvocationRuntimeFactory'];
  private readonly _resolveRecoveryIdentity: SessionDeps['resolveRecoveryIdentity'];
  private readonly _capabilityExecution: SessionDeps['capabilityExecution'];
  private readonly _runtimeSessionCoordinator: SessionDeps['runtimeSessionCoordinator'];
  /**
   * Remains pending while the previous generator is unwinding after abort().
   * abort() clears the user-visible running flag immediately, but a new run
   * must not enter the same StateSessionStorageV1 until the old loop has closed.
   */
  private _runCompletion: Promise<void> | null = null;
  /** Serializes every manual compaction mutation for this StateSessionStorageV1 thread. */
  private _manualCompactionBarrier: Promise<void> = Promise.resolve();
  private _manualCompactionAbortController: AbortController | null = null;
  private _manualCompactionCompletion: Promise<void> | null = null;
  private _manualCompactionClosed = false;
  private _manualCompactionQueueDepth = 0;
  /** True after the visible run has been cancelled but before its async cleanup is complete. */
  private _cancellationRequested = false;
  /** Prevents multiple prompts from being optimistically accepted for one cancelled run. */
  private _successorPromptReserved = false;
  private _deltaBuffer: {
    dispatch: ((action: Action) => void) | null;
    text?: Extract<RuntimeEvent, { type: 'model.text_delta' }>;
    reasoning?: Extract<RuntimeEvent, { type: 'model.reasoning_delta' }>;
    timer: ReturnType<typeof setTimeout> | null;
  } = { dispatch: null, timer: null };
  private _toolProgressBuffer: {
    dispatch: ((action: Action) => void) | null;
    events: Map<string, ToolProgressEvent>;
    timer: ReturnType<typeof setTimeout> | null;
  } = { dispatch: null, events: new Map(), timer: null };

  constructor(
    threadId: string,
    workspace: string,
    deps: SessionDeps,
    projectIdentity?: RuntimeProjectIdentityV1,
  ) {
    this.threadId = threadId;
    this.workspace = workspace;
    this.projectId = projectIdentity?.projectId;
    this.canonicalWorkspaceDigest = projectIdentity?.canonicalWorkspaceDigest;
    this.name = threadId;
    this.skillManifests = deps.skillManifests;
    this.skillOptions = deps.skillOptions;
    this.mcpManager = deps.mcpManager;
    this.mcpRecoveryController = deps.mcpRecoveryController ?? null;
    this._observabilityBridge = deps.observabilityBridge;
    this._shellExecutor = deps.shellExecutor;
    this._flushPresentation = deps.flushPresentation;
    this._modelInvocationRuntimeFactory = deps.modelInvocationRuntimeFactory;
    this._resolveRecoveryIdentity = deps.resolveRecoveryIdentity;
    this._capabilityExecution = deps.capabilityExecution;
    this._runtimeSessionCoordinator = deps.runtimeSessionCoordinator;
    this.interactionMode = deps.config.interactionMode ?? 'accept_edits';
    this.config = deps.config;

    this._proxyProvider = this._createProxyProvider();
  }

  // ── 公开 API ──

  /** Reserve the only successor prompt allowed while a cancelled run is unwinding. */
  tryReservePrompt(): boolean {
    if (this._successorPromptReserved) return false;
    if (this.agentLoopActive && !this._cancellationRequested) return false;
    this._successorPromptReserved = true;
    return true;
  }

  /** Wait for an already-terminal run to release its live Kernel control plane. */
  async waitForRunCompletion(): Promise<void> {
    await this._runCompletion;
  }

  async runManualCompactionExclusive<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this._manualCompactionQueueDepth += 1;
    const previous = this._manualCompactionBarrier;
    let release!: () => void;
    this._manualCompactionBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    if (this._manualCompactionClosed) {
      this._manualCompactionQueueDepth -= 1;
      release();
      const error = new Error('Session operation cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    const controller = new AbortController();
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this._manualCompactionAbortController = controller;
    this._manualCompactionCompletion = completion;
    try {
      return await operation(controller.signal);
    } finally {
      if (this._manualCompactionAbortController === controller) {
        this._manualCompactionAbortController = null;
      }
      if (this._manualCompactionCompletion === completion) {
        this._manualCompactionCompletion = null;
      }
      complete();
      this._manualCompactionQueueDepth -= 1;
      release();
    }
  }

  async waitForManualCompactionCompletion(): Promise<void> {
    if (this._manualCompactionQueueDepth > 0) await this._manualCompactionBarrier;
  }

  async cancelManualCompaction(close = false): Promise<void> {
    if (close) this._manualCompactionClosed = true;
    this._manualCompactionAbortController?.abort('Session operation cancelled.');
    await this._manualCompactionBarrier;
  }

  /**
   * Keep a live Kernel aligned with the TUI permissions selector. The event
   * is durable and advances the Kernel revision, so any in-flight effect is
   * re-evaluated before it can schedule work under the previous mode.
   */
  setInteractionMode(mode: 'accept_edits' | 'auto' | 'full'): void {
    const runtimeCoordinator = this._runtimeSessionCoordinator?.get(this.threadId);
    const control = this.authorizedExecutionControl ?? runtimeCoordinator?.control;
    control?.processEvent({
      type: 'interaction_mode.changed',
      mode,
      source: 'user',
      changedAt: new Date().toISOString(),
    });
    this.interactionMode = mode;
    runtimeCoordinator?.updateInteractionMode(mode);
  }

  persistCancellation(reason = 'Cancelled by user.'): RuntimeEvent[] {
    this._flushBufferedPresentation();
    if (this.agentLoopActive || this._runCompletion) {
      this._cancellationRequested = true;
    }
    const persisted: RuntimeEvent[] = [];
    try {
      const pending = this.authorizedExecutionControl?.getState().context.pendingCompaction;
      if (pending?.reason === 'manual') {
        const failed: RuntimeEvent = {
          type: 'context.compaction_failed',
          compactionId: pending.compactionId,
          sourceRevision: this.authorizedExecutionControl!.getState().revision,
          errorKind: 'summary_aborted',
          message: 'Summary was aborted.',
          retryable: false,
          requestedAtTurnId: pending.requestedAtTurnId,
        };
        this.authorizedExecutionControl!.processEvent(failed);
        if (this._activeDispatch) this._routeRuntimeEvent(failed, this._activeDispatch);
        else this._pushToBuffer(failed);
      }
      const cancellationEvents = this.authorizedExecutionControl?.cancelRun(reason) ?? [];
      persisted.push(...cancellationEvents);
      for (const event of cancellationEvents) {
        if (this._activeDispatch) {
          this._routeRuntimeEvent(event, this._activeDispatch);
        } else {
          this._pushToBuffer(event);
        }
      }
    } catch (error) {
      const event: RuntimeEvent = {
        type: 'run.error',
        message: `Failed to persist cancellation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        recoverable: false,
      };
      if (this._activeDispatch) this._routeRuntimeEvent(event, this._activeDispatch);
      else this._pushToBuffer(event);
    }
    return persisted;
  }

  abort(): void {
    this.persistCancellation();
    this._manualCompactionAbortController?.abort('Cancelled by user.');
    // Resolve a suspended interaction before aborting so the generator can
    // leave requestAction and close its StateSessionStorageV1 handle.
    this.resolveInterrupt({ type: 'cancel' as const });
    this._preparingShellExecutor?.abortPreparation?.();
    this.abortController?.abort();
    this.abortController = null;
    this.agentLoopActive = false;
    this.generator = null;
    this._foregroundWake?.();
    this._foregroundWake = null;
  }

  clearBuffer(): void {
    this._clearModelDeltas();
    this._clearToolProgress();
    this.eventBuffer = [];
    this.conversationHistory = [];
    this.pendingInterrupt = false;
  }

  /** 切换到前台：新事件路由到 provider.onEvent，唤醒挂起的后台中断 */
  setForeground(foreground: boolean): void {
    this._flushBufferedPresentation();
    this._foreground = foreground;
    if (foreground) {
      this._foregroundWake?.();
      this._foregroundWake = null;
    }
  }

  // ── Agent 运行 ──

  /** 运行 agent 任务。始终使用代理提供器，通过 _foreground 控制事件路由 */
  async runTask(
    task: string,
    deps: {
      dispatch: (action: Action) => void;
      provider: TuiUserInputProvider;
      config: AgentConfig;
      model?: import('@kite/builtin-runtime/model').SupportedChatModel;
    },
    requestedPhase?: AgentPhase,
    initialSkillActivations?: Array<{
      skillId: string;
      input: Record<string, unknown>;
    }>,
    hostSignal?: AbortSignal,
    hostAbort?: (reason: string) => void,
  ): Promise<void> {
    if (this._manualCompactionQueueDepth > 0) await this._manualCompactionBarrier;
    if (this.agentLoopActive && !this._cancellationRequested && !this._successorPromptReserved)
      return;
    if (this.agentLoopActive && !this._successorPromptReserved) {
      this._successorPromptReserved = true;
    }
    const previousRun = this._runCompletion;
    if (previousRun) await previousRun;
    // Several callers may have waited for the same cancelled run. Only the
    // first continuation may claim the session for a new loop.
    if (this.agentLoopActive) {
      this._successorPromptReserved = false;
      return;
    }

    this._successorPromptReserved = false;
    this._cancellationRequested = false;

    // Claim the session before sandbox preparation. Native startup may
    // remain pending for a while; during that window a second prompt must not
    // open a concurrent StateSessionStorageV1-backed loop. Establish cancellation at
    // the same boundary so abort() can also cancel a run that has not reached
    // the agent generator yet.
    const abortController = hostSignal ? null : new AbortController();
    const executionSignal = hostSignal ?? abortController!.signal;
    let resolveRunCompletion!: () => void;
    const runCompletion = new Promise<void>((resolve) => {
      resolveRunCompletion = resolve;
    });
    this._runCompletion = runCompletion;
    this.agentLoopActive = true;
    this.abortController = abortController;
    this._activeExecutionSignal = executionSignal;
    this._activeDispatch = deps.dispatch;
    const forwardHostAbort = () => {
      this.resolveInterrupt({ type: 'cancel' as const });
      this._preparingShellExecutor?.abortPreparation?.();
      this._manualCompactionAbortController?.abort('Cancelled by user.');
      this._foregroundWake?.();
      this._foregroundWake = null;
    };
    if (hostSignal?.aborted) forwardHostAbort();
    else hostSignal?.addEventListener('abort', forwardHostAbort, { once: true });

    let aborted = false;
    let generatorStarted = false;
    let activeRuntimeCoordinator: RuntimeSessionCoordinatorV1 | null = null;
    try {
      const shellContext =
        this.conversationHistory.length > 0 ? `\n${this.conversationHistory.join('\n')}` : '';
      const shellExecutor =
        this._shellExecutor ??
        composeAppSandboxExecutorV1({
          entrypoint: 'tui',
          workspace: this.workspace,
          config: deps.config,
        });
      this._preparingShellExecutor = shellExecutor;
      let shellRuntime: Awaited<ReturnType<AppShellExecutorV1['prepare']>>;
      try {
        shellRuntime = await shellExecutor.prepare();
      } finally {
        if (this._preparingShellExecutor === shellExecutor) {
          this._preparingShellExecutor = null;
        }
      }
      if (executionSignal.aborted) {
        aborted = true;
        return;
      }
      const effectiveBackend = shellRuntime.mode === 'sandbox' ? shellRuntime.backend : 'none';
      const gitExecutable = resolveAppGitExecutableV1();
      const gitBroker =
        gitExecutable && deps.config.brokeredGitShellDenyEvidence
          ? composeAppGitBrokerV1({
              workspace: this.workspace,
              executable: gitExecutable,
              config: deps.config,
              shellDenyEvidence: deps.config.brokeredGitShellDenyEvidence,
            })
          : undefined;
      const fullModeReason = fullModeUnavailableReason(this.interactionMode, effectiveBackend);
      if (fullModeReason) {
        const runtimeCoordinator = this._runtimeSessionCoordinator?.get(this.threadId);
        const control = this.authorizedExecutionControl ?? runtimeCoordinator?.control;
        control?.processEvent({
          type: 'interaction_mode.changed',
          mode: 'accept_edits',
          source: 'user',
          changedAt: new Date().toISOString(),
        });
        this.interactionMode = 'accept_edits';
        runtimeCoordinator?.updateInteractionMode('accept_edits');
        deps.dispatch({ type: 'SET_INTERACTION_MODE', mode: 'accept_edits' });
        deps.dispatch({
          type: 'RUNTIME_EVENT',
          event: {
            type: 'run.error',
            message: fullModeReason,
            recoverable: true,
          },
        });
        return;
      }

      const authMode =
        this.interactionMode === 'full' ? ('full_access' as const) : ('default' as const);

      const runAgentParams = buildRunAgentParams({
        task,
        threadId: this.threadId,
        workspace: this.workspace,
        config: deps.config,
        shellExecutor,
        gitBroker,
        signal: executionSignal,
        thinkingLevel: this.thinkingLevel,
        skills: this.skillManifests,
        skillOptions: this.skillOptions,
        initialSkillActivations,
        mcpManager: this.mcpManager,
        shellContext,
        interactionMode: this.interactionMode,
        authorizationMode: authMode,
        phase: requestedPhase ?? 'building',
        sandboxBackend: effectiveBackend,
        model: deps.model,
        // 后台会话不再默认注入 full_access；中断会挂起到该会话，等待切回前台处理。
      });

      const runtimeCoordinator = this._runtimeSessionCoordinator?.get(this.threadId);
      if (!runtimeCoordinator) {
        throw new Error('Runtime Host runtime session coordinator unavailable.');
      }
      activeRuntimeCoordinator = runtimeCoordinator;
      this.authorizedExecutionControl = runtimeCoordinator.control;
      runtimeCoordinator.updateSandboxAvailable(sandboxSupportsFullModeV1(effectiveBackend));

      // 始终使用代理提供器 — 事件路由由 _foreground 控制
      const runtimeInput: Omit<
        RuntimeTurnInputV1,
        'openStateSessionStorage' | 'runtimeSession' | 'createRuntimeEffectPort'
      > = {
        task: runAgentParams.task,
        userGoal: runAgentParams.userGoal,
        userId: runAgentParams.userId,
        threadId: runAgentParams.threadId,
        workspace: runAgentParams.workspace,
        recoveryIdentityKey: this._resolveRecoveryIdentity(this.threadId),
        capabilityExecution: this._capabilityExecution,
        config: runAgentParams.config,
        model: runAgentParams.model,
        modelInvocationRuntime: this._modelInvocationRuntimeFactory(this.workspace),
        shellExecutor: runAgentParams.shellExecutor,
        gitBroker: runAgentParams.gitBroker,
        mcpManager: runAgentParams.mcpManager,
        skills: runAgentParams.skills,
        skillOptions: runAgentParams.skillOptions,
        initialSkillActivations: runAgentParams.initialSkillActivations,
        interactionMode: runAgentParams.interactionMode,
        authorizationMode: runAgentParams.authorizationMode,
        authorizationSource: runAgentParams.authorizationSource,
        phase: runAgentParams.phase,
        thinkingLevel: runAgentParams.thinkingLevel,
        sandboxBackend: runAgentParams.sandboxBackend,
        signal: runAgentParams.signal,
        ...(hostAbort ? { abortExecution: hostAbort } : {}),
        frontend: 'tui',
        sessionLoggingPolicy: runAgentParams.sessionLoggingPolicy,
        sessionLoggingContentInspector: runAgentParams.sessionLoggingContentInspector,
        onSessionLoggingStatus: ({ mode }) => {
          if (mode === 'content' && !this._contentLoggingDisclosureShown) {
            this._contentLoggingDisclosureShown = true;
            deps.dispatch({
              type: 'LOCAL_TEXT',
              text:
                '  ⎿  Session content logging is enabled by the release artifact and your explicit opt-in. ' +
                'Reasoning, tool/file content, secrets, and credentials remain excluded.',
            });
          }
        },
        onCompactionProgress: (phase) => {
          deps.dispatch(
            phase
              ? { type: 'SET_COMPACTION_PROGRESS', phase, source: 'automatic' }
              : { type: 'SET_COMPACTION_PROGRESS' },
          );
        },
      };
      const runtimeProvider: RuntimeActionProvider = {
        requestAction: (effect, state) => this._requestRuntimeAction(effect, state),
      };
      const generator = runtimeCoordinator.executeTurn(runtimeInput, runtimeProvider);

      // 所有状态变更必须在 try 块内，防止 buildRunAgentParams/runAgent 抛出时
      // agentLoopActive 和 abortController 泄漏导致会话永久冻结
      this.generator = generator;
      generatorStarted = true;
      for await (const event of generator) {
        // abort() projects the cancellation events synchronously and then
        // aborts the controller. A provider/generator can still resolve one
        // more queued event after that point; never let that late event bleed
        // into a successor prompt that may already be visible in the TUI.
        if (executionSignal.aborted) {
          aborted = true;
          break;
        }
        if (isSilentCancellationMismatch(event)) continue;
        if (event.type === 'turn.aborted' && event.cause === 'user') {
          aborted = true;
        }
        this._routeRuntimeEvent(event, deps.dispatch);
        if (
          event.type === 'model.reasoning_completed' &&
          this._foreground &&
          this._flushPresentation
        ) {
          // reasoning_completed is a user-visible lifecycle boundary. Fast
          // providers can otherwise emit text + model.responded before Ink's
          // throttled renderer writes the running Thought frame. Wait on Ink's
          // actual commit/output barrier rather than guessing with a fixed delay.
          await this._flushPresentation();
        }
        if (aborted) {
          break;
        }
      }
      if (
        shouldProjectRunExited({
          aborted,
          signalAborted: executionSignal.aborted,
          foreground: this._foreground,
        })
      ) {
        deps.dispatch({ type: 'SET_EXITED' });
      }
    } catch (e: unknown) {
      if (executionSignal.aborted) {
        aborted = true;
        return;
      }
      // Emit any accumulated retry events before the fatal error.
      // In the Kernel architecture, model retries are normally emitted
      // through the runtime event pipeline.  This catch block handles
      // retries that were accumulated on the error object before the
      // pipeline could emit them.
      const modelRetries =
        e && typeof e === 'object' && 'modelRetries' in e
          ? (e as { modelRetries?: unknown }).modelRetries
          : [];
      if (Array.isArray(modelRetries)) {
        for (const retry of modelRetries) {
          const parsedRetry = asModelRetry(retry);
          if (this._foreground) {
            deps.dispatch({
              type: 'RUNTIME_EVENT',
              event: {
                type: 'model.retry',
                attempt: parsedRetry.attempt,
                maxAttempts: parsedRetry.maxAttempts,
                error: parsedRetry.error,
                delayMs: parsedRetry.delayMs,
              },
            });
          } else {
            this._pushToBuffer({
              type: 'model.retry',
              attempt: parsedRetry.attempt,
              maxAttempts: parsedRetry.maxAttempts,
              error: parsedRetry.error,
              delayMs: parsedRetry.delayMs,
            });
          }
        }
      }
      const errorEvent: RuntimeEvent = {
        type: 'run.error',
        message: toErrorMessage(e),
        recoverable: isRecoverableError(e),
      };
      if (this._foreground) {
        deps.dispatch({ type: 'RUNTIME_EVENT', event: errorEvent });
      } else {
        this._pushToBuffer(errorEvent);
      }
      if (this._foreground) {
        deps.dispatch({ type: 'SET_EXITED' });
      }
    } finally {
      hostSignal?.removeEventListener('abort', forwardHostAbort);
      const runtimeCoordinator =
        activeRuntimeCoordinator ?? this._runtimeSessionCoordinator?.get(this.threadId);
      if (runtimeCoordinator) {
        runtimeCoordinator.clearActiveCancelRun();
        this.authorizedExecutionControl = runtimeCoordinator.control;
      } else {
        this.authorizedExecutionControl = null;
      }
      this.agentLoopActive = false;
      this.abortController = null;
      this._activeExecutionSignal = null;
      this.generator = null;
      this._activeDispatch = null;
      // The cleanup barrier covers provider teardown too. A successor must not
      // start while the predecessor can still clear a shared pending action.
      if (generatorStarted && this._foreground) {
        deps.provider.reset();
      }
      if (this._runCompletion === runCompletion) {
        this._runCompletion = null;
      }
      resolveRunCompletion();
    }
  }

  // ── 私有：代理提供器 & 缓冲 ──

  /** 推送事件到缓冲，溢出时优先丢弃非关键事件 */
  private _pushToBuffer(event: RuntimeEvent): void {
    if (event.type === 'tool.progress') {
      event = normalizeToolProgress(event);
      for (let index = this.eventBuffer.length - 1; index >= 0; index -= 1) {
        const candidate = this.eventBuffer[index]!;
        if (
          'toolCallId' in candidate &&
          candidate.toolCallId === event.toolCallId &&
          (candidate.type === 'tool.finished' ||
            candidate.type === 'tool.failed' ||
            candidate.type === 'tool.rejected' ||
            candidate.type === 'tool.cancelled')
        ) {
          break;
        }
        if (
          candidate.type === 'tool.progress' &&
          candidate.toolCallId === event.toolCallId &&
          candidate.stream === event.stream
        ) {
          this.eventBuffer[index] = mergeToolProgress(candidate, event);
          return;
        }
      }
    }
    if (this.eventBuffer.length >= SessionRuntime.MAX_BUFFER) {
      // 查找第一个可丢弃事件的下标
      const dropIdx = this.eventBuffer.findIndex((e) => DISPOSABLE_EVENT_TYPES.has(e.type));
      if (dropIdx >= 0) {
        this.eventBuffer.splice(dropIdx, 1);
      } else if (DISPOSABLE_EVENT_TYPES.has(event.type)) return;
      // MAX_BUFFER is a soft presentation limit. Durable/lifecycle events may
      // temporarily exceed it rather than evict an earlier terminal fact.
    }
    this.eventBuffer.push(event);
  }

  /** Route the public RuntimeEvent stream directly to the foreground or buffer. */
  private _routeRuntimeEvent(event: RuntimeEvent, dispatch: (action: Action) => void): void {
    const observabilityFact = projectRuntimeObservabilityFactV1(event, new Date().toISOString());
    if (observabilityFact) this._observabilityBridge?.observeRuntimeFact(observabilityFact);
    if (event.type === 'plan.approved') {
      this.interactionMode = event.executionMode;
      this._runtimeSessionCoordinator
        ?.get(this.threadId)
        ?.updateInteractionMode(event.executionMode);
    }
    if (event.type === 'interaction_mode.changed') {
      this.interactionMode = event.mode;
      this._runtimeSessionCoordinator?.get(this.threadId)?.updateInteractionMode(event.mode);
    }
    if (event.type === 'model.text_delta' || event.type === 'model.reasoning_delta') {
      this._flushToolProgress();
      this._bufferModelDelta(event, dispatch);
      return;
    }
    if (event.type === 'tool.progress') {
      this._flushModelDeltas();
      this._bufferToolProgress(event, dispatch);
      return;
    }
    this._flushBufferedPresentation();
    if (this._foreground) {
      dispatch({ type: 'RUNTIME_EVENT', event });
      return;
    }
    // Background ask_user is immediately cancelled by the provider below; do not
    // replay a request the user can no longer answer after switching sessions.
    if (event.type === 'user_input.requested') return;
    this._pushToBuffer(event);
    if (event.type === 'approval.requested' || event.type === 'plan.review_requested') {
      this.pendingInterrupt = true;
      this.notifyInterrupt?.();
    }
  }

  private _bufferModelDelta(
    event: Extract<RuntimeEvent, { type: 'model.text_delta' | 'model.reasoning_delta' }>,
    dispatch: (action: Action) => void,
  ): void {
    this._deltaBuffer.dispatch = dispatch;
    if (event.type === 'model.text_delta') this._deltaBuffer.text = event;
    else this._deltaBuffer.reasoning = event;
    if (this._deltaBuffer.timer) return;
    this._deltaBuffer.timer = setTimeout(() => this._flushModelDeltas(), PRESENTATION_FRAME_MS);
  }

  private _flushModelDeltas(): void {
    const buffered = this._deltaBuffer;
    if (buffered.timer) clearTimeout(buffered.timer);
    this._deltaBuffer = { dispatch: null, timer: null };
    for (const event of [buffered.reasoning, buffered.text]) {
      if (!event) continue;
      if (this._foreground && buffered.dispatch) {
        buffered.dispatch({ type: 'RUNTIME_EVENT', event });
      } else {
        this._pushToBuffer(event);
      }
    }
  }

  private _clearModelDeltas(): void {
    if (this._deltaBuffer.timer) clearTimeout(this._deltaBuffer.timer);
    this._deltaBuffer = { dispatch: null, timer: null };
  }

  private _bufferToolProgress(event: ToolProgressEvent, dispatch: (action: Action) => void): void {
    const buffered = this._toolProgressBuffer;
    buffered.dispatch = dispatch;
    const key = toolProgressKey(event);
    const previous = buffered.events.get(key);
    buffered.events.set(
      key,
      previous ? mergeToolProgress(previous, event) : normalizeToolProgress(event),
    );
    if (buffered.timer) return;
    buffered.timer = setTimeout(() => this._flushToolProgress(), PRESENTATION_FRAME_MS);
  }

  private _flushToolProgress(): void {
    const buffered = this._toolProgressBuffer;
    if (buffered.timer) clearTimeout(buffered.timer);
    this._toolProgressBuffer = {
      dispatch: null,
      events: new Map(),
      timer: null,
    };
    for (const event of buffered.events.values()) {
      if (this._foreground && buffered.dispatch) {
        buffered.dispatch({ type: 'RUNTIME_EVENT', event });
      } else {
        this._pushToBuffer(event);
      }
    }
  }

  private _clearToolProgress(): void {
    if (this._toolProgressBuffer.timer) clearTimeout(this._toolProgressBuffer.timer);
    this._toolProgressBuffer = {
      dispatch: null,
      events: new Map(),
      timer: null,
    };
  }

  private _flushBufferedPresentation(): void {
    this._flushModelDeltas();
    this._flushToolProgress();
  }

  /** Adapt existing Ink button actions at the UI edge and bind the persisted interaction id. */
  private async _requestRuntimeAction(
    effect: Extract<RuntimeEffect, { interactionId: string }>,
    state: Readonly<RuntimeState>,
  ): Promise<RuntimeUserAction> {
    if (effect.type === 'request_provider_action') {
      const response = await this._proxyProvider.requestAction({
        kind: 'input',
        question: providerActionInput(effect.providerId, effect.action),
      });
      if (response.type !== 'input' || response.text.toLowerCase().startsWith('later')) {
        return {
          type: 'provider_action_result',
          interactionId: effect.interactionId,
          outcome: 'deferred',
        };
      }
      const result = await this.mcpRecoveryController?.recover?.(effect.providerId, effect.action);
      return result?.outcome === 'completed'
        ? {
            type: 'provider_action_result',
            interactionId: effect.interactionId,
            outcome: 'completed',
            providerDirectoryRevision: result.providerDirectoryRevision,
          }
        : {
            type: 'provider_action_result',
            interactionId: effect.interactionId,
            outcome: 'failed',
            failureCode:
              effect.action === 'login'
                ? 'authentication_failed'
                : effect.action === 'approve'
                  ? 'approval_denied'
                  : 'provider_unavailable',
          };
    }
    if (effect.type === 'request_provider_admission') {
      const response = await this._proxyProvider.requestAction({
        kind: 'input',
        question: providerAdmissionInput(
          effect.providerId,
          effect.providerStatus,
          effect.retryable,
        ),
      });
      const choice = response.type === 'input' ? response.text.toLowerCase() : 'cancel';
      if (choice.startsWith('session') || choice.startsWith('waive')) {
        return {
          type: 'provider_admission_decision',
          interactionId: effect.interactionId,
          decision: { kind: 'waive' },
        };
      }
      if (choice.startsWith('retry')) {
        const result = await this.mcpRecoveryController?.recover?.(effect.providerId, 'retry');
        return {
          type: 'provider_admission_decision',
          interactionId: effect.interactionId,
          decision:
            result?.outcome === 'completed'
              ? {
                  kind: 'retry',
                  outcome: 'ready',
                  providerDirectoryRevision: result.providerDirectoryRevision,
                }
              : {
                  kind: 'retry',
                  outcome: 'unavailable',
                  providerStatus: result?.providerStatus ?? effect.providerStatus,
                },
        };
      }
      return {
        type: 'provider_admission_decision',
        interactionId: effect.interactionId,
        decision: { kind: 'cancel' },
      };
    }
    if (effect.type === 'request_verification_decision') {
      const record = state.verification.records[effect.verificationId];
      if (!record) {
        return {
          type: 'replan_verification',
          verificationId: effect.verificationId,
          instruction: 'Re-evaluate the missing verification state before continuing.',
        };
      }
      const options = [
        {
          id: 'replan',
          label: 'Repair / replan',
          description: 'Continue work using the verifier evidence.',
        },
        ...(record.spec.compensation
          ? [
              {
                id: 'compensate',
                label: 'Compensate',
                description: 'Run the declared compensation before deciding completion.',
              },
            ]
          : []),
        {
          id: 'waive',
          label: 'Waive verification',
          description: 'Finish explicitly marked as unverified.',
        },
      ];
      const action = await this._proxyProvider.requestAction({
        kind: 'input',
        question: {
          question: `Required verification is ${record.status}. Choose a recovery action.`,
          options,
          allow_free_text: true,
          recommended: 'replan',
          context: `verification:${record.spec.subject}`,
        },
      });
      if (action.type === 'input') {
        const answer = action.text.trim();
        const normalized = answer.toLowerCase();
        if (normalized.startsWith('compensate') && record.spec.compensation) {
          return {
            type: 'request_verification_compensation',
            verificationId: effect.verificationId,
          };
        }
        if (normalized.startsWith('waive')) {
          return {
            type: 'waive_verification',
            verificationId: effect.verificationId,
            reason:
              answer.replace(/^waive\s*:?\s*/i, '').trim() ||
              'User explicitly waived required verification in the verification decision prompt.',
          };
        }
        return {
          type: 'replan_verification',
          verificationId: effect.verificationId,
          instruction:
            answer.replace(/^replan\s*:?\s*/i, '').trim() ||
            'Repair the failed verification using its recorded evidence.',
        };
      }
      return {
        type: 'replan_verification',
        verificationId: effect.verificationId,
        instruction: 'The verification decision was cancelled; continue with a safe repair.',
      };
    }
    const interaction = state.interactions;
    const planReviewDecision = (
      decision:
        | {
            kind: 'approve';
            nextMode: 'accept_edits' | 'auto';
          }
        | { kind: 'revise'; feedback: string }
        | { kind: 'cancel'; reason?: string },
    ): RuntimeUserAction | null =>
      interaction.kind === 'awaiting_review'
        ? {
            type: 'plan_review_decision',
            interactionId: effect.interactionId,
            planId: interaction.planId,
            version: interaction.version,
            structuralDigest: interaction.structuralDigest,
            decision,
          }
        : null;
    let payload: TuiInterruptPayload;
    if (effect.type === 'request_user_input' && interaction.kind === 'awaiting_user_input') {
      payload = { kind: 'input', question: interaction.request };
    } else if (
      effect.type === 'request_tool_approval' &&
      interaction.kind === 'awaiting_tool_approval'
    ) {
      payload = { kind: 'approval', approval: interaction.approval };
    } else if (effect.type === 'request_plan_review' && interaction.kind === 'awaiting_review') {
      payload = {
        kind: 'plan_review',
        plan: interaction.plan,
        ...(interaction.artifact ? { artifact: interaction.artifact } : {}),
      };
    } else {
      return {
        type: 'cancel',
        interactionId: effect.interactionId,
        reason: 'Interaction state changed.',
      };
    }

    const action = await this._proxyProvider.requestAction(payload);
    switch (action.type) {
      case 'input':
        return {
          type: 'input',
          interactionId: effect.interactionId,
          text: action.text,
          answers: action.answers,
        };
      case 'approve':
        return action.grant === 'none'
          ? {
              type: 'reject',
              interactionId: effect.interactionId,
              reason: 'No approval grant selected.',
            }
          : {
              type: 'approve',
              interactionId: effect.interactionId,
              grant: action.grant,
            };
      case 'reject':
        return { type: 'reject', interactionId: effect.interactionId };
      case 'plan_review_decision':
        return planReviewDecision(action.decision)!;
      case 'cancel':
        return { type: 'cancel', interactionId: effect.interactionId };
      default:
        return {
          type: 'cancel',
          interactionId: effect.interactionId,
          reason: 'Unsupported UI action.',
        };
    }
  }

  /** 创建代理提供器。interrupt 使用运行时自身状态，永久等待用户处理 */
  private _createProxyProvider(): Pick<TuiUserInputProvider, 'requestAction'> {
    const self = this;
    const proxy = {
      async requestAction(payload: TuiInterruptPayload): Promise<TuiAction> {
        if (!self._foreground) {
          // user_input in background: auto-cancel (user can't respond)
          // need_approval won't fire due to authorizationOverride, but guard anyway
          if (
            payload.kind === 'input' &&
            !payload.question?.context?.startsWith('verification:') &&
            !payload.question?.context?.startsWith('mcp-provider-')
          ) {
            return { type: 'cancel' as const };
          }
          // 后台 tool_approval 中断：标记并等待前台切换
          // Background tool_approval: mark and wait for foreground switch
          self.pendingInterrupt = true;
          self.notifyInterrupt?.();
          await new Promise<void>((resolve) => {
            self._foregroundWake = resolve;
          });
          self.pendingInterrupt = false;
          if (!self._activeExecutionSignal || self._activeExecutionSignal.aborted) {
            return { type: 'cancel' as const };
          }
        }
        // 使用运行时自身的中断状态，永久等待用户处理
        self._pendingInterrupt = payload;
        return new Promise<TuiAction>((resolve) => {
          self._pendingResolve = resolve;
        });
      },

      submitAction(action: TuiAction): void {
        self.resolveInterrupt(action);
      },

      reset(): void {
        self.resolveInterrupt({ type: 'cancel' as const });
      },

      getPendingInterrupt(): TuiInterruptPayload | null {
        return self._pendingInterrupt;
      },

      teardown(): Promise<void> {
        self.resolveInterrupt({ type: 'cancel' as const });
        return Promise.resolve();
      },
    };
    return proxy;
  }

  /** 解析挂起的中断（由 SessionManager 的中央 bridge 调用）/ Resolve pending interrupt (called by SessionManager's central bridge) */
  resolveInterrupt(action: TuiAction): void {
    if (this._pendingResolve) {
      const r = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingInterrupt = null;
      r(action);
    }
  }
}

/** 多会话管理器：创建/切换/查快照 */
export class SessionManager {
  private readonly sessionRegistry = new SessionRegistry<SessionRuntime>();
  private snapshotCallback: ((threadId: string) => void) | null = null;
  /** token 统计内存缓存，避免 getSnapshot 每次打开 DB / In-memory token stats cache to avoid DB access in getSnapshot */
  private tokenStatsCache = new Map<
    string,
    { cacheHitTokens: number; cacheMissTokens: number; totalTokens: number }
  >();
  private _observabilityShutdown: Promise<void> | null = null;
  /** 防抖定时器：合并高频 token 统计变更为批量写入，避免每个 stream chunk 都写 DB
   *  Debounce timers: batch high-frequency token stat changes into fewer writes */
  private _statsDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 防抖延迟（毫秒）/ Debounce delay in ms */
  private static readonly STATS_DEBOUNCE_MS = 1000;

  private deps: SessionDeps;
  private defaultConfig: AgentConfig;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.defaultConfig = deps.config;
    // Central bridge: when UI components (ApprovalBlock, InputBlock) call submitAction
    // on the real provider, route to the active runtime's resolveInterrupt.
    // This runs once, avoiding the chain-wrapping anti-pattern of per-runtime bridges.
    if (deps.provider.submitAction) {
      const origSubmit = deps.provider.submitAction.bind(deps.provider);
      deps.provider.submitAction = (action: TuiAction) => {
        origSubmit(action);
        const active = this.sessionRegistry.runtimes.get(this.sessionRegistry.activeId);
        active?.resolveInterrupt(action);
      };
    }
  }

  listRewindCheckpoints(threadId: string) {
    const store = this.deps.openStateSessionStorage(threadId);
    try {
      return store.listNamedSnapshots(threadId);
    } finally {
      store.close();
    }
  }

  listPersistedSessions(query = '') {
    return query
      ? searchSessions(this.deps.openStateSessionStorage, query)
      : listSessions(this.deps.openStateSessionStorage);
  }

  loadPersistedSession(threadId: string) {
    return loadSession(
      this.deps.openStateSessionStorage,
      threadId,
      this.deps.resolveRecoveryIdentity(threadId),
    );
  }

  deletePersistedSession(threadId: string) {
    return deleteSession(this.deps.openStateSessionStorage, threadId);
  }

  async generateAndPersistSessionName(threadId: string, task: string) {
    const name = await generateSessionName(task);
    if (name) await persistSessionName(this.deps.openStateSessionStorage, threadId, name);
    return name;
  }

  previewRewind(threadId: string, snapshotId: string, workspace: string) {
    const store = this.deps.openStateSessionStorage(threadId);
    try {
      if (!isAvailableRewindCheckpoint(store, threadId, snapshotId)) return null;
      return previewFilesToCheckpoint(store, threadId, snapshotId, workspace);
    } finally {
      store.close();
    }
  }

  async executeRewind(input: {
    sourceThreadId: string;
    snapshotId: string;
    scope: 'code_and_conversation' | 'code_only' | 'conversation_only';
    workspace: string;
  }) {
    const store = this.deps.openStateSessionStorage(input.sourceThreadId);
    try {
      if (!isAvailableRewindCheckpoint(store, input.sourceThreadId, input.snapshotId)) {
        throw new Error('Recovery point is unavailable or corrupted.');
      }
      const restoresConversation =
        input.scope === 'code_and_conversation' || input.scope === 'conversation_only';
      const restoresCode = input.scope === 'code_and_conversation' || input.scope === 'code_only';
      let targetThreadId = input.sourceThreadId;
      let recoveredData: Awaited<ReturnType<typeof loadSession>> = null;
      if (restoresConversation) {
        targetThreadId = `tui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        if (
          !store.forkSession(
            input.sourceThreadId,
            input.snapshotId,
            targetThreadId,
            this.deps.allocateRecoveryIdentity(),
          )
        ) {
          throw new Error('Recovery point is unavailable or corrupted.');
        }
        recoveredData = await loadSession(
          this.deps.openStateSessionStorage,
          targetThreadId,
          this.deps.resolveRecoveryIdentity(targetThreadId),
        );
        if (!recoveredData) throw new Error('Recovered session could not be loaded.');
      }
      const fileOutcome = restoresCode
        ? restoreFilesToCheckpoint(store, input.sourceThreadId, input.snapshotId, input.workspace)
        : null;
      return { targetThreadId, recoveredData, fileOutcome };
    } finally {
      store.close();
    }
  }

  /** 持久化 token 统计到 checkpoint DB（防抖合并，避免每次 token 变化都写 DB）
   *  Persist token stats to DB with debounce, avoiding a write on every token change */
  saveTokenStats(threadId: string, status: StatusState, immediate = false): void {
    const stats = {
      cacheHitTokens: status.cacheHitTokens,
      cacheMissTokens: status.cacheMissTokens,
      totalTokens: status.totalTokens,
    };
    this.tokenStatsCache.set(threadId, stats);

    if (immediate) {
      this._flushTokenStatsNow(threadId, stats);
      return;
    }

    // 清除旧定时器，创建新的合并定时器
    const existing = this._statsDebounceTimers.get(threadId);
    if (existing) clearTimeout(existing);
    this._statsDebounceTimers.set(
      threadId,
      setTimeout(() => {
        this._statsDebounceTimers.delete(threadId);
        // 从缓存读取最新值而非闭包捕获，避免跨调用 stale write 风险
        // Read latest from cache rather than closure-captured value to avoid stale-write risk
        const latest = this.tokenStatsCache.get(threadId) ?? stats;
        this._flushTokenStatsNow(threadId, latest);
      }, SessionManager.STATS_DEBOUNCE_MS),
    );
  }

  /** 立即写入 DB（绕过防抖）/ Immediate DB write (bypasses debounce) */
  private _flushTokenStatsNow(
    threadId: string,
    stats: {
      cacheHitTokens: number;
      cacheMissTokens: number;
      totalTokens: number;
    },
  ): void {
    try {
      this.deps.tokenStatsStorage.save(threadId, stats);
    } catch {
      // Token statistics are best-effort and internal persistence failures must
      // never write raw diagnostics into the TUI terminal.
    }
  }

  createSession(
    workspace: string,
    projectIdentityInput?:
      | RuntimeProjectIdentityV1
      | ((sessionId: string) => RuntimeProjectIdentityV1),
  ): string {
    // Navigation only changes presentation. A run may continue in the
    // background and must be cancelled through an explicit user stop action.
    const oldRt = this.sessionRegistry.runtimes.get(this.sessionRegistry.activeId);
    if (oldRt) {
      oldRt.setForeground(false);
    }
    const threadId = this.sessionRegistry.nextSessionId('tui');
    const projectIdentity =
      typeof projectIdentityInput === 'function'
        ? projectIdentityInput(threadId)
        : projectIdentityInput;
    if (this.deps.runtimeSessionCoordinator && !projectIdentity) {
      throw new Error('Runtime Host Project identity is required before Session creation.');
    }
    const rt = new SessionRuntime(
      threadId,
      workspace,
      {
        ...this.deps,
        config: this.defaultConfig,
      },
      projectIdentity,
    );
    rt.notifyInterrupt = () => {
      this.snapshotCallback?.(rt.threadId);
    };
    this.sessionRegistry.runtimes.set(threadId, rt);
    this.ensureRuntimeCoordinator(rt);
    this.sessionRegistry.activeId = threadId;
    return threadId;
  }

  getRuntime(threadId: string): SessionRuntime | undefined {
    return this.sessionRegistry.runtimes.get(threadId);
  }

  /** Bridge-only restart reconciliation. Runtime Host decides when it runs. */
  recoverRuntimeState(threadId: string): boolean {
    const runtime = this.sessionRegistry.runtimes.get(threadId);
    if (!runtime) return false;
    return this.ensureRuntimeCoordinator(runtime)?.recoveryChanged ?? false;
  }

  private ensureRuntimeCoordinator(
    runtime: SessionRuntime,
  ): RuntimeSessionCoordinatorV1 | undefined {
    const coordinatorAccess = this.deps.runtimeSessionCoordinator;
    if (!coordinatorAccess) return undefined;
    const existingCoordinator = coordinatorAccess.get(runtime.threadId);
    const modelInvocationRuntime = this.deps.modelInvocationRuntimeFactory(runtime.workspace);
    const identity: RuntimeSessionCoordinatorIdentityV1 = {
      sessionId: runtime.threadId,
      userId: 'tui-user',
      workspace: runtime.workspace,
      projectId: runtime.projectId!,
      canonicalWorkspaceDigest: runtime.canonicalWorkspaceDigest!,
      interactionMode: runtime.interactionMode,
      recoveryIdentityKey: this.deps.resolveRecoveryIdentity(runtime.threadId),
      sandboxAvailable: existingCoordinator?.getSandboxAvailable(),
      modelArtifactEvidence: modelInvocationRuntime.evidence,
      capabilityArtifactEvidence:
        'capabilityArtifacts' in modelInvocationRuntime
          ? modelInvocationRuntime.capabilityArtifacts
          : undefined,
    };
    const coordinator = coordinatorAccess.ensure(identity);
    runtime.authorizedExecutionControl = coordinator.control;
    return coordinator;
  }

  private runtimeCompactionDependencies(
    runtime: SessionRuntime,
    coordinator: RuntimeSessionCoordinatorV1,
    signal: AbortSignal | undefined,
    onProgress: (
      phase: import('@kite/runtime-contract').ContextCompactionProgressPhase | undefined,
    ) => void,
  ): RuntimeExecutorDependencies {
    const config = runtime.config;
    const modelRuntime = this.deps.modelInvocationRuntimeFactory(runtime.workspace);
    const providerDataAdmission = createApprovedProviderDataAdmissionV1(config);
    return {
      config,
      model: createChatModel(config),
      builtinToolCatalog: modelRuntime.builtinToolCatalog,
      toolPipelineComposition: modelRuntime.toolPipelineComposition,
      modelInvocationGateway: modelRuntime.gateway,
      modelEffectCoordinator: modelRuntime.modelEffects,
      capabilityExecution: this.deps.capabilityExecution,
      runtimeStore: coordinator.getStateSessionStorage(),
      mcpManager: runtime.mcpManager ?? undefined,
      skills: runtime.skillManifests,
      skillOptions: runtime.skillOptions ?? undefined,
      onCompactionProgress: onProgress,
      signal,
      providerDataAdmission,
      compactionReporter: config.compaction?.localDebug?.enabled
        ? createLocalCompactionDebugReporter({
            enabled: true,
            directory: config.compaction.localDebug.directory,
            sessionId: runtime.threadId,
          })
        : undefined,
    };
  }

  getDefaultConfig(): AgentConfig {
    return this.defaultConfig;
  }

  /** Bind a complete provider/model configuration to one TUI session. */
  setSessionConfig(
    threadId: string,
    config: AgentConfig,
    options: { persist?: boolean; asDefault?: boolean } = {},
  ): boolean {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return false;
    rt.config = config;
    if (options.asDefault) this.defaultConfig = config;
    if (options.persist) {
      try {
        const store = this.deps.openStateSessionStorage(threadId);
        try {
          store.setSessionModelRoute(threadId, {
            provider: config.providerName,
            name: config.modelName,
          });
        } finally {
          store.close();
        }
      } catch {
        // Model-route persistence is best-effort and stays out of the TUI stream.
      }
    }
    return true;
  }

  /**
   * Continue a session whose TUI replay intentionally hid a crashed pending
   * interaction. The source event store remains untouched: user work resumes
   * from a sanitized, durable fork so it can never reopen the old prompt.
   */
  forkRecoveredSessionForContinuation(threadId: string): SessionRuntime | undefined {
    const source = this.sessionRegistry.runtimes.get(threadId);
    if (!source?.localReplayRecovery) return source;
    const targetThreadId = this.sessionRegistry.nextRecoverySessionId('tui');
    const store = this.deps.openStateSessionStorage(threadId);
    try {
      if (!store.forkCurrentSession(threadId, targetThreadId, this.deps.allocateRecoveryIdentity()))
        return undefined;
    } finally {
      store.close();
    }
    const target = this.registerSession(targetThreadId, source.workspace);
    target.config = source.config;
    target.thinkingLevel = source.thinkingLevel;
    target.interactionMode = source.interactionMode;
    target.conversationHistory = [...source.conversationHistory];
    target.name = source.name;
    target.setForeground(true);
    source.setForeground(false);
    source.localReplayRecovery = false;
    this.sessionRegistry.activeId = targetThreadId;
    return target;
  }

  /** Execute or queue a manual compaction command through the durable Kernel boundary. */
  async handleContextCompaction(
    threadId: string,
    customInstructions?: string,
    onProgress?: (
      phase: import('@kite/runtime-contract').ContextCompactionProgressPhase | undefined,
    ) => void,
    onCommand?: (event: Extract<RuntimeEvent, { type: 'user.command_invoked' }>) => void,
  ): Promise<ContextCompactionCommandResult> {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return { events: [], text: 'Session is unavailable.', isError: true };
    return rt.runManualCompactionExclusive((signal) =>
      this.handleContextCompactionUnlocked(
        threadId,
        customInstructions,
        onProgress,
        onCommand,
        signal,
      ),
    );
  }

  /** Bridge-only path: Host owns serialization and the cancellation signal. */
  executeHostCompactionV1(
    threadId: string,
    customInstructions?: string,
    onProgress?: (
      phase: import('@kite/runtime-contract').ContextCompactionProgressPhase | undefined,
    ) => void,
    onCommand?: (event: Extract<RuntimeEvent, { type: 'user.command_invoked' }>) => void,
    signal?: AbortSignal,
  ): Promise<ContextCompactionCommandResult> {
    return this.handleContextCompactionUnlocked(
      threadId,
      customInstructions,
      onProgress,
      onCommand,
      signal,
    );
  }

  private async handleContextCompactionUnlocked(
    threadId: string,
    customInstructions?: string,
    onProgress?: (
      phase: import('@kite/runtime-contract').ContextCompactionProgressPhase | undefined,
    ) => void,
    onCommand?: (event: Extract<RuntimeEvent, { type: 'user.command_invoked' }>) => void,
    signal?: AbortSignal,
  ): Promise<ContextCompactionCommandResult> {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return { events: [], text: 'Session is unavailable.', isError: true };
    const config = rt.config;
    const flags = getFeatureFlags(config);
    if (!flags.contextCompactionV2 || !flags.contextCompactionManualV1) {
      return {
        events: [],
        text: 'Context compaction is disabled by feature flags.',
        isError: true,
      };
    }

    // Manual compaction is a Kernel effect, not an App-side recovery helper.
    // An idle SessionRuntime currently has no retained execution control that
    // can safely own the State 25 transition, lease, and Store 4 commit. Keep
    // the operation fail-closed until Host/session lifecycle supplies that
    // single coordinator; never open a second Kernel or executor here.
    const control = rt.authorizedExecutionControl;
    if (!control) return contextCompactionRequiresLiveControl();

    const runWithState = async (
      state: Readonly<RuntimeState>,
      processEvent: (event: RuntimeEvent) => void,
      execute?: () => Promise<RuntimeEvent[]>,
    ): Promise<ContextCompactionCommandResult> => {
      const commandEvent: Extract<RuntimeEvent, { type: 'user.command_invoked' }> = {
        type: 'user.command_invoked',
        commandId: crypto.randomUUID(),
        command: customInstructions ? `/compact ${customInstructions}` : '/compact',
      };
      // Render local commands immediately, but only persist a command once it
      // passes local preflight. A rejected `/compact` remains visible in the
      // current TUI alongside its result without becoming replayed history.
      const presentCommand = () => onCommand?.(commandEvent);
      const persistCommand = () => {
        processEvent(commandEvent);
        presentCommand();
      };

      const executeManualCompaction = async (
        compactionId: string,
      ): Promise<RuntimeEvent[] | undefined> => {
        if (!execute || rt.manualCompactionInFlightId === compactionId) return undefined;
        rt.manualCompactionInFlightId = compactionId;
        try {
          return await execute();
        } finally {
          if (rt.manualCompactionInFlightId === compactionId) {
            rt.manualCompactionInFlightId = null;
          }
        }
      };

      // A previous client version could persist a manual request after the
      // turn had stopped, but never schedule its effect. Once the session is
      // terminal, the next `/compact` must recover that durable request rather
      // than repeatedly reporting it as pending forever.
      const existingPending = state.context.pendingCompaction;
      if (existingPending?.reason === 'manual') {
        const boundary = findSafeCompactionBoundary(state);
        if (!boundary.eligible) {
          presentCommand();
          if (!execute) {
            return {
              events: [],
              text: 'A context compaction request is already pending.',
            };
          }
          const boundaryMessage =
            boundary.reason === 'No settled historical turn is old enough to compact.'
              ? 'Not enough messages to compact.'
              : (boundary.reason ?? 'Not enough messages to compact.');
          const failedEvent: RuntimeEvent = {
            type: 'context.compaction_failed',
            compactionId: existingPending.compactionId,
            sourceRevision: state.revision,
            errorKind: 'unsafe_boundary',
            message: boundaryMessage,
            retryable: false,
          };
          processEvent(failedEvent);
          return {
            events: [failedEvent],
            text: boundaryMessage,
          };
        }
        persistCommand();
        const produced = await executeManualCompaction(existingPending.compactionId);
        if (!produced) {
          return {
            events: [],
            text: 'A context compaction request is already pending.',
          };
        }
        const completed = produced.find(
          (candidate) => candidate.type === 'context.compaction_completed',
        );
        if (completed?.type === 'context.compaction_completed') {
          return {
            events: produced,
            text: contextCompactionTerminalNotice(completed).message,
          };
        }
        const failed = produced.find((candidate) => candidate.type === 'context.compaction_failed');
        const notice =
          failed?.type === 'context.compaction_failed'
            ? contextCompactionTerminalNotice(failed)
            : undefined;
        return {
          events: produced,
          text:
            notice?.message ??
            'Compaction queued; it will run when the Runtime reaches a safe boundary.',
          ...(notice?.isError ? { isError: true } : {}),
        };
      }

      const model = createChatModel(config);
      const capabilities = resolveModelCapabilities({
        config,
        adapter: model.capabilityMetadata,
      });
      const projectionEnvironment = resolveRuntimeContextProjectionEnvironment(
        {
          config,
          model,
          builtinToolCatalog: this.deps.builtinToolCatalog,
          mcpManager: rt.mcpManager ?? undefined,
          skills: rt.skillManifests,
          skillOptions: rt.skillOptions ?? undefined,
        },
        state,
      );
      const status = inspectManualContextCompaction(
        state,
        config,
        capabilities,
        projectionEnvironment,
      );

      // Reject early — emit events so the rejection text persists across TUI restart
      // (replayed through handleRuntimeEventAction during session load).
      if (execute && !status.safeBoundary.eligible) {
        presentCommand();
        const boundaryMessage =
          status.safeBoundary.reason === 'No settled historical turn is old enough to compact.'
            ? 'Not enough messages to compact.'
            : (status.safeBoundary.reason ?? 'Not enough messages to compact.');
        const compactId = crypto.randomUUID();
        const reqEvent: RuntimeEvent = {
          type: 'context.compaction_requested',
          compactionId: compactId,
          reason: 'manual',
          requestedAtRevision: state.revision,
          requestedAtTurnId: state.turn.turnId,
          force: false,
          estimate: status.preflight.estimate,
          ...(customInstructions ? { customInstructions } : {}),
        };
        processEvent(reqEvent);
        const failedEvent: RuntimeEvent = {
          type: 'context.compaction_failed',
          compactionId: compactId,
          sourceRevision: state.revision,
          errorKind: 'unsafe_boundary',
          message: boundaryMessage,
          retryable: false,
        };
        processEvent(failedEvent);
        return {
          events: [reqEvent, failedEvent],
          text: boundaryMessage,
        };
      }

      // A plain repeated /compact has no new source material once the active
      // checkpoint already covers the latest safe message. Custom summary
      // preferences apply only when there is new source material; /compact is
      // a capacity operation, not a general-purpose narrative editor.
      if (
        status.coveredThroughMessageId &&
        status.safeBoundary.lastMessageId === status.coveredThroughMessageId
      ) {
        presentCommand();
        const compactId = crypto.randomUUID();
        const reqEvent: RuntimeEvent = {
          type: 'context.compaction_requested',
          compactionId: compactId,
          reason: 'manual',
          requestedAtRevision: state.revision,
          requestedAtTurnId: state.turn.turnId,
          force: false,
          estimate: status.preflight.estimate,
        };
        processEvent(reqEvent);
        const failedEvent: RuntimeEvent = {
          type: 'context.compaction_failed',
          compactionId: compactId,
          sourceRevision: state.revision,
          errorKind: 'unsafe_boundary',
          message: 'No new messages to compact.',
          retryable: false,
        };
        processEvent(failedEvent);
        return {
          events: [reqEvent, failedEvent],
          text: 'No new messages to compact.',
        };
      }

      const event = manualContextCompactionEvent({
        state,
        config,
        customInstructions,
        capabilities,
        projectionEnvironment,
      }) as Extract<RuntimeEvent, { type: 'context.compaction_requested' }> | null;
      if (!event) {
        return {
          events: [],
          text: 'A context compaction request is already pending.',
        };
      }
      persistCommand();
      processEvent(event);
      if (!execute) {
        return {
          events: [event],
          text: 'Compaction queued; it will run after the current interaction reaches a settled boundary.',
        };
      }
      const produced = await executeManualCompaction(event.compactionId);
      if (!produced) {
        return {
          events: [event],
          text: 'A context compaction request is already pending.',
        };
      }
      const completed = produced.find(
        (candidate) => candidate.type === 'context.compaction_completed',
      );
      const failed = produced.find((candidate) => candidate.type === 'context.compaction_failed');
      if (completed?.type === 'context.compaction_completed') {
        const notice = contextCompactionTerminalNotice(completed);
        return {
          events: [event, ...produced],
          text: notice.message,
        };
      }
      const notice =
        failed?.type === 'context.compaction_failed'
          ? contextCompactionTerminalNotice(failed)
          : undefined;
      return {
        events: [event, ...produced],
        text:
          notice?.message ??
          'Compaction queued; it will run when the Runtime reaches a safe boundary.',
        ...(notice?.isError ? { isError: true } : {}),
      };
    };

    {
      const liveState = control.getState();
      // `SET_IDLE` is rendered after the runtime emits its terminal event but
      // can precede the generator's final cleanup by one React turn. Wait for
      // that cleanup before injecting the request into the existing control.
      if (liveState.turn.status === 'completed' && liveState.interactions.kind === 'idle') {
        await rt.waitForRunCompletion();
        if (rt.authorizedExecutionControl !== control) {
          return rt.authorizedExecutionControl
            ? this.handleContextCompactionUnlocked(
                threadId,
                customInstructions,
                onProgress,
                onCommand,
                signal,
              )
            : contextCompactionRequiresLiveControl();
        }
      }
      const runtimeCoordinator = this.deps.runtimeSessionCoordinator?.get(threadId);
      const execute =
        runtimeCoordinator && !runtimeCoordinator.isTurnActive()
          ? () =>
              runtimeCoordinator.executePendingCompaction({
                dependencies: this.runtimeCompactionDependencies(
                  rt,
                  runtimeCoordinator,
                  signal,
                  onProgress ?? (() => undefined),
                ),
                signal,
              })
          : undefined;
      return runWithState(control.getState(), control.processEvent, execute);
    }
  }

  /** PR 9: Handle /context — display context usage breakdown. */
  handleContextDisplay(threadId: string): string {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return 'Session is unavailable.';
    const config = rt.config;
    const runtimeCoordinator = this.deps.runtimeSessionCoordinator?.get(threadId);
    if (!runtimeCoordinator) return 'Context status requires an active Runtime Host session.';
    const state = runtimeCoordinator.getState();
    const model = createChatModel(config);
    const environment = resolveRuntimeContextProjectionEnvironment(
      {
        config,
        model,
        builtinToolCatalog: this.deps.builtinToolCatalog,
        mcpManager: rt.mcpManager ?? undefined,
        skills: rt.skillManifests,
        skillOptions: rt.skillOptions ?? undefined,
      },
      state,
    );
    const capabilities = resolveModelCapabilities({
      config,
      adapter: model.capabilityMetadata,
    });
    const status = buildContextStatusReport(state, config, environment, capabilities);
    return `\n${status.text}`;
  }

  /** Rebuild the current context projection locally when a session becomes active. */
  buildContextStatusSnapshot(threadId: string): ContextStatusSnapshot | undefined {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return undefined;
    const config = rt.config;
    const control =
      rt.authorizedExecutionControl ?? this.deps.runtimeSessionCoordinator?.get(threadId)?.control;
    if (!control) return undefined;
    try {
      const state = control.getState();
      const model = createChatModel(config);
      const environment = resolveRuntimeContextProjectionEnvironment(
        {
          config,
          model,
          builtinToolCatalog: this.deps.builtinToolCatalog,
          mcpManager: rt.mcpManager ?? undefined,
          skills: rt.skillManifests,
          skillOptions: rt.skillOptions ?? undefined,
        },
        state,
      );
      const capabilities = resolveModelCapabilities({
        config,
        adapter: model.capabilityMetadata,
      });
      const { projection, preflight } = buildContextStatusReport(
        state,
        config,
        environment,
        capabilities,
      );
      const checkpoint = state.context.activeCheckpoint;
      return {
        estimate: projection.estimate,
        status: preflight.status,
        ...(preflight.usableInputTokens != null
          ? { usableInputTokens: preflight.usableInputTokens }
          : {}),
        ...(preflight.utilization != null ? { utilization: preflight.utilization } : {}),
        ...(checkpoint
          ? {
              activeCheckpointId: checkpoint.compactionId,
              inputTokensBefore: checkpoint.inputTokensBefore,
              inputTokensAfter: checkpoint.inputTokensAfter,
            }
          : {}),
      };
    } catch {
      // Context status is advisory; internal rebuild failures stay out of TUI output.
      return undefined;
    }
  }

  /** PR 9: Handle /compact reset — preflight check and clear the active checkpoint. */
  async handleContextReset(threadId: string): Promise<ContextCompactionCommandResult> {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return { events: [], text: 'Session is unavailable.', isError: true };
    return rt.runManualCompactionExclusive(() => this.handleContextResetUnlocked(threadId));
  }

  /** Bridge-only path: Host owns serialization and the cancellation signal. */
  handleContextResetFromHost(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ContextCompactionCommandResult> {
    if (signal?.aborted) {
      const error = new Error('Session operation cancelled.');
      error.name = 'AbortError';
      return Promise.reject(error);
    }
    return this.handleContextResetUnlocked(threadId);
  }

  private async handleContextResetUnlocked(
    threadId: string,
  ): Promise<ContextCompactionCommandResult> {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return { events: [], text: 'Session is unavailable.', isError: true };
    const config = rt.config;
    const flags = getFeatureFlags(config);
    if (!flags.contextCompactionV2 || !flags.contextCompactionManualV1) {
      return {
        events: [],
        text: 'Context compaction is disabled by feature flags.',
        isError: true,
      };
    }

    // When a model run owns the live Kernel, route the reset through that same
    // control plane so its eventual snapshot cannot overwrite the reset.
    const runtimeCoordinator = this.deps.runtimeSessionCoordinator?.get(threadId);
    const control = rt.authorizedExecutionControl ?? runtimeCoordinator?.control;
    if (!control) return contextCompactionRequiresLiveControl();
    {
      const state = control.getState();
      if (state.context.pendingCompaction) {
        return { events: [], text: 'Wait for the pending compaction to finish before reset.' };
      }
      const checkpoint = state.context.activeCheckpoint;
      if (!checkpoint) {
        return { events: [], text: 'No active checkpoint to reset.' };
      }
      const model = createChatModel(config);
      const environment = resolveRuntimeContextProjectionEnvironment(
        {
          config,
          model,
          builtinToolCatalog: this.deps.builtinToolCatalog,
          mcpManager: rt.mcpManager ?? undefined,
          skills: rt.skillManifests,
          skillOptions: rt.skillOptions ?? undefined,
        },
        state,
      );
      const capabilities = resolveModelCapabilities({
        config,
        adapter: model.capabilityMetadata,
      });
      const preflight = compactResetPreflight(state, config, environment, capabilities);
      if (!preflight.safe) {
        return {
          events: [],
          text: `Cannot reset: ${preflight.reason}`,
          isError: true,
        };
      }
      const resetEvent: RuntimeEvent = {
        type: 'context.compaction_reset',
        checkpointId: checkpoint.compactionId,
        reason: 'manual',
      };
      control.processEvent(resetEvent);
      return {
        events: [resetEvent],
        text: `Checkpoint ${checkpoint.compactionId.slice(0, 12)}... cleared. Context restored to full transcript.`,
      };
    }
  }

  /** Persist a plan-mode intent before the user has supplied the task text. */
  enterPlanningMode(threadId: string): RuntimeEvent[] {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return [];
    const liveControl =
      rt.authorizedExecutionControl ?? this.deps.runtimeSessionCoordinator?.get(threadId)?.control;
    if (!liveControl) return [];
    const control: Pick<AuthorizedExecutionControlV1, 'getState' | 'processEventBatch'> =
      liveControl;
    const events: RuntimeEvent[] = [];
    const state = control.getState();
    const active = getActiveTask(state);
    const planning = getActivePlanning(state);
    if (active && planning.kind !== 'building_without_plan') {
      return events;
    }
    if (active?.sideEffectsStarted) return events;
    const taskId = active?.taskId ?? crypto.randomUUID();
    if (!active) {
      const started: RuntimeEvent = {
        type: 'task.started',
        taskId,
        userGoal: '',
        turnId: state.turn.turnId,
      };
      events.push(started);
    }
    const entered: RuntimeEvent = {
      type: 'planning.entered',
      taskId,
      source: 'user_command',
    };
    events.push(entered);
    return control.processEventBatch(events);
  }

  /** Persist an explicit plan-mode exit; review cancellation remains separate. */
  exitPlanningMode(threadId: string): PlanningModeExitResult | null {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return null;
    const liveControl =
      rt.authorizedExecutionControl ?? this.deps.runtimeSessionCoordinator?.get(threadId)?.control;
    if (!liveControl) return null;
    const control: Pick<AuthorizedExecutionControlV1, 'getState' | 'processEventBatch'> =
      liveControl;
    const state = control.getState();
    const active = getActiveTask(state);
    const planning = getActivePlanning(state);
    const phase = getAgentPhase(planning);
    // run.completed closes the Core Task before the TUI user explicitly
    // leaves its sticky plan input mode. In that settled state there is no
    // Task lifecycle left to cancel; report the authoritative building
    // phase so the client can reconcile its projection locally.
    if (!active || phase !== 'planning') return { events: [], phase };
    if (state.interactions.kind !== 'idle') {
      return { events: [], phase };
    }
    const events: RuntimeEvent[] = [
      {
        type: 'planning.exited',
        taskId: active.taskId,
        reason: 'Exited Plan Mode.',
      },
      {
        type: 'task.cancelled',
        taskId: active.taskId,
        reason: 'Exited Plan Mode.',
      },
    ];
    return { events: control.processEventBatch(events), phase: 'building' };
  }

  getActiveId(): string {
    return this.sessionRegistry.activeId;
  }

  switchSession(fromId: string, toId: string): void {
    // Switching the visible session is not cancellation. Background approval
    // and plan-review interactions remain durable and wake when foregrounded.
    const fromRt = this.sessionRegistry.runtimes.get(fromId);
    if (fromRt) {
      fromRt.setForeground(false);
    }
    this.sessionRegistry.activeId = toId;
  }

  /** 懒加载：首次访问时从 DB 批量载入 token 统计到内存缓存
   *  Lazy load: populate in-memory cache from DB on first access */
  private ensureTokenStatsLoaded(): void {
    if (this.tokenStatsCache.size > 0) return;
    try {
      for (const entry of this.deps.tokenStatsStorage.loadAll()) {
        this.tokenStatsCache.set(entry.sessionId, entry.value);
      }
    } catch {
      // Token statistics are advisory; internal load failures stay out of TUI output.
    }
  }

  /** 创建会话快照列表。
   *  @param prevSessions 前一次 snapshot 数组，用于继承已累积的 token 统计等跨生命周期状态。
   *  Create session snapshot list.
   *  @param prevSessions previous snapshot array, used to inherit accumulated token stats across lifecycles. */
  getSnapshot(
    prevSessions?: ReadonlyArray<{ threadId: string; status: StatusState }>,
  ): SessionSnapshot[] {
    // 首次调用时从 DB 批量加载到内存缓存 / Bulk load from DB into memory cache on first call
    this.ensureTokenStatsLoaded();
    const prevMap = new Map(prevSessions?.map((s) => [s.threadId, s.status]));
    const result: SessionSnapshot[] = [];
    for (const [threadId, rt] of this.sessionRegistry.runtimes) {
      const prevStatus = prevMap.get(threadId);
      const dbStats = this.tokenStatsCache.get(threadId);
      const rawStatus = {
        ...initialStatusSnapshot(),
        ...(dbStats ?? {}), // 从 DB 恢复的 token 统计
        ...(prevStatus ?? {}), // 内存中保留的状态（优先级最高）
      };
      // 从恢复的 token 计数重新计算缓存命中率（派生值，不单独持久化）
      // Recompute cacheHitRate from restored token counts (derived, not persisted separately)
      const cacheTotal = rawStatus.cacheHitTokens + rawStatus.cacheMissTokens;
      rawStatus.cacheHitRate = cacheTotal > 0 ? rawStatus.cacheHitTokens / cacheTotal : 0;
      result.push({
        threadId,
        name: rt.name,
        workspace: rt.workspace,
        active: threadId === this.sessionRegistry.activeId,
        running: rt.agentLoopActive,
        pendingInterrupt: rt.pendingInterrupt,
        interrupt: null,
        plan: null,
        interactionMode: rt.interactionMode,
        status: rawStatus,
        turns: [],
        pendingToolCalls: {},
      });
    }
    return result;
  }

  onInterruptPending(threadId: string): void {
    this.snapshotCallback?.(threadId);
  }

  onStatusChange(threadId: string): void {
    this.snapshotCallback?.(threadId);
  }

  /** 设置会话名称（在 generateSessionName 后调用） */
  setName(threadId: string, name: string): void {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (rt) rt.name = name;
  }

  setSnapshotCallback(fn: (threadId: string) => void): void {
    this.snapshotCallback = fn;
  }

  // ── 供 index.tsx /new 拦截使用 ──

  /** 注册一个由外部创建的 threadId（如 FORK） */
  registerSession(threadId: string, workspace: string): SessionRuntime {
    const storage = this.deps.openStateSessionStorage(threadId);
    let persisted: RuntimeState | null;
    try {
      persisted = storage.loadSnapshot<RuntimeState>(threadId);
    } finally {
      storage.close();
    }
    const projectIdentity =
      persisted?.session.projectId &&
      persisted.session.canonicalWorkspaceDigest &&
      /^sha256:[a-f0-9]{64}$/u.test(persisted.session.canonicalWorkspaceDigest)
        ? {
            projectId: persisted.session.projectId,
            canonicalWorkspaceDigest: persisted.session
              .canonicalWorkspaceDigest as `sha256:${string}`,
          }
        : undefined;
    if (this.deps.runtimeSessionCoordinator && !projectIdentity) {
      throw new Error('Persisted State Session is missing its Project identity.');
    }
    const rt = new SessionRuntime(
      threadId,
      workspace,
      {
        ...this.deps,
        config: this.defaultConfig,
      },
      projectIdentity,
    );
    rt.notifyInterrupt = () => {
      this.snapshotCallback?.(rt.threadId);
    };
    this.sessionRegistry.runtimes.set(threadId, rt);
    this.ensureRuntimeCoordinator(rt);
    return rt;
  }

  /** 检查指定 threadId 是否已有运行时 / Check if a runtime exists for threadId */
  hasRuntime(threadId: string): boolean {
    return this.sessionRegistry.runtimes.has(threadId);
  }

  /** 移除运行时（会话删除后调用）/ Remove a runtime (called after session deletion) */
  removeRuntime(threadId: string): void {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (rt) {
      rt.abort();
      rt.clearBuffer();
    }
    this.sessionRegistry.runtimes.delete(threadId);
    // Don't leave activeId pointing to a deleted session
    if (this.sessionRegistry.activeId === threadId) {
      this.sessionRegistry.activeId = '';
    }
  }

  /** Bridge-only presentation cleanup after Host has cancelled and drained the session. */
  removeRuntimeAfterHostClose(threadId: string): void {
    this.sessionRegistry.runtimes.get(threadId)?.clearBuffer();
    this.sessionRegistry.runtimes.delete(threadId);
    if (this.sessionRegistry.activeId === threadId) this.sessionRegistry.activeId = '';
  }

  /** Release the State 25 session only after Host lifecycle has drained. */
  async releaseRuntimeSessionCoordinator(threadId: string): Promise<void> {
    await this.deps.runtimeSessionCoordinator?.release(threadId);
  }

  /** Close all runtime coordinators after Host has stopped every session. */
  async closeRuntimeSessionCoordinators(): Promise<void> {
    await this.deps.runtimeSessionCoordinator?.close();
  }

  /** Cancel and await every writer before durable session deletion. */
  async cancelRuntimeOperations(threadId: string): Promise<void> {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return;
    rt.abort();
    await rt.cancelManualCompaction(true);
    await rt.waitForRunCompletion();
  }

  /** 中止所有运行中的会话（退出时调用）/ Abort all running sessions (called on exit) */
  abortAll(): void {
    for (const rt of this.sessionRegistry.runtimes.values()) {
      if (rt.agentLoopActive) {
        rt.abort();
      }
    }
  }

  /** 清理资源：刷新所有防抖写入、关闭 DB 连接 / Cleanup: flush all pending debounce writes, close DB */
  dispose(): void {
    // 清除所有防抖定时器并立即写入最新值
    // Clear all debounce timers and write latest values immediately
    for (const [threadId, timer] of this._statsDebounceTimers) {
      clearTimeout(timer);
      const stats = this.tokenStatsCache.get(threadId);
      if (stats) this._flushTokenStatsNow(threadId, stats);
    }
    this._statsDebounceTimers.clear();

    try {
      this.deps.tokenStatsStorage.close();
    } catch {
      /* best-effort */
    }
    // Telemetry is non-critical and bounded: start a best-effort flush without
    // delaying synchronous React cleanup. Explicit process exit paths also
    // retain a short settle window for this promise.
    void this.shutdownObservability(250);
  }

  /** Idempotent bounded shutdown used by every TUI process-exit path. */
  shutdownObservability(timeoutMs = 250): Promise<void> {
    if (!this.deps.observabilityBridge) return Promise.resolve();
    this._observabilityShutdown ??= this.deps.observabilityBridge.shutdown(timeoutMs).catch(() => {
      // Observability never changes Runtime or process-exit outcome semantics.
    });
    return this._observabilityShutdown;
  }

  /** 同步 skills 到所有现有运行时（skills 扫描完成后调用）/ Sync skill manifests to all existing runtimes (called after skill scan completes) */
  updateSkillManifests(manifests: SkillManifest[]): void {
    this.deps.skillManifests = manifests;
    for (const rt of this.sessionRegistry.runtimes.values()) {
      rt.skillManifests = manifests;
    }
  }

  /** Sync the runtime-facing MCP provider to all existing sessions. */
  updateMcpRuntimeProvider(provider: McpRuntimeProvider | null): void {
    this.deps.mcpManager = provider;
    for (const rt of this.sessionRegistry.runtimes.values()) {
      rt.mcpManager = provider;
    }
  }

  updateMcpRecoveryController(controller: Pick<McpController, 'recover'> | null): void {
    this.deps.mcpRecoveryController = controller;
    for (const runtime of this.sessionRegistry.runtimes.values()) {
      runtime.mcpRecoveryController = controller;
    }
  }
}

function initialStatusSnapshot(): StatusState {
  return {
    phase: 'building',
    plan: null,
    pendingPlan: null,
    authorization: 'default',
    workspaceAccess: 'write',
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheHitRate: 0,
    totalTokens: 0,
    currentNode: null,
    modelProvider: '',
    modelName: '',
    thinkingMode: '',
    retryState: null,
  };
}
