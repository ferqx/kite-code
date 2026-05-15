import React from "react";
import { render } from "ink";
import { loadAgentConfig } from "../../core/config/index";
import { createSandboxExecutor } from "../../core/sandbox/index";
import { runAgent } from "../../core/runner";
import { TuiUserInputProvider } from "./provider";
import App, { useTuiState } from "./App";
import InputLine from "./components/InputLine";
import StartupScreen from "./components/StartupScreen";
import { useSlashCommand } from "./hooks/useSlashCommand";

function TuiBootstrap() {
  const { state, dispatch, onToggleReason } = useTuiState();
  const workspace = process.cwd();
  const config = React.useMemo(() => loadAgentConfig(), []);
  const [initialized, setInitialized] = React.useState(false);
  const prevInterruptRef = React.useRef(state.interrupt);
  const conversationHistoryRef = React.useRef<string[]>([]);
  const threadIdRef = React.useRef<string>(`tui-${Date.now().toString(36)}`);
  const prevSessionKeyRef = React.useRef(state.sessionKey);
  const handleInputRef = React.useRef<(value: string) => void>(() => {});
  const agentLoopActiveRef = React.useRef(false);
  const abortControllerRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => setInitialized(true), 80);
    return () => clearTimeout(timer);
  }, []);

  // Reset conversation history and thread on new session
  React.useEffect(() => {
    if (state.sessionKey !== prevSessionKeyRef.current) {
      prevSessionKeyRef.current = state.sessionKey;
      conversationHistoryRef.current = [];
      threadIdRef.current = `tui-${Date.now().toString(36)}`;
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

  const handleSlashCommand = useSlashCommand(dispatch, handleExit);

  const provider = React.useMemo(
    () =>
      new TuiUserInputProvider((event) => {
        dispatch({ type: "EVENT", event });
      }),
    [dispatch]
  );

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

      // Build conversation context from history
      conversationHistoryRef.current.push(`User: ${task}`);
      const fullTask = conversationHistoryRef.current.join("\n");

      const shellExecutor = createSandboxExecutor({ enabled: true, workspace });

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      agentLoopActiveRef.current = true;

      const generator = runAgent(provider, {
        task: fullTask,
        userId: "tui-user",
        threadId: threadIdRef.current,
        workspace,
        checkpointPath: `${workspace}/.openpx/checkpoints.sqlite`,
        config,
        shellExecutor,
        signal: abortController.signal,
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
          data: { message: e?.message ?? String(e), recoverable: false },
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
      if (agentLoopActiveRef.current) return;

      if (value.startsWith("/")) {
        handleSlashCommand(value);
        return;
      }

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

  // Keep handleInput ref up to date for the editor effect
  React.useEffect(() => {
    handleInputRef.current = handleInput;
  }, [handleInput]);

  // Handle external editor: spawn $EDITOR, read content, submit as input
  React.useEffect(() => {
    if (!state.editorRequested) return;
    if (!process.env.EDITOR) {
      dispatch({ type: "EDITOR_DONE" });
      return;
    }

    let cancelled = false;
    const tmpFile = `${workspace}/.openpx/editor-input-${Date.now().toString(36)}.md`;

    import("node:fs").then(({ writeFileSync }) => {
      writeFileSync(tmpFile, "", "utf-8");
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
              // Submit content as user input on next tick
              setTimeout(() => {
                handleInputRef.current(content);
              }, 0);
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
    });

    return () => {
      cancelled = true;
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
    <App state={state} dispatch={dispatch} onToggleReason={onToggleReason} provider={provider}>
      <InputLine
        mode={state.interrupt?.kind === "approval" ? "approval" : state.interrupt?.kind === "input" ? "question" : "prompt"}
        onSubmit={handleInput}
        disabled={state.running}
        workspace={workspace}
      />
    </App>
  );
}

if (import.meta.main) {
  const { unmount } = render(<TuiBootstrap />);
  process.on("SIGINT", () => {
    unmount();
    process.exit(0);
  });
}
