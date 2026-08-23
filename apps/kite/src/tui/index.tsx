import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import type { AgentPhase, SkillManifest, SkillScanOptions } from '@kite/runtime-contract';
import { render, useApp } from 'ink';
import React from 'react';
import {
  type AgentConfig,
  type ConfigProbeResult,
  getFeatureFlags,
  type LanguagePreference,
  loadAgentConfig,
  loadColorPreset,
  loadTheme,
  loadUserLanguage,
  probeAgentConfig,
  saveColorPreset,
  saveUserLanguage,
} from '#app/config/index';
import { sessionExportPath } from '#app/config/paths';
import { defaultCheckpointPath } from '#app/config/paths.js';
import { shouldPromptWorkspaceTrust } from '#app/config/workspace-trust';
import type { SandboxBackend } from '#app/sandbox/types';
import { type AppShellExecutorV1, composeAppSandboxExecutorV1 } from '@/app/sandbox/composition';
import { composeObservabilityV1 } from '../observability/composition';
import { resolveTelemetryConsentV1 } from '../observability/consent';
import { formatObservabilityStatusV1, projectObservabilityStatusV1 } from '../observability/status';
import { resolveReleaseCompositionV1 } from '../release/composition-root';
import { tryProjectAdmittedExecutionStatusV1 } from '../release/execution-status';
import { formatReleaseStatusV1, projectReleaseStatusV1 } from '../release/status-projection';
import App, { type Action, shouldDisablePromptInput, useTuiState } from './App';
import ErrorBoundary from './components/ErrorBoundary';
import ConfigErrorScreen from './components/first-run/ConfigErrorScreen';
import FirstRunFlow from './components/first-run/FirstRunFlow';
import InputLine from './components/InputLine';
import WorkspaceTrustGate from './components/WorkspaceTrustGate';
import { createTuiExitCoordinatorV1 } from './exit-coordinator';
import { useMcpController } from './hooks/useMcpController';
import { type RewindDeps, useRewindCheckpoints, useRunRewind } from './hooks/useRewindHandler';
import { useSkillsLoader } from './hooks/useSkillsLoader';
import { useSlashCommand } from './hooks/useSlashCommand';
import type { SlashSuggestionData } from './hooks/useSlashSuggestions';
import { detectTuiDeviceLocale, I18nProvider, resolveTuiLanguage, useI18n } from './i18n';
import { shouldCancelClearedInterrupt } from './interrupt-clear';
import { TuiUserInputProvider } from './provider';
import { sessionDataToUI } from './replay-blocks.js';
import { shouldAbortStoppedRun, shouldSetIdleAfterRun } from './run-lifecycle';
import type {
  ContextCompactionProgressPhase,
  ContextCompactionResult,
  RuntimePresentationEvent,
} from './runtime-presentation';
import type { SessionManager, TuiSessionManagerFactory } from './session-manager';
import { getDarkTheme, lightTheme, osc4Apply, ThemeContext, type ThemePreset } from './theme';

/** 模块级引用，供退出时中止所有会话 / Module-level reference for aborting all sessions on exit */
let _sessionManagerForExit: SessionManager | null = null;
/** 退出时用于中止静默启动预热的执行器引用 / Executor reference used to abort the silent startup prewarm on exit */
let _appShellExecutorForExit: AppShellExecutorV1 | null = null;
let _requestTuiExit: ((code?: number) => Promise<void>) | null = null;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const HISTORICAL_SESSION_LIST_FAILURE_TEXT = '  ⎿  历史会话服务不可用，请输入 /resume 重试。';
const HISTORICAL_SESSION_LOAD_FAILURE_TEXT =
  '  ⎿  历史会话打开失败，当前会话未受影响；请稍后通过 /resume 重试。';

function resolveConfigForResume(
  currentConfig: AgentConfig,
  persistedProvider: string,
  persistedModelName: string,
): AgentConfig {
  if (!persistedProvider || !persistedModelName) return currentConfig;
  try {
    return loadAgentConfig({
      providerName: persistedProvider,
      modelName: persistedModelName,
    });
  } catch {
    return currentConfig;
  }
}

function hasModelConversation(state: import('./types').TuiState): boolean {
  return state.turns.some((turn) =>
    turn.blocks.some(
      (block) => block.kind === 'user' && !block.content.trimStart().startsWith('/'),
    ),
  );
}

function overlaySurfaceKey(state: import('./types').TuiState): string {
  if (state.interrupt) return 'interrupt';
  if (state.showHelp) return 'help';
  if (state.showModelSelector) return 'model';
  if (state.showPermissionSelector) return 'permissions';
  if (state.showEffortSelector) return 'effort';
  if (state.showThemeSelector) return 'theme';
  if (state.showLanguageSelector) return 'language';
  if (state.showSessions) return 'sessions';
  if (state.showMcp) return 'mcp';
  if (state.showRewind) return 'rewind';
  return 'main';
}

export interface TuiBootstrapProps {
  /** Single composition-root injection; presentation never constructs legacy Runtime. */
  createSessionManager?: TuiSessionManagerFactory;
  /** 可选的自定义模型实例（用于测试注入）/ Optional custom model instance (for test injection) */
  model?: import('@kite/builtin-runtime/model').SupportedChatModel;
  /** App-owned authorization source; omitted production composition remains fail closed. */
  /** Optional App-owned Shell runtime injection used by composition and system tests. */
  shellExecutor?: AppShellExecutorV1;
}

interface TuiAppProps {
  createSessionManager: TuiSessionManagerFactory;
  config: AgentConfig;
  languagePreference: LanguagePreference;
  onLanguageSelect: (language: LanguagePreference) => boolean;
  /** 可选的自定义模型实例（用于测试注入）/ Optional custom model instance (for test injection) */
  injectModel?: import('@kite/builtin-runtime/model').SupportedChatModel;
  shellExecutor?: AppShellExecutorV1;
}

