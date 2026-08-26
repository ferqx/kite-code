import type { BuiltinToolCatalogProjection } from '@kite-ai/builtin-runtime';
import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import { sandboxBackendAvailable } from '@kite-ai/builtin-runtime/sandbox';
import type {
  AgentPhase,
  RuntimeClientEvent,
  SkillManifest,
  SkillScanOptions,
} from '@kite-ai/runtime-contract';
import { projectRuntimeObservabilityFact } from '@kite-ai/runtime-host';
import {
  isPrecommittedInteractionAction,
  type PrecommittedInteractionActionDescriptor,
} from '#kite-cli/bootstrap/runtime/command-interaction-decision';
import type {
  AuthorizedExecutionControl,
  RuntimeSessionCoordinator,
  RuntimeSessionCoordinatorAccess,
} from '#kite-cli/bootstrap/runtime/RuntimeSessionCoordinator';
import { buildRunAgentParams } from '#kite-cli/bootstrap/runtime/runtime-agent-input';
import type { RuntimeUserAction } from '#kite-cli/bootstrap/runtime/state-actions';
import type {
  RuntimeActionProvider,
  RuntimeInteractionCommandCommitPort,
} from '#kite-cli/bootstrap/runtime/state-runner';
import type {
  RuntimeEffect,
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from '#kite-cli/bootstrap/runtime/state-runtime';
import type { PrecommittedStartTurnDescriptor } from '#kite-cli/bootstrap/runtime/turn-command-decision';
import type { RuntimeTurnInput } from '#kite-cli/bootstrap/runtime/turn-coordinator';
import type { AgentConfig } from '#kite-cli/config/index';
import { composeAppGitBroker, resolveAppGitExecutable } from '#kite-cli/git/composition';
import type { RuntimeMetricBridge } from '#kite-cli/observability/runtime-bridge';
import {
  type McpRecoveryController,
  providerActionInput,
  providerAdmissionInput,
  type SessionInterruptPayload,
  type SessionPresentationAction,
  type SessionUserAction,
  type SessionUserInputProvider,
  shouldProjectRunExited,
} from '#kite-cli/runtime/session/contracts';
import { projectStateRuntimeEventForPresentation } from '#kite-cli/runtime-client/presentation-history';
import { type AppShellExecutor, composeAppSandboxExecutor } from '#kite-cli/sandbox/composition';

function isRecoverableError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /timeout|timed out|rate limit|overloaded|\b429\b|\b5\d\d\b/.test(message);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Align a restored Kernel with the session preference before any new turn can
 * dispatch tools. Coordinator identity and the TUI label are mirrors; the
 * durable Kernel event remains the authority consumed by Tool Governance.
 */
export function reconcileRuntimeInteractionMode(
  control: AuthorizedExecutionControl,
  mode: RuntimeState['mode'],
  changedAt = new Date().toISOString(),
): boolean {
  if (control.getState().mode === mode) return false;
  control.processEvent({
    type: 'interaction_mode.changed',
    mode,
    source: 'user',
    changedAt,
  });
  if (control.getState().mode !== mode) {
    throw new Error('Runtime interaction mode reconciliation was not durably acknowledged.');
  }
  return true;
}

type ModelRetry = {
  invocationId?: unknown;
  attempt?: unknown;
  maxAttempts?: unknown;
  error?: unknown;
  delayMs?: unknown;
};

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asModelRetry(value: unknown): {
  invocationId?: string;
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
    ...(typeof retry.invocationId === 'string' && retry.invocationId.length > 0
      ? { invocationId: retry.invocationId }
      : {}),
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
} from '#kite-cli/runtime/session/contracts';

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
  provider: SessionUserInputProvider;
  skillManifests: SkillManifest[];
  skillOptions: SkillScanOptions | null;
  mcpManager: McpRuntimeProvider | null;
  /** Independent authorization source for one remote MCP content invocation. */
  mcpRecoveryController?: McpRecoveryController | null;
  /** checkpoint DB 路径，用于持久化 token 统计 / Checkpoint DB path for persisting token stats */
  checkpointPath: string;
  /** The only Store 4 production constructor, injected by apps/kite-cli bootstrap. */
  openStateRuntimeStorage: (threadId?: string) => StateRuntimeStorage;
  /** Host-owned stable private identity for one State recovery journal. */
  resolveRecoveryIdentity: (threadId: string) => string;
  /** App-owned fresh identity allocator used only inside a new fork transaction. */
  allocateRecoveryIdentity: () => string;
  /** App projection of the Host's one frozen Builtin registry snapshot. */
  builtinToolCatalog: BuiltinToolCatalogProjection;
  /** Host-owned Runtime SPI execution port; production bootstrap always injects it. */
  capabilityExecution?: RuntimeTurnInput['capabilityExecution'];
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
  observabilityBridge?: RuntimeMetricBridge;
  /** TUI-owned startup decision reused by every session and Shell invocation. */
  shellExecutor?: AppShellExecutor;
  /** Wait until Ink has committed and written the current presentation frame. */
  flushPresentation?: () => Promise<void>;
  /** App-owned concrete Model/Artifact/Subagent composition factory. */
  modelInvocationRuntimeFactory: (workspace: string) => RuntimeTurnInput['modelInvocationRuntime'];
  /** Optional TUI-only State coordinator supplied by Host bootstrap. */
  runtimeSessionCoordinator?: RuntimeSessionCoordinatorAccess;
}

