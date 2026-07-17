import React, { useSyncExternalStore } from 'react';
import {
  DefaultMcpAuthCoordinator,
  DefaultMcpSupervisor,
  McpManager,
  type McpRuntimeProvider,
  MemoryMcpCredentialStore,
} from '@/core/mcp';
import { TuiMcpController } from '../mcp/controller';

export function useMcpController(
  runtimeProviderRef: React.MutableRefObject<McpRuntimeProvider | null>,
  sessionManager: {
    updateMcpRuntimeProvider(provider: McpRuntimeProvider | null): void;
    updateMcpRecoveryController(controller: TuiMcpController | null): void;
  },
  workspace: string,
) {
  const controller = React.useMemo(
    () => new TuiMcpController(createSupervisor(), workspace),
    [workspace],
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  React.useEffect(() => {
    const runtimeProvider = controller.getRuntimeProvider();
    runtimeProviderRef.current = runtimeProvider;
    sessionManager.updateMcpRuntimeProvider(runtimeProvider);
    sessionManager.updateMcpRecoveryController(controller);
    void controller.start();
    return () => {
      runtimeProviderRef.current = null;
      sessionManager.updateMcpRuntimeProvider(null);
      sessionManager.updateMcpRecoveryController(null);
      void controller.stop();
    };
  }, [controller, runtimeProviderRef, sessionManager]);

  const mcpPromptRegistry = React.useMemo(() => {
    const registry = new Map<
      string,
      {
        server: string;
        prompt: { name: string; description?: string; arguments?: readonly unknown[] };
      }
    >();
    for (const server of view.control.servers) {
      if (!server.effective || server.health === 'disconnected') continue;
      for (const prompt of server.prompts) {
        registry.set(`mcp__${server.key.name}__${prompt.name}`, {
          server: server.key.name,
          prompt,
        });
      }
    }
    return registry;
  }, [view.control.servers]);

  return { controller, mcpPromptRegistry, view };
}

function createSupervisor(): DefaultMcpSupervisor {
  if (process.env.NODE_ENV === 'test' && process.env.KITE_TEST_MCP_CREDENTIAL_STORE === 'memory') {
    const credentialStore = new MemoryMcpCredentialStore();
    return new DefaultMcpSupervisor({
      manager: new McpManager({ credentialStore }),
      authCoordinator: new DefaultMcpAuthCoordinator({ credentialStore }),
    });
  }
  return new DefaultMcpSupervisor();
}