export function TuiBootstrap({
  createSessionManager,
  model: injectModel,
  shellExecutor,
}: TuiBootstrapProps) {
  const workspace = process.cwd();
  const [languagePreference, setLanguagePreference] = React.useState<LanguagePreference>(() =>
    loadUserLanguage(),
  );
  const [deviceLocale] = React.useState(detectTuiDeviceLocale);
  const language = resolveTuiLanguage(languagePreference, deviceLocale);
  // Workspace trust is checked first — no project-level config is read before trust.
  const [workspaceTrusted, setWorkspaceTrusted] = React.useState<boolean>(
    () => !shouldPromptWorkspaceTrust(workspace),
  );
  // Config is probed after trust is established.
  const [probeResult, setProbeResult] = React.useState<ConfigProbeResult | null>(() =>
    workspaceTrusted ? probeAgentConfig() : null,
  );

  const handleTrusted = React.useCallback(() => {
    setWorkspaceTrusted(true);
    setProbeResult(probeAgentConfig());
  }, []);

  const handleSetupComplete = React.useCallback(({ modelName }: { modelName: string }) => {
    const cfg = loadAgentConfig({ modelName });
    // Convert to a ready probe result so TuiApp mounts
    setProbeResult({ status: 'ready', config: cfg });
  }, []);

  const handleConfigRetry = React.useCallback(() => {
    setProbeResult(probeAgentConfig());
  }, []);

  const handleLanguageSelect = React.useCallback((next: LanguagePreference): boolean => {
    const saved = saveUserLanguage(next);
    setLanguagePreference(next);
    return saved;
  }, []);

  const withI18n = (node: React.ReactNode) => (
    <I18nProvider language={language}>{node}</I18nProvider>
  );

  // The executor is created as soon as workspace trust and config are
  // resolved, ahead of the main-UI mount, so the silent startup prewarm can
  // begin paying the one-time structural cost (backend probe) before the
  // first command. Test-injected executors keep precedence.
  const readyConfig = probeResult?.status === 'ready' ? probeResult.config : null;
  const bootstrapShellExecutor = React.useMemo(() => {
    if (shellExecutor) return shellExecutor;
    if (!readyConfig) return undefined;
    return composeAppSandboxExecutorV1({
      entrypoint: 'tui',
      workspace,
      config: readyConfig,
    });
  }, [shellExecutor, readyConfig, workspace]);

  // Register the bootstrap executor before TuiApp creates a SessionManager so
  // every early exit can still cancel the silent native prewarm.
  React.useEffect(() => {
    if (!bootstrapShellExecutor) return;
    _appShellExecutorForExit = bootstrapShellExecutor;
    return () => {
      if (_appShellExecutorForExit === bootstrapShellExecutor) {
        _appShellExecutorForExit = null;
      }
    };
  }, [bootstrapShellExecutor]);

  // Silent startup prewarm: success is deliberately invisible. Availability
  // decisions (host-shell downgrade / denial) are still projected by TuiApp's
  // prepare consumer; this kick only moves the wait earlier.
  React.useEffect(() => {
    if (!bootstrapShellExecutor) return;
    void bootstrapShellExecutor.prepare().catch(() => {
      // Aborted (exit during warmup) or superseded preparation is re-resolved
      // by the next prepare() consumer; the silent kick never surfaces.
    });
  }, [bootstrapShellExecutor]);

  // Remove preflight workspaces orphaned by an earlier TUI that exited mid
  // probe. Best effort, age-bounded, and safe against concurrent TUI
  // instances (their live probe directories are younger than the bound).
  React.useEffect(() => {}, []);

  if (!workspaceTrusted) {
    return withI18n(
      <ThemeContext.Provider value={getDarkTheme('blue')}>
        <WorkspaceTrustGate workspace={workspace} onTrusted={handleTrusted} />
      </ThemeContext.Provider>,
    );
  }

  if (!probeResult) {
    // Trusted but config not yet probed (should not normally happen)
    return null;
  }

  if (probeResult.status === 'not-configured') {
    return withI18n(
      <ThemeContext.Provider value={getDarkTheme('blue')}>
        <FirstRunFlow onComplete={handleSetupComplete} />
      </ThemeContext.Provider>,
    );
  }

  if (probeResult.status === 'invalid') {
    return withI18n(
      <ThemeContext.Provider value={getDarkTheme('blue')}>
        <ConfigErrorScreen
          configPath={probeResult.path}
          message={probeResult.message}
          onRetry={handleConfigRetry}
        />
      </ThemeContext.Provider>,
    );
  }

  if (!createSessionManager) {
    throw new Error('TUI Runtime composition is unavailable.');
  }

  return withI18n(
    <TuiApp
      createSessionManager={createSessionManager}
      config={probeResult.config}
      languagePreference={languagePreference}
      onLanguageSelect={handleLanguageSelect}
      injectModel={injectModel}
      shellExecutor={bootstrapShellExecutor}
    />,
  );
}

