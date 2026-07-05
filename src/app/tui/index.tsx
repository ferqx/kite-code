import { render } from 'ink';
import React from 'react';
import {
  type AgentConfig,
  loadAgentConfig,
  loadColorPreset,
  loadTheme,
  saveColorPreset,
  tryLoadAgentConfig,
} from '@/core/config/index';
import { sessionExportPath } from '@/core/config/paths';
import type { McpManager } from '@/core/mcp';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import { defaultCheckpointPath } from '../../core/config/paths.js';
import { deleteSession, listSessions, loadSession } from '../../core/persistence/sessions.js';
import App, { type Action, useTuiState } from './App';
import ErrorBoundary from './components/ErrorBoundary';
import InputLine, { type SlashSuggestionData } from './components/InputLine';
import SetupWizard from './components/SetupWizard';
import { useMcpConnection } from './hooks/useMcpConnection';
import { type RewindDeps, useRewindCheckpoints, useRunRewind } from './hooks/useRewindHandler';
import { useSkillsLoader } from './hooks/useSkillsLoader';
import { useSlashCommand } from './hooks/useSlashCommand';
import { TuiUserInputProvider } from './provider';
import { sessionDataToUI } from './replay-blocks.js';
import { SessionManager } from './session-manager';
import { TextBatcher } from './text-batcher';
import { getDarkTheme, lightTheme, osc4Apply, ThemeContext, type ThemePreset } from './theme';

/** 模块级引用，供退出时中止所有会话 / Module-level reference for aborting all sessions on exit */
let _sessionManagerForExit: SessionManager | null = null;
let _unmountForExit: (() => void) | null = null;

function resolveModelForResume(currentConfig: AgentConfig, persistedModelName: string): string {
  return persistedModelName || currentConfig.modelName;
}

export interface TuiBootstrapProps {
  /** 可选的自定义模型实例（用于测试注入）/ Optional custom model instance (for test injection) */
  model?: import('@/core/model/factory').SupportedChatModel;
}

interface TuiAppProps {
  config: AgentConfig;
  /** 可选的自定义模型实例（用于测试注入）/ Optional custom model instance (for test injection) */
  injectModel?: import('@/core/model/factory').SupportedChatModel;
}

export function TuiBootstrap({ model: injectModel }: TuiBootstrapProps = {}) {
  // Load config synchronously on first render — avoids a flash of SetupWizard
  // that would consume keystrokes before TuiApp mounts.
  const [config, setConfig] = React.useState<AgentConfig | null>(() => tryLoadAgentConfig());

  const handleSetupComplete = React.useCallback(({ modelName }: { modelName: string }) => {
    // SetupWizard saved everything (provider + models + effort) to config.
    const cfg = loadAgentConfig({ modelName });
    setConfig(cfg);
  }, []);

  if (!config) {
    return (
      <ThemeContext.Provider value={getDarkTheme('blue')}>
        <SetupWizard onComplete={handleSetupComplete} />
      </ThemeContext.Provider>
    );
  }

  return <TuiApp config={config} injectModel={injectModel} />;
}

