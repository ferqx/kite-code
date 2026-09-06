import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  COORDINATOR_WORKER_ENDPOINT_SCHEMA,
  COORDINATOR_WORKER_IDENTITY_SCHEMA,
  CoordinatorDispatcherError,
  type CoordinatorWorkerControlPort,
  type CoordinatorWorkerReference,
  type CoordinatorWorkspaceIdentity,
} from '@kite-ai/kite-local-runtime/coordinator';
import type { WorkspaceWorkerControlIdentity } from '../workspace-worker/process-host';
import type {
  WorkspaceWorkerProcessManager,
  WorkspaceWorkerProcessRegistration,
  WorkspaceWorkerProcessResult,
} from '../workspace-worker/process-manager';
import {
  canonicalWorkspaceIdentity,
  workspaceIdentityDigest,
} from '../workspace-worker/workspace-identity';

const WORKER_SCOPE_PREFIX = 'workspace_';
const WORKER_SCOPE_PATTERN = /^workspace_[a-f0-9]{64}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,1024}$/u;

type CanonicalWorkerReference = Omit<CoordinatorWorkerReference, 'workspace'> & {
  readonly workspace: KiteWorkspaceIdentity;
};

/**
 * The Coordinator owns this adapter; it only forwards closed Worker lifecycle/capability
 * operations. It never receives a Worker Store, process-state path, or capability to retain.
 */
export interface CoordinatorWorkerManagerPort
  extends Pick<
    WorkspaceWorkerProcessManager,
    'ensure' | 'resolve' | 'describeScope' | 'mintConnectionCapability'
  > {}

export type CoordinatorWorkerManagerAdapterErrorCode =
  | 'identity_mismatch'
  | 'outcome_unknown'
  | 'unavailable';

export class CoordinatorWorkerManagerAdapterError extends CoordinatorDispatcherError {
  declare readonly code: CoordinatorWorkerManagerAdapterErrorCode;

  constructor(code: CoordinatorWorkerManagerAdapterErrorCode, message: string) {
    super(code, message);
    this.name = 'CoordinatorWorkerManagerAdapterError';
  }
}

/**
 * Derive one stable Worker scope from the complete canonical Workspace identity. The path-only
 * `workspaceDigest` is deliberately not sufficient: canonical path, project id, and that digest
 * all enter the identity digest before the scope id is formed.
 */
export function coordinatorWorkerScopeId(workspace: CoordinatorWorkspaceIdentity): string {
  const canonical = canonicalWorkspaceOrThrow(workspace);
  const digest = workspaceIdentityDigest(canonical);
  const hex = digest.slice('sha256:'.length);
  if (!/^[a-f0-9]{64}$/u.test(hex)) {
    throw new CoordinatorWorkerManagerAdapterError(
      'identity_mismatch',
      'Workspace identity digest is unavailable.',
    );
  }
  return `${WORKER_SCOPE_PREFIX}${hex}`;
}

export interface CoordinatorWorkerManagerAdapterOptions {
  readonly manager: CoordinatorWorkerManagerPort;
  /** Immutable release selection owned by the Coordinator process. */
  readonly executableMode?: 'source' | 'installed';
}

