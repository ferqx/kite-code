import type {
  AppMcpActionRequest,
  AppMcpActionResponse,
  AppMcpSnapshot,
  AppMcpSnapshotRequest,
  ExecutionStatusRequest,
  ExecutionStatusSnapshot,
  ProviderModelSelectRequest,
  ProviderModelSelectResponse,
  ProviderModelSnapshot,
  ProviderModelSnapshotRequest,
  ReleaseStatusRequest,
  ReleaseStatusSnapshot,
  SkillCatalogRequest,
  SkillCatalogSnapshot,
  WorkspaceTrustDecisionRequest,
  WorkspaceTrustDecisionResponse,
  WorkspaceTrustQueryRequest,
  WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';

/**
 * The mutation boundary shared by App Control handlers.  The gate is injected
 * by the owner so the facade does not create a second global lock or know
 * anything about Runtime/Store lifecycle.  It deliberately has no retry
 * operation: an unknown outcome must remain unknown to the caller.
 */
export interface AppControlOperationGate {
  runMutation<T>(operation: () => Promise<T> | T): Promise<T>;
}

/** Compatibility name used by the service composition layer. */
export type OperationGate = AppControlOperationGate;

/** One no-op gate is useful for isolated, read-only handler tests. */
export const INLINE_APP_CONTROL_OPERATION_GATE: AppControlOperationGate = Object.freeze({
  async runMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    return await operation();
  },
});

/**
 * A small serial gate for the InProcess owner.  It serializes only admitted
 * mutations and never replays an operation after an exception or lost result.
 */
export function createSerialAppControlOperationGate(): AppControlOperationGate {
  let tail = Promise.resolve();
  return Object.freeze({
    runMutation<T>(operation: () => Promise<T> | T): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      return previous.then(operation).finally(release);
    },
  });
}

/** Workspace Trust is an independent query/mutation capability. */
export interface WorkspaceTrustHandlerPort {
  query(request: WorkspaceTrustQueryRequest): Promise<WorkspaceTrustQueryResponse>;
  decide(request: WorkspaceTrustDecisionRequest): Promise<WorkspaceTrustDecisionResponse>;
}

/** Provider discovery and model-route selection are independent capabilities. */
export interface ProviderModelHandlerPort {
  snapshot(request: ProviderModelSnapshotRequest): Promise<ProviderModelSnapshot>;
  select(request: ProviderModelSelectRequest): Promise<ProviderModelSelectResponse>;
}

/** MCP metadata and configuration actions are independent from other controls. */
export interface McpHandlerPort {
  snapshot(request: AppMcpSnapshotRequest): Promise<AppMcpSnapshot>;
  apply(request: AppMcpActionRequest): Promise<AppMcpActionResponse>;
}

/** Skill catalog is query-only at the browser-safe App Control boundary. */
export interface SkillCatalogHandlerPort {
  snapshot(request: SkillCatalogRequest): Promise<SkillCatalogSnapshot>;
}

/** Execution status is an authoritative, no-secret query. */
export interface ExecutionStatusHandlerPort {
  snapshot(request: ExecutionStatusRequest): Promise<ExecutionStatusSnapshot>;
}

/** Release status is process-scoped and query-only. */
export interface ReleaseStatusHandlerPort {
  snapshot(request: ReleaseStatusRequest): Promise<ReleaseStatusSnapshot>;
}

/** Explicit handler set; there is intentionally no string-keyed route map. */
export interface KiteAppControlHandlerPorts {
  readonly workspaceTrust: WorkspaceTrustHandlerPort;
  readonly providerModel: ProviderModelHandlerPort;
  readonly mcp: McpHandlerPort;
  readonly skills: SkillCatalogHandlerPort;
  readonly execution: ExecutionStatusHandlerPort;
  readonly release: ReleaseStatusHandlerPort;
}

export type AppControlHandlerPorts = KiteAppControlHandlerPorts;

/** A mutation can report uncertainty without inviting the client to replay it. */
export type AppControlMutationOutcome =
  | 'applied'
  | 'recorded'
  | 'already_selected'
  | 'declined'
  | 'conflict'
  | 'outcome_unknown'
  | 'unavailable'
  | 'rejected';

/** Thrown only for malformed/cross-workspace calls, never for mutation uncertainty. */
export class AppControlRequestError extends Error {
  readonly code = 'invalid_app_control_request' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AppControlRequestError';
  }
}

/**
 * Compare a request's complete Project identity with the connection-scoped
 * admission.  A canonical path alone is not sufficient: project ID and the
 * digest are part of the same security identity.
 */
export function assertAdmittedWorkspace(
  admitted: import('@kite-ai/kite-app-contract').KiteWorkspaceIdentity | undefined,
  actual: import('@kite-ai/kite-app-contract').KiteWorkspaceIdentity,
  label = 'App Control request',
): void {
  if (!admitted) {
    throw new AppControlRequestError(`${label} requires an admitted workspace.`);
  }
  assertSameWorkspace(admitted, actual, label);
}

/** Compare complete Project identity for both request admission and owner responses. */
export function assertSameWorkspace(
  expected: import('@kite-ai/kite-app-contract').KiteWorkspaceIdentity,
  actual: import('@kite-ai/kite-app-contract').KiteWorkspaceIdentity,
  label = 'App Control response',
): void {
  if (
    expected.canonicalPath !== actual.canonicalPath ||
    expected.projectId !== actual.projectId ||
    expected.workspaceDigest !== actual.workspaceDigest
  ) {
    throw new AppControlRequestError(`${label} is outside the admitted workspace.`);
  }
}

/** Optional explicit signal for an owner that cannot determine mutation outcome. */
export class AppControlOutcomeUnknownError extends Error {
  readonly code = 'outcome_unknown' as const;

  constructor(message = 'App Control mutation outcome is unknown.') {
    super(message);
    this.name = 'AppControlOutcomeUnknownError';
  }
}