function TuiApp({ config, injectModel }: TuiAppProps) {
  const workspace = process.cwd();
  const { state, dispatch, onToggleReason } = useTuiState(
    config.modelName,
    config.providerName,
    config.reasoningEffort,
    config.interactionMode,
  );
  const stateRef = React.useRef(state);
  stateRef.current = state;

  // TextBatcher: merge consecutive text events to reduce re-renders during streaming
  const textBatcher = React.useMemo(
    () => new TextBatcher((action) => dispatch(action), 16),
    [dispatch],
  );
  const textBatcherRef = React.useRef(textBatcher);
  textBatcherRef.current = textBatcher;

  React.useEffect(() => {
    textBatcher.setRunning(state.running);
  }, [state.running, textBatcher]);
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
  const thinkingLevelRef = React.useRef<string | null>(config.reasoningEffort ?? null);
  const interactionModeRef = React.useRef<'ask' | 'auto' | 'full'>(config.interactionMode ?? 'ask');
  const prevSessionKeyRef = React.useRef(state.sessionKey);
  const agentLoopActiveRef = React.useRef(false);
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const mcpManagerRef = React.useRef<McpManager | null>(null);
  const skillManifestsRef = React.useRef<SkillManifest[]>([]);
  const skillOptionsRef = React.useRef<SkillScanOptions | null>(null);
  const pendingSkillsRef = React.useRef<string[]>([]);
  const runTaskRef = React.useRef<(task: string) => Promise<void>>(async () => {});
  const [slashSuggestion, setSlashSuggestion] = React.useState<SlashSuggestionData | null>(null);

  const provider = React.useMemo(
    () =>
      new TuiUserInputProvider((event) => {
        textBatcherRef.current.push(event);
      }),
    [],
  );

  const sessionManager = React.useMemo(() => {
    const mgr = new SessionManager({
      config,
      provider,
      skillManifests: skillManifestsRef.current,
      skillOptions: skillOptionsRef.current,
      mcpManager: mcpManagerRef.current,
      checkpointPath: defaultCheckpointPath(),
    });
    mgr.setSnapshotCallback((threadId) => {
      dispatch({ type: 'SESSION_INTERRUPT_PENDING', threadId });
    });
    _sessionManagerForExit = mgr;
    return mgr;
  }, [config, provider, dispatch]);

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
      sessionManager.abortAll();
      _unmountForExit?.();
      process.exit(0);
    }
  }, [state.exitRequested, sessionManager]);

  // Rewind: checkpoint list + revert/fork execution
  useRewindCheckpoints(state, dispatch, threadIdRef);

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
      mcpManagerRef,
      agentLoopActiveRef,
      abortControllerRef,
      stateRef,
    }),
    [dispatch, provider, config, workspace, sessionManager],
  );
  const { runRewind, dispatchSessionLoadInterceptor } = useRunRewind(state, rewindDeps);
  const runRewindRef = React.useRef(runRewind);
  runRewindRef.current = runRewind;

  // MCP Manager lifecycle
  const { mcpManager, mcpPromptRegistry } = useMcpConnection(mcpManagerRef, sessionManager);

  // Skills loader: scan on mount
  useSkillsLoader(workspace, dispatch, skillManifestsRef, skillOptionsRef, sessionManager);

  // Keep pendingSkills ref in sync for use in runTask callback
  React.useEffect(() => {
    pendingSkillsRef.current = state.pendingSkills;
  }, [state.pendingSkills]);

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
    dispatch({ type: 'EVENT', event: { type: 'text', data: { text: '👋 Goodbye!' } } });
    sessionManager.abortAll();
    sessionManager.dispose();
    setTimeout(() => {
      _unmountForExit?.();
      process.exit(0);
    }, 300);
  }, [dispatch, sessionManager]);

  // Load historical sessions from DB on startup, but always start fresh.
  React.useEffect(() => {
    const checkpointPath = defaultCheckpointPath();
    listSessions(checkpointPath)
      .then((dbSessions) => {
        for (const s of dbSessions) {
          if (!sessionManager.hasRuntime(s.threadId)) {
            const rt = sessionManager.registerSession(s.threadId, workspace);
            rt.dormant = true;
            sessionManager.setName(s.threadId, s.name);
          }
        }

        // Always start a new session — user switches to historical ones via /sessions
        const newId = sessionManager.createSession(workspace);
        threadIdRef.current = newId;

        dispatch({ type: 'SET_SESSIONS', sessions: sessionManager.getSnapshot() });
      })
      .catch((e) => {
        console.error(
          `[TUI] Failed to list historical sessions: ${e instanceof Error ? e.message : String(e)}`,
        );
        // DB may not exist yet (first run) — auto-create
        if (!sessionManager.getActiveId()) {
          const newId = sessionManager.createSession(workspace);
          threadIdRef.current = newId;
          dispatch({ type: 'SET_SESSIONS', sessions: sessionManager.getSnapshot() });
        }
      });
  }, [
    sessionManager.registerSession,
    sessionManager.setName,
    sessionManager.hasRuntime,
    sessionManager.createSession,
    workspace,
    sessionManager.getSnapshot,
    sessionManager.getActiveId,
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
        const result = await loadSession(defaultCheckpointPath(), threadId);
        // If a newer load was issued while this was loading, discard
        if (loadGenerationRef.current !== gen) return;
        if (!result) {
          dispatch({
            type: 'LOAD_SESSION',
            threadId,
            blocks: [
              { id: 1, kind: 'text', content: `Session ${threadId} has no saved checkpoints.` },
            ],
            interrupt: null,
            modelProvider: '',
            modelName: '',
            thinkingLevel: null,
          });
          return;
        }

        const modelName = resolveModelForResume(config, result.modelName);
        const thinkingLevel = result.thinkingLevel ?? 'max';
        thinkingLevelRef.current = thinkingLevel;

        const { blocks, interrupt } = sessionDataToUI(result);
        dispatch({
          type: 'LOAD_SESSION',
          threadId,
          blocks,
          interrupt,
          modelProvider: result.modelProvider,
          modelName,
          thinkingLevel,
        });
      } catch (e: any) {
        if (loadGenerationRef.current !== gen) return;
        // Roll back SessionManager: if we switched to a different session and the
        // load failed, revert the switch and remove the orphaned runtime.
        if (oldId !== threadId) {
          sessionManager.switchSession(threadId, oldId);
          threadIdRef.current = oldId;
          sessionManager.removeRuntime(threadId);
        }
        dispatch({
          type: 'LOAD_SESSION',
          threadId,
          blocks: [{ id: 1, kind: 'text', content: `Failed to load session: ${e?.message ?? e}` }],
          interrupt: null,
          modelProvider: '',
          modelName: '',
          thinkingLevel: null,
        });
      }
    },
    [dispatch, config, sessionManager, workspace],
  );

  const dispatchSessionLoad = React.useCallback(
    async (action: Action) => {
      // Intercept NEW_SESSION to create runtime via SessionManager
      if (action.type === 'NEW_SESSION') {
        // Ignore /new if the current session has no user messages yet
        if (stateRef.current.turns.length === 0) return;
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
        dispatch({ type: 'SET_SESSIONS', sessions: sessionManager.getSnapshot() });
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
      // Intercept REVERT/FORK to store pending action before reducer closes panel
      dispatchSessionLoadInterceptor(action);
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
          dispatch({ type: 'SET_SESSIONS', sessions: sessionManager.getSnapshot() });
          for (const event of incomingRt.eventBuffer) {
            dispatch({ type: 'EVENT', event });
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
        try {
          await deleteSession(defaultCheckpointPath(), threadId);
        } catch {
          // DB error — still remove from runtime list
        }
        // Remove from SessionManager and refresh snapshots
        if (wasActive) {
          // Flush token stats before removing runtime (stats are lost after remove)
          sessionManager.saveTokenStats(threadId, stateRef.current.status, true);
        }
        sessionManager.removeRuntime(threadId);
        if (wasActive) {
          // Deleted the active session — create a new one so TUI has an active session
          const newId = sessionManager.createSession(workspace);
          threadIdRef.current = newId;
          dispatch({ type: 'NEW_SESSION', threadId: newId });
        } else {
          dispatch(action);
        }
        dispatch({ type: 'SET_SESSIONS', sessions: sessionManager.getSnapshot() });
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
          await fs.writeFile(filename, header + body, { encoding: 'utf-8', mode: 0o600 });
          dispatch({ type: 'EXPORT_SESSION_DONE', filename });
        } catch (e: any) {
          dispatch({
            type: 'EVENT',
            event: {
              type: 'error',
              data: { message: `Export failed: ${e?.message ?? e}`, recoverable: false },
            },
          });
        }
        return;
      }
      dispatch(action);
    },
    [
      dispatch,
      sessionManager,
      workspace,
      loadSessionById, // Intercept REVERT/FORK to store pending action before reducer closes panel
      dispatchSessionLoadInterceptor,
    ],
  );

  const runTaskBridge = React.useCallback((task: string) => {
    runTaskRef.current?.(task);
  }, []);

  const handleSlashCommand = useSlashCommand(
    dispatchSessionLoad,
    handleExit,
    mcpPromptRegistry,
    skillManifestsRef.current,
    skillOptionsRef.current ?? undefined,
    runTaskBridge,
    (preset) => {
      const p = preset.toLowerCase();
      if (p === 'teal' || p === 'blue' || p === 'purple' || p === 'cyan' || p === 'mono') {
        // No-op if already the active theme — avoids duplicate messages
        if (p === themePreset) return;
        setThemePreset(p);
        // OSC 4 reprograms terminal palette — existing Static content changes instantly, no clear needed
        process.stdout.write(osc4Apply(p));
        saveColorPreset(p);
        dispatchSessionLoad({ type: 'USER_MESSAGE', text: `/theme ${p}` });
        dispatchSessionLoad({
          type: 'EVENT',
          event: { type: 'text', data: { text: `  ⎿  Theme set to ${p}` } },
        });
      }
      // Invalid preset — silently ignored
    },
  );

  // Stable reference — avoids re-creating the object on every render and causing
  // an infinite re-render loop through useSlashSuggestions → setSlashSuggestion.
  const activeSelections = React.useMemo(
    () => ({
      theme: themePreset,
      model: state.status.modelName,
      interactionMode: state.interactionMode,
    }),
    [themePreset, state.status.modelName, state.interactionMode],
  );

  // When interrupt is cleared externally (ESC, Ctrl+C, etc.), cancel the pending promise
  React.useEffect(() => {
    const prev = prevInterruptRef.current;
    prevInterruptRef.current = state.interrupt;
    if (prev && !state.interrupt) {
      provider.submitAction({ type: 'cancel' });
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
    if (wasRunning && !state.running && !state.ctrlCPressed) {
      const rt = sessionManager.getRuntime(threadIdRef.current);
      rt?.abort();
    }
  }, [state.running, state.ctrlCPressed, sessionManager]);

  const runTask = React.useCallback(
    async (task: string) => {
      const threadId = threadIdRef.current;
      const rt = sessionManager.getRuntime(threadId);
      if (!rt || rt.agentLoopActive) return;

      // 将 React 层 per-session 状态同步到 Runtime / Sync React-layer per-session state to runtime
      rt.pendingSkills = [...pendingSkillsRef.current];
      rt.thinkingLevel = thinkingLevelRef.current;
      rt.interactionMode = interactionModeRef.current;
      rt.conversationHistory = [...conversationHistoryRef.current];

      dispatch({ type: 'USER_MESSAGE', text: task });
      dispatch({ type: 'SET_RUNNING' });
      dispatch({ type: 'DEACTIVATE_SKILL' }); // clear after capture into runtime

      // Update running state — agentLoopActive is managed by SessionRuntime.runTask internally
      sessionManager.onStatusChange(threadId);
      dispatch({ type: 'SET_SESSIONS', sessions: sessionManager.getSnapshot() });

      try {
        await rt.runTask(task, {
          dispatch,
          provider,
          config,
          model: injectModel,
        });
      } finally {
        // Only dispatch global state changes if this session is still active.
        // A background session that finished must not corrupt the foreground's running/interrupt state.
        const stillActive = threadIdRef.current === threadId;
        // Sync conversation history back from runtime so the next run preserves shell context
        if (stillActive) {
          conversationHistoryRef.current = [...rt.conversationHistory];
        }
        sessionManager.onStatusChange(threadId);
        dispatch({ type: 'SET_SESSIONS', sessions: sessionManager.getSnapshot() });
        if (stillActive) {
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
            const { generateSessionName, persistSessionName } = await import(
              '../../core/persistence/sessions.js'
            );
            const name = await generateSessionName(task);
            if (name && threadIdRef.current === threadId) {
              await persistSessionName(defaultCheckpointPath(), threadId, name);
              sessionManager.setName(threadId, name);
              dispatch({ type: 'SET_SESSIONS', sessions: sessionManager.getSnapshot() });
            }
          } catch {
            /* non-critical */
          }
        })();
      }
    },
    [provider, config, dispatch, sessionManager, injectModel],
  );
  // Keep ref in sync so slash-command bridge can invoke latest runTask
  runTaskRef.current = runTask;

  const handleInput = React.useCallback(
    (value: string) => {
      if (value.startsWith('/')) {
        handleSlashCommand(value);
        return;
      }

      // 检查当前活跃会话的运行状态，不阻塞其他会话
      const activeRt = sessionManager.getRuntime(threadIdRef.current);
      if (activeRt?.agentLoopActive) return;

      runTask(value);
    },
    [runTask, handleSlashCommand, sessionManager],
  );

  React.useEffect(() => {
    return () => {
      textBatcher.dispose();
      provider.teardown?.();
    };
  }, [provider, textBatcher]);

  return (
    <ThemeContext.Provider value={theme}>
      <App
        key={resizeKey}
        state={state}
        dispatch={dispatchSessionLoad}
        onToggleReason={onToggleReason}
        provider={provider}
        mcpManager={mcpManager ?? undefined}
        slashSuggestion={slashSuggestion}
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
          disabled={!!state.interrupt}
          workspace={workspace}
          overlayActive={
            state.showHelp ||
            state.showModelSelector ||
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
          activeSelections={activeSelections}
        />
      </App>
    </ThemeContext.Provider>
  );
}

