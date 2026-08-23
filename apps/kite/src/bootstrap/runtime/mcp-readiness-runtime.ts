import { BuiltinMcpExecutionUnknownError, type BuiltinMcpRuntimePort } from '@kite/builtin-runtime';
import {
  McpProviderError,
  type McpProviderFailureKind,
  type McpProviderRecoveryAction,
} from '@kite/builtin-runtime/mcp';
import {
  type ProviderReadinessCoordinator,
  type ProviderReadinessPersistence,
  ProviderReadinessPersistenceError,
  ProviderReadinessUnavailableError,
  ProviderReadinessUnknownError,
} from './provider-readiness';
import type { RuntimeState } from './state-runtime';

export const APP_MCP_READINESS_RUNTIME_SCHEMA_ = 'kite.app-mcp-readiness-runtime.v1' as const;

export interface CreateAppMcpReadinessRuntimeInput {
  /** The one MCP manager captured by the App composition root. */
  readonly runtime: BuiltinMcpRuntimePort;
  readonly readinessCoordinator?: ProviderReadinessCoordinator;
  readonly getState?: () => Readonly<RuntimeState>;
  readonly persistEvent?: ProviderReadinessPersistence['persistEvent'];
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
export function createAppMcpReadinessRuntime(
  input: Readonly<CreateAppMcpReadinessRuntimeInput>,
): BuiltinMcpRuntimePort {
  assertCompositionInput(input);
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
      const routeRevision = providerDirectoryRevision(runtime);
      const effectiveSignal = signal ?? input.signal;
      let receipt: Awaited<ReturnType<ProviderReadinessCoordinator['ensureReady']>>;
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
          throw providerErrorFromUnavailable(serverName, error);
        }
        if (
          error instanceof ProviderReadinessPersistenceError ||
          error instanceof ProviderReadinessUnknownError
        ) {
          throw new BuiltinMcpExecutionUnknownError(error.message);
        }
        throw error;
      }
      if (
        receipt.providerId !== serverName ||
        receipt.routeRevision !== routeRevision ||
        receipt.executionBoundaryDigest !== input.executionBoundaryDigest ||
        receipt.providerDirectoryRevision !== providerDirectoryRevision(runtime) ||
        !validTimestamp(receipt.readyAt) ||
        !validTimestamp(receipt.expiresAt) ||
        Date.parse(receipt.expiresAt) <= (input.now?.() ?? Date.now())
      ) {
        throw new BuiltinMcpExecutionUnknownError(
          `Provider readiness receipt '${receipt.readinessKey}' did not match current authority.`,
        );
      }
      return runtime.readResource(serverName, uri, effectiveSignal, transportBoundary);
    },
  });
}

function providerDirectoryRevision(runtime: BuiltinMcpRuntimePort): string {
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

function providerErrorFromUnavailable(
  providerId: string,
  error: ProviderReadinessUnavailableError,
): McpProviderError {
  const kind = providerFailureKind(error.failure.kind);
  return new McpProviderError({
    providerId,
    kind,
    message: boundedMessage(error.failure.message),
    retryable: error.failure.retryable,
    ...(providerRecoveryAction(kind, error.failure.retryable)
      ? { recoveryAction: providerRecoveryAction(kind, error.failure.retryable) }
      : {}),
  });
}

function providerFailureKind(value: string): McpProviderFailureKind {
  return value === 'provider_auth_required' ||
    value === 'provider_approval_required' ||
    value === 'provider_capability_changed'
    ? value
    : 'provider_unavailable';
}

function providerRecoveryAction(
  kind: McpProviderFailureKind,
  retryable: boolean,
): McpProviderRecoveryAction | undefined {
  if (kind === 'provider_auth_required') return 'login';
  if (kind === 'provider_approval_required') return 'approve';
  if (kind === 'provider_unavailable' && retryable) return 'retry';
  return undefined;
}

function boundedMessage(value: string): string {
  const message = Array.from(value.replace(/\p{Cc}/gu, ' ').trim())
    .slice(0, 2048)
    .join('');
  return message || 'MCP provider is unavailable.';
}

function validTimestamp(value: string): boolean {
  return value.length > 0 && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function assertCompositionInput(input: Readonly<CreateAppMcpReadinessRuntimeInput>): void {
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
