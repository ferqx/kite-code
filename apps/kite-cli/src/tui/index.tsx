import { debuglog } from 'node:util';
import type {
  KiteAppControlClient,
  KiteWorkspaceIdentity,
  ProviderModelSnapshot,
} from '@kite-ai/kite-app-contract';
import type { NativeProviderCredentialClient } from '@kite-ai/kite-local-runtime/client';
import type { AgentPhase, SkillManifest } from '@kite-ai/runtime-contract';
import { render, useApp } from 'ink';
import React from 'react';
import {
  type LanguagePreference,
  loadColorPreset,
  loadTheme,
  loadUserInteractionMode,
  loadUserLanguage,
  saveColorPreset,
  saveInteractionMode,
  saveUserLanguage,
  sessionExportPath,
} from '#kite-cli/preferences';
import type {
  TuiRuntimeClientFacade as SessionManager,
  TuiRuntimeClientFacadeFactory,
} from '../adapters/tui/session-adapter';
import type { KiteRuntimeModeAdapter } from '../service-mode';
import { createNativeTuiRuntimeClientFactory } from '../service-mode';
import App, { type Action, shouldDisablePromptInput, useTuiState } from './App';
import type { SandboxBackend } from './client-types';
import ErrorBoundary from './components/ErrorBoundary';
import ConfigErrorScreen from './components/first-run/ConfigErrorScreen';
import FirstRunFlow from './components/first-run/FirstRunFlow';
import InputLine from './components/InputLine';
import WorkspaceTrustGate from './components/WorkspaceTrustGate';
import { createTuiExitCoordinator } from './exit-coordinator';
import { useMcpController } from './hooks/useMcpController';
import { type RewindDeps, useRewindCheckpoints, useRunRewind } from './hooks/useRewindHandler';
import { useSkillsLoader } from './hooks/useSkillsLoader';
import { useSlashCommand } from './hooks/useSlashCommand';
import type { SlashSuggestionData } from './hooks/useSlashSuggestions';
import { detectTuiDeviceLocale, I18nProvider, resolveTuiLanguage, useI18n } from './i18n';
import { isTuiRunActive } from './presentation/selectors';
import {
  ensureTuiPromptSession,
  observeTuiPromptSubmission,
  TuiPromptSubmissionQueue,
} from './prompt-submission-queue';
import { TuiUserInputProvider } from './provider';
import { sessionDataToUI } from './replay-blocks.js';
import type { ContextCompactionProgressPhase } from './runtime-presentation';
import {
  type AppServerRuntimePresentation,
  formatAppServerRuntimeStatus,
} from './service-runtime-status';
import { SessionNavigationAuthority } from './session-navigation';
import {
  classifyHistoricalSessionOpenFailure,
  type HistoricalSessionOpenStage,
} from './session-open-diagnostic';
import { getDarkTheme, lightTheme, osc4Apply, ThemeContext, type ThemePreset } from './theme';

/** 模块级引用，供退出时中止所有会话 / Module-level reference for aborting all sessions on exit */
let _sessionManagerForExit: SessionManager | null = null;
let _runtimeModeForExit: KiteRuntimeModeAdapter | null = null;
let _requestTuiExit: ((code?: number) => Promise<void>) | null = null;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const HISTORICAL_SESSION_LOAD_FAILURE_TEXT =
  '  ⎿  历史会话打开失败，当前会话未受影响；请稍后通过 /resume 重试。';
const historicalSessionDebug = debuglog('kite-session');

export interface TuiBootstrapProps {
  /** Explicit parent-owned Runtime/App client; no Service discovery fallback is constructed. */
  runtimeMode?: KiteRuntimeModeAdapter;
  /** Single client-facade injection used by conformance tests. */
  createSessionManager?: TuiRuntimeClientFacadeFactory;
  /** Explicit client-safe App Control test seam. */
  appControlGateway?: {
    readonly discovery: KiteAppControlClient;
    forWorkspace(workspace: KiteWorkspaceIdentity): KiteAppControlClient;
  };
  credentialClient?: NativeProviderCredentialClient;
  /** Parent-owned App Server identity; initialize already proved exact build/capability pairing. */
  appServerRuntime?: AppServerRuntimePresentation;
}

interface TuiAppProps {
  createSessionManager: TuiRuntimeClientFacadeFactory;
  config: TuiInitialConfig;
  workspace: string;
  workspaceIdentity: KiteWorkspaceIdentity;
  appControl: KiteAppControlClient;
  languagePreference: LanguagePreference;
  onLanguageSelect: (language: LanguagePreference) => boolean;
  readAppServerRuntime?: () => AppServerRuntimePresentation;
}

interface TuiInitialConfig {
  readonly providerName: string;
  readonly modelName: string;
  readonly reasoningEffort: string | null;
  readonly interactionMode: 'accept_edits' | 'auto' | 'full';
  readonly reasoningEnabled: boolean;
}

function initialConfigFromSnapshot(snapshot: ProviderModelSnapshot): TuiInitialConfig | undefined {
  const selected = snapshot.selected;
  if (!selected) return undefined;
  const route = snapshot.providers
    .flatMap((provider) => provider.models)
    .find((model) => model.provider === selected.provider && model.name === selected.name);
  if (!route) return undefined;
  return {
    providerName: selected.provider,
    modelName: selected.name,
    reasoningEffort: null,
    interactionMode: loadUserInteractionMode(),
    reasoningEnabled: route.reasoning !== false,
  };
}

