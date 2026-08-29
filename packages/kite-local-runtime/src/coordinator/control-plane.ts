import { createHash } from 'node:crypto';
import type {
  CoordinatorCatalog,
  CoordinatorMutationMethod,
  CoordinatorOperationIdentity,
} from './catalog';
import type {
  CoordinatorIdentity,
  CoordinatorSessionMetadata,
  CoordinatorWebGatewayIdentity,
  CoordinatorWorkerCapabilityPurpose,
  CoordinatorWorkerReference,
  CoordinatorWorkspaceIdentity,
} from './codecs';
import { CoordinatorDispatcherError, type CoordinatorDispatcherHandlers } from './dispatcher';
import type {
  CoordinatorGatewayRegistration,
  CoordinatorRegistry,
  CoordinatorWorkerRegistration,
} from './registry';

export interface CoordinatorWorkerControlPort {
  resolveWorkspace(
    workspace: CoordinatorWorkspaceIdentity,
  ): Promise<CoordinatorWorkerReference | null>;
  ensureWorkspace(workspace: CoordinatorWorkspaceIdentity): Promise<CoordinatorWorkerReference>;
  describeScope(workerScopeId: string): Promise<{
    readonly workspace: CoordinatorWorkspaceIdentity;
    readonly worker: CoordinatorWorkerReference | null;
  } | null>;
  mintCapability(input: {
    readonly worker: CoordinatorWorkerReference;
    readonly clientId: string;
    readonly connectionGeneration: number;
    readonly purpose: CoordinatorWorkerCapabilityPurpose;
  }): Promise<{ readonly capability: string; readonly expiresAt: string }>;
}

export interface CoordinatorWebGatewayControlPort {
  ensure(): Promise<{
    readonly registration: CoordinatorGatewayRegistration;
    readonly launchUrl: string;
  }>;
  discover(): Promise<{
    readonly registration: CoordinatorGatewayRegistration;
    readonly launchUrl: string;
  } | null>;
  stop(): Promise<void>;
}

export interface CoordinatorControlPlaneOptions {
  readonly identity: CoordinatorIdentity;
  readonly catalog: CoordinatorCatalog;
  readonly registry: CoordinatorRegistry;
  readonly workers: CoordinatorWorkerControlPort;
  readonly gateway: CoordinatorWebGatewayControlPort;
  readonly beforeDirectoryRead?: () => Promise<void> | void;
}

export interface CoordinatorControlPlane {
  readonly handlers: CoordinatorDispatcherHandlers;
  completeReconcile(): void;
  applySessionMetadata(metadata: CoordinatorSessionMetadata): void;
}

