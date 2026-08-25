import { digestCapabilityValue } from '@kite/builtin-runtime/capability';
import { capabilityChangedProviderError, type McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import type { CapabilityDescriptor } from '@kite/runtime-contract';
import type { RuntimeJsonValue } from '@kite/runtime-spi';
import {
  type ProviderReadinessCoordinator,
  ProviderReadinessPersistenceError,
} from '#app/bootstrap/runtime/provider-readiness';
import type { RuntimeEvent, RuntimeState } from '#app/bootstrap/runtime/state-runtime';
import type { AgentConfig } from '#app/config';
import { computeExecutionBoundaryDigest } from '#app/config';
import type { BuiltinMcpRuntimePort } from '#builtin-runtime';

/** Prepare the one Dynamic MCP mechanism before Host acknowledges the attempt. */
export async function prepareDynamicMcpMechanism(input: {
  readonly descriptor: Readonly<CapabilityDescriptor>;
  readonly manager: McpRuntimeProvider;
  readonly providerReadinessCoordinator?: ProviderReadinessCoordinator;
  readonly getRuntimeState?: () => Readonly<RuntimeState>;
  readonly persistRuntimeEvent?: (event: RuntimeEvent) => Promise<boolean>;
  readonly taskConfig?: AgentConfig;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  readonly workspace: string;
  readonly canonicalArguments: RuntimeJsonValue;
  readonly retryAuthorized?: boolean;
}) {
  if (!isPlainRecord(input.canonicalArguments)) {
    throw new Error('Dynamic MCP canonical arguments are not an object.');
  }
  const route = input.manager.getCapabilityRoute?.(input.descriptor.capabilityId);
  if (!input.providerReadinessCoordinator || !input.getRuntimeState || !input.persistRuntimeEvent) {
    throw new ProviderReadinessPersistenceError(
      'Provider readiness coordinator and StateRuntimeStorage acknowledgement are required.',
    );
  }
  const providerDirectoryRevision = input.manager.getProviderDirectorySnapshot().revision;
  const routeRevision =
    route?.endpointRevision ?? providerDirectoryRevision ?? 'provider-directory-unavailable';
  const executionBoundaryDigest = input.taskConfig?.executionBoundary
    ? computeExecutionBoundaryDigest(input.taskConfig.executionBoundary)
    : digestCapabilityValue({ schema: 'kite.unsealed-execution-boundary.v1' });
  await input.providerReadinessCoordinator.ensureReady(
    {
      providerId: input.descriptor.provider.id,
      routeRevision,
      executionBoundaryDigest,
      toolCallId: input.toolCallId,
      retryAuthorized: input.retryAuthorized === true,
      signal: input.signal,
    },
    { getState: input.getRuntimeState, persistEvent: input.persistRuntimeEvent },
  );
  const currentDescriptor = input.manager.findCapability(input.descriptor.capabilityId);
  if (!currentDescriptor || currentDescriptor.revision !== input.descriptor.revision) {
    throw capabilityChangedProviderError(input.descriptor.provider.id);
  }
  return Object.freeze({
    workspace: input.workspace,
    preassembledMechanism: Object.freeze({
      mcp: Object.freeze({
        runtime: input.manager as unknown as BuiltinMcpRuntimePort,
        invocation: Object.freeze({
          capabilityId: input.descriptor.capabilityId,
          expectedRevision: input.descriptor.revision,
        }),
      }),
    }),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
