import { z } from 'zod';
import {
  assertCoordinatorJsonValue,
  COORDINATOR_SESSION_METADATA_SCHEMA,
  COORDINATOR_WEB_GATEWAY_ENDPOINT_SCHEMA,
  COORDINATOR_WEB_GATEWAY_IDENTITY_SCHEMA,
  COORDINATOR_WORKER_ENDPOINT_SCHEMA,
  COORDINATOR_WORKER_IDENTITY_SCHEMA,
  type CoordinatorSessionMetadata,
} from './codecs';

const digest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, 'expected a canonical Workspace SHA-256 digest');
const timestamp = z.iso.datetime({ offset: true });
const lifecycleState = z.enum(['starting', 'ready', 'draining', 'dead']);

const workerRegistrationSchema = z
  .object({
    identity: COORDINATOR_WORKER_IDENTITY_SCHEMA,
    workspaceDigest: digest,
    endpoint: COORDINATOR_WORKER_ENDPOINT_SCHEMA,
    state: lifecycleState,
    startedAt: timestamp,
    lastSeenAt: timestamp,
  })
  .strict();
export type CoordinatorWorkerRegistration = z.infer<typeof workerRegistrationSchema>;
export const COORDINATOR_WORKER_REGISTRATION_SCHEMA = workerRegistrationSchema;

const gatewayRegistrationSchema = z
  .object({
    identity: COORDINATOR_WEB_GATEWAY_IDENTITY_SCHEMA,
    endpoint: COORDINATOR_WEB_GATEWAY_ENDPOINT_SCHEMA,
    state: z.enum(['starting', 'ready', 'draining']),
    startedAt: timestamp,
    lastSeenAt: timestamp,
  })
  .strict();
export type CoordinatorGatewayRegistration = z.infer<typeof gatewayRegistrationSchema>;
export const COORDINATOR_GATEWAY_REGISTRATION_SCHEMA = gatewayRegistrationSchema;

export type CoordinatorDirectoryChangeKind =
  | 'worker_registered'
  | 'worker_unregistered'
  | 'worker_dead'
  | 'session_metadata_changed'
  | 'session_metadata_removed'
  | 'gateway_changed';

export interface CoordinatorDirectoryChange {
  readonly revision: string;
  readonly kind: CoordinatorDirectoryChangeKind;
  readonly workerScopeId?: string;
  readonly sessionId?: string;
  readonly gatewayInstanceId?: string;
}

export interface CoordinatorDirectorySnapshot {
  readonly directoryRevision: string;
  readonly workers: readonly CoordinatorWorkerRegistration[];
  readonly sessions: readonly CoordinatorSessionMetadata[];
  readonly gateway: CoordinatorGatewayRegistration | null;
}

export interface CoordinatorDirectorySubscription {
  readonly subscriptionId: string;
  readonly initialRevision: string;
  close(): void;
}

export type CoordinatorDirectoryListener = (change: CoordinatorDirectoryChange) => void;

export interface CoordinatorReconcileInput {
  readonly workers?: readonly CoordinatorWorkerRegistration[];
  readonly sessions?: readonly CoordinatorSessionMetadata[];
  readonly gateway?: CoordinatorGatewayRegistration | null;
}

export type CoordinatorRegistryErrorCode =
  | 'worker_scope_busy'
  | 'worker_instance_mismatch'
  | 'unknown_worker'
  | 'gateway_singleton_busy'
  | 'gateway_instance_mismatch'
  | 'unknown_gateway'
  | 'invalid_metadata';

export class CoordinatorRegistryError extends Error {
  readonly code: CoordinatorRegistryErrorCode;

  constructor(code: CoordinatorRegistryErrorCode, message: string) {
    super(message);
    this.name = 'CoordinatorRegistryError';
    this.code = code;
  }
}

