import React from "react";
import { render } from "ink";
import { loadAgentConfig, loadTheme, type AgentConfig } from "@/core/config/index";
import { sessionExportPath } from "@/core/config/paths";
import { ThemeContext, darkTheme, lightTheme } from "./theme";
import { McpManager } from "@/core/mcp";
import { TuiUserInputProvider } from "./provider";
import App, { useTuiState, type Action } from "./App";
import { TextBatcher } from "./text-batcher";
import InputLine, { type EditorContentHandle, type SlashSuggestionData } from "./components/InputLine";
import StartupScreen from "./components/StartupScreen";
import ErrorBoundary from "./components/ErrorBoundary";
import { useSlashCommand } from "./hooks/useSlashCommand";
import { loadSession, listSessions, deleteSession } from "../../core/persistence/sessions.js";
import { defaultCheckpointPath } from "../../core/config/paths.js";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import { SessionManager } from "./session-manager";
import { useMcpConnection } from "./hooks/useMcpConnection";
import { useSkillsLoader } from "./hooks/useSkillsLoader";
import { useRewindCheckpoints, useRunRewind, type RewindDeps } from "./hooks/useRewindHandler";
import { useExternalEditor } from "./hooks/useExternalEditor";

/** 模块级引用，供退出时中止所有会话 / Module-level reference for aborting all sessions on exit */
let _sessionManagerForExit: SessionManager | null = null;

function resolveModelForResume(
  currentConfig: AgentConfig,
  persistedModelName: string,
): string {
  return persistedModelName || currentConfig.modelName;
}

export interface TuiBootstrapProps {
  /** 可选的自定义模型实例（用于测试注入）/ Optional custom model instance (for test injection) */
  model?: import("@/core/model/factory").SupportedChatModel;
}