/** Closed control-plane composition. All Runtime data remains on Worker links. */
export function createCoordinatorControlPlane(
  options: CoordinatorControlPlaneOptions,
): CoordinatorControlPlane {
  let lifecycle: 'reconciling' | 'ready' | 'draining' = 'reconciling';
  for (const metadata of options.catalog.listSessions())
    options.registry.upsertSessionMetadata(metadata);

  const handlers: CoordinatorDispatcherHandlers = {
    status: () => ({
      state: lifecycle,
      identity: options.identity,
      directoryRevision: options.registry.snapshot().directoryRevision,
    }),
    resolveWorkspaceWorker: async ({ workspace }) => {
      requireReady();
      return { worker: await options.workers.resolveWorkspace(workspace) };
    },
    ensureWorkspaceWorker: async ({ workspace }, context) =>
      runIdempotent('ensureWorkspaceWorker', { workspace }, context.idempotencyKey, async () => ({
        worker: await options.workers.ensureWorkspace(workspace),
      })),
    resolveSessionWorkspace: async ({ sessionId }) => {
      requireReady();
      await options.beforeDirectoryRead?.();
      const metadata = options.catalog
        .listSessions()
        .find((entry) => entry.sessionId === sessionId && !entry.tombstone);
      if (!metadata)
        throw new CoordinatorDispatcherError('unavailable', 'Session route is unavailable.');
      const scope = await options.workers.describeScope(metadata.workerScopeId);
      if (!scope)
        throw new CoordinatorDispatcherError('unavailable', 'Workspace route is unavailable.');
      return {
        workerScopeId: metadata.workerScopeId,
        workspace: { ...scope.workspace },
        worker: scope.worker,
      };
    },
    listSessionMetadata: async ({ workspace, cursor, limit = 200 }) => {
      requireReady();
      await options.beforeDirectoryRead?.();
      let workerScopeId: string | undefined;
      if (workspace) {
        const scopes = [
          ...new Set(
            options.catalog
              .listSessions()
              .filter((entry) => !entry.tombstone)
              .map((entry) => entry.workerScopeId),
          ),
        ];
        for (const scopeId of scopes) {
          const scope = await options.workers.describeScope(scopeId);
          if (scope && sameWorkspace(scope.workspace, workspace)) {
            if (workerScopeId !== undefined && workerScopeId !== scopeId) {
              throw new CoordinatorDispatcherError(
                'identity_mismatch',
                'Workspace maps to multiple Worker scopes.',
              );
            }
            workerScopeId = scopeId;
          }
        }
        if (workerScopeId === undefined) return { entries: [] };
      }
      const all = options.catalog
        .listSessions()
        .filter((entry) => !entry.tombstone)
        .filter((entry) => workerScopeId === undefined || entry.workerScopeId === workerScopeId)
        .filter((entry) => cursor === undefined || entry.sessionId > cursor)
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
      const entries = all.slice(0, limit);
      return {
        entries,
        ...(all.length > entries.length && entries.length > 0
          ? { nextCursor: entries.at(-1)!.sessionId }
          : {}),
      };
    },
    mintWorkerConnectionCapability: async (params, context) => {
      requireReady();
      return runIdempotent(
        'mintWorkerConnectionCapability',
        params,
        context.idempotencyKey,
        async () => {
          const worker = await options.workers.resolveWorkspace(params.workspace);
          if (
            !worker ||
            worker.identity.workerScopeId !== params.workerScopeId ||
            worker.workspace.workspaceDigest !== params.workspace.workspaceDigest
          ) {
            throw new CoordinatorDispatcherError('identity_mismatch', 'Worker route changed.');
          }
          const capability = await options.workers.mintCapability({
            worker,
            clientId: params.clientId,
            connectionGeneration: params.connectionGeneration,
            purpose: params.purpose,
          });
          return {
            worker,
            clientId: params.clientId,
            connectionGeneration: params.connectionGeneration,
            purpose: params.purpose,
            workerConnectionCapability: capability.capability,
            expiresAt: capability.expiresAt,
          };
        },
      );
    },
    ensureWebGateway: async (_params, context) =>
      runIdempotent('ensureWebGateway', {}, context.idempotencyKey, async () => {
        const launched = await options.gateway.ensure();
        return {
          gateway: gatewayReference(launched.registration),
          launchUrl: launched.launchUrl,
        };
      }),
    discoverWebGateway: async () => {
      const discovered = await options.gateway.discover();
      return discovered === null
        ? { gateway: null }
        : {
            gateway: gatewayReference(discovered.registration),
            launchUrl: discovered.launchUrl,
          };
    },
    stopWebGateway: async (_params, context) =>
      runIdempotent('stopWebGateway', {}, context.idempotencyKey, async () => {
        await options.gateway.stop();
        return { gateway: null };
      }),
    stopCoordinator: async () => {
      requireReady();
      lifecycle = 'draining';
      return { state: 'draining' };
    },
    subscribeDirectoryChanges: async ({ cursor }, context) => {
      requireReady();
      await options.beforeDirectoryRead?.();
      const current = options.registry.snapshot().directoryRevision;
      if (cursor !== current) {
        return { subscriptionId: `directory-${context.requestId}`, directoryRevision: current };
      }
      let subscription: ReturnType<CoordinatorRegistry['subscribeDirectoryChanges']> | undefined;
      try {
        const changed = new Promise<string>((resolve) => {
          subscription = options.registry.subscribeDirectoryChanges((change) =>
            resolve(change.revision),
          );
          context.signal.addEventListener('abort', () => resolve(current), { once: true });
        });
        return {
          subscriptionId: subscription?.subscriptionId ?? `directory-${context.requestId}`,
          directoryRevision: await changed,
        };
      } finally {
        subscription?.close();
      }
    },
  };

  return Object.freeze({
    handlers,
    completeReconcile() {
      if (lifecycle === 'draining') return;
      lifecycle = 'ready';
    },
    applySessionMetadata(metadata: CoordinatorSessionMetadata) {
      if (lifecycle === 'draining') throw new Error('Coordinator is draining.');
      options.catalog.upsertSession(metadata);
      options.registry.upsertSessionMetadata(metadata);
    },
  });

  function requireReady(): void {
    if (lifecycle !== 'ready') {
      throw new CoordinatorDispatcherError('unavailable', 'Coordinator is reconciling.');
    }
  }

  async function runIdempotent<Result>(
    method: CoordinatorMutationMethod,
    params: unknown,
    idempotencyKey: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    requireReady();
    const identity: CoordinatorOperationIdentity = {
      idempotencyKey,
      method,
      requestDigest: digestRequest(method, params),
    };
    const admission = options.catalog.admitOperation(identity);
    if (admission.status === 'digest_mismatch') {
      throw new CoordinatorDispatcherError('identity_mismatch', 'Idempotency identity changed.');
    }
    if (admission.status !== 'new') {
      throw new CoordinatorDispatcherError('outcome_unknown', 'Operation outcome requires query.');
    }
    try {
      const result = await operation();
      options.catalog.settleOperation(identity, 'committed');
      return result;
    } catch (error) {
      try {
        options.catalog.settleOperation(identity, 'outcome_unknown');
      } catch {
        // The durable in-progress receipt still forbids automatic replay.
      }
      throw error;
    }
  }
}

function sameWorkspace(
  left: CoordinatorWorkspaceIdentity,
  right: CoordinatorWorkspaceIdentity,
): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

function digestRequest(method: CoordinatorMutationMethod, params: unknown): string {
  return createHash('sha256').update(JSON.stringify({ method, params }), 'utf8').digest('hex');
}

function gatewayReference(registration: CoordinatorGatewayRegistration | null): {
  readonly identity: CoordinatorWebGatewayIdentity;
  readonly endpoint: { readonly origin: string };
} | null {
  return registration === null
    ? null
    : { identity: registration.identity, endpoint: registration.endpoint };
}

export function workerRegistrationFromReference(
  worker: CoordinatorWorkerReference,
  state: CoordinatorWorkerRegistration['state'],
  timestamp: string,
): CoordinatorWorkerRegistration {
  return {
    identity: worker.identity,
    workspaceDigest: worker.workspace.workspaceDigest,
    endpoint: worker.endpoint,
    state,
    startedAt: timestamp,
    lastSeenAt: timestamp,
  };
}
