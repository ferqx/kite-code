import {
  BuiltinMcpExecutionUnknownErrorV1,
  type BuiltinMcpRuntimePortV1,
} from '@kite/builtin-runtime';
import {
  McpProviderError,
  type McpProviderFailureKind,
  type McpProviderRecoveryAction,
} from '@kite/builtin-runtime/mcp';
import {
  type ProviderReadinessCoordinatorV1,
  ProviderReadinessPersistenceError,
  type ProviderReadinessPersistenceV1,
  ProviderReadinessUnavailableError,
  ProviderReadinessUnknownError,
} from './provider-readiness';
import type { RuntimeState } from './state-runtime';

export const APP_MCP_READINESS_RUNTIME_SCHEMA_V1 = 'kite.app-mcp-readiness-runtime.v1' as const;

export interface CreateAppMcpReadinessRuntimeInputV1 {
  /** The one MCP manager captured by the App composition root. */
  readonly runtime: BuiltinMcpRuntimePortV1;
  readonly readinessCoordinator?: ProviderReadinessCoordinatorV1;
  readonly getState?: () => Readonly<RuntimeState>;
  readonly persistEvent?: ProviderReadinessPersistenceV1['persistEvent'];
  readonly toolCallId: string;
  readonly executionBoundaryDigest: string;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}

/**
 * App-only readiness wrapper for the Builtin read_mcp_resource operation.
 * It owns no MCP schema, result, registry, or retry authority: after one
 * exact State readiness receipt it delegates to the same injected manager.
 */
export function createAppMcpReadinessRuntimeV1(
  input: Readonly<CreateAppMcpReadinessRuntimeInputV1>,
): BuiltinMcpRuntimePortV1 {
  assertCompositionInputV1(input);
  const runtime = input.runtime;

  return Object.freeze({
    getCapabilitySnapshot: () => runtime.getCapabilitySnapshot(),
    getProviderDirectorySnapshot: () => runtime.getProviderDirectorySnapshot(),
    getResourceDirectorySnapshot: () => runtime.getResourceDirectorySnapshot(),
    findCapability: (capabilityId: string) => runtime.findCapability(capabilityId),
    callCapability: (invocation: unknown) => runtime.callCapability(invocation),
    readResource: async (
      serverName: string,
      uri: string,
      signal?: AbortSignal,
      transportBoundary?: unknown,
    ): Promise<string> => {
      const coordinator = input.readinessCoordinator;
      const getState = input.getState;
      const persistEvent = input.persistEvent;
      if (!coordinator || !getState || !persistEvent) {
        throw new ProviderReadinessPersistenceError(
          'Provider readiness coordinator and State persistence are required.',
        );
      }
      const routeRevision = providerDirectoryRevisionV1(runtime);
      const effectiveSignal = signal ?? input.signal;
      let receipt: Awaited<ReturnType<ProviderReadinessCoordinatorV1['ensureReady']>>;
      try {
        receipt = await coordinator.ensureReady(
          {
            providerId: serverName,
            routeRevision,
            executionBoundaryDigest: input.executionBoundaryDigest,
            toolCallId: input.toolCallId,
            signal: effectiveSignal,
          },
          { getState, persistEvent },
        );
      } catch (error) {
        if (error instanceof ProviderReadinessUnavailableError) {
          throw providerErrorFromUnavailableV1(serverName, error);
        }
        if (
          error instanceof ProviderReadinessPersistenceError ||
          error instanceof ProviderReadinessUnknownError
        ) {
          throw new BuiltinMcpExecutionUnknownErrorV1(error.message);
        }
        throw error;
      }
      if (
        receipt.providerId !== serverName ||
        receipt.routeRevision !== routeRevision ||
        receipt.executionBoundaryDigest !== input.executionBoundaryDigest ||
        receipt.providerDirectoryRevision !== providerDirectoryRevisionV1(runtime) ||
        !validTimestampV1(receipt.readyAt) ||
        !validTimestampV1(receipt.expiresAt) ||
        Date.parse(receipt.expiresAt) <= (input.now?.() ?? Date.now())
      ) {
        throw new BuiltinMcpExecutionUnknownErrorV1(
          `Provider readiness receipt '${receipt.readinessKey}' did not match current authority.`,
        );
      }
      return runtime.readResource(serverName, uri, effectiveSignal, transportBoundary);
    },
  });
}

function providerDirectoryRevisionV1(runtime: BuiltinMcpRuntimePortV1): string {
  const snapshot = runtime.getProviderDirectorySnapshot();
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !('revision' in snapshot) ||
    typeof snapshot.revision !== 'string' ||
    snapshot.revision.length === 0 ||
    snapshot.revision.length > 512 ||
    /\p{Cc}/u.test(snapshot.revision)
  ) {
    throw new ProviderReadinessPersistenceError(
      'Provider directory revision is unavailable for readiness binding.',
    );
  }
  return snapshot.revision;
}

function providerErrorFromUnavailableV1(
  providerId: string,
  error: ProviderReadinessUnavailableError,
): McpProviderError {
  const kind = providerFailureKindV1(error.failure.kind);
  return new McpProviderError({
    providerId,
    kind,
    message: boundedMessageV1(error.failure.message),
    retryable: error.failure.retryable,
    ...(providerRecoveryActionV1(kind, error.failure.retryable)
      ? { recoveryAction: providerRecoveryActionV1(kind, error.failure.retryable) }
      : {}),
  });
}

function providerFailureKindV1(value: string): McpProviderFailureKind {
  return value === 'provider_auth_required' ||
    value === 'provider_approval_required' ||
    value === 'provider_capability_changed'
    ? value
    : 'provider_unavailable';
}

function providerRecoveryActionV1(
  kind: McpProviderFailureKind,
  retryable: boolean,
): McpProviderRecoveryAction | undefined {
  if (kind === 'provider_auth_required') return 'login';
  if (kind === 'provider_approval_required') return 'approve';
  if (kind === 'provider_unavailable' && retryable) return 'retry';
  return undefined;
}

function boundedMessageV1(value: string): string {
  const message = Array.from(value.replace(/\p{Cc}/gu, ' ').trim())
    .slice(0, 2048)
    .join('');
  return message || 'MCP provider is unavailable.';
}

function validTimestampV1(value: string): boolean {
  return value.length > 0 && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function assertCompositionInputV1(input: Readonly<CreateAppMcpReadinessRuntimeInputV1>): void {
  if (
    !input?.runtime ||
    typeof input.runtime.readResource !== 'function' ||
    typeof input.runtime.getProviderDirectorySnapshot !== 'function' ||
    !input.signal ||
    typeof input.signal.aborted !== 'boolean' ||
    !input.toolCallId ||
    !input.executionBoundaryDigest
  ) {
    throw new ProviderReadinessPersistenceError('MCP readiness composition is invalid.');
  }
}