export function TuiBootstrap({
  runtimeMode,
  createSessionManager,
  appControlGateway,
  credentialClient,
  appServerRuntime,
}: TuiBootstrapProps) {
  const workspace = process.cwd();
  _runtimeModeForExit = runtimeMode ?? null;
  const effectiveAppControlGateway = React.useMemo(() => {
    if (runtimeMode) {
      return {
        discovery: runtimeMode.appControl,
        forWorkspace: (_workspace: KiteWorkspaceIdentity) => runtimeMode.appControl,
      };
    }
    return appControlGateway;
  }, [appControlGateway, runtimeMode]);
  const effectiveCreateSessionManager = React.useMemo(() => {
    if (createSessionManager) return createSessionManager;
    if (!runtimeMode) return undefined;
    return createNativeTuiRuntimeClientFactory({
      connection: runtimeMode.connection,
    });
  }, [createSessionManager, runtimeMode]);
  const effectiveCredentialClient = credentialClient ?? runtimeMode?.credentialClient;
  const [languagePreference, setLanguagePreference] = React.useState<LanguagePreference>(() =>
    loadUserLanguage(),
  );
  const [deviceLocale] = React.useState(detectTuiDeviceLocale);
  const language = resolveTuiLanguage(languagePreference, deviceLocale);
  // Workspace trust is checked first — no project-level config is read before trust.
  const [workspaceIdentity, setWorkspaceIdentity] = React.useState<KiteWorkspaceIdentity | null>(
    null,
  );
  const [providerSnapshot, setProviderSnapshot] = React.useState<
    | { readonly status: 'idle' | 'loading' }
    | { readonly status: 'ready'; readonly snapshot: ProviderModelSnapshot }
    | { readonly status: 'error' }
  >({ status: 'idle' });
  const [runtimeConnectionStatus, setRuntimeConnectionStatus] = React.useState<
    'not_required' | 'connecting' | 'connected' | 'error'
  >(() => (runtimeMode ? 'connecting' : 'not_required'));

  const refreshProviderSnapshot = React.useCallback(
    async (identity: KiteWorkspaceIdentity) => {
      if (!effectiveAppControlGateway) {
        setProviderSnapshot({ status: 'error' });
        return;
      }
      setProviderSnapshot({ status: 'loading' });
      try {
        const snapshot = await effectiveAppControlGateway
          .forWorkspace(identity)
          .getProviderModelSnapshot({
            schema: 'kite.app.provider-model.snapshot-request.v1',
            workspace: identity,
          });
        setProviderSnapshot({ status: 'ready', snapshot });
      } catch {
        setProviderSnapshot({ status: 'error' });
      }
    },
    [effectiveAppControlGateway],
  );

  const connectRuntimeAfterTrust = React.useCallback(
    async (identity: KiteWorkspaceIdentity): Promise<void> => {
      if (!runtimeMode) {
        setRuntimeConnectionStatus('not_required');
        await refreshProviderSnapshot(identity);
        return;
      }
      setRuntimeConnectionStatus('connecting');
      try {
        await runtimeMode.connection.connect();
        setRuntimeConnectionStatus('connected');
        await refreshProviderSnapshot(identity);
      } catch {
        setRuntimeConnectionStatus('error');
        setProviderSnapshot({ status: 'error' });
      }
    },
    [refreshProviderSnapshot, runtimeMode],
  );

  const handleTrusted = React.useCallback(
    (identity: KiteWorkspaceIdentity) => {
      setWorkspaceIdentity(identity);
      void connectRuntimeAfterTrust(identity);
    },
    [connectRuntimeAfterTrust],
  );

  const handleSetupComplete = React.useCallback(
    (_result: { modelName: string }) => {
      if (workspaceIdentity) void refreshProviderSnapshot(workspaceIdentity);
    },
    [refreshProviderSnapshot, workspaceIdentity],
  );

  const handleConfigRetry = React.useCallback(() => {
    if (workspaceIdentity) void connectRuntimeAfterTrust(workspaceIdentity);
  }, [connectRuntimeAfterTrust, workspaceIdentity]);

  const handleLanguageSelect = React.useCallback((next: LanguagePreference): boolean => {
    const saved = saveUserLanguage(next);
    if (saved) setLanguagePreference(next);
    return saved;
  }, []);

  const withI18n = (node: React.ReactNode) => (
    <I18nProvider language={language}>{node}</I18nProvider>
  );

  if (!workspaceIdentity) {
    return withI18n(
      <ThemeContext.Provider value={getDarkTheme('blue')}>
        <WorkspaceTrustGate
          workspace={workspace}
          appControl={effectiveAppControlGateway?.discovery}
          onTrusted={handleTrusted}
          onExit={() => void _requestTuiExit?.()}
        />
      </ThemeContext.Provider>,
    );
  }

  if (providerSnapshot.status === 'idle' || providerSnapshot.status === 'loading') {
    return null;
  }

  if (
    runtimeMode &&
    runtimeConnectionStatus !== 'connected' &&
    providerSnapshot.status !== 'error'
  ) {
    return null;
  }

  const initialConfig =
    providerSnapshot.status === 'ready'
      ? initialConfigFromSnapshot(providerSnapshot.snapshot)
      : undefined;

  if (providerSnapshot.status === 'ready' && !initialConfig) {
    return withI18n(
      <ThemeContext.Provider value={getDarkTheme('blue')}>
        <FirstRunFlow
          onComplete={handleSetupComplete}
          appControl={effectiveAppControlGateway?.forWorkspace(workspaceIdentity)}
          credentialClient={effectiveCredentialClient}
          workspace={workspaceIdentity}
          onExit={() => void _requestTuiExit?.()}
        />
      </ThemeContext.Provider>,
    );
  }

  if (providerSnapshot.status === 'error') {
    return withI18n(
      <ThemeContext.Provider value={getDarkTheme('blue')}>
        <ConfigErrorScreen
          configPath="App Control provider configuration"
          message="Provider/model state is unavailable or invalid."
          onRetry={handleConfigRetry}
          onExit={() => void _requestTuiExit?.()}
        />
      </ThemeContext.Provider>,
    );
  }

  if (!effectiveCreateSessionManager) {
    throw new Error('TUI Runtime composition is unavailable.');
  }
  if (!effectiveAppControlGateway) {
    throw new Error('TUI App Control composition is unavailable.');
  }

  return withI18n(
    <TuiApp
      createSessionManager={effectiveCreateSessionManager}
      config={initialConfig!}
      workspace={workspace}
      workspaceIdentity={workspaceIdentity}
      appControl={effectiveAppControlGateway.forWorkspace(workspaceIdentity)}
      languagePreference={languagePreference}
      onLanguageSelect={handleLanguageSelect}
      readAppServerRuntime={appServerRuntime ? () => appServerRuntime : undefined}
    />,
  );
}

