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
import {
  type ContextStatusSnapshot,
  getAgentPhase,
  type SkillManifest,
} from '@kite/runtime-contract';
import {
  runtimeHostStateActivePlanning as getActivePlanning,
  runtimeHostStateActiveTask as getActiveTask,
} from '@kite/runtime-host';
import type {
  AuthorizedExecutionControl,
  RuntimeSessionCoordinator,
  RuntimeSessionCoordinatorIdentity,
} from '#app/bootstrap/runtime/RuntimeSessionCoordinator';
import {
  type RuntimeExecutorDependencies,
  resolveRuntimeContextProjectionEnvironment,
} from '#app/bootstrap/runtime/runtime-effect-dependencies';
import { SessionPersistenceService } from '#app/bootstrap/runtime/session-persistence-service';
import { SessionRegistry } from '#app/bootstrap/runtime/session-registry';
import type { RuntimeEvent, RuntimeState } from '#app/bootstrap/runtime/state-runtime';
import { TokenStatsService } from '#app/bootstrap/runtime/token-stats-service';
import { getFeatureFlags } from '#app/config/features';
import type { AgentConfig } from '#app/config/index';
import { createApprovedProviderDataAdmission } from '#app/config/provider-data-admission';
import type {
  McpRecoveryController,
  SessionListProjection,
  SessionStatusProjection,
  SessionUserAction,
} from '#app/runtime/session/contracts';
import {
  type ContextCompactionCommandResult,
  contextCompactionRequiresLiveControl,
  type PlanningModeExitResult,
  type RuntimeProjectIdentity,
  type SessionDeps,
  SessionRuntime,
} from './runtime-session';

export class SessionManager {
  private readonly sessionRegistry = new SessionRegistry<SessionRuntime>();
  private readonly persistenceService: SessionPersistenceService;
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
    this.persistenceService = new SessionPersistenceService(deps);
    this.tokenStatsService = new TokenStatsService(deps.tokenStatsStorage);
    // Central bridge: when UI components (ApprovalBlock, InputBlock) call submitAction
    // on the real provider, route to the active runtime's resolveInterrupt.
    // This runs once, avoiding the chain-wrapping anti-pattern of per-runtime bridges.
    if (deps.provider.submitAction) {
      const origSubmit = deps.provider.submitAction.bind(deps.provider);
      deps.provider.submitAction = (action: SessionUserAction) => {
        origSubmit(action);
        const active = this.sessionRegistry.runtimes.get(this.sessionRegistry.activeId);
        active?.resolveInterrupt(action);
      };
    }
  }

  listRewindCheckpoints(threadId: string) {
    return this.persistenceService.listRewindCheckpoints(threadId);
  }

  listPersistedSessions(query = '') {
    return this.persistenceService.listPersistedSessions(query);
  }

  loadPersistedSession(threadId: string) {
    return this.persistenceService.loadPersistedSession(threadId);
  }

  deletePersistedSession(threadId: string) {
    return this.persistenceService.deletePersistedSession(threadId);
  }

  async generateAndPersistSessionName(threadId: string, task: string) {
    return this.persistenceService.generateAndPersistSessionName(threadId, task);
  }

  previewRewind(threadId: string, snapshotId: string, workspace: string) {
    return this.persistenceService.previewRewind(threadId, snapshotId, workspace);
  }

  async executeRewind(input: {
    sourceThreadId: string;
    snapshotId: string;
    scope: 'code_and_conversation' | 'code_only' | 'conversation_only';
    workspace: string;
  }) {
    return this.persistenceService.executeRewind(input);
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
    runtime.authorizedExecutionControl = coordinator.control;
    return coordinator;
  }

  private runtimeCompactionDependencies(
    runtime: SessionRuntime,
    coordinator: RuntimeSessionCoordinator,
    signal: AbortSignal | undefined,
    onProgress: (
      phase: import('@kite/runtime-contract').ContextCompactionProgressPhase | undefined,
    ) => void,
  ): RuntimeExecutorDependencies {
    const config = runtime.config;
    const modelRuntime = this.deps.modelInvocationRuntimeFactory(runtime.workspace);
    const providerDataAdmission = createApprovedProviderDataAdmission(config);
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
  executeHostCompaction(
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
    if (!flags.contextCompaction || !flags.contextCompactionManual) {
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
    if (!flags.contextCompaction || !flags.contextCompactionManual) {
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
    const control: Pick<AuthorizedExecutionControl, 'getState' | 'processEventBatch'> = liveControl;
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
    const control: Pick<AuthorizedExecutionControl, 'getState' | 'processEventBatch'> = liveControl;
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
    try {
      this.tokenStatsService.loadIfEmpty();
    } catch {
      // Token statistics are advisory; internal load failures stay out of TUI output.
    }
  }

  /** 创建会话快照列表。
   *  @param prevSessions 前一次 snapshot 数组，用于继承已累积的 token 统计等跨生命周期状态。
   *  Create session snapshot list.
   *  @param prevSessions previous snapshot array, used to inherit accumulated token stats across lifecycles. */
  getSnapshot(
    prevSessions?: ReadonlyArray<{ threadId: string; status: SessionStatusProjection }>,
  ): SessionListProjection[] {
    // 首次调用时从 DB 批量加载到内存缓存 / Bulk load from DB into memory cache on first call
    this.ensureTokenStatsLoaded();
    const prevMap = new Map(prevSessions?.map((s) => [s.threadId, s.status]));
    const result: SessionListProjection[] = [];
    for (const [threadId, rt] of this.sessionRegistry.runtimes) {
      const prevStatus = prevMap.get(threadId);
      const dbStats = this.tokenStatsService.get(threadId);
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

function initialStatusSnapshot(): SessionStatusProjection {
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
