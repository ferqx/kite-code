import React from "react";
import { render } from "ink";
import { loadAgentConfig } from "../../core/config/index";
import { createSandboxExecutor } from "../../core/sandbox/index";
import { runAgent } from "../../core/runner";
import { TuiUserInputProvider } from "./provider";
import App, { useTuiState } from "./App";

function TuiBootstrap() {
  const { state, dispatch, onToggleReason } = useTuiState();
  const providerRef = React.useRef<TuiUserInputProvider>(undefined!);

  React.useEffect(() => {
    const config = loadAgentConfig();
    const workspace = process.cwd();
    const shellExecutor = createSandboxExecutor({ enabled: true, workspace });
    const task = process.argv.slice(2).join(" ") || "No task provided";
    const threadId = `tui-${Date.now().toString(36)}`;
    const checkpointPath = `${workspace}/.openpx/checkpoints.sqlite`;

    const provider = new TuiUserInputProvider((event) => {
      dispatch({ type: "EVENT", event });
    });
    providerRef.current = provider;

    const generator = runAgent(provider, {
      task,
      userId: "tui-user",
      threadId,
      workspace,
      checkpointPath,
      config,
      shellExecutor,
    });

    (async () => {
      for await (const _ of generator) {
        /* driven by provider.onEvent */
      }
      dispatch({ type: "SET_EXITED" });
    })();

    return () => {
      provider.teardown?.();
    };
  }, []);

  return <App state={state} dispatch={dispatch} onToggleReason={onToggleReason} provider={providerRef.current} />;
}

if (import.meta.main) {
  render(<TuiBootstrap />);
}