if (import.meta.main) {
  // 在 Ink 初始化前禁用终端回显 + 隐藏光标 + 清屏
  // 否则 cooked-mode 下用户按键会被终端驱动回显到屏幕上，出现残留字符
  // Disable terminal echo + hide cursor + clear screen before Ink init,
  // otherwise keystrokes in cooked mode are echoed by the terminal driver
  function disableEchoAndClear() {
    try {
      // Unix: stty -echo disables terminal echo at the TTY level
      Bun.spawnSync(['stty', '-echo'], { stdio: ['inherit', 'inherit', 'inherit'] });
    } catch {
      // Windows / unsupported platforms: stty not available, skip
    }
    process.stdout.write('\x1b[?25l\x1b[2J\x1b[3J\x1b[H');
  }
  disableEchoAndClear();

  // Use Ink's built-in kittyKeyboard option instead of manual enableKittyKeyboardProtocol().
  // The manual approach enabled Kitty at the terminal level but Ink's parser didn't
  // know about it, causing arrow keys (CSI 1u/2u) to be mis-parsed as Enter.
  const { unmount } = render(
    <ErrorBoundary>
      <TuiBootstrap />
    </ErrorBoundary>,
    {
      maxFps: 60,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: 'enabled' },
      incrementalRendering: false,
    },
  );

  // Expose unmount so exit handlers inside the component tree can properly
  // tear down kitty keyboard protocol before terminating the process.
  _unmountForExit = unmount;

  process.on('SIGINT', () => {
    _sessionManagerForExit?.abortAll();
    _sessionManagerForExit?.dispose();
    unmount();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    _sessionManagerForExit?.abortAll();
    _sessionManagerForExit?.dispose();
    unmount();
    process.exit(0);
  });
}
