import packageJson from '../../package.json' with { type: 'json' };
import { createKiteInProcessAppControlComposition } from '../app-control';
import { createKiteTuiSessionManager } from '../bootstrap';
import { runKiteInternalMcpStdioChild } from '../bootstrap/mcp-stdio-composition';
import { createRuntimeOperationGate } from '../runtime-application';
import type { AppShellExecutor } from '../sandbox/composition';
import { runTui as runTuiClient, type TuiBootstrapProps } from './index';

export type KiteTuiProps = Omit<TuiBootstrapProps, 'createSessionManager'> & {
  readonly shellExecutor?: AppShellExecutor;
  readonly model?: import('@kite-ai/builtin-runtime/model').SupportedChatModel;
};

export function runTui(props: KiteTuiProps = {}): void {
  const appControl = createKiteInProcessAppControlComposition(createRuntimeOperationGate(), {
    ...(props.shellExecutor === undefined
      ? {}
      : { shellExecutorForWorkspace: () => props.shellExecutor! }),
  });
  runTuiClient({
    ...props,
    createSessionManager: (dependencies) => {
      const workspace = appControl.admitWorkspace(dependencies.workspace);
      const runtimeInputs = appControl.runtimeInputsFor(workspace);
      return createKiteTuiSessionManager(dependencies, {
        config: runtimeInputs.config,
        checkpointPath: runtimeInputs.checkpointPath,
        skillManifests: [...runtimeInputs.skillManifests],
        skillOptions: runtimeInputs.skillOptions,
        mcpManager: runtimeInputs.mcpManager,
        workspaceReady: runtimeInputs.workspaceReady,
        shellExecutor: runtimeInputs.shellExecutor,
        observabilityBridge: runtimeInputs.observabilityBridge,
        appControl,
        ...(props.model === undefined ? {} : { injectedModel: props.model }),
      });
    },
    appControlGateway: props.appControlGateway ?? appControl.gateway,
    credentialClient: appControl.credentialClient,
  });
}

if (import.meta.main) {
  if (runKiteInternalMcpStdioChild()) {
    // The private wrapper owns stdin/stdout until its authenticated terminal.
  } else if (process.argv.includes('--version')) {
    console.log(`Kite Code TUI ${packageJson.version}`);
  } else {
    runTui();
  }
}