export interface RuntimeProjectIdentity {
  readonly projectId: string;
  readonly canonicalWorkspaceDigest: `sha256:${string}`;
}

export interface ContextCompactionCommandResult {
  events: RuntimeClientEvent[];
  text: string;
  isError?: boolean;
  /** Typed fail-closed reason when no live Runtime/Kernel control exists. */
  failureCode?: 'runtime_control_unavailable';
}

export function contextCompactionRequiresLiveControl(): ContextCompactionCommandResult {
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
  eventBuffer: RuntimeClientEvent[] = [];
  /** Durable State facts emitted while this Session is backgrounded. */
  private _durableStateEventBuffer: RuntimeEvent[] = [];
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
  mcpRecoveryController: McpRecoveryController | null;

  generator: AsyncGenerator<RuntimeEvent> | null = null;
  authorizedExecutionControl: AuthorizedExecutionControl | null = null;
  /** Prevent repeated `/compact` commands from concurrently executing one pending checkpoint. */
  manualCompactionInFlightId: string | null = null;
  /** 当后台会话命中中断时通知 Manager 刷新快照 / Callback to notify Manager on background interrupt */
  notifyInterrupt: (() => void) | null = null;

  // ── 双模式代理：生成器始终使用 _proxyProvider，通过 _foreground 切换事件路由 ──
  private _foreground = true;
  private _foregroundWake: (() => void) | null = null;
  private _proxyProvider: Pick<SessionUserInputProvider, 'requestAction'>;
  /** 每实例独立的中断状态，不与 realProvider 共享 pendingResolve。中断永久等待用户处理 */
  private _pendingInterrupt: SessionInterruptPayload | null = null;
  private _pendingResolve: {
    interactionId: string;
    generation?: number;
    resolve: (action: SessionUserAction | PrecommittedInteractionActionDescriptor) => void;
  } | null = null;
  private _pendingCommandInteraction: {
    interactionId: string;
    port: RuntimeInteractionCommandCommitPort;
  } | null = null;
  /** Bridge-private durable State event sink; absent outside Runtime Server composition. */
  private _runtimeStateEventSink: ((event: RuntimeEvent) => void) | null = null;
  /**
   * A durable interaction can reach the TUI before the runner installs its
   * requestAction waiter (notably while concurrent Subagent siblings drain).
   * Bind that early UI decision to the exact Runtime interaction instead of
   * dropping Enter/Esc during the hand-off window.
   */
  private _queuedInterruptAction: {
    interactionId: string;
    generation?: number;
    action: SessionUserAction;
  } | null = null;
  /** Bounded exact-ID guard for key repeat and late UI submissions. */
  private readonly _submittedInteractionIds = new Set<string>();
  private _activeDispatch: ((action: SessionPresentationAction) => void) | null = null;
  private _contentLoggingDisclosureShown = false;
  private readonly _observabilityBridge: RuntimeMetricBridge | undefined;
  private readonly _shellExecutor: AppShellExecutor | undefined;
  /** Executor whose prepare() promise currently owns this run's startup boundary. */
  private _preparingShellExecutor: AppShellExecutor | null = null;
  private readonly _flushPresentation: (() => Promise<void>) | undefined;
  private readonly _modelInvocationRuntimeFactory: SessionDeps['modelInvocationRuntimeFactory'];
  private readonly _resolveRecoveryIdentity: SessionDeps['resolveRecoveryIdentity'];
  private readonly _capabilityExecution: SessionDeps['capabilityExecution'];
  private readonly _runtimeSessionCoordinator: SessionDeps['runtimeSessionCoordinator'];
  /**
   * Remains pending while the previous generator is unwinding after abort().
   * abort() clears the user-visible running flag immediately, but a new run
   * must not enter the same StateRuntimeStorage until the old loop has closed.
   */
  private _runCompletion: Promise<void> | null = null;
  /** Serializes every manual compaction mutation for this StateRuntimeStorage thread. */
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
    dispatch: ((action: SessionPresentationAction) => void) | null;
    text?: Extract<RuntimeEvent, { type: 'model.text_delta' }>;
    reasoning?: Extract<RuntimeEvent, { type: 'model.reasoning_delta' }>;
    timer: ReturnType<typeof setTimeout> | null;
  } = { dispatch: null, timer: null };
  private _toolProgressBuffer: {
    dispatch: ((action: SessionPresentationAction) => void) | null;
    events: Map<string, ToolProgressEvent>;
    timer: ReturnType<typeof setTimeout> | null;
  } = { dispatch: null, events: new Map(), timer: null };

  constructor(
    threadId: string,
    workspace: string,
    deps: SessionDeps,
    projectIdentity?: RuntimeProjectIdentity,
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

  /** Surface an asynchronous Host command failure through the canonical Runtime event stream. */
  reportRuntimeFailure(message: string): void {
    const event: RuntimeEvent = {
      type: 'run.error',
      message,
      recoverable: false,
    };
    if (this._activeDispatch) this._routeRuntimeEvent(event, this._activeDispatch);
    else this._pushToBuffer(event);
  }

  abort(): void {
    this.persistCancellation();
    this._manualCompactionAbortController?.abort('Cancelled by user.');
    // Resolve a suspended interaction before aborting so the generator can
    // leave requestAction and close its StateRuntimeStorage handle.
    this._cancelCurrentInteraction();
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
    this._durableStateEventBuffer = [];
    this.conversationHistory = [];
    this.pendingInterrupt = false;
  }

  /** 切换到前台：新事件路由到 provider.onEvent，唤醒挂起的后台中断 */
  setForeground(foreground: boolean): void {
    this._flushBufferedPresentation();
    this._foreground = foreground;
    if (foreground) {
      this._flushDurableStateEventBuffer();
      this._foregroundWake?.();
      this._foregroundWake = null;
    }
  }

  // ── Agent 运行 ──

  /** 运行 agent 任务。始终使用代理提供器，通过 _foreground 控制事件路由 */
  async runTask(
    task: string,
    deps: {
      dispatch: (action: SessionPresentationAction) => void;
      /** Runtime Server bridge receives every non-ephemeral State revision here. */
      onRuntimeStateEvent?: (event: RuntimeEvent) => void;
      provider: SessionUserInputProvider;
      config: AgentConfig;
      model?: import('@kite-ai/builtin-runtime/model').SupportedChatModel;
    },
    requestedPhase?: AgentPhase,
    initialSkillActivations?: Array<{
      skillId: string;
      input: Record<string, unknown>;
    }>,
    hostSignal?: AbortSignal,
    hostAbort?: (reason: string) => void,
    precommittedStart?: PrecommittedStartTurnDescriptor,
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
    // open a concurrent StateRuntimeStorage-backed loop. Establish cancellation at
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
    this._runtimeStateEventSink = deps.onRuntimeStateEvent ?? null;
    const forwardHostAbort = () => {
      this._cancelCurrentInteraction();
      this._preparingShellExecutor?.abortPreparation?.();
      this._manualCompactionAbortController?.abort('Cancelled by user.');
      this._foregroundWake?.();
      this._foregroundWake = null;
    };
    if (hostSignal?.aborted) forwardHostAbort();
    else hostSignal?.addEventListener('abort', forwardHostAbort, { once: true });

    let aborted = false;
    let generatorStarted = false;
    let activeRuntimeCoordinator: RuntimeSessionCoordinator | null = null;
    try {
      const shellContext =
        this.conversationHistory.length > 0 ? `\n${this.conversationHistory.join('\n')}` : '';
      const shellExecutor =
        this._shellExecutor ??
        composeAppSandboxExecutor({
          entrypoint: 'tui',
          workspace: this.workspace,
          config: deps.config,
        });
      this._preparingShellExecutor = shellExecutor;
      let shellRuntime: Awaited<ReturnType<AppShellExecutor['prepare']>>;
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
      const gitExecutable = resolveAppGitExecutable();
      const gitBroker =
        gitExecutable && deps.config.brokeredGitShellDenyEvidence
          ? composeAppGitBroker({
              workspace: this.workspace,
              executable: gitExecutable,
              config: deps.config,
              shellDenyEvidence: deps.config.brokeredGitShellDenyEvidence,
            })
          : undefined;
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
      runtimeCoordinator.updateSandboxAvailable(sandboxBackendAvailable(effectiveBackend));
      if (precommittedStart) {
        if (runtimeCoordinator.getState().mode !== this.interactionMode) {
          throw new Error('Runtime precommitted interaction mode does not match current State.');
        }
      } else {
        reconcileRuntimeInteractionMode(runtimeCoordinator.control, this.interactionMode);
      }

      // 始终使用代理提供器 — 事件路由由 _foreground 控制
      const runtimeInput: Omit<
        RuntimeTurnInput,
        'openStateRuntimeStorage' | 'runtimeSession' | 'createRuntimeEffectPort'
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
        ...(precommittedStart ? { precommittedStart } : {}),
        interactionMode: runAgentParams.interactionMode,
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
        requestAction: (effect, state, commandCommit) =>
          this._requestRuntimeAction(effect, state, commandCommit),
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
          // A retry without an exact invocation identity cannot be projected
          // safely when sibling model calls are concurrent.
          if (!parsedRetry.invocationId) continue;
          if (this._foreground) {
            deps.dispatch({
              type: 'RUNTIME_EVENT',
              event: {
                type: 'model.retry',
                requestId: parsedRetry.invocationId,
                attempt: parsedRetry.attempt,
                delayMs: parsedRetry.delayMs,
              },
            });
          } else {
            this._pushToBuffer({
              type: 'model.retry',
              invocationId: parsedRetry.invocationId,
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
        deps.dispatch({
          type: 'RUNTIME_EVENT',
          event: { type: 'unavailable', reason: 'unknown_event' },
        });
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
      this._runtimeStateEventSink = null;
      this._queuedInterruptAction = null;
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
    if (this._runtimeStateEventSink && !isEphemeralRuntimeEvent(event)) {
      // A background session must not dispatch into the active TUI, but the
      // durable revision cannot be discarded or compressed. On foreground
      // restoration the bridge emits every buffered raw fact in order.
      this._durableStateEventBuffer.push(event);
      return;
    }
    const projected = projectStateRuntimeEventForPresentation(event);
    if (projected === undefined) return;
    if (this.eventBuffer.length >= SessionRuntime.MAX_BUFFER) {
      const dropIdx = this.eventBuffer.findIndex(
        (candidate) => candidate.type === 'model.text_delta' || candidate.type === 'tool.progress',
      );
      if (dropIdx >= 0) {
        this.eventBuffer.splice(dropIdx, 1);
      } else if (projected.type === 'model.text_delta' || projected.type === 'tool.progress')
        return;
    }
    this.eventBuffer.push(projected);
  }

  /** Route the public RuntimeEvent stream directly to the foreground or buffer. */
  private _routeRuntimeEvent(
    event: RuntimeEvent,
    dispatch: (action: SessionPresentationAction) => void,
  ): void {
    const observabilityFact = projectRuntimeObservabilityFact(event, new Date().toISOString());
    if (observabilityFact) this._observabilityBridge?.observeRuntimeFact(observabilityFact);
    if (event.type === 'interaction_mode.changed') {
      this.interactionMode = event.mode;
      this._runtimeSessionCoordinator?.get(this.threadId)?.updateInteractionMode(event.mode);
    }
    if (event.type === 'model.text_delta' || event.type === 'model.reasoning_delta') {
      this._flushToolProgress();
      this._bufferModelDelta(event, dispatch);
      return;
    }
    if (event.type === 'model.reasoning_completed') {
      // Completion is ephemeral just like its cumulative delta. Flush that
      // delta first, then send the lifecycle boundary through the same
      // presentation dispatch. Sending it to the durable State sink would
      // make the server wait for a revision that an ephemeral event never
      // consumes, so live Server clients would never receive completion.
      this._flushModelDeltas();
      if (this._foreground) {
        const projected = projectStateRuntimeEventForPresentation(event);
        if (projected) dispatch({ type: 'RUNTIME_EVENT', event: projected });
      } else {
        this._pushToBuffer(event);
      }
      return;
    }
    if (event.type === 'tool.progress') {
      this._flushModelDeltas();
      this._bufferToolProgress(event, dispatch);
      return;
    }
    this._flushBufferedPresentation();
    if (this._foreground) {
      // Preserve the State revision even for facts omitted by the safe
      // projector. TuiRuntimeBridge owns the raw→safe projection and emits an
      // event-less notification for omitted facts, so Server revision tracking
      // never turns the next tool/interaction notification into a reset.
      if (this._runtimeStateEventSink) {
        this._runtimeStateEventSink(event);
        return;
      }
      const projected = projectStateRuntimeEventForPresentation(event);
      if (projected) dispatch({ type: 'RUNTIME_EVENT', event: projected });
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
    dispatch: (action: SessionPresentationAction) => void,
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
        const projected = projectStateRuntimeEventForPresentation(event);
        if (projected) buffered.dispatch({ type: 'RUNTIME_EVENT', event: projected });
      } else {
        this._pushToBuffer(event);
      }
    }
  }

  private _clearModelDeltas(): void {
    if (this._deltaBuffer.timer) clearTimeout(this._deltaBuffer.timer);
    this._deltaBuffer = { dispatch: null, timer: null };
  }

  private _bufferToolProgress(
    event: ToolProgressEvent,
    dispatch: (action: SessionPresentationAction) => void,
  ): void {
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
        const projected = projectStateRuntimeEventForPresentation(event);
        if (projected) buffered.dispatch({ type: 'RUNTIME_EVENT', event: projected });
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

  private _flushDurableStateEventBuffer(): void {
    if (!this._runtimeStateEventSink || this._durableStateEventBuffer.length === 0) return;
    const buffered = this._durableStateEventBuffer;
    this._durableStateEventBuffer = [];
    for (const event of buffered) this._runtimeStateEventSink(event);
  }

  /** Adapt existing Ink button actions at the UI edge and bind the persisted interaction id. */
  private async _requestRuntimeAction(
    effect: Extract<RuntimeEffect, { interactionId: string }>,
    state: Readonly<RuntimeState>,
    commandCommit: RuntimeInteractionCommandCommitPort,
  ): Promise<RuntimeUserAction | PrecommittedInteractionActionDescriptor> {
    this._pendingCommandInteraction = { interactionId: effect.interactionId, port: commandCommit };
    if (effect.type === 'request_provider_action') {
      const response = await this._proxyProvider.requestAction({
        kind: 'input',
        interactionId: effect.interactionId,
        question: providerActionInput(effect.providerId, effect.action),
      });
      if (isPrecommittedInteractionAction(response as RuntimeUserAction)) {
        return response as unknown as PrecommittedInteractionActionDescriptor;
      }
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
        interactionId: effect.interactionId,
        question: providerAdmissionInput(
          effect.providerId,
          effect.providerStatus,
          effect.retryable,
        ),
      });
      if (isPrecommittedInteractionAction(response as RuntimeUserAction)) {
        return response as unknown as PrecommittedInteractionActionDescriptor;
      }
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
        interactionId: effect.interactionId,
        question: {
          question: `Required verification is ${record.status}. Choose a recovery action.`,
          options,
          allow_free_text: true,
          recommended: 'replan',
          context: `verification:${record.spec.subject}`,
        },
      });
      if (isPrecommittedInteractionAction(action as RuntimeUserAction)) {
        return action as unknown as PrecommittedInteractionActionDescriptor;
      }
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
    let payload: SessionInterruptPayload;
    if (effect.type === 'request_user_input' && interaction.kind === 'awaiting_user_input') {
      payload = {
        kind: 'input',
        interactionId: effect.interactionId,
        question: interaction.request,
      };
    } else if (
      effect.type === 'request_tool_approval' &&
      interaction.kind === 'awaiting_tool_approval'
    ) {
      const pendingApproval = state.pendingApprovals.get(effect.interactionId);
      if (!pendingApproval || pendingApproval.status !== 'awaiting_user') {
        return {
          type: 'cancel',
          interactionId: effect.interactionId,
          reason: 'Approval queue identity changed.',
        };
      }
      payload = {
        kind: 'approval',
        interactionId: effect.interactionId,
        generation: pendingApproval.generation,
        approval: interaction.approval,
      };
    } else if (effect.type === 'request_plan_review' && interaction.kind === 'awaiting_review') {
      payload = {
        kind: 'plan_review',
        interactionId: effect.interactionId,
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
    if (isPrecommittedInteractionAction(action as RuntimeUserAction)) {
      return action as unknown as PrecommittedInteractionActionDescriptor;
    }
    switch (action.type) {
      case 'input':
        return {
          type: 'input',
          interactionId: effect.interactionId,
          text: action.text,
          answers: action.answers,
        };
      case 'approve':
        return {
          type: 'approve',
          interactionId: effect.interactionId,
          generation: payload.kind === 'approval' ? payload.generation : -1,
          grant: action.grant,
        };
      case 'reject':
        return {
          type: 'reject',
          interactionId: effect.interactionId,
          generation: payload.kind === 'approval' ? payload.generation : -1,
        };
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
  private _createProxyProvider(): Pick<SessionUserInputProvider, 'requestAction'> {
    const self = this;
    const proxy = {
      async requestAction(payload: SessionInterruptPayload): Promise<SessionUserAction> {
        if (!self._foreground) {
          // user_input in background: auto-cancel (user can't respond)
          // need_approval won't fire due to authorizationOverride, but guard anyway
          if (
            payload.kind === 'input' &&
            !payload.question?.context?.startsWith('verification:') &&
            !payload.question?.context?.startsWith('mcp-provider-')
          ) {
            return { type: 'cancel' as const, interactionId: payload.interactionId };
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
            return { type: 'cancel' as const, interactionId: payload.interactionId };
          }
        }
        const queued = self._queuedInterruptAction;
        if (queued) {
          self._queuedInterruptAction = null;
          if (
            queued.interactionId === payload.interactionId &&
            // Approve/reject are approval-generation scoped.  Cancellation
            // is deliberately not: Ctrl+C and an early Esc/cancel may arrive
            // before the waiter attaches, and input/plan interactions do not
            // carry an approval generation at all.  Requiring
            // `undefined === payload.generation` here strands an early
            // cancellation for an approval forever.
            (queued.action.type === 'cancel' || queued.generation === approvalGeneration(payload))
          ) {
            return queued.action;
          }
        }
        // 使用运行时自身的中断状态，永久等待用户处理
        self._pendingInterrupt = payload;
        return new Promise<SessionUserAction | PrecommittedInteractionActionDescriptor>(
          (resolve) => {
            self._pendingResolve = {
              interactionId: payload.interactionId,
              ...(payload.kind === 'approval' ? { generation: payload.generation } : {}),
              resolve,
            };
          },
        ) as Promise<SessionUserAction>;
      },

      submitAction(action: SessionUserAction): void {
        self.resolveInterrupt(action);
      },

      reset(): void {
        self._cancelCurrentInteraction();
      },

      getPendingInterrupt(): SessionInterruptPayload | null {
        return self._pendingInterrupt;
      },

      teardown(): Promise<void> {
        self._cancelCurrentInteraction();
        return Promise.resolve();
      },
    };
    return proxy;
  }

  /** 解析挂起的中断（由 SessionManager 的中央 bridge 调用）/ Resolve pending interrupt (called by SessionManager's central bridge) */
  resolveInterrupt(action: SessionUserAction): void {
    const actionKey = sessionActionIdentity(action);
    const generation = approvalActionGeneration(action);
    if (this._submittedInteractionIds.has(actionKey)) return;
    if (
      this._pendingResolve?.interactionId === action.interactionId &&
      (action.type === 'cancel' || this._pendingResolve.generation === generation)
    ) {
      const pending = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingInterrupt = null;
      this._queuedInterruptAction = null;
      this._rememberSubmittedInteraction(actionKey);
      pending.resolve(action);
      return;
    }
    const interaction = this._currentRuntimeInteractionIdentity();
    if (
      interaction?.interactionId === action.interactionId &&
      (action.type === 'cancel' || interaction.generation === generation) &&
      !this._queuedInterruptAction
    ) {
      this._queuedInterruptAction = {
        interactionId: action.interactionId,
        ...(generation === undefined ? {} : { generation }),
        action,
      };
    }
  }

  /** Bridge-private command seam; it is never part of the TUI public contract. */
  getPendingInteractionCommandPort(
    interactionId: string,
  ): RuntimeInteractionCommandCommitPort | null {
    return this._pendingCommandInteraction?.interactionId === interactionId
      ? this._pendingCommandInteraction.port
      : null;
  }

  resolveCommittedInteraction(descriptor: PrecommittedInteractionActionDescriptor): boolean {
    const pending = this._pendingResolve;
    if (
      !pending ||
      pending.interactionId !== descriptor.interactionId ||
      this._pendingCommandInteraction?.interactionId !== descriptor.interactionId
    ) {
      return false;
    }
    this._pendingResolve = null;
    this._pendingInterrupt = null;
    this._queuedInterruptAction = null;
    this._pendingCommandInteraction = null;
    pending.resolve(descriptor);
    return true;
  }

  private _cancelCurrentInteraction(): void {
    this._pendingCommandInteraction = null;
    const interactionId =
      this._pendingInterrupt?.interactionId ??
      this._pendingResolve?.interactionId ??
      this._currentRuntimeInteractionId();
    if (interactionId) this.resolveInterrupt({ type: 'cancel', interactionId });
  }

  private _rememberSubmittedInteraction(actionIdentity: string): void {
    this._submittedInteractionIds.add(actionIdentity);
    if (this._submittedInteractionIds.size <= 4096) return;
    const oldest = this._submittedInteractionIds.values().next().value;
    if (typeof oldest === 'string') this._submittedInteractionIds.delete(oldest);
  }

  private _currentRuntimeInteractionId(): string | null {
    return this._currentRuntimeInteractionIdentity()?.interactionId ?? null;
  }

  private _currentRuntimeInteractionIdentity(): {
    interactionId: string;
    generation?: number;
  } | null {
    let state: Readonly<RuntimeState> | undefined;
    try {
      state = this._runtimeSessionCoordinator?.get(this.threadId)?.getState();
    } catch {
      // An idle or closing coordinator may intentionally have no readable
      // control plane. There is no durable interaction to bind in that state.
      return null;
    }
    const interaction = state?.interactions;
    if (interaction && interaction.kind !== 'idle' && 'interactionId' in interaction) {
      const interactionId = interaction.interactionId;
      if (typeof interactionId === 'string' && interactionId.length > 0) {
        // The focused interaction wins over an off-screen approval.  This is
        // important while an input/plan waiter is visible alongside durable
        // queued approvals: an early cancel must bind to the input/plan id,
        // not be discarded because the approval carries another generation.
        const pending = state?.pendingApprovals.get(interactionId);
        return {
          interactionId,
          ...(pending ? { generation: pending.generation } : {}),
        };
      }
    }
    const activeApprovalId = state?.activeApprovalId;
    if (typeof activeApprovalId === 'string' && activeApprovalId.length > 0) {
      const pending = state?.pendingApprovals.get(activeApprovalId);
      return {
        interactionId: activeApprovalId,
        ...(pending ? { generation: pending.generation } : {}),
      };
    }
    return null;
  }
}

function approvalGeneration(payload: SessionInterruptPayload): number | undefined {
  return payload.kind === 'approval' ? payload.generation : undefined;
}

function isEphemeralRuntimeEvent(event: RuntimeEvent): boolean {
  return (
    event.type === 'model.text_delta' ||
    event.type === 'model.reasoning_delta' ||
    event.type === 'model.reasoning_completed' ||
    event.type === 'tool.progress'
  );
}

function approvalActionGeneration(action: SessionUserAction): number | undefined {
  return action.type === 'approve' || action.type === 'reject' ? action.generation : undefined;
}

function sessionActionIdentity(action: SessionUserAction): string {
  return `${action.interactionId}:${approvalActionGeneration(action) ?? 'interaction'}`;
}

/** 多会话管理器：创建/切换/查快照 */