export function createCoordinatorWorkerManagerAdapter(
  options: CoordinatorWorkerManagerAdapterOptions,
): CoordinatorWorkerControlPort {
  return Object.freeze({
    async resolveWorkspace(workspace: CoordinatorWorkspaceIdentity) {
      const canonical = canonicalWorkspaceOrThrow(workspace);
      const workerScopeId = scopeIdForCanonicalWorkspace(canonical);
      const result = await invokeManager(() =>
        options.manager.resolve({ workerScopeId, workspace: canonical }),
      );
      return referenceFromResult(result, canonical, workerScopeId, 'resolve');
    },

    async ensureWorkspace(workspace: CoordinatorWorkspaceIdentity) {
      const canonical = canonicalWorkspaceOrThrow(workspace);
      const workerScopeId = scopeIdForCanonicalWorkspace(canonical);
      const result = await invokeManager(() =>
        options.manager.ensure({
          workerScopeId,
          workspace: canonical,
          ...(options.executableMode ? { executableMode: options.executableMode } : {}),
        }),
      );
      const reference = referenceFromResult(result, canonical, workerScopeId, 'ensure');
      if (reference === null) {
        throw new CoordinatorWorkerManagerAdapterError(
          'unavailable',
          'Workspace Worker did not become ready.',
        );
      }
      return reference;
    },

    async describeScope(workerScopeId: string) {
      assertScopeId(workerScopeId);
      const identity = await invokeManager(() => options.manager.describeScope(workerScopeId));
      if (identity === undefined) return null;
      const canonical = canonicalIdentityOrThrow(identity);
      const expectedScopeId = scopeIdForCanonicalWorkspace(canonical);
      if (expectedScopeId !== workerScopeId) {
        throw new CoordinatorWorkerManagerAdapterError(
          'identity_mismatch',
          'Workspace Worker scope identity does not match its Workspace.',
        );
      }

      // describeScope is the restart-safe identity proof. Resolve immediately through the same
      // manager to obtain the current path-free endpoint/registration, then verify both facts
      // against that proof before exposing a Coordinator reference.
      const result = await invokeManager(() =>
        options.manager.resolve({ workerScopeId, workspace: canonical }),
      );
      const worker = referenceFromResult(result, canonical, workerScopeId, 'describe');
      if (worker === null) {
        throw new CoordinatorWorkerManagerAdapterError(
          'unavailable',
          'Described Workspace Worker is not currently routable.',
        );
      }
      assertReferenceIdentity(worker, identity, canonical, workerScopeId);
      return { workspace: canonical, worker };
    },

    async mintCapability(input: Parameters<CoordinatorWorkerControlPort['mintCapability']>[0]) {
      const worker = assertReference(input.worker);
      const workerScopeId = scopeIdForCanonicalWorkspace(worker.workspace);
      if (worker.identity.workerScopeId !== workerScopeId) {
        throw new CoordinatorWorkerManagerAdapterError(
          'identity_mismatch',
          'Worker reference scope is not derived from its Workspace identity.',
        );
      }
      const currentIdentity = await invokeManager(() =>
        options.manager.describeScope(workerScopeId),
      );
      if (currentIdentity === undefined) {
        throw new CoordinatorWorkerManagerAdapterError(
          'unavailable',
          'Workspace Worker is not currently routable.',
        );
      }
      const currentWorkspace = canonicalIdentityOrThrow(currentIdentity);
      if (
        currentIdentity.workerScopeId !== worker.identity.workerScopeId ||
        currentIdentity.workerInstanceId !== worker.identity.instanceId ||
        currentIdentity.buildId !== worker.identity.buildId ||
        !sameWorkspace(currentWorkspace, worker.workspace)
      ) {
        throw new CoordinatorWorkerManagerAdapterError(
          'unavailable',
          'Workspace Worker reference changed during capability mint.',
        );
      }
      const result = await invokeManager(() =>
        options.manager.mintConnectionCapability({
          workerScopeId,
          workspace: worker.workspace,
          clientId: input.clientId,
          connectionGeneration: input.connectionGeneration,
          purpose: input.purpose,
        }),
      );
      if (result.outcome === 'outcome_unknown') {
        throw new CoordinatorWorkerManagerAdapterError(
          'outcome_unknown',
          'Workspace Worker capability outcome is unknown.',
        );
      }
      if (result.outcome !== 'applied') {
        throw new CoordinatorWorkerManagerAdapterError(
          result.diagnostic === 'identity_uncertain' ? 'outcome_unknown' : 'unavailable',
          'Workspace Worker capability is unavailable.',
        );
      }
      if (!CAPABILITY_PATTERN.test(result.capability) || !isTimestamp(result.expiresAt)) {
        throw new CoordinatorWorkerManagerAdapterError(
          'identity_mismatch',
          'Workspace Worker capability response is invalid.',
        );
      }
      return Object.freeze({
        capability: result.capability,
        expiresAt: result.expiresAt,
      });
    },
  });
}

function canonicalWorkspaceOrThrow(workspace: CoordinatorWorkspaceIdentity): KiteWorkspaceIdentity {
  try {
    return canonicalWorkspaceIdentity({
      canonicalPath: workspace.canonicalPath,
      projectId: workspace.projectId,
      workspaceDigest: workspace.workspaceDigest as `sha256:${string}`,
    });
  } catch {
    throw new CoordinatorWorkerManagerAdapterError(
      'identity_mismatch',
      'Workspace identity is not canonical.',
    );
  }
}

function canonicalIdentityOrThrow(identity: WorkspaceWorkerControlIdentity): KiteWorkspaceIdentity {
  if (
    !safeText(identity.workerScopeId) ||
    !safeText(identity.workerInstanceId) ||
    !safeText(identity.buildId)
  ) {
    throw new CoordinatorWorkerManagerAdapterError(
      'identity_mismatch',
      'Workspace Worker identity is invalid.',
    );
  }
  return canonicalWorkspaceOrThrow(identity.workspace);
}

function scopeIdForCanonicalWorkspace(workspace: KiteWorkspaceIdentity): string {
  const digest = workspaceIdentityDigest(workspace).slice('sha256:'.length);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new CoordinatorWorkerManagerAdapterError(
      'identity_mismatch',
      'Workspace identity digest is invalid.',
    );
  }
  return `${WORKER_SCOPE_PREFIX}${digest}`;
}

