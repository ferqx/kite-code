import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import React, { useSyncExternalStore } from 'react';
import { TuiMcpController } from '../mcp/controller';
export function useMcpController(client: KiteAppControlClient, workspace: KiteWorkspaceIdentity) {
  const controller = React.useMemo(
    () => new TuiMcpController(client, workspace),
    [client, workspace],
  );
  const subscribe = React.useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = React.useCallback(() => controller.getSnapshot(), [controller]);
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  React.useEffect(() => {
    void controller.start().catch(() => {
      // The presentation layer keeps the typed empty snapshot. A later
      // polling/explicit refresh can recover without constructing a local
      // Supervisor or falling back to Store state.
    });
    return () => {
      void controller.stop();
    };
  }, [controller]);

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
