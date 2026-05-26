import React from "react";
import { render } from "ink";
import { loadAgentConfig, loadMcpConfig, editorInputPath, type AgentConfig } from "@/core/config/index";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";
import { defaultConfigPath } from "@/core/config/paths";
import { ThemeContext, darkTheme, lightTheme } from "./theme";
import { McpManager } from "@/core/mcp";
import { createSandboxExecutor } from "@/core/sandbox/index";
import { isRecoverableError, revertToCheckpoint, forkFromCheckpoint } from "@/core/runner";
import { buildRevertParams, buildForkParams } from "./run-agent";
import { TuiUserInputProvider } from "./provider";
import App, { useTuiState, type Action } from "./App";
import InputLine, { type EditorContentHandle } from "./components/InputLine";
import StartupScreen from "./components/StartupScreen";
import ErrorBoundary from "./components/ErrorBoundary";
import { useSlashCommand } from "./hooks/useSlashCommand";
import { loadSession, listSessions, deleteSession } from "../../core/persistence/sessions.js";
import { defaultCheckpointPath } from "../../core/config/paths.js";
import { BunSqliteSaver } from "../../core/persistence/checkpoint.js";
import { scanSkills, getSkillContent } from "@/core/skills/loader";
import { skillDirs } from "@/core/config/paths";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import { SessionManager } from "./session-manager";

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
  const { state, dispatch, onToggleReason } = useTuiState();
  const workspace = process.cwd();
  const config = React.useMemo(() => loadAgentConfig(), []);
  const theme = React.useMemo(() => {
    try {
      const configPath = defaultConfigPath();
      if (existsSync(configPath)) {
        const raw = readFileSync(configPath, "utf8");
        const parsed = parseJsonc(raw) as Record<string, unknown>;
        if (parsed.theme === "light") return lightTheme;
      }
    } catch { /* use default */ }
    return darkTheme;
  }, []);
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
  const pendingRewindRef = React.useRef<{ type: "revert"; checkpointId: string } | { type: "fork"; checkpointId: string } | null>(null);
  const mcpManagerRef = React.useRef<McpManager | null>(null);
  const [mcpManager, setMcpManager] = React.useState<McpManager | null>(null);
  const [mcpPromptRegistry, setMcpPromptRegistry] = React.useState<
    Map<string, { server: string; prompt: { name: string; description?: string } }> | undefined
  >(undefined);
  const skillManifestsRef = React.useRef<SkillManifest[]>([]);
  const skillOptionsRef = React.useRef<SkillScanOptions | null>(null);
  const pendingSkillsRef = React.useRef<string[]>([]);
  const runTaskRef = React.useRef<(task: string) => Promise<void>>(async () => {});

  const provider = React.useMemo(
    () =>
      new TuiUserInputProvider((event) => {
        dispatch({ type: "EVENT", event });
      }),
    [dispatch]
  );

  const sessionManager = React.useMemo(() => {
    const mgr = new SessionManager({
      config,
      provider,
      skillManifests: skillManifestsRef.current,
      skillOptions: skillOptionsRef.current,
      mcpManager: mcpManagerRef.current,
    });
    mgr.setSnapshotCallback((threadId) => {
      dispatch({ type: "SESSION_INTERRUPT_PENDING", threadId });
    });
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
      pendingRewindRef.current = null;
      prevRewindCounterRef.current = 0;
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
      process.exit(0);
    }
  }, [state.exitRequested]);

  // Load checkpoint list when Rewind panel is opened
  React.useEffect(() => {
    if (!state.showRewind || !threadIdRef.current) return;

    let disposed = false;
    const checkpointPath = defaultCheckpointPath();
    const saver = new BunSqliteSaver(checkpointPath);
    try {
      saver.listCheckpoints(threadIdRef.current).then((cps) => {
        if (disposed) return;
        dispatch({ type: "SET_CHECKPOINTS", checkpoints: cps });
      }).catch(() => {
        if (disposed) return;
        dispatch({ type: "SET_CHECKPOINTS", checkpoints: [] });
      }).finally(() => {
        saver.close();
      });
    } catch {
      dispatch({ type: "SET_CHECKPOINTS", checkpoints: [] });
      saver.close();
    }
    return () => {
      disposed = true;
      try { saver.close(); } catch { /* already closed */ }
    };
  }, [state.showRewind, dispatch]);

  // Execute revert/fork when triggered by CheckpointSelector
  const prevRewindCounterRef = React.useRef(0);
  const runRewindRef = React.useRef<((type: "revert" | "fork", checkpointId: string) => void) | null>(null);
  React.useEffect(() => {
    if (state.rewindCounter === prevRewindCounterRef.current) return;
    prevRewindCounterRef.current = state.rewindCounter;
    if (state.rewindCounter === 0) return;

    const pending = pendingRewindRef.current;
    pendingRewindRef.current = null;
    if (!pending) return;

    runRewindRef.current?.(pending.type, pending.checkpointId);
  }, [state.rewindCounter]);

  // MCP Manager lifecycle: create, connect, disconnect on unmount
  React.useEffect(() => {
    const mcpConfig = loadMcpConfig();
    const manager = new McpManager();
    mcpManagerRef.current = manager;
    setMcpManager(manager);
    sessionManager.updateMcpManager(manager);
    // Connect and update prompt registry when ready
    manager.connectAll(mcpConfig.servers).then(() => {
      setMcpPromptRegistry(new Map(manager.getPromptRegistry()));
    }).catch((err) => {
      console.error("[MCP] Failed to connect servers:", err);
    });
    return () => {
      manager.disconnectAll().catch((err) => {
        console.error("[MCP] Failed to disconnect servers:", err);
      });
      mcpManagerRef.current = null;
      setMcpManager(null);
      setMcpPromptRegistry(undefined);
    };
  }, []);

  // Skills loader: scan on mount
  React.useEffect(() => {
    const opts = skillDirs(workspace);
    skillOptionsRef.current = opts;
    const manifests = scanSkills(opts);
    skillManifestsRef.current = manifests;
    dispatch({ type: "SET_SKILL_MANIFESTS", manifests });
    sessionManager.updateSkillManifests(manifests);
  }, [workspace, dispatch]);

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
    setTimeout(() => process.exit(0), 300);
  }, [dispatch]);

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

  const dispatchSessionLoad = React.useCallback(
    async (action: any) => {
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
      // ── existing intercepts for LOAD_SESSION_PENDING, REVERT, FORK ──
      if (action.type === "LOAD_SESSION_PENDING") {
        const threadId = action.threadId;
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

        try {
          const result = await loadSession(defaultCheckpointPath(), threadId);
          // If a newer LOAD_SESSION_PENDING was issued while this was loading, discard
          if (loadGenerationRef.current !== gen) return;
          if (!result) {
            dispatch({
              type: "LOAD_SESSION",
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
            blocks: [{ id: 1, kind: "text", content: `Failed to load session: ${e?.message ?? e}` }],
            interrupt: null,
            modelProvider: "",
            modelName: "",
            thinkingLevel: null,
          });
        }
        return;
      }
      // Intercept REVERT/FORK to store pending action before reducer closes panel
      if (action.type === "REVERT_TO_CHECKPOINT") {
        pendingRewindRef.current = { type: "revert", checkpointId: action.checkpointId };
      } else if (action.type === "FORK_FROM_CHECKPOINT") {
        pendingRewindRef.current = { type: "fork", checkpointId: action.checkpointId };
      }
      // ── 多会话：SWITCH_SESSION 拦截，缓冲回放 ──
      if (action.type === "SWITCH_SESSION") {
        const oldId = sessionManager.getActiveId();
        const newId = action.threadId;
        if (oldId === newId) {
          // Same session — no-op
          return;
        }

        const incomingRt = sessionManager.getRuntime(newId);

        // Dormant session (loaded from DB, state not yet hydrated): load full state
        if (incomingRt?.dormant) {
          dispatch({ type: "LOAD_SESSION_PENDING", threadId: newId });
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
      dispatch(action);
    },
    [dispatch, config, sessionManager, workspace],
  );

  const runTaskBridge = React.useCallback((task: string) => {
    runTaskRef.current?.(task);
  }, []);

  const handleSlashCommand = useSlashCommand(
    dispatch,
    handleExit,
    () => { provider.compactRequested = true; },
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
        sessionManager.onStatusChange(threadId);
        dispatch({ type: "SET_SESSIONS", sessions: sessionManager.getSnapshot() });
        if (stillActive) {
          dispatch({ type: "SET_IDLE" });
        }

        // Fire-and-forget: generate smart session name once after first message
        (async () => {
          try {
            // Only generate if not already named (name still equals threadId)
            if (rt.name !== threadId) return;
            const { generateSessionName, persistSessionName } = await import("../../core/persistence/sessions.js");
            const name = await generateSessionName(task);
            if (name) {
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

  // Execute revert/fork when user selects from /rewind panel
  const runRewind = React.useCallback(
    async (type: "revert" | "fork", checkpointId: string) => {
      if (agentLoopActiveRef.current) return;

      dispatch({ type: "SET_RUNNING" });

      const threadId = threadIdRef.current;
      if (!threadId) {
        provider.onEvent({
          type: "error",
          data: { message: "No active session. Start a conversation first.", recoverable: false },
        });
        dispatch({ type: "SET_EXITED" });
        dispatch({ type: "SET_IDLE" });
        return;
      }

      const shellExecutor = createSandboxExecutor({ enabled: true, workspace });

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      agentLoopActiveRef.current = true;

      const baseRewindParams = {
        threadId,
        workspace,
        config,
        shellExecutor,
        signal: abortController.signal,
        thinkingLevel: thinkingLevelRef.current,
        skills: skillManifestsRef.current,
        skillOptions: skillOptionsRef.current,
        mcpManager: mcpManagerRef.current,
      };

      let generator: AsyncGenerator<any>;
      if (type === "revert") {
        generator = revertToCheckpoint(provider, buildRevertParams({
          ...baseRewindParams,
          checkpointId,
        }));
      } else {
        const newThreadId = `tui-${Date.now().toString(36)}`;
        threadIdRef.current = newThreadId;
        // FORK 创建新会话，注册到 SessionManager
        const forkedRt = sessionManager.registerSession(newThreadId, workspace);
        forkedRt.thinkingLevel = thinkingLevelRef.current;
        forkedRt.conversationHistory = [...conversationHistoryRef.current];
        sessionManager.onStatusChange(newThreadId);
        // 先同步 SessionSnapshot 到 state.sessions，再切换，避免 reducer 中 target 找不到新会话
        dispatch({ type: "SET_SESSIONS", sessions: sessionManager.getSnapshot() });
        // 切换到分叉的新会话，后续 generator 事件写入正确的 activeSession
        dispatch({ type: "SWITCH_SESSION", threadId: newThreadId });
        generator = forkFromCheckpoint(provider, buildForkParams({
          ...baseRewindParams,
          oldThreadId: threadId,
          checkpointId,
          newThreadId,
        }));
      }

      let aborted = false;
      try {
        for await (const _ of generator) {
          if (abortController.signal.aborted) {
            aborted = true;
            break;
          }
        }
        if (!aborted) dispatch({ type: "SET_EXITED" });
      } catch (e: any) {
        provider.onEvent({
          type: "error",
          data: { message: e?.message ?? String(e), recoverable: isRecoverableError(e) },
        });
        dispatch({ type: "SET_EXITED" });
      } finally {
        abortControllerRef.current = null;
        agentLoopActiveRef.current = false;
        provider.reset();
        dispatch({ type: "SET_IDLE" });
      }
    },
    [provider, workspace, config, dispatch]
  );
  runRewindRef.current = runRewind;

  // Execute !shell commands directly
  const runShell = React.useCallback(
    (command: string) => {
      import("node:child_process").then(({ execSync }) => {
        try {
          const cwd = process.cwd();
          const result = execSync(command, { cwd, timeout: 30000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
          const output = result.trim() || "(no output)";
          dispatch({ type: "EVENT", event: { type: "text", data: { text: `\`\`\`\n${output}\n\`\`\`` } } });
          // 写入当前会话 runtime 和 ref，两者必须同步，否则下一次 runTask 会
          // 用 ref 中的旧值覆盖 runtime 的历史
          const entry = `User (shell): ${command}\nResult:\n${output}`;
          const rt = sessionManager.getRuntime(threadIdRef.current);
          if (rt) {
            rt.conversationHistory.push(entry);
          }
          conversationHistoryRef.current.push(entry);
        } catch (err: any) {
          const errorMsg = err.stderr?.trim() || err.message || "command failed";
          dispatch({ type: "EVENT", event: { type: "text", data: { text: `✗ \`${command}\`\n\`\`\`\n${errorMsg}\n\`\`\`` } } });
        } finally {
          dispatch({ type: "SET_IDLE" });
        }
      });
    },
    [dispatch, sessionManager]
  );

  const handleInput = React.useCallback(
    (value: string) => {
      if (value.startsWith("/")) {
        handleSlashCommand(value);
        return;
      }

      // 检查当前活跃会话的运行状态，不阻塞其他会话
      const activeRt = sessionManager.getRuntime(threadIdRef.current);
      if (activeRt?.agentLoopActive) return;

      if (value.startsWith("!")) {
        const command = value.slice(1).trim();
        dispatch({ type: "USER_MESSAGE", text: value });
        runShell(command);
        return;
      }

      runTask(value);
    },
    [runTask, handleSlashCommand, sessionManager]
  );

  // Handle external editor: spawn $EDITOR, read content, submit as input
  React.useEffect(() => {
    if (!state.editorRequested) return;
    if (!process.env.EDITOR) {
      dispatch({ type: "EDITOR_DONE" });
      return;
    }

    let cancelled = false;
    const tmpFile = editorInputPath(Date.now().toString(36));

    import("node:fs").then(({ writeFileSync }) => {
      const content = editorContentRef.current?.getContent() ?? "";
      writeFileSync(tmpFile, content, "utf-8");
    }).then(() =>
      import("node:child_process")
    ).then(({ spawn }) => {
      const proc = spawn(process.env.EDITOR!, [tmpFile], { stdio: "inherit", shell: true });
      proc.on("exit", () => {
        if (cancelled) return;
        import("node:fs").then(({ readFileSync, unlinkSync }) => {
          try {
            const content = readFileSync(tmpFile, "utf-8").trim();
            unlinkSync(tmpFile);
            if (content) {
              // Large content → placeholder in input; small → auto-submit
              editorContentRef.current?.handleEditorResult(content);
            }
          } catch {
            /* file may not exist */
          }
          dispatch({ type: "EDITOR_DONE" });
        });
      });
      proc.on("error", () => {
        if (!cancelled) dispatch({ type: "EDITOR_DONE" });
      });
    }).catch(() => {
      if (!cancelled) dispatch({ type: "EDITOR_DONE" });
    });

    return () => {
      cancelled = true;
      import("node:fs").then(({ unlinkSync }) => {
        try { unlinkSync(tmpFile); } catch {}
      }).catch(() => {});
    };
  }, [state.editorRequested, workspace, dispatch]);

  React.useEffect(() => {
    return () => {
      provider.teardown?.();
    };
  }, [provider]);

  if (!initialized) {
    return <StartupScreen modelName={config.modelName ?? "deepseek-v4"} workspace={workspace} />;
  }

  return (
    <ThemeContext.Provider value={theme}>
    <App state={state} dispatch={dispatchSessionLoad} onToggleReason={onToggleReason} provider={provider} onCompactRequest={() => { provider.compactRequested = true; }} mcpManager={mcpManager ?? undefined}>
      <InputLine
        key={state.activeSessionId}
        mode={state.interrupt?.kind === "approval" ? "approval" : state.interrupt?.kind === "input" ? "question" : "prompt"}
        onSubmit={handleInput}
        disabled={!!state.interrupt}
        workspace={workspace}
        overlayActive={state.showHelp || state.showModelSelector || state.showSessions}
        editorContentRef={editorContentRef}
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
  });
  process.on("SIGINT", () => {
    unmount();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    unmount();
    process.exit(0);
  });
}