function assertScopeId(value: string): void {
  if (!WORKER_SCOPE_PATTERN.test(value)) {
    throw new CoordinatorWorkerManagerAdapterError(
      'identity_mismatch',
      'Workspace Worker scope identity is invalid.',
    );
  }
}

function referenceFromResult(
  result: WorkspaceWorkerProcessResult,
  workspace: KiteWorkspaceIdentity,
  workerScopeId: string,
  operation: 'resolve' | 'ensure' | 'describe',
): CoordinatorWorkerReference | null {
  if (result.outcome === 'outcome_unknown') {
    throw new CoordinatorWorkerManagerAdapterError(
      'outcome_unknown',
      `Workspace Worker ${operation} outcome is unknown.`,
    );
  }
  if (result.outcome === 'busy' || result.outcome === 'unavailable') {
    if (result.diagnostic === 'identity_uncertain' || result.diagnostic === 'state_corrupt') {
      throw new CoordinatorWorkerManagerAdapterError(
        'identity_mismatch',
        `Workspace Worker ${operation} identity is unavailable.`,
      );
    }
    if (operation === 'resolve' && result.diagnostic === 'not_running') return null;
    throw new CoordinatorWorkerManagerAdapterError(
      'unavailable',
      `Workspace Worker ${operation} is unavailable.`,
    );
  }
  if (result.outcome === 'incompatible') {
    throw new CoordinatorWorkerManagerAdapterError(
      'unavailable',
      `Workspace Worker ${operation} is incompatible.`,
    );
  }
  if (result.state !== 'ready' || result.registration === undefined) {
    if (operation === 'resolve' && result.state === 'absent') return null;
    throw new CoordinatorWorkerManagerAdapterError(
      'unavailable',
      `Workspace Worker ${operation} did not return a ready registration.`,
    );
  }
  return referenceFromRegistration(result.registration, workspace, workerScopeId);
}

function referenceFromRegistration(
  registration: WorkspaceWorkerProcessRegistration,
  workspace: KiteWorkspaceIdentity,
  workerScopeId: string,
): CoordinatorWorkerReference {
  try {
    const identity = COORDINATOR_WORKER_IDENTITY_SCHEMA.parse(registration.identity);
    const endpoint = COORDINATOR_WORKER_ENDPOINT_SCHEMA.parse(registration.endpoint);
    if (
      registration.state !== 'ready' ||
      identity.workerScopeId !== workerScopeId ||
      registration.workspaceDigest !== workspace.workspaceDigest
    ) {
      throw new Error('registration identity mismatch');
    }
    return Object.freeze({
      identity,
      workspace,
      endpoint,
    });
  } catch {
    throw new CoordinatorWorkerManagerAdapterError(
      'identity_mismatch',
      'Workspace Worker registration identity is invalid.',
    );
  }
}

function assertReference(value: CoordinatorWorkerReference): CanonicalWorkerReference {
  try {
    const identity = COORDINATOR_WORKER_IDENTITY_SCHEMA.parse(value.identity);
    const endpoint = COORDINATOR_WORKER_ENDPOINT_SCHEMA.parse(value.endpoint);
    const workspace = canonicalWorkspaceOrThrow(value.workspace);
    return Object.freeze({ identity, endpoint, workspace });
  } catch {
    throw new CoordinatorWorkerManagerAdapterError(
      'identity_mismatch',
      'Workspace Worker reference identity is invalid.',
    );
  }
}

function assertReferenceIdentity(
  reference: CoordinatorWorkerReference,
  identity: WorkspaceWorkerControlIdentity,
  workspace: KiteWorkspaceIdentity,
  workerScopeId: string,
): void {
  if (
    reference.identity.workerScopeId !== identity.workerScopeId ||
    reference.identity.instanceId !== identity.workerInstanceId ||
    reference.identity.buildId !== identity.buildId ||
    reference.workspace.canonicalPath !== workspace.canonicalPath ||
    reference.workspace.projectId !== workspace.projectId ||
    reference.workspace.workspaceDigest !== workspace.workspaceDigest
  ) {
    throw new CoordinatorWorkerManagerAdapterError(
      'identity_mismatch',
      'Workspace Worker registration changed during discovery.',
    );
  }
  if (reference.identity.workerScopeId !== workerScopeId) {
    throw new CoordinatorWorkerManagerAdapterError(
      'identity_mismatch',
      'Workspace Worker registration scope changed during discovery.',
    );
  }
}

function sameWorkspace(left: KiteWorkspaceIdentity, right: KiteWorkspaceIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

async function invokeManager<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CoordinatorWorkerManagerAdapterError) throw error;
    throw new CoordinatorWorkerManagerAdapterError(
      'unavailable',
      'Workspace Worker manager is unavailable.',
    );
  }
}

function isTimestamp(value: string): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function safeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}