function TuiApp({
  createSessionManager,
  config,
  languagePreference,
  onLanguageSelect,
  injectModel,
  shellExecutor,
}: TuiAppProps) {
  const workspace = process.cwd();
  const { t: translate } = useI18n();
  const { waitUntilRenderFlush } = useApp();
  const { state, dispatch, onToggleReason } = useTuiState(
    config.modelName,
    config.providerName,
    config.reasoningEffort,
    config.interactionMode,
    config.reasoningExplicitlyDisabled !== true,
  );
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const [themePreset, setThemePreset] = React.useState<ThemePreset>(() => {
    const saved = loadColorPreset(workspace);
    if (
      saved === 'teal' ||
      saved === 'blue' ||
      saved === 'purple' ||
      saved === 'cyan' ||
      saved === 'mono'
    ) {
      return saved;
    }
    return 'blue';
  });
  // Apply OSC 4 palette on startup
  React.useEffect(() => {
    process.stdout.write(osc4Apply(themePreset));
  }, [themePreset]);
  const theme = React.useMemo(
    () => (loadTheme(workspace) === 'light' ? lightTheme : getDarkTheme(themePreset)),
    [themePreset, workspace],
  );
  const prevInterruptRef = React.useRef(state.interrupt);
  const conversationHistoryRef = React.useRef<string[]>([]);
  // Lazy init — only create thread when user sends first message
  const threadIdRef = React.useRef<string>('');
  // Generation counter for session loads: a new LOAD_SESSION_PENDING increments this.
  // Each async handler captures its generation; if a newer load started, the old one
  // discards its result, preventing the first-to-resolve Promise from overwriting the
  // later-initiated load's state.
  const loadGenerationRef = React.useRef(0);
  // Prevent concurrent NEW_SESSION from creating ghost sessions
  const creatingSessionRef = React.useRef(false);
  // A cancelled run may still be unwinding while the next prompt has already
  // been accepted. Older run finalizers must not clear the newer run's state.
  const runGenerationRef = React.useRef(0);
  const inputValueRef = React.useRef('');
  const handleInputValueChange = React.useCallback((v: string) => {
    inputValueRef.current = v;
  }, []);

  // Terminal resize: only remount App when width shrinks.
  // Height changes (e.g. tmux split, terminal window height drag) don't
  // need a full remount since <Flex> layout handles height automatically.
  // Width increases don't need a remount — existing content still fits.
  // React batches rapid setState calls into a single render, so fast
  // drag-resize only triggers one layout refresh at the final width.
  // Sync output buffering is handled inside useStaticContent.
  const [resizeKey, setResizeKey] = React.useState(0);
  React.useEffect(() => {
    let prevCols = process.stdout.columns;
    const handler = () => {
      const newCols = process.stdout.columns;
      if (newCols === prevCols) return;
      const shrunk = newCols < prevCols;
      prevCols = newCols;
      if (!shrunk) return;
      setResizeKey((n) => n + 1);
    };
    process.stdout.on('resize', handler);
    return () => {
      process.stdout.off('resize', handler);
    };
  }, []);

  // Header is intentionally rendered through Ink <Static> so completed output
  // enters terminal scrollback exactly once. Static items cannot be updated in
  // place, therefore a visible model/effort change needs the same atomic
  // clear-and-remount path used for a shrinking terminal. The TUI state lives
  // above <App>, so the redraw does not reset the active session.
  const headerPresentationRef = React.useRef(
    `${state.status.modelName}\u0000${state.status.reasoningEnabled}\u0000${state.status.thinkingMode}`,
  );
  React.useEffect(() => {
    const presentation = `${state.status.modelName}\u0000${state.status.reasoningEnabled}\u0000${state.status.thinkingMode}`;
    if (headerPresentationRef.current === presentation) return;
    headerPresentationRef.current = presentation;
    setResizeKey((n) => n + 1);
  }, [state.status.modelName, state.status.reasoningEnabled, state.status.thinkingMode]);

  const thinkingLevelRef = React.useRef<string | null>(config.reasoningEffort ?? null);
  const interactionModeRef = React.useRef<'accept_edits' | 'auto' | 'full'>(
    config.interactionMode ?? 'accept_edits',
  );
  const prevSessionKeyRef = React.useRef(state.sessionKey);
  const agentLoopActiveRef = React.useRef(false);
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const mcpRuntimeProviderRef = React.useRef<McpRuntimeProvider | null>(null);
  const skillManifestsRef = React.useRef<SkillManifest[]>([]);
  const skillOptionsRef = React.useRef<SkillScanOptions | null>(null);
  const runTaskRef = React.useRef<
    (
      task: string,
      requestedPhase?: AgentPhase,
      initialSkillActivations?: Array<{
        skillId: string;
        input: Record<string, unknown>;
      }>,
    ) => Promise<void>
  >(async () => {});
  const [slashSuggestion, setSlashSuggestion] = React.useState<SlashSuggestionData | null>(null);
  const interruptClearedByResolutionRef = React.useRef(false);

  const provider = React.useMemo(() => {
    const p = new TuiUserInputProvider();
    const submitAction = p.submitAction.bind(p);
    p.submitAction = (action) => {
      // Every UI action, including Esc/Ctrl+C cancellation, is submitted to
      // Runtime before the durable terminal event clears the footer.
      interruptClearedByResolutionRef.current = true;
      submitAction(action);
    };
    return p;
  }, []);

  const observability = React.useMemo(
    () =>
      composeObservabilityV1({
        artifactTelemetryAllowed: false,
        featureEnabled: getFeatureFlags(config).observabilityMetricsV1,
        consent: resolveTelemetryConsentV1({
          releaseChannel: 'development',
          user: config.telemetry?.user,
          project: config.telemetry?.project,
        }),
      }),
    [config],
  );
  const appShellExecutor = React.useMemo(
    () =>
      shellExecutor ??
      composeAppSandboxExecutorV1({
        entrypoint: 'tui',
        workspace,
        config,
      }),
    [config, shellExecutor, workspace],
  );

  const sessionManager = React.useMemo(() => {
    const mgr = createSessionManager({
      config,
      provider,
      skillManifests: skillManifestsRef.current,
      skillOptions: skillOptionsRef.current,
      mcpManager: mcpRuntimeProviderRef.current,
      checkpointPath: defaultCheckpointPath(),
      observabilityBridge: observability.bridge,
      shellExecutor: appShellExecutor,
      flushPresentation: waitUntilRenderFlush,
    });
    mgr.setSnapshotCallback((threadId: string) => {
      dispatch({ type: 'SESSION_INTERRUPT_PENDING', threadId });
    });
    _sessionManagerForExit = mgr;
    return mgr;
  }, [
    config,
    provider,
    dispatch,
    observability.bridge,
    appShellExecutor,
    waitUntilRenderFlush,
    createSessionManager,
  ]);
  React.useEffect(
    () => () => {
      void Promise.resolve(sessionManager.abortAll()).finally(() => sessionManager.dispose());
      if (_sessionManagerForExit === sessionManager) _sessionManagerForExit = null;
    },
    [sessionManager],
  );
  // Pending qualification is deliberately projected as unavailable. This keeps
  // Full disabled without synchronously probing the platform in React render.
  const [sandboxBackend, setSandboxBackend] = React.useState<SandboxBackend>('none');
  React.useEffect(() => {
    let disposed = false;
    setSandboxBackend('none');
    void appShellExecutor
      .prepare()
      .then((decision) => {
        if (disposed) return;
        setSandboxBackend(decision.mode === 'sandbox' ? decision.backend : 'none');
        if (decision.mode === 'denied') {
          dispatch({
            type: 'LOCAL_TEXT',
            text: `Shell unavailable: ${decision.reason ?? 'execution policy denied Shell'}`,
            isError: true,
          });
        }
      })
      .catch(() => {
        // Preparation aborted during exit; nothing left to project.
      });
    return () => {
      disposed = true;
    };
  }, [appShellExecutor, dispatch]);
  const effectiveSandboxRuntime = React.useMemo(
    () => ({
      enabled: sandboxBackend !== 'none',
      backend: sandboxBackend,
      available: sandboxBackend !== 'none',
    }),
    [sandboxBackend],
  );
  const releaseStatusText = React.useMemo(() => {
    const executionStatus = tryProjectAdmittedExecutionStatusV1({
      config,
      sandboxRuntime: effectiveSandboxRuntime,
    });
    const composition = resolveReleaseCompositionV1({
      config,
      artifactReleaseProfileV1Enabled: false,
      profileId: 'internal-dogfood',
      production: false,
    });
    return formatReleaseStatusV1(projectReleaseStatusV1({ composition, executionStatus }));
  }, [config, effectiveSandboxRuntime]);
  const telemetryStatusText = React.useMemo(() => {
    const consent = resolveTelemetryConsentV1({
      releaseChannel: 'development',
      user: config.telemetry?.user,
      project: config.telemetry?.project,
    });
    return formatObservabilityStatusV1(
      projectObservabilityStatusV1({
        artifactTelemetryAllowed: false,
        featureEnabled: getFeatureFlags(config).observabilityMetricsV1,
        consent,
        remoteExporterConfigured: false,
      }),
    );
  }, [config]);

  // Reset conversation history and thread on new session
  React.useEffect(() => {
    if (state.sessionKey !== prevSessionKeyRef.current) {
      prevSessionKeyRef.current = state.sessionKey;
      conversationHistoryRef.current = [];
      threadIdRef.current = sessionManager.getActiveId();
      thinkingLevelRef.current = null;
    }
  }, [state.sessionKey, sessionManager.getActiveId]);

  // Sync conversation history from runtime on session switch
  React.useEffect(() => {
    const prevId = state.activeSessionId;
    if (!prevId) return;
    const rt = sessionManager.getRuntime(prevId);
    if (rt) {
      conversationHistoryRef.current = [...rt.conversationHistory];
    }
  }, [state.activeSessionId, sessionManager]);

  // Exit when exitRequested flag is set (double Ctrl+C when not running)
  React.useEffect(() => {
    if (state.exitRequested) {
      void _requestTuiExit?.();
    }
  }, [state.exitRequested]);

  // Rewind: checkpoint list + revert/fork execution
  useRewindCheckpoints(state, dispatch, threadIdRef, sessionManager);

  const rewindDeps: RewindDeps = React.useMemo(
    () => ({
      dispatch,
      provider,
      config,
      workspace,
      sessionManager,
      threadIdRef,
      loadGenerationRef,
      conversationHistoryRef,
      thinkingLevelRef,
      skillManifestsRef,
      skillOptionsRef,
      mcpRuntimeProviderRef,
      agentLoopActiveRef,
      abortControllerRef,
      stateRef,
    }),
    [dispatch, provider, config, workspace, sessionManager],
  );
  const { runRewind, previewRewind } = useRunRewind(rewindDeps);
  const runRewindRef = React.useRef(runRewind);
  runRewindRef.current = runRewind;

  // MCP control plane and runtime provider lifecycle
  const { controller: mcpController, mcpPromptRegistry } = useMcpController(
    mcpRuntimeProviderRef,
    sessionManager,
    workspace,
    config,
  );

  // Skills loader: scan on mount
  useSkillsLoader(workspace, dispatch, skillManifestsRef, skillOptionsRef, sessionManager);

  // 将 thinkingLevel ref 与 state.status.thinkingMode 同步，确保 ModelSelector 切换后 runTask 拿到最新值
  // Sync thinkingLevel ref with state.status.thinkingMode so runTask uses latest value after ModelSelector changes
  React.useEffect(() => {
    thinkingLevelRef.current = state.status.thinkingMode || null;
  }, [state.status.thinkingMode]);

  // 将 interactionMode ref 与 state.interactionMode 同步
  React.useEffect(() => {
    interactionModeRef.current = state.interactionMode;
  }, [state.interactionMode]);

  // 每当 token 统计变化时持久化到 DB，确保最新值始终写入
  // Persist token stats to DB on every change, guaranteeing latest values
  React.useEffect(() => {
    const tid = state.activeSessionId;
    if (!tid) return;
    const s = state.status;
    // 跳过初始零值，避免启动时无意义写入
    if (s.cacheHitTokens === 0 && s.cacheMissTokens === 0 && s.totalTokens === 0) return;
    sessionManager.saveTokenStats(tid, s);
  }, [
    state.status.cacheHitTokens,
    state.status.cacheMissTokens,
    state.status.totalTokens,
    state.activeSessionId,
    sessionManager.saveTokenStats,
    state.status,
  ]);

  const handleExit = React.useCallback(() => {
    dispatch({ type: 'LOCAL_TEXT', text: '👋 Goodbye!' });
    void _requestTuiExit?.();
  }, [dispatch]);

  // Load historical sessions from DB on startup, but always start fresh.
  React.useEffect(() => {
    sessionManager
      .listPersistedSessions()
      .then((dbSessions: Array<{ threadId: string; name: string }>) => {
        for (const s of dbSessions) {
          if (!sessionManager.hasRuntime(s.threadId)) {
            const rt = sessionManager.registerSession(s.threadId, workspace);
            rt.dormant = true;
            sessionManager.setName(s.threadId, s.name);
          }
        }

        // Always start a new session — user switches to historical ones via /resume
        const newId = sessionManager.createSession(workspace);
        threadIdRef.current = newId;

        dispatch({
          type: 'SET_SESSIONS',
          sessions: sessionManager.getSnapshot(),
        });
      })
      .catch(() => {
        // Historical session failures stay inside the TUI render contract. Do not
        // create a replacement session or write raw diagnostics to stderr.
        dispatch({
          type: 'SET_SESSIONS',
          sessions: sessionManager.getSnapshot(),
        });
        dispatch({
          type: 'SET_SESSION_SERVICE_UNAVAILABLE',
          unavailable: true,
        });
        dispatch({
          type: 'LOCAL_TEXT',
          text: HISTORICAL_SESSION_LIST_FAILURE_TEXT,
        });
      });
  }, [
    sessionManager.registerSession,
    sessionManager.setName,
    sessionManager.hasRuntime,
    sessionManager.createSession,
    workspace,
    sessionManager.getSnapshot,
    sessionManager.listPersistedSessions,
    dispatch,
  ]);

  /** 从 DB 加载指定会话的完整状态（LOAD_SESSION_PENDING 的实际逻辑） */
  const loadSessionById = React.useCallback(
    async (threadId: string) => {
      // Increment generation: supersedes any in-flight loads
      const gen = ++loadGenerationRef.current;

      // Ensure SessionManager switches to this session (handles dormant & SessionSelector loads)
      const oldId = sessionManager.getActiveId();
      if (oldId !== threadId) {
        if (!sessionManager.hasRuntime(threadId)) {
          sessionManager.registerSession(threadId, workspace);
        }
        sessionManager.switchSession(oldId, threadId);
        const rt = sessionManager.getRuntime(threadId);
        if (rt) {
          rt.setForeground(true);
          rt.dormant = false;
        }
      }
      threadIdRef.current = threadId;
      conversationHistoryRef.current = [];

      dispatch({ type: 'LOAD_SESSION_PENDING', threadId });

      try {
        const result = await sessionManager.loadPersistedSession(threadId);
        // If a newer load was issued while this was loading, discard
        if (loadGenerationRef.current !== gen) return;
        if (!result) {
          dispatch({
            type: 'LOAD_SESSION',
            threadId,
            blocks: [
              {
                id: 1,
                kind: 'text',
                content: `Session ${threadId} has no saved checkpoints.`,
              },
            ],
            interrupt: null,
            modelProvider: '',
            modelName: '',
            thinkingLevel: null,
          });
          return;
        }

        const resumedConfig = resolveConfigForResume(
          sessionManager.getDefaultConfig(),
          result.modelProvider,
          result.modelName,
        );
        sessionManager.setSessionConfig(threadId, resumedConfig);
        const thinkingLevel = result.thinkingLevel ?? 'max';
        thinkingLevelRef.current = thinkingLevel;

        const {
          blocks,
          interrupt,
          interactionMode,
          pendingToolCalls,
          recoveredPendingInteraction,
        } = sessionDataToUI(result);
        const runtime = sessionManager.getRuntime(threadId);
        if (runtime) {
          runtime.localReplayRecovery = recoveredPendingInteraction;
          runtime.interactionMode = interactionMode;
        }
        dispatch({
          type: 'LOAD_SESSION',
          threadId,
          blocks,
          interrupt,
          pendingToolCalls,
          modelProvider: resumedConfig.providerName,
          modelName: resumedConfig.modelName,
          thinkingLevel,
          reasoningEnabled: resumedConfig.reasoningExplicitlyDisabled !== true,
          interactionMode,
        });
        if (
          result.runtimeEvents.some(
            (event: RuntimePresentationEvent) => event.type === 'user.message_appended',
          )
        ) {
          const contextSnapshot = sessionManager.buildContextStatusSnapshot(threadId);
          if (loadGenerationRef.current !== gen) return;
          if (contextSnapshot) {
            dispatch({
              type: 'SET_CONTEXT_SNAPSHOT',
              snapshot: contextSnapshot,
            });
          }
        }
      } catch {
        if (loadGenerationRef.current !== gen) return;
        // Roll back SessionManager: if we switched to a different session and the
        // load failed, revert the switch and remove the orphaned runtime.
        if (oldId !== threadId) {
          sessionManager.switchSession(threadId, oldId);
          threadIdRef.current = oldId;
          await sessionManager.removeRuntime(threadId);
          // Keep the previously active TUI projection intact. LOAD_SESSION would
          // make the failed target appear active again even though SessionManager
          // has already rolled back to oldId.
          dispatch({ type: 'HIDE_SESSIONS' });
          dispatch({
            type: 'SET_SESSIONS',
            sessions: sessionManager.getSnapshot(),
          });
          dispatch({
            type: 'LOCAL_TEXT',
            text: HISTORICAL_SESSION_LOAD_FAILURE_TEXT,
          });
          return;
        }
        dispatch({
          type: 'LOAD_SESSION',
          threadId,
          blocks: [
            {
              id: 1,
              kind: 'text',
              content: HISTORICAL_SESSION_LOAD_FAILURE_TEXT,
            },
          ],
          interrupt: null,
          modelProvider: '',
          modelName: '',
          thinkingLevel: null,
        });
      }
    },
    [dispatch, sessionManager, workspace],
  );

  const dispatchSessionLoad = React.useCallback(
    async (action: Action) => {
      // Intercept NEW_SESSION to create runtime via SessionManager
      if (action.type === 'NEW_SESSION') {
        // Ignore /new for an already-active empty session. User input is
        // separately blocked while historical storage is unavailable because
        // an in-memory session could not make its first durable Kernel write.
        if (stateRef.current.turns.length === 0 && sessionManager.getActiveId()) return;
        // Prevent concurrent NEW_SESSION from creating ghost sessions
        if (creatingSessionRef.current) return;
        creatingSessionRef.current = true;
        // Flush token stats for outgoing session before leaving it
        const oldId = sessionManager.getActiveId();
        if (oldId) sessionManager.saveTokenStats(oldId, stateRef.current.status, true);
        // Supersede any in-flight LOAD_SESSION_PENDING
        loadGenerationRef.current++;
        const newId = sessionManager.createSession(workspace);
        threadIdRef.current = newId;
        // The reducer will use this threadId to create the snapshot
        dispatch({ type: 'NEW_SESSION', threadId: newId });
        dispatch({
          type: 'SET_SESSION_SERVICE_UNAVAILABLE',
          unavailable: false,
        });
        dispatch({
          type: 'SET_SESSIONS',
          sessions: sessionManager.getSnapshot(),
        });
        // Release the lock after the reducer processes the session change.
        // The next render (triggered by the dispatches above) will reset this.
        setTimeout(() => {
          creatingSessionRef.current = false;
        }, 0);
        return;
      }
      // ── LOAD_SESSION_PENDING：委托给 loadSessionById ──
      if (action.type === 'LOAD_SESSION_PENDING') {
        await loadSessionById(action.threadId);
        return;
      }
      if (action.type === 'EXECUTE_REWIND') {
        dispatch(action);
        void runRewindRef.current(action.scope, action.checkpointId);
        return;
      }
      if (action.type === 'SELECT_MODEL') {
        try {
          const selectedConfig = loadAgentConfig({
            providerName: action.provider,
            modelName: action.modelName,
          });
          const threadId = sessionManager.getActiveId();
          sessionManager.setSessionConfig(threadId, selectedConfig, {
            persist: true,
            asDefault: true,
          });
          dispatch({
            ...action,
            reasoningEnabled: selectedConfig.reasoningExplicitlyDisabled !== true,
          });
          if (hasModelConversation(stateRef.current)) {
            const contextSnapshot = sessionManager.buildContextStatusSnapshot(threadId);
            if (contextSnapshot) {
              dispatch({
                type: 'SET_CONTEXT_SNAPSHOT',
                snapshot: contextSnapshot,
              });
            }
          }
        } catch (error) {
          dispatch({
            type: 'LOCAL_TEXT',
            text: `无法切换模型：${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          });
        }
        return;
      }
      if (action.type === 'SET_THINKING_LEVEL') {
        // Keep the next prompt on the newly selected effort even if the user
        // starts typing before React has run the state-to-ref synchronization effect.
        thinkingLevelRef.current = action.level;
        dispatch(action);
        return;
      }
      // ── 多会话：SWITCH_SESSION 拦截，缓冲回放 ──
      if (action.type === 'SWITCH_SESSION') {
        const oldId = sessionManager.getActiveId();
        const newId = action.threadId;
        if (oldId === newId) {
          // Same session — no-op
          return;
        }

        // 持久化离开会话的 token 统计（立即写入，取消旧的防抖定时器）
        // Persist outgoing session's token stats (immediate write, cancel debounce)
        if (oldId) {
          sessionManager.saveTokenStats(oldId, stateRef.current.status, true);
        }

        const incomingRt = sessionManager.getRuntime(newId);

        // Dormant session (loaded from DB, state not yet hydrated): load full state
        if (incomingRt?.dormant) {
          await loadSessionById(newId);
          return;
        }

        sessionManager.switchSession(oldId, newId);
        threadIdRef.current = newId;

        // 进入的会话切到前台模式：代理提供器将事件路由到 provider.onEvent
        if (incomingRt) {
          incomingRt.setForeground(true);
        }

        dispatch(action);

        // 回放目标会话的缓冲事件
        if (incomingRt && incomingRt.eventBuffer.length > 0) {
          dispatch({
            type: 'SET_SESSIONS',
            sessions: sessionManager.getSnapshot(),
          });
          for (const event of incomingRt.eventBuffer) {
            dispatch({
              type: 'RUNTIME_EVENT',
              event,
            });
          }
          incomingRt.eventBuffer = [];
          incomingRt.pendingInterrupt = false;
        }
        return;
      }
      // ── DELETE_SESSION：删除会话，从 DB 和 SessionManager 中移除 ──
      if (action.type === 'DELETE_SESSION') {
        const { threadId } = action;
        const wasActive = threadId === sessionManager.getActiveId();
        // Invalidate any in-flight loadSessionById for this threadId to prevent
        // stale load from restoring the deleted session.
        loadGenerationRef.current++;
        await sessionManager.cancelRuntimeOperations(threadId);
        try {
          await sessionManager.deletePersistedSession(threadId);
        } catch {
          // DB error — still remove from runtime list
        }
        // Remove from SessionManager and refresh snapshots
        if (wasActive) {
          // Flush token stats before removing runtime (stats are lost after remove)
          sessionManager.saveTokenStats(threadId, stateRef.current.status, true);
        }
        await sessionManager.removeRuntime(threadId);
        if (wasActive) {
          // Deleted the active session — create a new one so TUI has an active session
          const newId = sessionManager.createSession(workspace);
          threadIdRef.current = newId;
          dispatch({ type: 'NEW_SESSION', threadId: newId });
        } else {
          dispatch(action);
        }
        dispatch({
          type: 'SET_SESSIONS',
          sessions: sessionManager.getSnapshot(),
        });
        return;
      }
      // ── EXPORT_SESSION：执行文件写入（取代 reducer 内的 fire-and-forget）──
      if (action.type === 'EXPORT_SESSION') {
        const s = stateRef.current;
        const now = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = sessionExportPath(now);
        const body = s.turns
          .flatMap((t) => t.blocks)
          .map((b) => {
            if (b.kind === 'user') return `**You:** ${b.content}`;
            if (b.kind === 'text') return b.content;
            if (b.kind === 'reason') return `> ${b.content}`;
            return '';
          })
          .filter(Boolean)
          .join('\n\n');
        const header = `# Kite Code Session Export\n\n> ${new Date().toLocaleString()}\n\n---\n\n`;
        try {
          const fs = await import('node:fs/promises');
          const { mkdirSync } = await import('node:fs');
          const dir = filename.split('/').slice(0, -1).join('/') || '.';
          mkdirSync(dir, { recursive: true });
          await fs.writeFile(filename, header + body, {
            encoding: 'utf-8',
            mode: 0o600,
          });
          dispatch({ type: 'EXPORT_SESSION_DONE', filename });
        } catch (e: unknown) {
          dispatch({
            type: 'LOCAL_TEXT',
            text: `Export failed: ${toErrorMessage(e)}`,
            isError: true,
          });
        }
        return;
      }
      dispatch(action);
    },
    [dispatch, sessionManager, workspace, loadSessionById],
  );

  const runTaskBridge = React.useCallback(
    (
      task: string,
      requestedPhase?: AgentPhase,
      initialSkillActivations?: Array<{
        skillId: string;
        input: Record<string, unknown>;
      }>,
    ) => {
      runTaskRef.current?.(task, requestedPhase, initialSkillActivations);
    },
    [],
  );

  const enterPlanMode = React.useCallback(() => {
    const events = sessionManager.enterPlanningMode(threadIdRef.current);
    for (const event of events) dispatchSessionLoad({ type: 'RUNTIME_EVENT', event });
  }, [dispatchSessionLoad, sessionManager]);

  const togglePlanMode = React.useCallback(() => {
    if (state.status.phase === 'planning') {
      const result = sessionManager.exitPlanningMode(threadIdRef.current);
      if (!result) return;
      for (const event of result.events) {
        dispatchSessionLoad({ type: 'RUNTIME_EVENT', event });
      }
      if (result.events.length === 0 && result.phase === 'building') {
        dispatchSessionLoad({ type: 'SET_PHASE', phase: 'building' });
      }
      return;
    }
    const events = sessionManager.enterPlanningMode(threadIdRef.current);
    for (const event of events) dispatchSessionLoad({ type: 'RUNTIME_EVENT', event });
  }, [dispatchSessionLoad, sessionManager, state.status.phase]);

  // Stable onCompact via refs — bypasses stale closure issues with useSlashCommand
  // and Ink 7 useInput across session switches.
  const onCompactRef = React.useRef<(customInstructions?: string) => void>(() => {});
  onCompactRef.current = (customInstructions?: string) => {
    const targetThreadId = threadIdRef.current;
    const submittedAfterVisibleCompletion = !stateRef.current.running;
    void (async () => {
      // SET_EXITED makes the prompt visible before the previous generator has
      // necessarily released its Kernel. A compact command submitted from that
      // prompt must use the standalone executor after cleanup, rather than
      // adding a pending request to a loop that will no longer schedule it.
      if (submittedAfterVisibleCompletion) {
        await sessionManager.getRuntime(targetThreadId)?.waitForRunCompletion();
      }
      return sessionManager.handleContextCompaction(
        targetThreadId,
        customInstructions,
        (phase: ContextCompactionProgressPhase | undefined) => {
          if (threadIdRef.current === targetThreadId) {
            dispatchSessionLoad(
              phase
                ? { type: 'SET_COMPACTION_PROGRESS', phase, source: 'manual' }
                : { type: 'SET_COMPACTION_PROGRESS' },
            );
          }
        },
        (event: RuntimePresentationEvent) => {
          if (threadIdRef.current === targetThreadId) {
            dispatchSessionLoad({ type: 'RUNTIME_EVENT', event });
          }
        },
      );
    })()
      .then((result) => {
        // Runtime events are already durable in targetThreadId. If the user
        // switched sessions while compaction was running, let the target
        // session pick them up through normal replay instead of rendering
        // them in the newly active session.
        if (threadIdRef.current !== targetThreadId) {
          const target = sessionManager.getRuntime(targetThreadId);
          for (const event of result.events) target?.eventBuffer.push(event);
          return;
        }
        for (const event of result.events) {
          dispatchSessionLoad({ type: 'RUNTIME_EVENT', event });
        }
        if (
          !result.events.some((event: RuntimePresentationEvent) =>
            [
              'context.compaction_completed',
              'context.compaction_failed',
              'context.compaction_reset',
            ].includes(event.type),
          )
        ) {
          dispatchSessionLoad({
            type: 'LOCAL_TEXT',
            text: `  ⎿  ${result.text}`,
            ...(result.isError ? { isError: true } : {}),
          });
        }
      })
      .catch(() => {
        if (threadIdRef.current !== targetThreadId) return;
        dispatchSessionLoad({
          type: 'LOCAL_TEXT',
          text: '  ⎿  Context compaction failed unexpectedly; the original conversation was preserved.',
          isError: true,
        });
        dispatchSessionLoad({ type: 'SET_COMPACTION_PROGRESS' });
      });
  };

  const applyThemePreset = React.useCallback(
    (preset: string) => {
      const p = preset.toLowerCase();
      if (p !== 'teal' && p !== 'blue' && p !== 'purple' && p !== 'cyan' && p !== 'mono') return;
      if (p === themePreset) return;
      setThemePreset(p);
      process.stdout.write(osc4Apply(p));
      saveColorPreset(p);
      dispatchSessionLoad({ type: 'USER_MESSAGE', text: `/theme ${p}` });
      dispatchSessionLoad({
        type: 'LOCAL_TEXT',
        text: `  ⎿  Theme set to ${p}`,
      });
    },
    [dispatchSessionLoad, themePreset],
  );

  const handleSlashCommand = useSlashCommand(
    dispatchSessionLoad,
    handleExit,
    mcpPromptRegistry,
    skillManifestsRef.current,
    skillOptionsRef.current ?? undefined,
    runTaskBridge,
    enterPlanMode,
    (customInstructions) => {
      onCompactRef.current(customInstructions);
    },
    // PR 9: /context handler — display context usage breakdown
    () => {
      const targetThreadId = threadIdRef.current;
      dispatchSessionLoad({ type: 'USER_MESSAGE', text: '/context' });
      const text = sessionManager.handleContextDisplay(targetThreadId);
      dispatchSessionLoad({ type: 'LOCAL_TEXT', text });
    },
    // PR 9: /compact reset handler — preflight + clear active checkpoint
    () => {
      const targetThreadId = threadIdRef.current;
      dispatchSessionLoad({ type: 'USER_MESSAGE', text: '/compact reset' });
      void sessionManager
        .handleContextReset(targetThreadId)
        .then((result: ContextCompactionResult) => {
          if (threadIdRef.current !== targetThreadId) {
            const target = sessionManager.getRuntime(targetThreadId);
            for (const event of result.events) target?.eventBuffer.push(event);
            return;
          }
          for (const event of result.events) {
            dispatchSessionLoad({ type: 'RUNTIME_EVENT', event });
          }
          dispatchSessionLoad({
            type: 'LOCAL_TEXT',
            text: `  ⎿  ${result.text}`,
            ...(result.isError ? { isError: true } : {}),
          });
        })
        .catch(() => {
          if (threadIdRef.current !== targetThreadId) return;
          dispatchSessionLoad({
            type: 'LOCAL_TEXT',
            text: '  ⎿  Context reset failed; the active checkpoint was preserved.',
            isError: true,
          });
        });
    },
    releaseStatusText,
    telemetryStatusText,
  );

  // When interrupt is cleared externally (ESC, Ctrl+C, etc.), cancel the pending promise
  React.useEffect(() => {
    const prev = prevInterruptRef.current;
    prevInterruptRef.current = state.interrupt;
    const clearedByResolution = interruptClearedByResolutionRef.current;
    if (shouldCancelClearedInterrupt(prev, state.interrupt, clearedByResolution)) {
      provider.submitAction({ type: 'cancel' });
    }
    if (prev && !state.interrupt) {
      interruptClearedByResolutionRef.current = false;
    } else if (prev && state.interrupt && prev !== state.interrupt) {
      interruptClearedByResolutionRef.current = false;
    }
  }, [state.interrupt, provider]);

  // When Ctrl+C is pressed during agent loop (with no interrupt), abort via signal
  React.useEffect(() => {
    if (state.ctrlCPressed && !state.interrupt) {
      const rt = sessionManager.getRuntime(threadIdRef.current);
      rt?.abort();
    }
  }, [state.ctrlCPressed, state.interrupt, sessionManager]);

  // When Esc stops a running agent, abort the controller so the generator
  // doesn't keep running in background. Ctrl+C is handled above and already
  // sets ctrlCPressed, so we skip here to avoid double-abort.
  const prevRunningRef = React.useRef(state.running);
  React.useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = state.running;
    if (
      shouldAbortStoppedRun({
        wasRunning,
        running: state.running,
        ctrlCPressed: state.ctrlCPressed,
        exited: state.exited,
      })
    ) {
      const rt = sessionManager.getRuntime(threadIdRef.current);
      rt?.abort();
    }
  }, [state.running, state.ctrlCPressed, state.exited, sessionManager]);

  // Keyboard cancellation must reach SessionRuntime in the same input turn as
  // ESC/Ctrl+C. Waiting for the reducer-driven running=false effect leaves a
  // race where the next prompt is submitted while the old runtime still looks
  // active, so tryReservePrompt() rejects it as an ordinary concurrent prompt.
  const abortForegroundRun = React.useCallback(() => {
    if (stateRef.current.interrupt || !stateRef.current.running) return;
    sessionManager.getRuntime(threadIdRef.current)?.abort();
  }, [sessionManager]);

  const syncInteractionMode = React.useCallback(
    (mode: 'accept_edits' | 'auto' | 'full') => {
      // Update the ref in the same input turn so a prompt submitted immediately
      // after closing the selector cannot observe the old value.
      sessionManager.getRuntime(threadIdRef.current)?.setInteractionMode(mode);
      interactionModeRef.current = mode;
    },
    [sessionManager],
  );

  const runTask = React.useCallback(
    async (
      task: string,
      requestedPhase?: AgentPhase,
      initialSkillActivations?: Array<{
        skillId: string;
        input: Record<string, unknown>;
      }>,
    ) => {
      let threadId = threadIdRef.current;
      let rt = sessionManager.getRuntime(threadId);
      if (!rt) return;

      if (rt.localReplayRecovery) {
        const continued = sessionManager.forkRecoveredSessionForContinuation(threadId);
        if (!continued) {
          dispatch({
            type: 'LOCAL_TEXT',
            text: '  ⎿  无法创建恢复会话；原始未完成交互未被重新执行。',
            isError: true,
          });
          return;
        }
        threadId = continued.threadId;
        threadIdRef.current = threadId;
        rt = continued;
        const current = stateRef.current;
        dispatch({
          type: 'LOAD_SESSION',
          threadId,
          blocks: current.turns.flatMap((turn) => turn.blocks),
          interrupt: null,
          pendingToolCalls: current.pendingToolCalls,
          modelProvider: rt.config.providerName,
          modelName: rt.config.modelName,
          thinkingLevel: thinkingLevelRef.current,
          reasoningEnabled: rt.config.reasoningExplicitlyDisabled !== true,
        });
      }

      // Recover first so the reservation belongs to the continuation runtime,
      // not the immutable source session left by an interrupted interaction.
      if (!rt.tryReservePrompt()) return;
      const runGeneration = ++runGenerationRef.current;

      // 将 React 层 per-session 状态同步到 Runtime / Sync React-layer per-session state to runtime
      rt.thinkingLevel = thinkingLevelRef.current;
      rt.interactionMode = interactionModeRef.current;
      rt.conversationHistory = [...conversationHistoryRef.current];

      // Establish the new active turn before inserting the prompt. This keeps
      // the prompt out of the idle/static transition window between a
      // cancelled predecessor and its successor; otherwise Ink can commit the
      // combined old+new turn to <Static> before the successor tool starts.
      dispatch({ type: 'SET_RUNNING' });
      // Render the submitted prompt immediately. Runtime persistence may wait
      // for the cancelled predecessor to finish cleanup, but the user's message must
      // not be hidden behind that internal single-flight barrier.
      dispatch({ type: 'USER_MESSAGE', text: task });

      // Update running state — agentLoopActive is managed by SessionRuntime.runTask internally
      sessionManager.onStatusChange(threadId);
      dispatch({
        type: 'SET_SESSIONS',
        sessions: sessionManager.getSnapshot(),
      });

      try {
        await rt.runTask(
          task,
          {
            dispatch,
            provider,
            config: rt.config,
            model: injectModel,
          },
          requestedPhase,
          initialSkillActivations,
        );
      } finally {
        // Only dispatch global state changes if this session is still active.
        // A background session that finished must not corrupt the foreground's running/interrupt state.
        const stillActive = threadIdRef.current === threadId;
        // Sync conversation history back from runtime so the next run preserves shell context
        if (stillActive) {
          conversationHistoryRef.current = [...rt.conversationHistory];
        }
        sessionManager.onStatusChange(threadId);
        dispatch({
          type: 'SET_SESSIONS',
          sessions: sessionManager.getSnapshot(),
        });
        if (shouldSetIdleAfterRun(stillActive, runGeneration, runGenerationRef.current)) {
          dispatch({ type: 'SET_IDLE' });
        }

        // Fire-and-forget: generate smart session name once after first message
        // Guard: only if the session is still active to prevent cross-session writes.
        (async () => {
          try {
            // Only generate if not already named (name still equals threadId)
            if (rt.name !== threadId) return;
            const stillActive = threadIdRef.current === threadId;
            if (!stillActive) return;
            const name = await sessionManager.generateAndPersistSessionName(threadId, task);
            if (name && threadIdRef.current === threadId) {
              sessionManager.setName(threadId, name);
              dispatch({
                type: 'SET_SESSIONS',
                sessions: sessionManager.getSnapshot(),
              });
            }
          } catch {
            /* non-critical */
          }
        })();
      }
    },
    [provider, dispatch, sessionManager, injectModel],
  );
  // Keep ref in sync so slash-command bridge can invoke latest runTask
  runTaskRef.current = runTask;
  // Ref to avoid Ink 7 stale closure: useInput in InputLine may fire with
  // a captured handleInput that references an outdated handleSlashCommand
  // from before a session switch.
  const handleSlashCommandRef = React.useRef(handleSlashCommand);
  handleSlashCommandRef.current = handleSlashCommand;

  const handleInput = React.useCallback(
    (value: string) => {
      if (value.startsWith('/')) {
        handleSlashCommandRef.current(value);
        return;
      }

      // Historical storage failure blocks new work until the backing Runtime
      // Store can be reopened. A new in-memory TUI session would still fail on
      // its first durable Kernel write, so only /resume retry is available.
      if (stateRef.current.sessionServiceUnavailable && !/^\/resume(?:\s|$)/i.test(value.trim())) {
        return;
      }
      // Plan mode is a sticky TUI input policy across completed conversations.
      // Pass it explicitly for every plain prompt so the new Core Task cannot
      // silently fall back to building while the Footer still says plan.
      runTask(value, stateRef.current.status.phase);
    },
    [runTask],
  );

  React.useEffect(() => {
    return () => {
      provider.teardown?.();
    };
  }, [provider]);

  const appPresentationKey = `${resizeKey}:${overlaySurfaceKey(state)}`;
  const loadPersistedSessionsForSelector = React.useCallback(
    (query: string) => sessionManager.listPersistedSessions(query),
    [sessionManager],
  );

  return (
    <ThemeContext.Provider value={theme}>
      <App
        key={appPresentationKey}
        state={state}
        dispatch={dispatchSessionLoad}
        onToggleReason={onToggleReason}
        provider={provider}
        workspace={workspace}
        mcpController={mcpController}
        slashSuggestion={slashSuggestion}
        sandboxBackend={sandboxBackend}
        onTogglePlanMode={togglePlanMode}
        onInteractionModeChange={syncInteractionMode}
        themePreset={themePreset}
        onThemeSelect={applyThemePreset}
        languagePreference={languagePreference}
        onLanguageSelect={(language) => {
          const saved = onLanguageSelect(language);
          if (!saved) {
            dispatchSessionLoad({
              type: 'LOCAL_TEXT',
              text: translate('language.saveFailed'),
              isError: true,
            });
          }
        }}
        onAbort={abortForegroundRun}
        getRewindPreview={previewRewind}
        loadSessions={loadPersistedSessionsForSelector}
        resizeGeneration={resizeKey}
      >
        <InputLine
          key={state.activeSessionId}
          mode={
            state.interrupt?.kind === 'approval'
              ? 'approval'
              : state.interrupt?.kind === 'input'
                ? 'question'
                : 'prompt'
          }
          onSubmit={handleInput}
          disabled={shouldDisablePromptInput(state)}
          workspace={workspace}
          overlayActive={
            state.showHelp ||
            state.showModelSelector ||
            state.showPermissionSelector ||
            state.showEffortSelector ||
            state.showThemeSelector ||
            state.showLanguageSelector ||
            state.showSessions ||
            state.showMcp ||
            state.showRewind ||
            !!state.interrupt
          }
          onSlashSuggestionChange={setSlashSuggestion}
          initialValue={inputValueRef.current}
          onValueChange={handleInputValueChange}
          planMode={state.status.phase === 'planning'}
          planName={state.status.plan?.name}
        />
      </App>
    </ThemeContext.Provider>
  );
}

export function runTui(props: TuiBootstrapProps): void {
  // 在 Ink 初始化前禁用终端回显 + 隐藏光标 + 清屏
  // 否则 cooked-mode 下用户按键会被终端驱动回显到屏幕上，出现残留字符
  // Disable terminal echo + hide cursor + clear screen before Ink init,
  // otherwise keystrokes in cooked mode are echoed by the terminal driver
  function disableEchoAndClear() {
    try {
      // Unix: stty -echo disables terminal echo at the TTY level
      Bun.spawnSync(['stty', '-echo'], {
        stdio: ['inherit', 'inherit', 'inherit'],
      });
    } catch {
      // Windows / unsupported platforms: stty not available, skip
    }
    process.stdout.write('\x1b[?25l\x1b[2J\x1b[3J\x1b[H');
  }
  disableEchoAndClear();

  // Use Ink's built-in kittyKeyboard option instead of manual enableKittyKeyboardProtocol().
  // The manual approach enabled Kitty at the terminal level but Ink's parser didn't
  // know about it, causing arrow keys (CSI 1u/2u) to be mis-parsed as Enter.
  let unmountTui: (() => void) | null = null;
  const exitCoordinator = createTuiExitCoordinatorV1({
    getSessionLifecycle: () => _sessionManagerForExit,
    getShellExecutor: () => _appShellExecutorForExit,
    unmount: () => unmountTui?.(),
    exit: (code) => process.exit(code),
  });
  _requestTuiExit = (code) => exitCoordinator.requestExit(code);

  const { unmount } = render(
    <ErrorBoundary onExit={() => void _requestTuiExit?.(1)}>
      <TuiBootstrap {...props} />
    </ErrorBoundary>,
    {
      maxFps: 60,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: 'enabled' },
      incrementalRendering: false,
      // Ink 7.1.1 treats every CI environment as non-interactive by default,
      // even when stdout is a real PTY. Use the actual terminal capabilities so
      // PTY-backed sessions (including system tests) keep input and live rendering.
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    },
  );
  unmountTui = unmount;

  process.on('SIGINT', () => {
    void exitCoordinator.requestExit();
  });
  process.on('SIGTERM', () => {
    void exitCoordinator.requestExit();
  });
}
