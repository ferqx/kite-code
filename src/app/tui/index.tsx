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

  React.useEffect(() => {
    const timer = setTimeout(() => setInitialized(true), 80);
    return () => clearTimeout(timer);
  }, []);

  const handleExit = React.useCallback(() => {
    process.exit(0);
  }, []);

  const handleSlashCommand = useSlashCommand(dispatch, handleExit);

  const provider = React.useMemo(
    () =>
      new TuiUserInputProvider((event) => {
        dispatch({ type: "EVENT", event });
      }),
    [dispatch]
  );

  const runTask = React.useCallback(
    async (task: string) => {
      dispatch({ type: "SET_RUNNING" });
      dispatch({ type: "CLEAR_INTERRUPT" });

      const shellExecutor = createSandboxExecutor({ enabled: true, workspace });
      const threadId = `tui-${Date.now().toString(36)}`;

      const generator = runAgent(provider, {
        task,
        userId: "tui-user",
        threadId,
        workspace,
        checkpointPath: `${workspace}/.openpx/checkpoints.sqlite`,
        config,
        shellExecutor,
      });

      let aborted = false;

      try {
        for await (const _ of generator) {
          if (aborted) break;
        }
        if (!aborted) dispatch({ type: "SET_EXITED" });
      } catch {
        dispatch({ type: "SET_EXITED" });
      } finally {
        provider.reset();
        dispatch({ type: "SET_IDLE" });
      }
    },
    [provider, workspace, config, dispatch]
  );

  const handleInput = React.useCallback(
    (value: string) => {
      if (state.running) return;

      if (value.startsWith("/")) {
        handleSlashCommand(value);
        return;
      }

      if (value.startsWith("!")) {
        runTask(value);
        return;
      }

      runTask(value);
    },
    [state.running, runTask, handleSlashCommand]
  );

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