export function TuiBootstrap({ model: injectModel }: TuiBootstrapProps = {}) {
  const workspace = process.cwd();
  const config = React.useMemo(() => loadAgentConfig(), []);
  const { state, dispatch, onToggleReason } = useTuiState(config.modelName);
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
  const theme = React.useMemo(() => (loadTheme(workspace) === "light" ? lightTheme : darkTheme), []);
  const [initialized, setInitialized] = React.useState(false);
  const prevInterruptRef = React.useRef(state.interrupt);
  const conversationHistoryRef = React.useRef<string[]>([]);
  // Lazy init — only create thread when user sends first message
  const threadIdRef = React.useRef<string>("");
  // Generation counter for session loads: a new LOAD_SESSION_PENDING increments this.
  // Each async handler captures its generation; if a newer load started, the old one
  // discards its result, preventing the first-to-resolve Promise from overwriting the
  // later-initiated load's state.
  const loadGenerationRef = React.useRef(0);
  const editorContentRef = React.useRef<EditorContentHandle | null>(null);
  const thinkingLevelRef = React.useRef<string | null>(null);
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
    []
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
      dispatch({ type: "SESSION_INTERRUPT_PENDING", threadId });
    });
    _sessionManagerForExit = mgr;
    return mgr;
  }, [config, provider]);

  React.useEffect(() => {
    const timer = setTimeout(() => setInitialized(true), 80);
    return () => clearTimeout(timer);
  }, []);

  // Reset conversation history and thread on new session
  React.useEffect(() => {
    if (state.sessionKey !== prevSessionKeyRef.current) {
      prevSessionKeyRef.current = state.sessionKey;
      conversationHistoryRef.current = [];
      threadIdRef.current = sessionManager.getActiveId();
      thinkingLevelRef.current = null;
    }
  }, [state.sessionKey]);

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
      process.exit(0);
    }
  }, [state.exitRequested, sessionManager]);

  // Rewind: checkpoint list + revert/fork execution
  useRewindCheckpoints(state, dispatch, threadIdRef);

  const rewindDeps: RewindDeps = React.useMemo(() => ({
    dispatch, provider, config, workspace, sessionManager,
    threadIdRef, loadGenerationRef, conversationHistoryRef,
    thinkingLevelRef, skillManifestsRef, skillOptionsRef, mcpManagerRef,
    agentLoopActiveRef, abortControllerRef,
  }), [dispatch, provider, config, workspace, sessionManager]);
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

  const handleExit = React.useCallback(() => {
    dispatch({ type: "EVENT", event: { type: "text", data: { text: "👋 Goodbye!" } } });
    sessionManager.abortAll();
    setTimeout(() => process.exit(0), 300);
  }, [dispatch, sessionManager]);

  // Load historical sessions from DB on startup, but always start fresh.
  React.useEffect(() => {
    if (!initialized) return;
    const checkpointPath = defaultCheckpointPath();
    listSessions(checkpointPath).then((dbSessions) => {
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

      dispatch({ type: "SET_SESSIONS", sessions: sessionManager.getSnapshot() });
    }).catch(() => {
      // DB may not exist yet (first run) — auto-create
      if (!sessionManager.getActiveId()) {
        const newId = sessionManager.createSession(workspace);
        threadIdRef.current = newId;
        dispatch({ type: "SET_SESSIONS", sessions: sessionManager.getSnapshot() });
      }
    });
  }, [initialized]);

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

      dispatch({ type: "LOAD_SESSION_PENDING", threadId });

      try {
        const result = await loadSession(defaultCheckpointPath(), threadId);
        // If a newer load was issued while this was loading, discard
        if (loadGenerationRef.current !== gen) return;
        if (!result) {
          dispatch({
            type: "LOAD_SESSION",
            threadId,
            blocks: [{ id: 1, kind: "text", content: `Session ${threadId} has no saved checkpoints.` }],
            interrupt: null,
            modelProvider: "",
            modelName: "",
            thinkingLevel: null,
          });
          return;
        }

        const modelName = resolveModelForResume(config, result.modelName);
        const thinkingLevel = result.thinkingLevel ?? "max";
        thinkingLevelRef.current = thinkingLevel;

        dispatch({
          type: "LOAD_SESSION",
          threadId,
          blocks: result.blocks,
          interrupt: result.interrupt,
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
          type: "LOAD_SESSION",
          threadId,
          blocks: [{ id: 1, kind: "text", content: `Failed to load session: ${e?.message ?? e}` }],
          interrupt: null,
          modelProvider: "",
          modelName: "",
          thinkingLevel: null,
        });
      }
    },
    [dispatch, config, sessionManager, workspace],
  );

  const dispatchSessionLoad = React.useCallback(
    async (action: Action) => {
      // Intercept NEW_SESSION to create runtime via SessionManager
      if (action.type === "NEW_SESSION") {
        // Supersede any in-flight LOAD_SESSION_PENDING
        loadGenerationRef.current++;
        const newId = sessionManager.createSession(workspace);
        threadIdRef.current = newId;
        // The reducer will use this threadId to create the snapshot
        dispatch({ type: "NEW_SESSION", threadId: newId });
        dispatch({ type: "SET_SESSIONS", sessions: sessionManager.getSnapshot() });
        return;
      }
      // ── LOAD_SESSION_PENDING：委托给 loadSessionById ──
      if (action.type === "LOAD_SESSION_PENDING") {
        await loadSessionById(action.threadId);
        return;
      }
      // Intercept REVERT/FORK to store pending action before reducer closes panel
      dispatchSessionLoadInterceptor(action);
      // ── 多会话：SWITCH_SESSION 拦截，缓冲回放 ──
      if (action.type === "SWITCH_SESSION") {
        const oldId = sessionManager.getActiveId();
        const newId = action.threadId;
        if (oldId === newId) {
          // Same session — no-op
          return;
        }

        // 持久化离开会话的 token 统计 / Persist outgoing session's token stats
        if (oldId) {
          sessionManager.saveTokenStats(oldId, stateRef.current.status);
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
          dispatch({ type: "SET_SESSIONS", sessions: sessionManager.getSnapshot() });
          for (const event of incomingRt.eventBuffer) {
            dispatch({ type: "EVENT", event });
          }
          incomingRt.eventBuffer = [];
          incomingRt.pendingInterrupt = false;
        }
        return;
      }
      // ── DELETE_SESSION：删除会话，从 DB 和 SessionManager 中移除 ──
      if (action.type === "DELETE_SESSION") {
        const { threadId } = action;
        // Don't delete the active session
        if (threadId === sessionManager.getActiveId()) {
          dispatch(action); // just close the selector
          return;
        }
        // Invalidate any in-flight loadSessionById for this threadId to prevent
        // stale load from restoring the deleted session.
        loadGenerationRef.current++;
        try {
          await deleteSession(defaultCheckpointPath(), threadId);
        } catch {
          // DB error — still remove from runtime list
        }
        // Remove from SessionManager and refresh snapshots
        sessionManager.removeRuntime(threadId);
        dispatch(action);
        dispatch({ type: "SET_SESSIONS", sessions: sessionManager.getSnapshot() });
        return;
      }
      // ── EXPORT_SESSION：执行文件写入（取代 reducer 内的 fire-and-forget）──
      if (action.type === "EXPORT_SESSION") {
        const s = stateRef.current;
        const now = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = sessionExportPath(now);
        const body = s.turns.flatMap(t => t.blocks)
          .map((b) => {
            if (b.kind === "user") return `**You:** ${b.content}`;
            if (b.kind === "text") return b.content;
            if (b.kind === "reason") return `> ${b.content}`;
            return "";
          })
          .filter(Boolean)
          .join("\n\n");
        const header = `# OpenPX Session Export\n\n> ${new Date().toLocaleString()}\n\n---\n\n`;
        try {
          const fs = await import("node:fs/promises");
          const { mkdirSync } = await import("node:fs");
          const dir = filename.split("/").slice(0, -1).join("/") || ".";
          mkdirSync(dir, { recursive: true });
          await fs.writeFile(filename, header + body, { encoding: "utf-8", mode: 0o600 });
          dispatch({ type: "EXPORT_SESSION_DONE", filename });
        } catch (e: any) {
          dispatch({ type: "EVENT", event: { type: "error", data: { message: `Export failed: ${e?.message ?? e}`, recoverable: false } } });
        }
        return;
      }
      dispatch(action);
    },
    [dispatch, config, sessionManager, workspace, loadSessionById],
  );

  const runTaskBridge = React.useCallback((task: string) => {
    runTaskRef.current?.(task);
  }, []);

  const handleSlashCommand = useSlashCommand(
    dispatch,
    handleExit,
    mcpPromptRegistry,
    skillManifestsRef.current,
    skillOptionsRef.current ?? undefined,
    runTaskBridge,
  );

  // When interrupt is cleared externally (ESC, Ctrl+C, etc.), cancel the pending promise
  React.useEffect(() => {
    const prev = prevInterruptRef.current;
    prevInterruptRef.current = state.interrupt;
    if (prev && !state.interrupt) {
      provider.submitAction({ type: "cancel" });
    }
  }, [state.interrupt, provider]);

  // When Ctrl+C is pressed during agent loop (with no interrupt), abort via signal
  React.useEffect(() => {
    if (state.ctrlCPressed && !state.interrupt) {
      const rt = sessionManager.getRuntime(threadIdRef.current);
      rt?.abortController?.abort();
    }
  }, [state.ctrlCPressed, state.interrupt, sessionManager]);

  const runTask = React.useCallback(
    async (task: string) => {
      const threadId = threadIdRef.current;
      const rt = sessionManager.getRuntime(threadId);
      if (!rt || rt.agentLoopActive) return;

      // 将 React 层 per-session 状态同步到 Runtime / Sync React-layer per-session state to runtime
      rt.pendingSkills = [...pendingSkillsRef.current];
      rt.thinkingLevel = thinkingLevelRef.current;
      rt.conversationHistory = [...conversationHistoryRef.current];

      dispatch({ type: "USER_MESSAGE", text: task });
      dispatch({ type: "SET_RUNNING" });
      dispatch({ type: "DEACTIVATE_SKILL" }); // clear after capture into runtime

      // Update running state — agentLoopActive is managed by SessionRuntime.runTask internally
      sessionManager.onStatusChange(threadId);
      dispatch({ type: "SET_SESSIONS", sessions: sessionManager.getSnapshot() });

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
        dispatch({ type: "SET_SESSIONS", sessions: sessionManager.getSnapshot() });
        // 持久化 token 统计 / Persist token stats
        sessionManager.saveTokenStats(threadId, stateRef.current.status);
        if (stillActive) {
          dispatch({ type: "SET_IDLE" });
        }

        // Fire-and-forget: generate smart session name once after first message
        // Guard: only if the session is still active to prevent cross-session writes.
        (async () => {
          try {
            // Only generate if not already named (name still equals threadId)
            if (rt.name !== threadId) return;
            const stillActive = threadIdRef.current === threadId;
            if (!stillActive) return;
            const { generateSessionName, persistSessionName } = await import("../../core/persistence/sessions.js");
            const name = await generateSessionName(task);
            if (name && threadIdRef.current === threadId) {
              await persistSessionName(defaultCheckpointPath(), threadId, name);
              sessionManager.setName(threadId, name);
              dispatch({ type: "SET_SESSIONS", sessions: sessionManager.getSnapshot() });
            }
          } catch { /* non-critical */ }
        })();
      }
    },
    [provider, workspace, config, dispatch, sessionManager],
  );
  // Keep ref in sync so slash-command bridge can invoke latest runTask
  runTaskRef.current = runTask;


  const handleInput = React.useCallback(
    (value: string) => {
      if (value.startsWith("/")) {
        handleSlashCommand(value);
        return;
      }

      // 检查当前活跃会话的运行状态，不阻塞其他会话
      const activeRt = sessionManager.getRuntime(threadIdRef.current);
      if (activeRt?.agentLoopActive) return;

      runTask(value);
    },
    [runTask, handleSlashCommand, sessionManager]
  );

  // External editor: spawn $EDITOR, read content, submit as input
  useExternalEditor(state, workspace, dispatch, editorContentRef);

  React.useEffect(() => {
    return () => {
      textBatcher.dispose();
      provider.teardown?.();
    };
  }, [provider, textBatcher]);

  if (!initialized) {
    return <StartupScreen modelName={config.modelName} workspace={workspace} />;
  }

  return (
    <ThemeContext.Provider value={theme}>
    <App state={state} dispatch={dispatchSessionLoad} onToggleReason={onToggleReason} provider={provider} mcpManager={mcpManager ?? undefined} slashSuggestion={slashSuggestion}>
      <InputLine
        key={state.activeSessionId}
        mode={state.interrupt?.kind === "approval" ? "approval" : state.interrupt?.kind === "input" ? "question" : "prompt"}
        onSubmit={handleInput}
        disabled={!!state.interrupt}
        workspace={workspace}
        overlayActive={state.showHelp || state.showModelSelector || state.showSessions || state.showMcp || state.showRewind || !!state.interrupt}
        editorContentRef={editorContentRef}
        onSlashSuggestionChange={setSlashSuggestion}
      />
    </App>
    </ThemeContext.Provider>
  );
}

if (import.meta.main) {
  // Use Ink's built-in kittyKeyboard option instead of manual enableKittyKeyboardProtocol().
  // The manual approach enabled Kitty at the terminal level but Ink's parser didn't
  // know about it, causing arrow keys (CSI 1u/2u) to be mis-parsed as Enter.
  const { unmount } = render(<ErrorBoundary><TuiBootstrap /></ErrorBoundary>, {
    maxFps: 60,
    exitOnCtrlC: false,
    kittyKeyboard: { mode: 'enabled' },
    incrementalRendering: false,
  });
  process.on("SIGINT", () => {
    _sessionManagerForExit?.abortAll();
    unmount();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    _sessionManagerForExit?.abortAll();
    unmount();
    process.exit(0);
  });
}