function TuiApp({
  createSessionManager,
  config,
  workspace,
  workspaceIdentity,
  appControl,
  languagePreference,
  onLanguageSelect,
  readAppServerRuntime,
}: TuiAppProps) {
  const { language, t: translate } = useI18n();
  const { waitUntilRenderFlush } = useApp();
  const { state, dispatch, onToggleReason } = useTuiState(
    config.modelName,
    config.providerName,
    config.reasoningEffort,
    config.interactionMode,
    config.reasoningEnabled,
  );
  const stateRef = React.useRef(state);
  stateRef.current = state;
  // A Run owns the model snapshot admitted with its first prompt. The model
  // selector may update App Control while this Run is active, but that desired
  // route is intentionally not projected into the active header/footer.
  const activeRunModelRef = React.useRef<{
    provider: string;
    name: string;
    reasoningEnabled?: boolean;
  } | null>(null);
  const previousRunActiveRef = React.useRef(false);
  const runActive = isTuiRunActive(state);
  React.useEffect(() => {
    if (runActive && !previousRunActiveRef.current) {
      activeRunModelRef.current = {
        provider: state.status.modelProvider,
        name: state.status.modelName,
        reasoningEnabled: state.status.reasoningEnabled,
      };
    }
    if (!runActive && previousRunActiveRef.current) {
      activeRunModelRef.current = null;
    }
    previousRunActiveRef.current = runActive;
  }, [
    runActive,
    state.status.modelName,
    state.status.modelProvider,
    state.status.reasoningEnabled,
  ]);

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
  const conversationHistoryRef = React.useRef<string[]>([]);
  // Lazy init — only create thread when user sends first message
  const threadIdRef = React.useRef<string>('');
  // One ordering authority covers asynchronous historical loads and every
  // foreground identity change. Reducer loading state is presentation only;
  // it must never be used to decide whether a delayed load may commit.
  const sessionNavigationRef = React.useRef<SessionNavigationAuthority | null>(null);
  if (!sessionNavigationRef.current) {
    sessionNavigationRef.current = new SessionNavigationAuthority();
  }
  const sessionNavigation = sessionNavigationRef.current;
  // Prevent concurrent NEW_SESSION from creating ghost sessions
  const creatingSessionRef = React.useRef(false);
  // A cancelled run may still be unwinding while the next prompt has already
  // been accepted. Older run finalizers must not clear the newer run's state.
  const inputValueRef = React.useRef('');
  const handleInputValueChange = React.useCallback((v: string) => {
    inputValueRef.current = v;
  }, []);
  const canToggleLastOutputBlock = React.useCallback(
    () => inputValueRef.current.trim().length === 0,
    [],
  );

  // Resize is a presentation epoch in both directions. Width and height are
  // both significant: widening needs reflow just as much as narrowing, and a
  // height-only resize can otherwise leave Ink's Static/dynamic boundary at a
  // stale cursor position. Sync output buffering is coordinated by the
  // commit-phase renderer hook.
  const [resizeKey, setResizeKey] = React.useState(0);
  React.useEffect(() => {
    let prevSize = { columns: process.stdout.columns, rows: process.stdout.rows };
    const handler = () => {
      const nextSize = { columns: process.stdout.columns, rows: process.stdout.rows };
      if (nextSize.columns === prevSize.columns && nextSize.rows === prevSize.rows) return;
      prevSize = nextSize;
      setResizeKey((n) => n + 1);
    };
    process.stdout.on('resize', handler);
    return () => {
      process.stdout.off('resize', handler);
    };
  }, []);

  const thinkingLevelRef = React.useRef<string | null>(config.reasoningEffort ?? null);
  const interactionModeRef = React.useRef<'accept_edits' | 'auto' | 'full'>(
    config.interactionMode ?? 'auto',
  );
  const prevSessionKeyRef = React.useRef(state.sessionKey);
  const agentLoopActiveRef = React.useRef(false);
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const skillManifestsRef = React.useRef<SkillManifest[]>([]);
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
  const promptSubmissionQueueRef = React.useRef<TuiPromptSubmissionQueue | null>(null);
  const queuedPromptIdRef = React.useRef(0);
  if (!promptSubmissionQueueRef.current) {
    promptSubmissionQueueRef.current = new TuiPromptSubmissionQueue();
  }
  const [slashSuggestion, setSlashSuggestion] = React.useState<SlashSuggestionData | null>(null);
  const [sessionGrantCount, setSessionGrantCount] = React.useState(0);
  const [providerModelSnapshot, setProviderModelSnapshot] = React.useState<ProviderModelSnapshot>();

  const refreshProviderModel = React.useCallback(async (): Promise<ProviderModelSnapshot> => {
    const snapshot = await appControl.getProviderModelSnapshot({
      schema: 'kite.app.provider-model.snapshot-request.v1',
      workspace: workspaceIdentity,
    });
    setProviderModelSnapshot(snapshot);
    return snapshot;
  }, [appControl, workspaceIdentity]);

  React.useEffect(() => {
    let cancelled = false;
    void appControl
      .getProviderModelSnapshot({
        schema: 'kite.app.provider-model.snapshot-request.v1',
        workspace: workspaceIdentity,
      })
      .then((snapshot) => {
        if (!cancelled) setProviderModelSnapshot(snapshot);
      })
      .catch(() => {
        if (!cancelled) setProviderModelSnapshot(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [appControl, workspaceIdentity]);

  const selectProviderModel = React.useCallback(
    async (model: import('./components/ModelSelector').ModelOption): Promise<boolean> => {
      if (!model.observedRevision) return false;
      try {
        const response = await appControl.selectProviderModel({
          schema: 'kite.app.provider-model.select-request.v1',
          workspace: workspaceIdentity,
          provider: model.provider,
          name: model.name,
          expectedRevision: model.observedRevision,
        });
        setProviderModelSnapshot(response.snapshot);
        if (response.outcome === 'applied' || response.outcome === 'already_selected') return true;
        if (response.outcome !== 'outcome_unknown') return false;
      } catch {
        // Lost mutation response: query authoritative state once; never replay.
      }
      try {
        const current = await refreshProviderModel();
        return (
          current.selected?.provider === model.provider && current.selected.name === model.name
        );
      } catch {
        return false;
      }
    },
    [appControl, refreshProviderModel, workspaceIdentity],
  );

  const provider = React.useMemo(() => {
    return new TuiUserInputProvider();
  }, []);

  const sessionManager = React.useMemo(() => {
    return createSessionManager({
      workspace,
      initialInteractionMode: config.interactionMode,
      flushPresentation: waitUntilRenderFlush,
    });
  }, [config.interactionMode, waitUntilRenderFlush, createSessionManager, workspace]);
  React.useEffect(() => {
    const releaseActionSink = provider.setActionSink((action) =>
      sessionManager.submitUserAction(action),
    );
    sessionManager.setSnapshotCallback((threadId: string) => {
      dispatch({ type: 'SESSION_INTERRUPT_PENDING', threadId });
    });
    _sessionManagerForExit = sessionManager;
    return () => {
      releaseActionSink();
      if (_sessionManagerForExit === sessionManager) _sessionManagerForExit = null;
    };
  }, [dispatch, provider, sessionManager]);
  React.useEffect(() => {
    if (!state.showPermissionSelector) return;
    const sessionId = state.activeSessionId || threadIdRef.current;
    if (!sessionId) {
      setSessionGrantCount(0);
      return;
    }
    let cancelled = false;
    void sessionManager
      .getSessionProjection(sessionId)
      .then((projection) => {
        if (!cancelled && threadIdRef.current === sessionId) {
          setSessionGrantCount(projection?.sessionCommandGrantCount ?? 0);
        }
      })
      .catch(() => {
        if (!cancelled && threadIdRef.current === sessionId) setSessionGrantCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionManager, state.activeSessionId, state.showPermissionSelector]);
  const [sandboxBackend, setSandboxBackend] = React.useState<SandboxBackend>('none');
  React.useEffect(() => {
    let cancelled = false;
    setSandboxBackend('none');
    void appControl
      .getExecutionStatus({
        schema: 'kite.app.execution-status.request.v1',
        workspace: workspaceIdentity,
      })
      .then((status) => {
        if (!cancelled) setSandboxBackend(status.sandboxBackend);
      })
      .catch(() => {
        if (!cancelled) setSandboxBackend('none');
      });
    return () => {
      cancelled = true;
    };
  }, [appControl, workspaceIdentity]);
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
      conversationHistoryRef,
      thinkingLevelRef,
      skillManifestsRef,
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
    appControl,
    workspaceIdentity,
  );

  // Skills loader: scan on mount
  useSkillsLoader(appControl, workspaceIdentity, dispatch, skillManifestsRef);

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

  const ensurePromptSession = React.useCallback(
    (submittedSessionId: string): string => {
      const resolved = ensureTuiPromptSession({
        submittedSessionId,
        getActiveSessionId: sessionManager.getActiveId,
        createSession: () => sessionManager.createSession(workspace),
      });
      threadIdRef.current = resolved.sessionId;
      if (resolved.created) {
        dispatch({
          type: 'SET_SESSIONS',
          sessions: sessionManager.getSnapshot(),
        });
      }
      return resolved.sessionId;
    },
    [dispatch, sessionManager, workspace],
  );

  // Start with one fresh in-memory session. Historical entries are discovered
  // by the selector and are deliberately not registered here: registration
  // opens/reconciles a Runtime and must happen only after a selected session
  // has passed its implicit compatibility load.
  React.useEffect(() => {
    // Always start a new session — user switches to historical ones via
    // /resume. A discovery failure is therefore unable to block new input.
    ensurePromptSession('');
  }, [ensurePromptSession]);

  /** 从 DB 加载指定会话的完整状态（LOAD_SESSION_PENDING 的实际逻辑） */
  const loadSessionById = React.useCallback(
    async (threadId: string) => {
      const token = sessionNavigation.beginLoad(threadId);

      // Keep the currently active Runtime/projection intact until the target
      // has loaded. Historical sessions are registered only after this load;
      // this is the implicit compatibility boundary for known old formats.
      const oldId = sessionManager.getActiveId();
      let stage: HistoricalSessionOpenStage = 'persisted_load';
      let registeredForLoad = false;
      let restartRecoveryUnavailable = false;

      const cleanupStaleRegistration = async (): Promise<void> => {
        if (
          !registeredForLoad ||
          sessionManager.getActiveId() === threadId ||
          sessionNavigation.isLoadingTarget(threadId)
        ) {
          return;
        }
        try {
          await sessionManager.removeRuntime(threadId);
        } catch (cleanupError) {
          historicalSessionDebug(
            'stale cleanup failed stage=%s error=%s',
            stage,
            classifyHistoricalSessionOpenFailure(stage, cleanupError),
          );
        }
      };

      dispatch({ type: 'LOAD_SESSION_PENDING', threadId });

      try {
        let result = await sessionManager.loadPersistedSession(threadId);
        if (!result) throw new Error(`Session ${threadId} has no saved checkpoints.`);
        if (!sessionNavigation.isCurrent(token)) return;

        // Register without publishing the target as active. Host resume owns
        // restart cleanup; historical replay must wait for that durable
        // boundary and then reload the advanced event tail.
        stage = 'runtime_registration';
        if (!sessionManager.hasRuntime(threadId)) {
          const runtime = sessionManager.registerSession(threadId, workspace, {
            recoverBeforeSubscribe: result.recovery === 'restart_required',
          });
          runtime.dormant = true;
          registeredForLoad = true;
        }
        stage = 'runtime_recovery';
        try {
          await sessionManager.waitForSessionReady(threadId);
        } catch (error) {
          if (result.recovery !== 'restart_required') throw error;
          // History remains display-only evidence. If the explicit Server
          // recovery barrier is temporarily fenced by an orphaned effect
          // lease, show only the durable transcript and never synthesize a
          // lifecycle terminal or retain a local Working state.
          restartRecoveryUnavailable = true;
        }
        if (!sessionNavigation.isCurrent(token)) {
          await cleanupStaleRegistration();
          return;
        }
        stage = 'persisted_reload';
        const recovered = await sessionManager.loadPersistedSession(threadId);
        if (!recovered) throw new Error(`Session ${threadId} has no saved checkpoints.`);
        result = recovered;
        if (!sessionNavigation.isCurrent(token)) {
          await cleanupStaleRegistration();
          return;
        }

        const committed = sessionNavigation.commit(token, () => {
          stage = 'runtime_switch';
          if (oldId !== threadId) {
            sessionManager.switchSession(oldId, threadId);
            const rt = sessionManager.getRuntime(threadId);
            if (rt) {
              rt.setForeground(true);
              rt.dormant = false;
            }
          }
          threadIdRef.current = threadId;
          conversationHistoryRef.current = [];
          // The target was intentionally absent from the startup projection;
          // publish it only after the compatibility load and Runtime registration
          // have succeeded.
          dispatch({
            type: 'SET_SESSIONS',
            sessions: sessionManager.getSnapshot(),
          });

          const resumedRoute = sessionManager.applyPersistedModelRoute(
            threadId,
            result.modelProvider,
            result.modelName,
          );
          const thinkingLevel = result.thinkingLevel ?? 'max';
          thinkingLevelRef.current = thinkingLevel;

          stage = 'presentation_replay';
          const runtime = sessionManager.getRuntime(threadId);
          const {
            blocks,
            interrupt,
            interactionMode,
            pendingToolCalls,
            recoveredPendingInteraction,
          } = sessionDataToUI({
            ...result,
            // Initial mode is snapshot state, not necessarily represented by
            // an interaction_mode.changed event. Host recovery has already
            // restored the exact admitted State by this point.
            interactionMode: runtime?.interactionMode ?? result.interactionMode,
          });
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
            modelProvider: resumedRoute.provider,
            modelName: resumedRoute.name,
            thinkingLevel,
            reasoningEnabled: resumedRoute.reasoningEnabled,
            interactionMode,
          });
          if (restartRecoveryUnavailable) {
            dispatch({
              type: 'LOCAL_TEXT',
              text: '  ⎿  运行恢复暂不可用；已以只读方式打开持久历史。',
              isError: true,
            });
          }
          if (result.runtimeEvents.some((envelope) => envelope.event.type === 'user.message')) {
            stage = 'context_projection';
            const contextSnapshot = sessionManager.buildContextStatusSnapshot(threadId);
            if (contextSnapshot) {
              dispatch({
                type: 'SET_CONTEXT_SNAPSHOT',
                snapshot: contextSnapshot,
              });
            }
          }
        });
        if (!committed) return;
      } catch (error) {
        if (!sessionNavigation.isCurrent(token)) {
          await cleanupStaleRegistration();
          return;
        }
        historicalSessionDebug(
          'open failed stage=%s error=%s',
          stage,
          classifyHistoricalSessionOpenFailure(stage, error),
        );
        // Roll back SessionManager: if we switched to a different session and the
        // load failed, revert the switch and remove the orphaned runtime.
        if (oldId !== threadId) {
          sessionManager.switchSession(threadId, oldId);
          threadIdRef.current = oldId;
          try {
            await sessionManager.removeRuntime(threadId);
          } catch (cleanupError) {
            // The primary admission/replay failure is the reason this open did
            // not commit. Host cleanup is secondary and must not suppress the
            // isolated TUI failure projection or make the previous session
            // unusable. The bridge keeps cleanup fail-closed and reports its
            // bounded cause only through the opt-in diagnostic channel.
            historicalSessionDebug(
              'rollback failed stage=%s error=%s',
              stage,
              classifyHistoricalSessionOpenFailure(stage, cleanupError),
            );
          }
          if (!sessionNavigation.isCurrent(token)) return;
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
              presentationState: 'sealed',
            },
          ],
          interrupt: null,
          modelProvider: '',
          modelName: '',
          thinkingLevel: null,
        });
      }
    },
    [dispatch, sessionManager, sessionNavigation, workspace],
  );

  const dispatchSessionLoad = React.useCallback(
    async (action: Action) => {
      // CLEAR_OUTPUT can be issued while the view is already empty (for
      // example after a previous clear). Advance the physical presentation
      // epoch explicitly so Static/header ownership is reset even when there
      // is no turns-length transition for the renderer hook to observe.
      if (action.type === 'CLEAR_OUTPUT') {
        setResizeKey((epoch) => epoch + 1);
      }
      // Intercept NEW_SESSION to create runtime via SessionManager
      if (action.type === 'NEW_SESSION') {
        // Ignore /new for an already-active empty session.
        if (stateRef.current.turns.length === 0 && sessionManager.getActiveId()) return;
        // Prevent concurrent NEW_SESSION from creating ghost sessions
        if (creatingSessionRef.current) return;
        creatingSessionRef.current = true;
        // Flush token stats for outgoing session before leaving it
        const oldId = sessionManager.getActiveId();
        if (oldId) sessionManager.saveTokenStats(oldId, stateRef.current.status, true);
        sessionNavigation.invalidatePendingLoad();
        const newId = sessionManager.createSession(workspace);
        threadIdRef.current = newId;
        // The reducer will use this threadId to create the snapshot
        dispatch({ type: 'NEW_SESSION', threadId: newId });
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
        // A direct in-memory switch is a newer foreground decision than any
        // pending historical load, including a repeated selection while the
        // older Promise is still unresolved.
        sessionNavigation.invalidatePendingLoad();
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

        // Historical sessions are intentionally not registered at startup.
        // A missing Runtime therefore follows the same implicit load path as
        // a dormant one; only an already hydrated Runtime can switch directly.
        if (!incomingRt || incomingRt.dormant) {
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
              type: 'ACCEPT_PRESENTATION_ENVELOPE',
              event,
            });
          }
          incomingRt.eventBuffer = [];
        }
        return;
      }
      // ── DELETE_SESSION：删除会话，从 DB 和 SessionManager 中移除 ──
      if (action.type === 'DELETE_SESSION') {
        const { threadId } = action;
        const wasActive = threadId === sessionManager.getActiveId();
        // Invalidate any in-flight loadSessionById for this threadId to prevent
        // stale load from restoring the deleted session.
        sessionNavigation.invalidatePendingLoad();
        if (wasActive) {
          // Token statistics live outside the Runtime State transaction and
          // must flush before the Host atomically removes that State.
          sessionManager.saveTokenStats(threadId, stateRef.current.status, true);
        }
        await sessionManager.cancelRuntimeOperations(threadId);
        try {
          await sessionManager.deletePersistedSession(threadId);
        } catch (error) {
          dispatch({
            type: 'LOCAL_TEXT',
            text: `删除会话失败：${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          });
          return;
        }
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
    [dispatch, sessionManager, sessionNavigation, workspace, loadSessionById],
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
    // With no submitted task, `/plan` is only input policy for the next
    // start_turn.  Creating a local Runtime planning placeholder here would
    // mutate State outside RuntimeClient → RuntimeServer → RuntimeAccess and
    // leave the bridge's Host revision stale.  The actual planning transition
    // is committed atomically with that next start_turn.
    dispatchSessionLoad({ type: 'SET_PHASE', phase: 'planning' });
  }, [dispatchSessionLoad]);

  const togglePlanMode = React.useCallback(() => {
    // This selector never writes Runtime State. Runtime phase changes belong
    // to the durable start_turn command (or its subsequent runtime events).
    dispatchSessionLoad({
      type: 'SET_PHASE',
      phase: state.status.phase === 'planning' ? 'building' : 'planning',
    });
  }, [dispatchSessionLoad, state.status.phase]);

  // Stable onCompact via refs — bypasses stale closure issues with useSlashCommand
  // and Ink 7 useInput across session switches.
  const onCompactRef = React.useRef<(customInstructions?: string) => void>(() => {});
  onCompactRef.current = (customInstructions?: string) => {
    const targetThreadId = threadIdRef.current;
    const submittedAfterVisibleCompletion = !isTuiRunActive(stateRef.current);
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
        (_event) => {
          // The Service emits the durable compaction event through the
          // Runtime Client subscription; the command callback is diagnostic
          // presentation metadata and is intentionally not a Runtime event.
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
          dispatchSessionLoad({ type: 'ACCEPT_PRESENTATION_ENVELOPE', event });
        }
        if (!result.events.some((envelope) => envelope.event.type === 'context.compaction')) {
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
      if (!saveColorPreset(p)) {
        dispatchSessionLoad({
          type: 'LOCAL_TEXT',
          text: '无法保存主题设置；当前主题保持不变。',
          isError: true,
        });
        return;
      }
      setThemePreset(p);
      dispatchSessionLoad({ type: 'LOCAL_COMMAND', text: `/theme ${p}` });
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
    undefined,
    runTaskBridge,
    enterPlanMode,
    (customInstructions) => {
      onCompactRef.current(customInstructions);
    },
    // PR 9: /context handler — display context usage breakdown
    () => {
      const targetThreadId = threadIdRef.current;
      dispatchSessionLoad({ type: 'LOCAL_COMMAND', text: '/context' });
      const text = sessionManager.handleContextDisplay(targetThreadId);
      dispatchSessionLoad({ type: 'LOCAL_TEXT', text });
    },
    // PR 9: /compact reset handler — preflight + clear active checkpoint
    () => {
      const targetThreadId = threadIdRef.current;
      const targetTurnCount = Math.max(1, stateRef.current.turns.length);
      dispatchSessionLoad({ type: 'LOCAL_COMMAND', text: '/compact reset' });
      void sessionManager
        .handleContextReset(targetThreadId)
        .then((result) => {
          if (threadIdRef.current !== targetThreadId) {
            const target = sessionManager.getRuntime(targetThreadId);
            for (const event of result.events) target?.eventBuffer.push(event);
            return;
          }
          for (const event of result.events) {
            dispatchSessionLoad({ type: 'ACCEPT_PRESENTATION_ENVELOPE', event });
          }
          if (stateRef.current.turns.length !== targetTurnCount) return;
          dispatchSessionLoad({
            type: 'LOCAL_TEXT',
            text: `  ⎿  ${result.text}`,
            ...(result.isError ? { isError: true } : {}),
          });
        })
        .catch(() => {
          if (
            threadIdRef.current !== targetThreadId ||
            stateRef.current.turns.length !== targetTurnCount
          ) {
            return;
          }
          dispatchSessionLoad({
            type: 'LOCAL_TEXT',
            text: '  ⎿  Context reset failed; the active checkpoint was preserved.',
            isError: true,
          });
        });
    },
    () => {
      const appServerRuntime = readAppServerRuntime?.();
      dispatchSessionLoad({ type: 'LOCAL_COMMAND', text: '/status' });
      const identity = appServerRuntime
        ? formatAppServerRuntimeStatus(appServerRuntime, {
            transport: translate('appServerStatus.transport'),
            mode: translate('appServerStatus.mode'),
            buildId: translate('appServerStatus.buildId'),
            serverVersion: translate('appServerStatus.serverVersion'),
            clientVersion: translate('appServerStatus.clientVersion'),
            paired: translate('appServerStatus.paired'),
            protocolCompatible: translate('appServerStatus.protocolCompatible'),
          })
        : `  ⎿  ${translate('appServerStatus.unavailable')}`;
      dispatchSessionLoad({
        type: 'LOCAL_TEXT',
        text: identity,
        ...(appServerRuntime ? {} : { isError: true }),
      });
    },
  );

  // Keyboard cancellation must reach the Runtime Client facade in the same input turn as
  // ESC/Ctrl+C. Waiting for the reducer-driven running=false effect leaves a
  // race where the next prompt is submitted while the old runtime still looks
  // active, so tryReservePrompt() rejects it as an ordinary concurrent prompt.
  const abortForegroundRun = React.useCallback(() => {
    // Ctrl+C is always whole-turn cancellation. The Runtime Client facade owns the
    // durable no-op check when there is no active turn, so an input/plan/tool
    // overlay must never narrow this into a local interaction cancellation.
    const current = stateRef.current;
    if (!isTuiRunActive(current) || current.cancelRequestedRunId !== undefined) return;
    const runtime = sessionManager.getRuntime(threadIdRef.current);
    if (!runtime) return;
    void runtime.abort().catch((error) => {
      dispatch({ type: 'CANCEL_REQUEST_FAILED' });
      dispatch({
        type: 'LOCAL_TEXT',
        text: `  ⎿  Cancellation was not accepted: ${toErrorMessage(error)}`,
        isError: true,
      });
    });
  }, [dispatch, sessionManager]);

  const syncInteractionMode = React.useCallback(
    (mode: 'accept_edits' | 'auto' | 'full') => {
      // Update the ref in the same input turn so a prompt submitted immediately
      // after closing the selector cannot observe the old value.
      sessionManager.getRuntime(threadIdRef.current)?.setInteractionMode(mode);
      interactionModeRef.current = mode;
      if (!saveInteractionMode(mode)) {
        dispatch({
          type: 'LOCAL_TEXT',
          text: translate('permission.saveFailed'),
          isError: true,
        });
      }
    },
    [dispatch, sessionManager, translate],
  );

  const clearActiveSessionCommandGrants = React.useCallback(() => {
    const activeThreadId = threadIdRef.current;
    void sessionManager
      .clearSessionCommandGrants(activeThreadId)
      .then(async () => {
        const projection = await sessionManager.getSessionProjection(activeThreadId);
        if (threadIdRef.current === activeThreadId) {
          setSessionGrantCount(projection?.sessionCommandGrantCount ?? 0);
        }
      })
      .catch(() => {
        dispatchSessionLoad({
          type: 'LOCAL_TEXT',
          text: '  ⎿  Session command grants could not be cleared.',
          isError: true,
        });
      });
  }, [dispatchSessionLoad, sessionManager]);

  const runTaskNow = React.useCallback(
    async (
      submittedThreadId: string,
      task: string,
      requestedPhase?: AgentPhase,
      initialSkillActivations?: Array<{
        skillId: string;
        input: Record<string, unknown>;
      }>,
      queuedPromptId?: number,
    ) => {
      // A prompt queued behind an active turn belongs to the Session that was
      // foreground when the user pressed Enter. Do not retarget it if the user
      // switches Sessions while the preceding turn is still completing.
      let threadId = ensurePromptSession(submittedThreadId);
      let rt = sessionManager.getRuntime(threadId);
      if (!rt) throw new Error(`Runtime session is unavailable: ${threadId}`);

      if (rt.localReplayRecovery) {
        const continued = await sessionManager.forkRecoveredSessionForContinuation(threadId);
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
          modelProvider: rt.modelProvider,
          modelName: rt.modelName,
          thinkingLevel: thinkingLevelRef.current,
          reasoningEnabled: rt.reasoningEnabled,
        });
      }

      // A durable run terminal can make the prompt visible one render before
      // the Host lifecycle releases the completed execution. Queue a prompt
      // submitted in that narrow window behind the Host-owned idle barrier;
      // otherwise tryReservePrompt() would silently discard an ordinary
      // consecutive turn (and must not be made permissive with a local abort).
      await rt.waitForRunCompletion();

      // Recover first so the reservation belongs to the continuation runtime,
      // not the immutable source session left by an interrupted interaction.
      if (!rt.tryReservePrompt()) {
        throw new Error('The Runtime session did not admit the queued prompt.');
      }
      const startsForeground = threadIdRef.current === threadId;

      // 将 React 层 per-session 状态同步到 Runtime / Sync React-layer per-session state to runtime
      if (startsForeground) {
        rt.thinkingLevel = thinkingLevelRef.current;
        rt.conversationHistory = [...conversationHistoryRef.current];
      }

      // Capture the model at the admission boundary for both an idle prompt
      // and a queued successor. A successor can begin without an
      // idle→active transition, so only capturing the first Run would leave
      // its header pinned to the predecessor's model.
      if (startsForeground) {
        activeRunModelRef.current = {
          provider: stateRef.current.status.modelProvider,
          name: stateRef.current.status.modelName,
          reasoningEnabled: stateRef.current.status.reasoningEnabled,
        };
      }
      // Update the local presentation boundary; canonical Run activity comes from Runtime authority.
      if (startsForeground && queuedPromptId === undefined) {
        // An idle prompt has no predecessor to disturb, so retain immediate local echo.
        dispatch({ type: 'SET_RUNNING' });
        dispatch({ type: 'LOCAL_USER_PROMPT', text: task });
      }
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
            onAccepted: (identity) => {
              if (queuedPromptId !== undefined) {
                if (threadIdRef.current === threadId) {
                  dispatch({
                    type: 'ACCEPT_QUEUED_PROMPT',
                    id: queuedPromptId,
                    sessionId: threadId,
                    text: task,
                    messageId: identity.messageId,
                  });
                } else {
                  dispatch({ type: 'DEQUEUE_LOCAL_PROMPT', id: queuedPromptId });
                }
                return;
              }
              dispatch({ type: 'ACCEPT_LOCAL_PROMPT', text: task, messageId: identity.messageId });
            },
          },
          requestedPhase,
          initialSkillActivations,
        );
      } catch (error) {
        if (threadIdRef.current === threadId) {
          dispatch({ type: 'DROP_LOCAL_USER_PROMPT', text: task });
        }
        throw error;
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
    [dispatch, ensurePromptSession, sessionManager],
  );
  const runTask = React.useCallback(
    (
      task: string,
      requestedPhase?: AgentPhase,
      initialSkillActivations?: Array<{
        skillId: string;
        input: Record<string, unknown>;
      }>,
      queuedPromptId?: number,
    ): Promise<void> => {
      const submittedThreadId = threadIdRef.current;
      return promptSubmissionQueueRef.current!.enqueue(submittedThreadId, (targetThreadId) =>
        runTaskNow(targetThreadId, task, requestedPhase, initialSkillActivations, queuedPromptId),
      );
    },
    [runTaskNow],
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

      // Plan mode is a sticky TUI input policy across completed conversations.
      // Pass it explicitly for every plain prompt so the new Core Task cannot
      // silently fall back to building while the Footer still says plan.
      const submittedSessionId = threadIdRef.current;
      const submittedRuntime = sessionManager.getRuntime(submittedSessionId);
      const queued =
        isTuiRunActive(stateRef.current) ||
        submittedRuntime?.agentLoopActive === true ||
        promptSubmissionQueueRef.current!.hasPending(submittedSessionId);
      const queuedPromptId = queued ? ++queuedPromptIdRef.current : undefined;
      if (queuedPromptId !== undefined) {
        dispatchSessionLoad({
          type: 'QUEUE_LOCAL_PROMPT',
          id: queuedPromptId,
          sessionId: submittedSessionId,
          text: value,
        });
      }
      observeTuiPromptSubmission({
        queued,
        submit: () => runTask(value, stateRef.current.status.phase, undefined, queuedPromptId),
        onQueued: () => {},
        onFailure: (error) => {
          if (queuedPromptId !== undefined) {
            dispatchSessionLoad({ type: 'DEQUEUE_LOCAL_PROMPT', id: queuedPromptId });
          }
          dispatchSessionLoad({
            type: 'LOCAL_TEXT',
            text: `  ⎿  Message was not sent: ${toErrorMessage(error)}`,
            isError: true,
          });
        },
      });
    },
    [dispatchSessionLoad, runTask, sessionManager],
  );

  React.useEffect(() => {
    return () => {
      provider.teardown?.();
    };
  }, [provider]);

  const modelForDisplay = runActive
    ? (activeRunModelRef.current ?? {
        provider: state.status.modelProvider,
        name: state.status.modelName,
        reasoningEnabled: state.status.reasoningEnabled,
      })
    : {
        provider: state.status.modelProvider,
        name: state.status.modelName,
        reasoningEnabled: state.status.reasoningEnabled,
      };
  const presentationKey = [
    languagePreference,
    language,
    themePreset,
    modelForDisplay.provider,
    modelForDisplay.name,
    state.status.thinkingMode,
    modelForDisplay.reasoningEnabled,
  ].join(':');
  const loadPersistedSessionsForSelector = React.useCallback(
    (query: string) => sessionManager.listPersistedSessions(query),
    [sessionManager],
  );

  return (
    <ThemeContext.Provider value={theme}>
      <App
        state={state}
        dispatch={dispatchSessionLoad}
        onToggleReason={onToggleReason}
        provider={provider}
        workspace={workspace}
        mcpController={mcpController}
        providerModelSnapshot={providerModelSnapshot}
        onModelSelect={selectProviderModel}
        slashSuggestion={slashSuggestion}
        sandboxBackend={sandboxBackend}
        onTogglePlanMode={togglePlanMode}
        onInteractionModeChange={syncInteractionMode}
        sessionGrantCount={sessionGrantCount}
        onClearSessionGrants={clearActiveSessionCommandGrants}
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
        canToggleLastOutputBlock={canToggleLastOutputBlock}
        getRewindPreview={previewRewind}
        loadSessions={loadPersistedSessionsForSelector}
        resizeGeneration={resizeKey}
        modelForDisplay={modelForDisplay}
        presentationKey={presentationKey}
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
  const exitCoordinator = createTuiExitCoordinator({
    getSessionLifecycle: () => {
      const session = _sessionManagerForExit;
      const runtimeMode = _runtimeModeForExit;
      if (!session && !runtimeMode) return null;
      return {
        shutdownObservability: (timeoutMs: number) =>
          session?.shutdownObservability(timeoutMs) ?? Promise.resolve(),
        dispose: async () => {
          if (session) await session.dispose();
          else await runtimeMode?.close('tui_exit');
        },
      };
    },
    getShellExecutor: () => null,
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
