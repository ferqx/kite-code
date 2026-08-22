import { randomUUID } from 'node:crypto';
import {
  createMcpTransportAdmissionReceiptV1,
  createMcpTransportBoundaryIdentityV1,
  DefaultMcpSupervisor,
  type McpRuntimeProvider,
  type McpTransportAdmissionRequestV1,
  MemoryMcpCredentialStore,
} from '@kite/builtin-runtime/mcp';
import {
  createProtectedPathEvaluatorV1,
  networkBoundaryPolicyFromExecutionBoundaryV1,
} from '@kite/builtin-runtime/sandbox';
import React, { useSyncExternalStore } from 'react';
import { createInstalledMcpStdioProcessPortV1 } from '#app/bootstrap/mcp-stdio-composition';
import { type AgentConfig, DefaultMcpConfigRepository } from '#app/config';
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
  const localStdioOptions =
    config.executionBoundary && config.executionCapabilitySurface?.localStdioMcp === true
      ? {
          stdioProcessPort: createInstalledMcpStdioProcessPortV1(),
          protectedPathEvaluator: createProtectedPathEvaluatorV1({
            workspaceRoot: config.executionBoundary.workspaceRoot,
            mode: config.executionBoundary.protectedPathPolicy,
          }),
        }
      : {};
  const repository = new DefaultMcpConfigRepository();
  if (process.env.NODE_ENV === 'test' && process.env.KITE_TEST_MCP_CREDENTIAL_STORE === 'memory') {
    const credentialStore = new MemoryMcpCredentialStore();
    return new DefaultMcpSupervisor({
      repository,
      credentialStore,
      connectionManagerOptions: {
        ...transportBoundaryOptions,
        ...localStdioOptions,
      },
    });
  }
  return new DefaultMcpSupervisor({
    repository,
    connectionManagerOptions: { ...transportBoundaryOptions, ...localStdioOptions },
  });
}

function sealedTransportBoundaryOptions(config: AgentConfig, workspace: string) {
  // Remote HTTP keeps its independent TLS/OAuth + RAV1 egress authority when
  // no release execution boundary exists. Local stdio still has no Host
  // process port in this branch and therefore remains spawn=0/fail-closed.
  if (!config.executionBoundary) return { transportBoundaryRequired: false as const };
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
      async admit(request: McpTransportAdmissionRequestV1) {
        return createMcpTransportAdmissionReceiptV1(request);
      },
    },
  };
}
