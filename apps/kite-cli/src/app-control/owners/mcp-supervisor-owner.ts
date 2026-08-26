import { randomUUID } from 'node:crypto';
import {
  createMcpTransportAdmissionReceipt,
  createMcpTransportBoundaryIdentity,
  DefaultMcpSupervisor,
  type McpTransportAdmissionRequest,
  MemoryMcpCredentialStore,
} from '@kite-ai/builtin-runtime/mcp';
import {
  createProtectedPathEvaluator,
  networkBoundaryPolicyFromExecutionBoundary,
} from '@kite-ai/builtin-runtime/sandbox';
import { createInstalledMcpStdioProcessPort } from '#kite-cli/bootstrap/mcp-stdio-composition';
import { type AgentConfig, DefaultMcpConfigRepository, getFeatureFlags } from '#kite-cli/config';

type McpExecutionConfig = Pick<
  AgentConfig,
  'executionBoundary' | 'executionCapabilitySurface' | 'features'
> & {
  readonly productionExecution?: { readonly qualificationId?: string };
};

/** Runtime Workspace composition; never imported by the TUI presentation layer. */
export function createWorkspaceMcpSupervisor(
  workspace: string,
  config: McpExecutionConfig = {},
): DefaultMcpSupervisor {
  const transportBoundaryOptions = sealedTransportBoundaryOptions(config, workspace);
  const localStdioOptions =
    config.executionBoundary && config.executionCapabilitySurface?.localStdioMcp === true
      ? {
          stdioProcessPort: createInstalledMcpStdioProcessPort(),
          protectedPathEvaluator: createProtectedPathEvaluator({
            workspaceRoot: config.executionBoundary.workspaceRoot,
            mode: config.executionBoundary.protectedPathPolicy,
          }),
        }
      : {};
  const repository = new DefaultMcpConfigRepository();
  if (process.env.NODE_ENV === 'test' && process.env.KITE_TEST_MCP_CREDENTIAL_STORE === 'memory') {
    return new DefaultMcpSupervisor({
      repository,
      credentialStore: new MemoryMcpCredentialStore(),
      connectionManagerOptions: { ...transportBoundaryOptions, ...localStdioOptions },
    });
  }
  return new DefaultMcpSupervisor({
    repository,
    connectionManagerOptions: { ...transportBoundaryOptions, ...localStdioOptions },
  });
}

function sealedTransportBoundaryOptions(config: McpExecutionConfig, workspace: string) {
  if (!config.executionBoundary) return { transportBoundaryRequired: false as const };
  if (!config.executionCapabilitySurface) {
    return {
      transportBoundaryRequired: true as const,
      ...(config.productionExecution ? { mcpWriteGovernanceRequired: true as const } : {}),
    };
  }
  const networkPolicy = networkBoundaryPolicyFromExecutionBoundary(
    config.executionBoundary,
    getFeatureFlags(config).networkBoundary === true,
  );
  const identity = createMcpTransportBoundaryIdentity({
    workspaceRoot: workspace,
    executionBoundary: config.executionBoundary,
    executionSurface: config.executionCapabilitySurface,
    runIdentity: `service-mcp-control:${randomUUID()}`,
    profileIdentity: config.productionExecution?.qualificationId ?? 'unqualified-profile',
    networkPolicyRevision: networkPolicy.revision,
  });
  return {
    transportBoundaryRequired: true as const,
    ...(config.productionExecution ? { mcpWriteGovernanceRequired: true as const } : {}),
    transportBoundary: {
      identity,
      async admit(request: McpTransportAdmissionRequest) {
        return createMcpTransportAdmissionReceipt(request);
      },
    },
  };
}
