import { randomUUID } from 'node:crypto';
import React, { useSyncExternalStore } from 'react';
import type { AgentConfig } from '@/core/config';
import {
  createMcpTransportBoundaryIdentityV1,
  DefaultMcpAuthCoordinator,
  DefaultMcpSupervisor,
  type McpRuntimeProvider,
  McpTransportBoundaryErrorV1,
  MemoryMcpCredentialStore,
} from '@/core/mcp';
import { networkBoundaryPolicyFromExecutionBoundaryV1 } from '@/core/sandbox/network-policy';
import { TuiMcpController } from '../mcp/controller';

export function useMcpController(
  runtimeProviderRef: React.MutableRefObject<McpRuntimeProvider | null>,
  sessionManager: {
    updateMcpRuntimeProvider(provider: McpRuntimeProvider | null): void;
    updateMcpRecoveryController(controller: TuiMcpController | null): void;
  },
  workspace: string,
  config: AgentConfig,
) {
  const controller = React.useMemo(
    () => new TuiMcpController(createSupervisor(config, workspace), workspace),
    [config, workspace],
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

function createSupervisor(config: AgentConfig, workspace: string): DefaultMcpSupervisor {
  const transportBoundaryOptions = sealedTransportBoundaryOptions(config, workspace);
  if (process.env.NODE_ENV === 'test' && process.env.KITE_TEST_MCP_CREDENTIAL_STORE === 'memory') {
    const credentialStore = new MemoryMcpCredentialStore();
    return new DefaultMcpSupervisor({
      connectionManagerOptions: { credentialStore, ...transportBoundaryOptions },
      authCoordinator: new DefaultMcpAuthCoordinator({ credentialStore }),
    });
  }
  return new DefaultMcpSupervisor({ connectionManagerOptions: transportBoundaryOptions });
}

/** @qualification-default-off-guard-v1 {"entrypointId":"tui","flagId":"networkBoundaryV1","outcome":"legacy_fallback","sourceKind":"public_surface","symbol":"sealedTransportBoundaryOptions"} */
function sealedTransportBoundaryOptions(config: AgentConfig, workspace: string) {
  if (!config.executionBoundary) return {};
  const productionExecution = (
    config as AgentConfig & {
      productionExecution?: { qualificationId?: string };
    }
  ).productionExecution;
  if (!config.executionCapabilitySurface) {
    return {
      transportBoundaryRequired: true as const,
      ...(productionExecution ? { mcpWriteGovernanceRequired: true as const } : {}),
    };
  }
  const networkPolicy = networkBoundaryPolicyFromExecutionBoundaryV1(
    config.executionBoundary,
    config.features?.networkBoundaryV1 === true,
  );
  const identity = createMcpTransportBoundaryIdentityV1({
    workspaceRoot: workspace,
    executionBoundary: config.executionBoundary,
    executionSurface: config.executionCapabilitySurface,
    runIdentity: `tui-mcp-control:${randomUUID()}`,
    profileIdentity: productionExecution?.qualificationId ?? 'unqualified-profile',
    networkPolicyRevision: networkPolicy.revision,
  });
  return {
    transportBoundaryRequired: true as const,
    ...(productionExecution ? { mcpWriteGovernanceRequired: true as const } : {}),
    transportBoundary: {
      identity,
      async admit(): Promise<never> {
        throw new McpTransportBoundaryErrorV1(
          'boundary_unavailable',
          'TUI MCP transport admission receipts are unavailable for this sealed run.',
        );
      },
    },
  };
}