export interface CoordinatorRegistry {
  registerWorker(registration: CoordinatorWorkerRegistration): CoordinatorWorkerRegistration;
  markWorkerDead(workerScopeId: string, workerInstanceId: string): void;
  unregisterWorker(workerScopeId: string, workerInstanceId: string): void;
  worker(workerScopeId: string): CoordinatorWorkerRegistration | undefined;
  workers(): readonly CoordinatorWorkerRegistration[];
  upsertSessionMetadata(metadata: CoordinatorSessionMetadata): void;
  removeSessionMetadata(sessionId: string): void;
  sessions(): readonly CoordinatorSessionMetadata[];
  ensureWebGateway(registration: CoordinatorGatewayRegistration): CoordinatorGatewayRegistration;
  discoverWebGateway(): CoordinatorGatewayRegistration | null;
  stopWebGateway(instanceId: string): void;
  subscribeDirectoryChanges(
    listener: CoordinatorDirectoryListener,
  ): CoordinatorDirectorySubscription;
  reconcile(input: CoordinatorReconcileInput): CoordinatorDirectorySnapshot;
  snapshot(): CoordinatorDirectorySnapshot;
}

export function createCoordinatorRegistry(): CoordinatorRegistry {
  const workerByScope = new Map<string, CoordinatorWorkerRegistration>();
  const sessionById = new Map<string, CoordinatorSessionMetadata>();
  const listeners = new Map<string, CoordinatorDirectoryListener>();
  let gateway: CoordinatorGatewayRegistration | null = null;
  let directoryRevision = 0;
  let subscriptionSequence = 0;

  const bump = (change: Omit<CoordinatorDirectoryChange, 'revision'>): void => {
    directoryRevision += 1;
    const next = immutable({ ...change, revision: String(directoryRevision) });
    for (const listener of listeners.values()) {
      try {
        listener(next);
      } catch {
        // A directory observer never changes registry authority.
      }
    }
  };

  const registerWorker = (input: CoordinatorWorkerRegistration): CoordinatorWorkerRegistration => {
    const registration = parseWorkerRegistration(input);
    const scope = registration.identity.workerScopeId;
    const previous = workerByScope.get(scope);
    if (previous && previous.identity.instanceId !== registration.identity.instanceId) {
      if (previous.state !== 'dead') {
        throw new CoordinatorRegistryError(
          'worker_scope_busy',
          'Coordinator worker scope already has a live owner.',
        );
      }
    }
    workerByScope.set(scope, registration);
    if (
      !previous ||
      previous.identity.instanceId !== registration.identity.instanceId ||
      previous.state !== registration.state ||
      previous.lastSeenAt !== registration.lastSeenAt
    ) {
      bump({ kind: 'worker_registered', workerScopeId: scope });
    }
    return immutable(registration);
  };

  const markWorkerDead = (workerScopeId: string, workerInstanceId: string): void => {
    const previous = workerByScope.get(workerScopeId);
    if (!previous) {
      throw new CoordinatorRegistryError('unknown_worker', 'Coordinator worker is not registered.');
    }
    if (previous.identity.instanceId !== workerInstanceId) {
      throw new CoordinatorRegistryError(
        'worker_instance_mismatch',
        'Coordinator worker instance mismatches.',
      );
    }
    if (previous.state !== 'dead') {
      workerByScope.set(workerScopeId, immutable({ ...previous, state: 'dead' }));
      bump({ kind: 'worker_dead', workerScopeId });
    }
  };

  const unregisterWorker = (workerScopeId: string, workerInstanceId: string): void => {
    const previous = workerByScope.get(workerScopeId);
    if (!previous) {
      throw new CoordinatorRegistryError('unknown_worker', 'Coordinator worker is not registered.');
    }
    if (previous.identity.instanceId !== workerInstanceId) {
      throw new CoordinatorRegistryError(
        'worker_instance_mismatch',
        'Coordinator worker instance mismatches.',
      );
    }
    workerByScope.delete(workerScopeId);
    bump({ kind: 'worker_unregistered', workerScopeId });
  };

  const upsertSessionMetadata = (input: CoordinatorSessionMetadata): void => {
    const metadata = parseSessionMetadata(input);
    const previous = sessionById.get(metadata.sessionId);
    sessionById.set(metadata.sessionId, metadata);
    if (JSON.stringify(previous) !== JSON.stringify(metadata)) {
      bump({ kind: 'session_metadata_changed', sessionId: metadata.sessionId });
    }
  };

  const removeSessionMetadata = (sessionId: string): void => {
    if (sessionById.delete(sessionId)) bump({ kind: 'session_metadata_removed', sessionId });
  };

  const ensureWebGateway = (
    input: CoordinatorGatewayRegistration,
  ): CoordinatorGatewayRegistration => {
    const registration = parseGatewayRegistration(input);
    if (
      gateway &&
      gateway.identity.instanceId !== registration.identity.instanceId &&
      gateway.state !== 'draining'
    ) {
      throw new CoordinatorRegistryError(
        'gateway_singleton_busy',
        'Coordinator already has a live Web Gateway.',
      );
    }
    gateway = registration;
    bump({ kind: 'gateway_changed', gatewayInstanceId: registration.identity.instanceId });
    return immutable(registration);
  };

  const stopWebGateway = (instanceId: string): void => {
    if (!gateway)
      throw new CoordinatorRegistryError('unknown_gateway', 'Web Gateway is not registered.');
    if (gateway.identity.instanceId !== instanceId) {
      throw new CoordinatorRegistryError(
        'gateway_instance_mismatch',
        'Web Gateway instance mismatches.',
      );
    }
    gateway = null;
    bump({ kind: 'gateway_changed', gatewayInstanceId: instanceId });
  };

  const snapshot = (): CoordinatorDirectorySnapshot =>
    immutable({
      directoryRevision: String(directoryRevision),
      workers: [...workerByScope.values()].sort((left, right) =>
        left.identity.workerScopeId.localeCompare(right.identity.workerScopeId),
      ),
      sessions: [...sessionById.values()].sort((left, right) =>
        left.sessionId.localeCompare(right.sessionId),
      ),
      gateway,
    });

  const reconcile = (input: CoordinatorReconcileInput): CoordinatorDirectorySnapshot => {
    if (input.workers) {
      for (const worker of input.workers) registerWorker(worker);
    }
    if (input.sessions) {
      for (const session of input.sessions) upsertSessionMetadata(session);
    }
    if (input.gateway !== undefined) {
      if (input.gateway === null) {
        if (gateway) stopWebGateway(gateway.identity.instanceId);
      } else {
        ensureWebGateway(input.gateway);
      }
    }
    return snapshot();
  };

  return {
    registerWorker,
    markWorkerDead,
    unregisterWorker,
    worker: (workerScopeId) => {
      const value = workerByScope.get(workerScopeId);
      return value === undefined ? undefined : immutable(value);
    },
    workers: () => immutable([...workerByScope.values()]),
    upsertSessionMetadata,
    removeSessionMetadata,
    sessions: () => immutable([...sessionById.values()]),
    ensureWebGateway,
    discoverWebGateway: () => (gateway === null ? null : immutable(gateway)),
    stopWebGateway,
    subscribeDirectoryChanges: (listener) => {
      if (typeof listener !== 'function') {
        throw new CoordinatorRegistryError('invalid_metadata', 'Directory listener is invalid.');
      }
      const subscriptionId = `directory-subscription-${++subscriptionSequence}`;
      listeners.set(subscriptionId, listener);
      let closed = false;
      return {
        subscriptionId,
        initialRevision: String(directoryRevision),
        close: () => {
          if (closed) return;
          closed = true;
          listeners.delete(subscriptionId);
        },
      };
    },
    reconcile,
    snapshot,
  };
}

function parseWorkerRegistration(value: unknown): CoordinatorWorkerRegistration {
  try {
    assertCoordinatorJsonValue(value);
    return workerRegistrationSchema.parse(value);
  } catch {
    throw new CoordinatorRegistryError(
      'invalid_metadata',
      'Coordinator worker registration is invalid.',
    );
  }
}

function parseGatewayRegistration(value: unknown): CoordinatorGatewayRegistration {
  try {
    assertCoordinatorJsonValue(value);
    return gatewayRegistrationSchema.parse(value);
  } catch {
    throw new CoordinatorRegistryError(
      'invalid_metadata',
      'Coordinator Gateway registration is invalid.',
    );
  }
}

function parseSessionMetadata(value: unknown): CoordinatorSessionMetadata {
  try {
    assertCoordinatorJsonValue(value);
    return COORDINATOR_SESSION_METADATA_SCHEMA.parse(value);
  } catch {
    throw new CoordinatorRegistryError(
      'invalid_metadata',
      'Coordinator Session metadata is invalid.',
    );
  }
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
