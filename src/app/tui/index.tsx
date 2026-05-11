import React from "react";
import { render } from "ink";
import { loadAgentConfig } from "../../core/config/index";
import { createSandboxExecutor } from "../../core/sandbox/index";
import { runAgent } from "../../core/runner";
import { TuiUserInputProvider } from "./provider";
import App, { useTuiState } from "./App";

function TuiBootstrap() {
  const { state, dispatch, onToggleReason } = useTuiState();

  const provider = React.useMemo(
    () =>
      new TuiUserInputProvider((event) => {
        dispatch({ type: "EVENT", event });
      }),
    [dispatch]
  );

  React.useEffect(() => {
    const config = loadAgentConfig();
    const workspace = process.cwd();
    const shellExecutor = createSandboxExecutor({ enabled: true, workspace });
    const task = process.argv.slice(2).join(" ") || "No task provided";
    const threadId = `tui-${Date.now().toString(36)}`;
    const checkpointPath = `${workspace}/.openpx/checkpoints.sqlite`;

    const generator = runAgent(provider, {
      task,
      userId: "tui-user",
      threadId,
      workspace,
      checkpointPath,
      config,
      shellExecutor,
    });

    let aborted = false;

    (async () => {
      try {
        for await (const _ of generator) {
          if (aborted) break;
        }
        if (!aborted) dispatch({ type: "SET_EXITED" });
      } catch {
        dispatch({ type: "SET_EXITED" });
      }
    })();

    return () => {
      aborted = true;
      provider.teardown?.();
    };
  }, [provider]);

  return <App state={state} dispatch={dispatch} onToggleReason={onToggleReason} provider={provider} />;
}

if (import.meta.main) {
  const { unmount } = render(<TuiBootstrap />);
  process.on("SIGINT", () => {
    unmount();
    process.exit(0);
  });
}
