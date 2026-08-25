import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import type { ContextStatusSnapshot, SkillManifest } from '@kite/runtime-contract';
import type {
  RuntimeSessionCoordinator,
  RuntimeSessionCoordinatorIdentity,
} from '#app/bootstrap/runtime/RuntimeSessionCoordinator';
import type { RuntimeEvent, RuntimeState } from '#app/bootstrap/runtime/state-runtime';
import type { AgentConfig } from '#app/config/index';
import { ContextCompactionService } from '#app/runtime/session/context-compaction-service';
import type {
  McpRecoveryController,
  SessionListProjection,
  SessionStatusProjection,
  SessionUserAction,
} from '#app/runtime/session/contracts';
import {
  enterPlanningMode as enterPlanningModeWithControl,
  exitPlanningMode as exitPlanningModeWithControl,
} from '#app/runtime/session/planning-mode-service';
import { RewindService } from '#app/runtime/session/rewind-service';
import { SessionLifecycleService } from '#app/runtime/session/session-lifecycle';
import { projectSessionList, TokenStatsService } from '#app/runtime/session/session-projection';
import { SessionRegistry } from '#app/runtime/session/session-registry';
import {
  type ContextCompactionCommandResult,
  type PlanningModeExitResult,
  type RuntimeProjectIdentity,
  type SessionDeps,
  SessionRuntime,
} from './runtime-session';

export class SessionManager {
  private readonly sessionRegistry = new SessionRegistry<SessionRuntime>();
  private readonly lifecycleService: SessionLifecycleService;
  private readonly rewindService: RewindService;
  private readonly contextCompactionService: ContextCompactionService;
  private snapshotCallback: ((threadId: string) => void) | null = null;
  /** token 统计内存缓存，避免 getSnapshot 每次打开 DB / In-memory token stats cache to avoid DB access in getSnapshot */
  private readonly tokenStatsService: TokenStatsService;
  private _observabilityShutdown: Promise<void> | null = null;
  /** 防抖定时器：合并高频 token 统计变更为批量写入，避免每个 stream chunk 都写 DB
   *  Debounce timers: batch high-frequency token stat changes into fewer writes */
  /** 防抖延迟（毫秒）/ Debounce delay in ms */

