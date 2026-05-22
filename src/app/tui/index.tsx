import React from "react";
import { render } from "ink";
import { loadAgentConfig, editorInputPath, type AgentConfig } from "@/core/config/index";
import { createSandboxExecutor } from "@/core/sandbox/index";
import { runAgent, isRecoverableError } from "@/core/runner";
import { TuiUserInputProvider } from "./provider";
import App, { useTuiState, type Action } from "./App";
import InputLine, { type EditorContentHandle } from "./components/InputLine";
import StartupScreen from "./components/StartupScreen";
import ErrorBoundary from "./components/ErrorBoundary";
import { useSlashCommand } from "./hooks/useSlashCommand";
import { loadSession } from "../../core/persistence/sessions.js";
import { defaultCheckpointPath } from "../../core/config/paths.js";

function resolveModelForResume(
  currentConfig: AgentConfig,
  persistedModelName: string,
): string {
  return persistedModelName || currentConfig.modelName;
}

function TuiBootstrap() {
  const { state, dispatch, onToggleReason } = useTuiState();
  const workspace = process.cwd();
  const config = React.useMemo(() => loadAgentConfig(), []);
  const [initialized, setInitialized] = React.useState(false);
  const prevInterruptRef = React.useRef(state.interrupt);
  const conversationHistoryRef = React.useRef<string[]>([]);
  // Lazy init — only create thread when user sends first message
  const threadIdRef = React.useRef<string>("");
  const pendingSessionRef = React.useRef<string | null>(null);
  const editorContentRef = React.useRef<EditorContentHandle | null>(null);
  const thinkingLevelRef = React.useRef<string | null>(null);
  const prevSessionKeyRef = React.useRef(state.sessionKey);
  const agentLoopActiveRef = React.useRef(false);
  const abortControllerRef = React.useRef<AbortController | null>(null);

  const dispatchSessionLoad = React.useCallback(
    async (action: any) => {
      if (action.type === "LOAD_SESSION_PENDING") {
        const threadId = action.threadId;
        pendingSessionRef.current = threadId;
        try {
          const result = await loadSession(defaultCheckpointPath(), threadId);
          if (pendingSessionRef.current !== threadId) {
            pendingSessionRef.current = null;
            return;
          }
          if (!result) {
            pendingSessionRef.current = null;
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
          threadIdRef.current = threadId;
          conversationHistoryRef.current = [];

          dispatch({
            type: "LOAD_SESSION",
            blocks: result.blocks,
            interrupt: result.interrupt,
            modelProvider: result.modelProvider,
            modelName,
            thinkingLevel,
          });
        } catch (e: any) {
          dispatch({
            type: "LOAD_SESSION",
            blocks: [{ id: 1, kind: "text", content: `Failed to load session: ${e?.message ?? e}` }],
            interrupt: null,
            modelProvider: "",
            modelName: "",
            thinkingLevel: null,
          });
        }
        pendingSessionRef.current = null;
        return;
      }
      dispatch(action);
    },
    [dispatch, config],
  );

  React.useEffect(() => {
    const timer = setTimeout(() => setInitialized(true), 80);
    return () => clearTimeout(timer);
  }, []);

  // Reset conversation history and thread on new session
  React.useEffect(() => {
    if (state.sessionKey !== prevSessionKeyRef.current) {
      prevSessionKeyRef.current = state.sessionKey;
      conversationHistoryRef.current = [];
      threadIdRef.current = ""; // Lazy init on first message
      thinkingLevelRef.current = null;
    }
  }, [state.sessionKey]);

  // Exit when exitRequested flag is set (double Ctrl+C when not running)
  React.useEffect(() => {
    if (state.exitRequested) {
      process.exit(0);
    }
  }, [state.exitRequested]);

  // When Ctrl+C is pressed during agent loop (with no interrupt), abort via signal
  React.useEffect(() => {
    if (state.ctrlCPressed && agentLoopActiveRef.current && !state.interrupt) {
      abortControllerRef.current?.abort();
    }
  }, [state.ctrlCPressed, state.interrupt]);

  const handleExit = React.useCallback(() => {
    dispatch({ type: "EVENT", event: { type: "text", data: { text: "👋 Goodbye!" } } });
    setTimeout(() => process.exit(0), 300);
  }, [dispatch]);

  const provider = React.useMemo(
    () =>
      new TuiUserInputProvider((event) => {
        dispatch({ type: "EVENT", event });
      }),
    [dispatch]
  );

  const handleSlashCommand = useSlashCommand(dispatch, handleExit, () => {
    provider.compactRequested = true;
  });

  // When interrupt is cleared externally (ESC, Ctrl+C, etc.), cancel the pending promise
  React.useEffect(() => {
    const prev = prevInterruptRef.current;
    prevInterruptRef.current = state.interrupt;
    if (prev && !state.interrupt) {
      provider.submitAction({ type: "cancel" });
    }
  }, [state.interrupt, provider]);

  const runTask = React.useCallback(
    async (task: string) => {
      if (agentLoopActiveRef.current) return;

      dispatch({ type: "USER_MESSAGE", text: task });
      dispatch({ type: "SET_RUNNING" });

      // Lazy init thread ID on first message
      if (!threadIdRef.current) {
        threadIdRef.current = `tui-${Date.now().toString(36)}`;
      }

      // Each turn sends only the current message. The checkpoint maintains
      // the full conversation history — runAgent reads it automatically.
      // conversationHistoryRef accumulates shell command outputs for context.
      const shellContext = conversationHistoryRef.current.length > 0
        ? "\n" + conversationHistoryRef.current.join("\n")
        : "";
      const fullTask = task + shellContext;

      const shellExecutor = createSandboxExecutor({ enabled: true, workspace });

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      agentLoopActiveRef.current = true;

      const generator = runAgent(provider, {
        task: fullTask,
        userId: "tui-user",
        threadId: threadIdRef.current,
        workspace,
        checkpointPath: defaultCheckpointPath(),
        config,
        shellExecutor,
        signal: abortController.signal,
        thinkingLevel: thinkingLevelRef.current,
      });

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

        // Fire-and-forget: generate smart session name after first message
        const threadId = threadIdRef.current;
        const firstTask = task;
        (async () => {
          try {
            const { generateSessionName, persistSessionName } = await import("../../core/persistence/sessions.js");
            const name = await generateSessionName(firstTask);
            if (name) {
              await persistSessionName(defaultCheckpointPath(), threadId, name);
            }
          } catch { /* non-critical */ }
        })();
      }
    },
    [provider, workspace, config, dispatch]
  );

  // Execute !shell commands directly
  const runShell = React.useCallback(
    (command: string) => {
      import("node:child_process").then(({ execSync }) => {
        try {
          const cwd = process.cwd();
          const result = execSync(command, { cwd, timeout: 30000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
          const output = result.trim() || "(no output)";
          dispatch({ type: "EVENT", event: { type: "text", data: { text: `\`\`\`\n${output}\n\`\`\`` } } });
          // Add to conversation history for context
          conversationHistoryRef.current.push(`User (shell): ${command}\nResult:\n${output}`);
        } catch (err: any) {
          const errorMsg = err.stderr?.trim() || err.message || "command failed";
          dispatch({ type: "EVENT", event: { type: "text", data: { text: `✗ \`${command}\`\n\`\`\`\n${errorMsg}\n\`\`\`` } } });
        } finally {
          dispatch({ type: "SET_IDLE" });
        }
      });
    },
    [dispatch]
  );

  const handleInput = React.useCallback(
    (value: string) => {
      if (value.startsWith("/")) {
        handleSlashCommand(value);
        return;
      }

      if (agentLoopActiveRef.current) return;

      if (value.startsWith("!")) {
        const command = value.slice(1).trim();
        dispatch({ type: "USER_MESSAGE", text: value });
        runShell(command);
        return;
      }

      runTask(value);
    },
    [runTask, handleSlashCommand]
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
    <App state={state} dispatch={dispatchSessionLoad} onToggleReason={onToggleReason} provider={provider} onCompactRequest={() => { provider.compactRequested = true; }}>
      <InputLine
        mode={state.interrupt?.kind === "approval" ? "approval" : state.interrupt?.kind === "input" ? "question" : "prompt"}
        onSubmit={handleInput}
        disabled={!!state.interrupt}
        workspace={workspace}
        overlayActive={state.showHelp || state.showModelSelector || state.showSessions}
        editorContentRef={editorContentRef}
      />
    </App>
  );
}

function enableKittyKeyboardProtocol() {
  if (process.stdout.isTTY && process.stdin.isTTY) {
    // Enable Kitty keyboard protocol disambiguate mode so Shift+Enter
    // is reported as CSI 13;2 u instead of raw \r indistinguishable
    // from plain Enter. Ink's parseKeypress already handles CSI-u.
    process.stdout.write("\x1b[>1u");
  }
}

function disableKittyKeyboardProtocol() {
  if (process.stdout.isTTY && process.stdin.isTTY) {
    process.stdout.write("\x1b[<u");
  }
}

if (import.meta.main) {
  enableKittyKeyboardProtocol();
  // Disable Ink's built-in Ctrl+C exit (which only detects \x03, not
  // Kitty CSI-u). Instead, useGlobalKeys dispatches CTRL_C which the
  // reducer handles for both legacy \x03 and CSI-u 99;5 u formats.
  const { unmount } = render(<ErrorBoundary><TuiBootstrap /></ErrorBoundary>, { maxFps: 60, exitOnCtrlC: false });
  process.on("SIGINT", () => {
    disableKittyKeyboardProtocol();
    unmount();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    disableKittyKeyboardProtocol();
    unmount();
    process.exit(0);
  });
  process.on("exit", () => {
    disableKittyKeyboardProtocol();
  });
}