  private deps: SessionDeps;
  private defaultConfig: AgentConfig;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.defaultConfig = deps.config;
    this.lifecycleService = new SessionLifecycleService(deps);
    this.rewindService = new RewindService(deps);
    this.contextCompactionService = new ContextCompactionService(
      () => this.deps,
      (threadId) => this.sessionRegistry.runtimes.get(threadId),
    );
    this.tokenStatsService = new TokenStatsService(deps.tokenStatsStorage);
    // Durable approvals do not occupy the presentation provider's local
    // requestAction slot. One explicit sink carries exact actions to the
    // currently active Runtime without wrapping or replacing submitAction.
    deps.provider.setActionSink?.((action: SessionUserAction) => {
      const active = this.sessionRegistry.runtimes.get(this.sessionRegistry.activeId);
      active?.resolveInterrupt(action);
    });
  }

  listRewindCheckpoints(threadId: string) {
    return this.rewindService.listCheckpoints(threadId);
  }

  listPersistedSessions(query = '') {
    return this.lifecycleService.listPersistedSessions(query);
  }

  loadPersistedSession(threadId: string) {
    return this.lifecycleService.loadPersistedSession(threadId);
  }

  deletePersistedSession(threadId: string) {
    return this.lifecycleService.deletePersistedSession(threadId);
  }

  async generateAndPersistSessionName(threadId: string, task: string) {
    return this.lifecycleService.generateAndPersistSessionName(threadId, task);
  }

  previewRewind(threadId: string, snapshotId: string, workspace: string) {
    return this.rewindService.preview(threadId, snapshotId, workspace);
  }

  async executeRewind(input: {
    sourceThreadId: string;
    snapshotId: string;
    scope: 'code_and_conversation' | 'code_only' | 'conversation_only';
    workspace: string;
  }) {
    return this.rewindService.execute(input);
  }

  /** 持久化 token 统计到 checkpoint DB（防抖合并，避免每次 token 变化都写 DB）
   *  Persist token stats to DB with debounce, avoiding a write on every token change */
  saveTokenStats(threadId: string, status: SessionStatusProjection, immediate = false): void {
    this.tokenStatsService.save(
      threadId,
      {
        cacheHitTokens: status.cacheHitTokens,
        cacheMissTokens: status.cacheMissTokens,
        totalTokens: status.totalTokens,
      },
      immediate,
    );
  }

  createSession(
    workspace: string,
    projectIdentityInput?: RuntimeProjectIdentity | ((sessionId: string) => RuntimeProjectIdentity),
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

  listSessionCommandGrants(threadId: string) {
    const coordinator = this.deps.runtimeSessionCoordinator?.get(threadId);
    if (!coordinator) return [];
    return [...coordinator.getState().sessionCommandGrants.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  clearSessionCommandGrants(threadId: string): readonly RuntimeEvent[] | null {
    const coordinator = this.deps.runtimeSessionCoordinator?.get(threadId);
    if (!coordinator) return null;
    const state = coordinator.getState();
    if (state.sessionCommandGrants.size === 0) return [];
    const event: RuntimeEvent = {
      type: 'approval.session_grants_cleared',
      sessionId: state.session.threadId,
      sessionRevision: state.revision,
      generation: state.approvalGeneration + 1,
      clearedAt: new Date().toISOString(),
    };
    const applied = coordinator.control.processEventBatch([event]);
    if (applied.length !== 1 || coordinator.getState().sessionCommandGrants.size !== 0) {
      return null;
    }
    // Return the exact persisted event so the foreground TUI consumes the
    // same fact that replay will later see; callers must not synthesize a
    // presentation-only "cleared" action.
    return applied;
  }

  /** Bridge-only restart reconciliation. Runtime Host decides when it runs. */
  recoverRuntimeState(threadId: string): boolean {
    const runtime = this.sessionRegistry.runtimes.get(threadId);
    if (!runtime) return false;
    return this.ensureRuntimeCoordinator(runtime)?.recoveryChanged ?? false;
  }

  private ensureRuntimeCoordinator(runtime: SessionRuntime): RuntimeSessionCoordinator | undefined {
    const coordinatorAccess = this.deps.runtimeSessionCoordinator;
    if (!coordinatorAccess) return undefined;
    const existingCoordinator = coordinatorAccess.get(runtime.threadId);
    const modelInvocationRuntime = this.deps.modelInvocationRuntimeFactory(runtime.workspace);
    const identity: RuntimeSessionCoordinatorIdentity = {
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
    runtime.interactionMode = coordinator.getInteractionModeState().interactionMode;
    runtime.authorizedExecutionControl = coordinator.control;
    return coordinator;
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
        const store = this.deps.openStateRuntimeStorage(threadId);
        try {
          store.sessions.setSessionModelRoute(threadId, {
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
    const store = this.deps.openStateRuntimeStorage(threadId);
    try {
      if (
        !store.checkpoints.forkCurrentSession(
          threadId,
          targetThreadId,
          this.deps.allocateRecoveryIdentity(),
        )
      )
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
  handleContextCompaction(
    threadId: string,
    customInstructions?: string,
    onProgress?: (
      phase: import('@kite/runtime-contract').ContextCompactionProgressPhase | undefined,
    ) => void,
    onCommand?: (event: Extract<RuntimeEvent, { type: 'user.command_invoked' }>) => void,
  ): Promise<ContextCompactionCommandResult> {
    return this.contextCompactionService.handle(
      threadId,
      customInstructions,
      onProgress,
      onCommand,
    );
  }

  /** Bridge-only path: Host owns serialization and the cancellation signal. */
  executeHostCompaction(
    threadId: string,
    customInstructions?: string,
    onProgress?: (
      phase: import('@kite/runtime-contract').ContextCompactionProgressPhase | undefined,
    ) => void,
    onCommand?: (event: Extract<RuntimeEvent, { type: 'user.command_invoked' }>) => void,
    signal?: AbortSignal,
  ): Promise<ContextCompactionCommandResult> {
    return this.contextCompactionService.executeHost(
      threadId,
      customInstructions,
      onProgress,
      onCommand,
      signal,
    );
  }

  handleContextDisplay(threadId: string): string {
    return this.contextCompactionService.display(threadId);
  }

  buildContextStatusSnapshot(threadId: string): ContextStatusSnapshot | undefined {
    return this.contextCompactionService.snapshot(threadId);
  }

  handleContextReset(threadId: string): Promise<ContextCompactionCommandResult> {
    return this.contextCompactionService.reset(threadId);
  }

  handleContextResetFromHost(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ContextCompactionCommandResult> {
    return this.contextCompactionService.resetFromHost(threadId, signal);
  }

  /** Persist a plan-mode intent before the user has supplied the task text. */
  enterPlanningMode(threadId: string): RuntimeEvent[] {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return [];
    const liveControl =
      rt.authorizedExecutionControl ?? this.deps.runtimeSessionCoordinator?.get(threadId)?.control;
    if (!liveControl) return [];
    return enterPlanningModeWithControl(liveControl);
  }

  /** Persist an explicit plan-mode exit; review cancellation remains separate. */
  exitPlanningMode(threadId: string): PlanningModeExitResult | null {
    const rt = this.sessionRegistry.runtimes.get(threadId);
    if (!rt) return null;
    const liveControl =
      rt.authorizedExecutionControl ?? this.deps.runtimeSessionCoordinator?.get(threadId)?.control;
    if (!liveControl) return null;
    return exitPlanningModeWithControl(liveControl);
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
    this.sessionRegistry.runtimes.get(toId)?.setForeground(true);
  }

  /** 创建会话快照列表。
   *  @param prevSessions 前一次 snapshot 数组，用于继承已累积的 token 统计等跨生命周期状态。
   *  Create session snapshot list.
   *  @param prevSessions previous snapshot array, used to inherit accumulated token stats across lifecycles. */
  getSnapshot(
    prevSessions?: ReadonlyArray<{ threadId: string; status: SessionStatusProjection }>,
  ): SessionListProjection[] {
    return projectSessionList(this.sessionRegistry, this.tokenStatsService, prevSessions);
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
    const storage = this.deps.openStateRuntimeStorage(threadId);
    let persisted: RuntimeState | null;
    let persistedName: string | undefined;
    try {
      persisted = storage.sessions.loadSnapshot<RuntimeState>(threadId);
      try {
        persistedName = storage.sessions
          .listSessions()
          .find((entry) => entry.threadId === threadId)?.name;
      } catch {
        // Session metadata is presentation-only. A malformed/unknown row must
        // not turn an otherwise successfully loaded session into a failure.
      }
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
    // Workspace and Project identity are one persisted security identity. A
    // historical session selected from another checkout must not combine the
    // caller's current workspace with the restored Project digest.
    const effectiveWorkspace = persisted?.session.workspace ?? workspace;
    const rt = new SessionRuntime(
      threadId,
      effectiveWorkspace,
      {
        ...this.deps,
        config: this.defaultConfig,
      },
      projectIdentity,
    );
    if (persistedName) rt.name = persistedName;
    rt.notifyInterrupt = () => {
      this.snapshotCallback?.(rt.threadId);
    };
    // Coordinator admission validates the complete persisted identity. Keep
    // registration atomic so a failure cannot leave a ghost Runtime that a
    // later selector attempt mistakes for a hydrated session.
    this.ensureRuntimeCoordinator(rt);
    this.sessionRegistry.runtimes.set(threadId, rt);
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

  /** Release the State 27 session only after Host lifecycle has drained. */
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
    this.deps.provider.setActionSink?.(null);
    // 清除所有防抖定时器并立即写入最新值
    // Clear all debounce timers and write latest values immediately
    this.tokenStatsService.flushAll();

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

  updateMcpRecoveryController(controller: McpRecoveryController | null): void {
    this.deps.mcpRecoveryController = controller;
    for (const runtime of this.sessionRegistry.runtimes.values()) {
      runtime.mcpRecoveryController = controller;
    }
  }
}
