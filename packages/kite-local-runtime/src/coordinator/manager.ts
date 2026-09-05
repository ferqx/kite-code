import { randomBytes } from 'node:crypto';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorEndpointDescriptor,
  type CoordinatorIdentity,
  decodeCoordinatorEndpointDescriptor,
} from './codecs';
import {
  type CoordinatorProcessChild,
  type CoordinatorProcessEnvironment,
  type CoordinatorProcessExecutable,
  type CoordinatorProcessExecutableResolver,
  type CoordinatorProcessIdentityProbe,
  type CoordinatorProcessPort,
  type CoordinatorProcessReadySignal,
  type CoordinatorProcessSpawnPort,
  coordinatorReadyMatchesDescriptor,
  coordinatorReadyMatchesIdentity,
} from './process-host';
import {
  COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA,
  COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA_,
  type CoordinatorProcessDescriptor,
  type CoordinatorProcessLaunchIntent,
  type CoordinatorProcessLockIdentity,
  type CoordinatorProcessLockLease,
  type CoordinatorProcessStateCleanup,
  type CoordinatorProcessStatePort,
  type CoordinatorProcessStatus,
  createCoordinatorProcessLockIdentity,
  safeDecodeCoordinatorProcessDescriptor,
  safeDecodeCoordinatorProcessLockIdentity,
} from './process-state';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_COORDINATOR_ARGS = Object.freeze(['coordinator', 'run'] as const);

export type CoordinatorManagerOperation = 'ensure' | 'status' | 'stop';
export type CoordinatorManagerState = 'absent' | 'starting' | 'ready' | 'draining';
export type CoordinatorManagerOutcome =
  | 'applied'
  | 'busy'
  | 'incompatible'
  | 'outcome_unknown'
  | 'unavailable';
export type CoordinatorManagerDiagnostic =
  | 'not_running'
  | 'identity_uncertain'
  | 'protocol_incompatible'
  | 'client_contract_incompatible'
  | 'build_mismatch'
  | 'process_busy'
  | 'unsupported'
  | 'timeout';

export interface CoordinatorManagerRequest {
  readonly requestId?: string;
  readonly executableMode?: 'source' | 'installed';
}

export interface CoordinatorManagerResult {
  readonly requestId: string;
  readonly operation: CoordinatorManagerOperation;
  readonly outcome: CoordinatorManagerOutcome;
  readonly state: CoordinatorManagerState;
  /** The endpoint is path-free; carriers derive its local address from the validated home. */
  readonly endpoint?: CoordinatorEndpointDescriptor;
  readonly descriptor?: CoordinatorProcessDescriptor;
  readonly diagnostic?: CoordinatorManagerDiagnostic;
}

export interface CoordinatorProcessHandshake {
  readonly outcome: 'healthy' | 'incompatible' | 'unavailable';
  readonly instanceId?: string;
  readonly buildId?: string;
  readonly protocolVersion?: number;
  readonly protocolRevision?: string;
  readonly clientContractRevision?: string;
  readonly diagnostic?:
    | 'protocol_incompatible'
    | 'client_contract_incompatible'
    | 'identity_uncertain';
}

export interface CoordinatorProcessProbePort {
  /** Authenticated server-owned handshake; it must not be synthesized from disk state. */
  handshake(input: {
    readonly descriptor: CoordinatorProcessDescriptor;
    readonly endpoint: CoordinatorEndpointDescriptor;
  }): Promise<CoordinatorProcessHandshake>;
}

export interface CoordinatorProcessStopPort {
  /** Graceful stop request only; this port has no kill/force authority. */
  stop(input: {
    readonly descriptor: CoordinatorProcessDescriptor;
    readonly requestId: string;
  }): Promise<
    | { readonly outcome: 'applied' }
    | { readonly outcome: 'outcome_unknown' }
    | {
        readonly outcome: 'unavailable';
        readonly diagnostic?: 'identity_uncertain' | 'unsupported';
      }
  >;
}

export interface CoordinatorProcessManagerOptions {
  readonly state: CoordinatorProcessStatePort;
  readonly process: CoordinatorProcessPort;
  readonly environment: { resolve(): Promise<CoordinatorProcessEnvironment> };
  readonly executableResolver: CoordinatorProcessExecutableResolver;
  readonly spawn: CoordinatorProcessSpawnPort;
  readonly probe?: CoordinatorProcessProbePort;
  readonly stop?: CoordinatorProcessStopPort;
  readonly coordinatorIdentity?: CoordinatorIdentity;
  readonly expectedBuildId?: string;
  readonly args?: readonly string[];
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  /** Verified exact start token for the manager process's lifecycle lock. */
  readonly managerProcessStartIdentity: string;
}

export interface CoordinatorProcessManager {
  ensure(request?: CoordinatorManagerRequest): Promise<CoordinatorManagerResult>;
  status(request?: CoordinatorManagerRequest): Promise<CoordinatorManagerResult>;
  stop(request?: CoordinatorManagerRequest): Promise<CoordinatorManagerResult>;
}

export interface CoordinatorManagedConnection {
  readonly descriptor: CoordinatorProcessDescriptor;
  readonly endpoint: CoordinatorEndpointDescriptor;
}

export class CoordinatorProcessManagerError extends Error {
  readonly code: 'unavailable' | 'incompatible' | 'outcome_unknown';

  constructor(code: 'unavailable' | 'incompatible' | 'outcome_unknown', message: string) {
    super(message);
    this.name = 'CoordinatorProcessManagerError';
    this.code = code;
  }
}

let requestSequence = 0;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(value: string | undefined): string {
  const id = value ?? `coordinator-manager-${++requestSequence}`;
  if (
    id.length === 0 ||
    id.length > 256 ||
    [...id].some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new TypeError('Coordinator manager requestId is invalid.');
  }
  return id;
}

function timeoutError(operation: string): Error {
  return new Error(`Coordinator ${operation} deadline exceeded.`);
}

function boundedTimeout(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 1 || result > MAX_TIMEOUT_MS) {
    throw new RangeError(`Coordinator ${label} timeout is invalid.`);
  }
  return Math.floor(result);
}

function invoke<T>(operation: () => PromiseLike<T>, duration: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(label)), duration);
  });
  return Promise.race([Promise.resolve().then(operation), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function freezeResult(value: CoordinatorManagerResult): CoordinatorManagerResult {
  return Object.freeze({
    ...value,
    ...(value.endpoint ? { endpoint: Object.freeze(value.endpoint) } : {}),
  });
}

function result(
  requestIdValue: string,
  operation: CoordinatorManagerOperation,
  outcome: CoordinatorManagerOutcome,
  state: CoordinatorManagerState,
  descriptor?: CoordinatorProcessDescriptor,
  diagnostic?: CoordinatorManagerDiagnostic,
): CoordinatorManagerResult {
  return freezeResult({
    requestId: requestIdValue,
    operation,
    outcome,
    state,
    ...(descriptor ? { descriptor, endpoint: descriptor.endpoint } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  });
}

function descriptorIdentityProbe(
  descriptor: CoordinatorProcessDescriptor,
): CoordinatorProcessIdentityProbe {
  return {
    pid: descriptor.pid,
    processStartIdentity: descriptor.processStartIdentity,
  };
}

function lockIdentityProbe(lock: CoordinatorProcessLockIdentity): CoordinatorProcessIdentityProbe {
  return { pid: lock.pid, processStartIdentity: lock.processStartIdentity };
}

function lockMatchesDescriptor(
  lock: CoordinatorProcessLockIdentity | undefined,
  descriptor: CoordinatorProcessDescriptor,
): lock is CoordinatorProcessLockIdentity {
  return (
    lock !== undefined &&
    lock.kind === 'instance' &&
    lock.pid === descriptor.pid &&
    lock.instanceId === descriptor.instanceId &&
    lock.startedAt === descriptor.startedAt &&
    lock.processStartIdentity === descriptor.processStartIdentity &&
    lock.buildId === descriptor.buildId
  );
}

function endpointMatchesDescriptor(
  endpoint: CoordinatorEndpointDescriptor,
  descriptor: CoordinatorProcessDescriptor,
): boolean {
  return JSON.stringify(endpoint) === JSON.stringify(descriptor.endpoint);
}

function endpointOwnerMatchesCurrentUser(endpoint: CoordinatorEndpointDescriptor): boolean {
  if (endpoint.transport !== 'unix_socket' || typeof process.getuid !== 'function') return true;
  return endpoint.owner.kind === 'posix_uid' && endpoint.owner.uid === process.getuid();
}

function normalizeHandshake(value: unknown): CoordinatorProcessHandshake {
  if (!isRecord(value)) return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
  const outcome = value.outcome;
  if (outcome !== 'healthy' && outcome !== 'incompatible' && outcome !== 'unavailable') {
    return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
  }
  const diagnostic =
    value.diagnostic === 'protocol_incompatible' ||
    value.diagnostic === 'client_contract_incompatible' ||
    value.diagnostic === 'identity_uncertain'
      ? value.diagnostic
      : undefined;
  if (outcome === 'healthy' && diagnostic !== undefined) {
    return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
  }
  return {
    outcome,
    ...(typeof value.instanceId === 'string' ? { instanceId: value.instanceId } : {}),
    ...(typeof value.buildId === 'string' ? { buildId: value.buildId } : {}),
    ...(typeof value.protocolVersion === 'number'
      ? { protocolVersion: value.protocolVersion }
      : {}),
    ...(typeof value.protocolRevision === 'string'
      ? { protocolRevision: value.protocolRevision }
      : {}),
    ...(typeof value.clientContractRevision === 'string'
      ? { clientContractRevision: value.clientContractRevision }
      : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function handshakeDiagnostic(
  handshake: CoordinatorProcessHandshake,
  descriptor: CoordinatorProcessDescriptor,
  expectedBuildId: string | undefined,
): CoordinatorManagerDiagnostic | undefined {
  if (handshake.outcome === 'incompatible') {
    if (
      handshake.diagnostic === 'protocol_incompatible' ||
      handshake.protocolVersion !== COORDINATOR_PROTOCOL_VERSION ||
      handshake.protocolRevision !== COORDINATOR_PROTOCOL_REVISION_
    ) {
      return 'protocol_incompatible';
    }
    if (
      handshake.diagnostic === 'client_contract_incompatible' ||
      handshake.clientContractRevision !== COORDINATOR_CLIENT_CONTRACT_REVISION_
    ) {
      return 'client_contract_incompatible';
    }
    return 'identity_uncertain';
  }
  if (handshake.outcome === 'unavailable') return 'identity_uncertain';
  if (handshake.instanceId !== descriptor.instanceId) return 'identity_uncertain';
  if (handshake.buildId !== descriptor.buildId) return 'identity_uncertain';
  if (handshake.protocolVersion !== descriptor.protocolVersion) return 'protocol_incompatible';
  if (handshake.protocolRevision !== descriptor.protocolRevision) return 'protocol_incompatible';
  if (handshake.clientContractRevision !== descriptor.clientContractRevision) {
    return 'client_contract_incompatible';
  }
  return expectedBuildId !== undefined && handshake.buildId !== expectedBuildId
    ? 'build_mismatch'
    : undefined;
}

function normalizeStop(value: unknown): Awaited<ReturnType<CoordinatorProcessStopPort['stop']>> {
  if (!isRecord(value)) return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
  if (value.outcome === 'applied') return { outcome: 'applied' };
  if (value.outcome === 'outcome_unknown') return { outcome: 'outcome_unknown' };
  if (value.outcome === 'unavailable') {
    return {
      outcome: 'unavailable',
      ...(value.diagnostic === 'unsupported' || value.diagnostic === 'identity_uncertain'
        ? { diagnostic: value.diagnostic }
        : {}),
    };
  }
  return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
}

function descriptorFromUnknown(
  value: unknown,
):
  | { readonly descriptor: CoordinatorProcessDescriptor }
  | { readonly malformed: true }
  | undefined {
  if (value === undefined) return undefined;
  const decoded = safeDecodeCoordinatorProcessDescriptor(value);
  return decoded.success ? { descriptor: decoded.data } : { malformed: true };
}

function lockFromUnknown(
  value: unknown,
): { readonly lock: CoordinatorProcessLockIdentity } | { readonly malformed: true } | undefined {
  if (value === undefined) return undefined;
  const decoded = safeDecodeCoordinatorProcessLockIdentity(value);
  return decoded.success ? { lock: decoded.data } : { malformed: true };
}

function assertReadyIdentity(
  ready: CoordinatorProcessReadySignal,
  executable: CoordinatorProcessExecutable,
  expectedBuildId: string | undefined,
  expectedIdentity: CoordinatorIdentity | undefined,
): CoordinatorManagerDiagnostic | undefined {
  if (expectedIdentity && !coordinatorReadyMatchesIdentity(ready, expectedIdentity)) {
    if (ready.protocolVersion !== expectedIdentity.protocolVersion) return 'protocol_incompatible';
    if (ready.clientContractRevision !== expectedIdentity.clientContractRevision) {
      return 'client_contract_incompatible';
    }
    return ready.buildId !== expectedIdentity.buildId ? 'build_mismatch' : 'identity_uncertain';
  }
  if (expectedBuildId !== undefined && ready.buildId !== expectedBuildId) return 'build_mismatch';
  if (executable.buildId !== undefined && ready.buildId !== executable.buildId) {
    return 'build_mismatch';
  }
  if (
    ready.protocolVersion !== COORDINATOR_PROTOCOL_VERSION ||
    ready.protocolRevision !== COORDINATOR_PROTOCOL_REVISION_
  ) {
    return 'protocol_incompatible';
  }
  if (ready.clientContractRevision !== COORDINATOR_CLIENT_CONTRACT_REVISION_) {
    return 'client_contract_incompatible';
  }
  return undefined;
}

/**
 * Single-home Coordinator lifecycle owner. Every public operation is serialized and every
 * cross-process mutation is guarded by the owner-only lifecycle lock. This manager never kills a
 * process, issues Runtime commands, or derives a healthy result from a stale descriptor alone.
 */
export function createCoordinatorProcessManager(
  options: CoordinatorProcessManagerOptions,
): CoordinatorProcessManager {
  const startupTimeoutMs = boundedTimeout(
    options.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
    'startup',
  );
  const operationTimeoutMs = boundedTimeout(
    options.operationTimeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    'operation',
  );
  const expectedBuildId = options.expectedBuildId;
  const managerProcessStartIdentity = options.managerProcessStartIdentity;
  const managerIdentityAvailable =
    typeof managerProcessStartIdentity === 'string' &&
    managerProcessStartIdentity.length > 0 &&
    managerProcessStartIdentity.length <= 256 &&
    ![...managerProcessStartIdentity].some((character) => /\p{Cc}/u.test(character));
  let serialTail = Promise.resolve();

  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = serialTail.then(operation, operation);
    serialTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  const invokeOperation = <T>(operation: () => PromiseLike<T>, label = 'operation'): Promise<T> =>
    invoke(operation, operationTimeoutMs, label);

  const preserveFailure = async (): Promise<void> => {
    try {
      await invokeOperation(() => options.state.preserveFailure());
    } catch {
      // State on disk is itself recovery evidence; never replace the lifecycle result with a
      // native error that could contain a path.
    }
  };

  const readLaunchIntent = async (): Promise<
    CoordinatorProcessLaunchIntent | 'malformed' | undefined
  > => {
    try {
      const value = await invokeOperation(() => options.state.readLaunchIntent());
      if (value === undefined) return undefined;
      const decoded = COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA.safeParse(value);
      return decoded.success ? decoded.data : 'malformed';
    } catch {
      return 'malformed';
    }
  };

  const clearLaunchIntent = async (intent: CoordinatorProcessLaunchIntent): Promise<boolean> => {
    try {
      await invokeOperation(() => options.state.clearLaunchIntent(intent));
      return true;
    } catch {
      await preserveFailure();
      return false;
    }
  };

  const managerLockIdentity = (): CoordinatorProcessLockIdentity =>
    createCoordinatorProcessLockIdentity({
      kind: 'lifecycle',
      pid: typeof process.pid === 'number' && process.pid > 0 ? process.pid : 1,
      instanceId: `manager-${randomBytes(12).toString('base64url')}`,
      startedAt: new Date().toISOString(),
      processStartIdentity: managerProcessStartIdentity,
      buildId: expectedBuildId ?? 'coordinator-manager',
    });

  const acquireLifecycleLock = async (): Promise<CoordinatorProcessLockLease | undefined> => {
    if (!managerIdentityAvailable) return undefined;
    const identity = managerLockIdentity();
    let lease: CoordinatorProcessLockLease | undefined;
    try {
      lease = await invokeOperation(() => options.state.acquireLock('lifecycle', identity));
    } catch {
      return undefined;
    }
    if (lease) return lease;

    let raw: unknown | undefined;
    try {
      raw = await invokeOperation(() => options.state.readLifecycleLock());
    } catch {
      return undefined;
    }
    const decoded = lockFromUnknown(raw);
    if (!decoded) {
      try {
        return await invokeOperation(() => options.state.acquireLock('lifecycle', identity));
      } catch {
        return undefined;
      }
    }
    if ('malformed' in decoded) return undefined;
    let status: CoordinatorProcessStatus;
    try {
      status = await invokeOperation(() =>
        options.process.inspect(lockIdentityProbe(decoded.lock)),
      );
    } catch {
      status = 'uncertain';
    }
    if (status !== 'dead') return undefined;
    try {
      await invokeOperation(() => options.state.clearStale({ lifecycleLock: decoded.lock }));
      return await invokeOperation(() => options.state.acquireLock('lifecycle', identity));
    } catch {
      return undefined;
    }
  };

  const withLifecycleLock = async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
    const lease = await acquireLifecycleLock();
    if (!lease) return undefined;
    let value: T | undefined;
    let error: unknown;
    try {
      value = await operation();
    } catch (caught) {
      error = caught;
    }
    try {
      await invokeOperation(() => lease.release());
    } catch (releaseError) {
      await preserveFailure();
      if (error === undefined) error = releaseError;
    }
    if (error !== undefined) throw error;
    return value;
  };

  const inspectProcessIdentity = async (
    identity: CoordinatorProcessIdentityProbe,
  ): Promise<CoordinatorProcessStatus> => {
    try {
      return await invokeOperation(() => options.process.inspect(identity));
    } catch {
      return 'uncertain';
    }
  };

  const inspect = async (
    descriptor: CoordinatorProcessDescriptor,
  ): Promise<CoordinatorProcessStatus> =>
    inspectProcessIdentity(descriptorIdentityProbe(descriptor));

  const readState = async (): Promise<
    | { readonly kind: 'absent' }
    | { readonly kind: 'malformed' }
    | {
        readonly kind: 'descriptor';
        readonly descriptor: CoordinatorProcessDescriptor;
        readonly instanceLock: CoordinatorProcessLockIdentity | undefined;
        readonly endpoint: CoordinatorEndpointDescriptor | undefined;
      }
    | {
        readonly kind: 'lock';
        readonly lock: CoordinatorProcessLockIdentity;
        readonly endpoint: CoordinatorEndpointDescriptor | undefined;
      }
  > => {
    let rawDescriptor: unknown | undefined;
    try {
      rawDescriptor = await invokeOperation(() => options.state.readDescriptor());
    } catch {
      return { kind: 'malformed' };
    }
    const decodedDescriptor = descriptorFromUnknown(rawDescriptor);
    let rawEndpoint: unknown | undefined;
    try {
      rawEndpoint = await invokeOperation(() => options.state.readEndpoint());
    } catch {
      return { kind: 'malformed' };
    }
    let endpoint: CoordinatorEndpointDescriptor | undefined;
    if (rawEndpoint !== undefined) {
      try {
        endpoint = decodeCoordinatorEndpointDescriptor(rawEndpoint);
      } catch {
        return { kind: 'malformed' };
      }
      if (!endpointOwnerMatchesCurrentUser(endpoint)) return { kind: 'malformed' };
    }
    let rawLock: unknown | undefined;
    try {
      rawLock = await invokeOperation(() => options.state.readInstanceLock());
    } catch {
      return { kind: 'malformed' };
    }
    const decodedLock = lockFromUnknown(rawLock);
    if (decodedDescriptor && 'malformed' in decodedDescriptor) return { kind: 'malformed' };
    if (decodedLock && 'malformed' in decodedLock) return { kind: 'malformed' };
    if (decodedDescriptor) {
      return {
        kind: 'descriptor',
        descriptor: decodedDescriptor.descriptor,
        instanceLock: decodedLock?.lock,
        endpoint,
      };
    }
    if (decodedLock) return { kind: 'lock', lock: decodedLock.lock, endpoint };
    if (endpoint) return { kind: 'malformed' };
    return { kind: 'absent' };
  };

  const clearDescriptorState = async (
    descriptor: CoordinatorProcessDescriptor,
    instanceLock: CoordinatorProcessLockIdentity | undefined,
    endpoint: CoordinatorEndpointDescriptor | undefined,
  ): Promise<boolean> => {
    if (!lockMatchesDescriptor(instanceLock, descriptor)) return false;
    try {
      const cleanup: CoordinatorProcessStateCleanup = {
        descriptor,
        instanceLock,
        ...(endpoint && endpointMatchesDescriptor(endpoint, descriptor) ? { endpoint } : {}),
      };
      await invokeOperation(() => options.state.clearStale(cleanup));
      return true;
    } catch {
      await preserveFailure();
      return false;
    }
  };

  const clearLockState = async (
    lock: CoordinatorProcessLockIdentity,
    endpoint: CoordinatorEndpointDescriptor | undefined,
  ): Promise<boolean> => {
    try {
      const cleanup: CoordinatorProcessStateCleanup = {
        instanceLock: lock,
        ...(endpoint &&
        endpoint.coordinator.instanceId === lock.instanceId &&
        endpoint.coordinator.buildId === lock.buildId
          ? { endpoint }
          : {}),
      };
      await invokeOperation(() => options.state.clearStale(cleanup));
      return true;
    } catch {
      await preserveFailure();
      return false;
    }
  };

  const probeDescriptor = async (
    descriptor: CoordinatorProcessDescriptor,
    operation: CoordinatorManagerOperation,
    id: string,
  ): Promise<CoordinatorManagerResult> => {
    if (!endpointOwnerMatchesCurrentUser(descriptor.endpoint)) {
      return result(id, operation, 'unavailable', 'ready', descriptor, 'identity_uncertain');
    }
    if (expectedBuildId !== undefined && descriptor.buildId !== expectedBuildId) {
      return result(id, operation, 'incompatible', 'ready', descriptor, 'build_mismatch');
    }
    if (options.coordinatorIdentity) {
      if (descriptor.protocolVersion !== options.coordinatorIdentity.protocolVersion) {
        return result(id, operation, 'incompatible', 'ready', descriptor, 'protocol_incompatible');
      }
      if (descriptor.protocolRevision !== options.coordinatorIdentity.protocolRevision) {
        return result(id, operation, 'incompatible', 'ready', descriptor, 'protocol_incompatible');
      }
      if (
        descriptor.clientContractRevision !== options.coordinatorIdentity.clientContractRevision
      ) {
        return result(
          id,
          operation,
          'incompatible',
          'ready',
          descriptor,
          'client_contract_incompatible',
        );
      }
    }
    const status = await inspect(descriptor);
    if (status === 'dead') {
      return result(id, operation, 'unavailable', 'absent', descriptor, 'not_running');
    }
    if (status === 'uncertain') {
      return result(id, operation, 'unavailable', 'ready', descriptor, 'identity_uncertain');
    }
    if (!options.probe) return result(id, operation, 'applied', 'ready', descriptor);
    let handshake: CoordinatorProcessHandshake;
    try {
      handshake = normalizeHandshake(
        await invokeOperation(() =>
          options.probe!.handshake({ descriptor, endpoint: descriptor.endpoint }),
        ),
      );
    } catch {
      handshake = { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
    }
    const diagnostic = handshakeDiagnostic(handshake, descriptor, expectedBuildId);
    if (diagnostic !== undefined) {
      return result(
        id,
        operation,
        diagnostic === 'protocol_incompatible' ||
          diagnostic === 'client_contract_incompatible' ||
          diagnostic === 'build_mismatch'
          ? 'incompatible'
          : 'unavailable',
        'ready',
        descriptor,
        diagnostic,
      );
    }
    return result(id, operation, 'applied', 'ready', descriptor);
  };

  const waitForStopped = async (descriptor: CoordinatorProcessDescriptor): Promise<boolean> => {
    const deadline = Date.now() + operationTimeoutMs;
    while (Date.now() < deadline) {
      const current = await inspect(descriptor);
      if (current === 'dead') return true;
      let state: Awaited<ReturnType<typeof readState>>;
      try {
        state = await readState();
      } catch {
        return false;
      }
      if (state.kind === 'absent') return true;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(25, deadline - Date.now())),
      );
    }
    return false;
  };

  const launch = async (
    id: string,
    request: CoordinatorManagerRequest,
  ): Promise<CoordinatorManagerResult> => {
    const deadline = Date.now() + startupTimeoutMs;
    const launchInvoke = <T>(operation: () => PromiseLike<T>): Promise<T> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(timeoutError('startup'));
      return invoke(operation, remaining, 'startup');
    };
    let environment: CoordinatorProcessEnvironment;
    let executable: CoordinatorProcessExecutable;
    try {
      environment = await launchInvoke(() => options.environment.resolve());
      executable = await launchInvoke(() =>
        options.executableResolver.resolve(request.executableMode ?? 'source'),
      );
    } catch {
      await preserveFailure();
      return result(id, 'ensure', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    if (expectedBuildId !== undefined && executable.buildId !== expectedBuildId) {
      await preserveFailure();
      return result(id, 'ensure', 'incompatible', 'absent', undefined, 'build_mismatch');
    }

    const launchBuildId = executable.buildId ?? expectedBuildId;
    if (launchBuildId === undefined) {
      return result(id, 'ensure', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    const launchIntent = COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA.parse({
      schema: COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA_,
      nonce: randomBytes(24).toString('base64url'),
      buildId: launchBuildId,
      createdAt: new Date().toISOString(),
    });
    try {
      await launchInvoke(() => options.state.publishLaunchIntent(launchIntent));
    } catch {
      await preserveFailure();
      return result(id, 'ensure', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }

    const input = {
      executable,
      args: options.args ?? DEFAULT_COORDINATOR_ARGS,
      cwd: environment.cwd,
      env: Object.freeze({
        ...environment.env,
        ...(executable.buildId === undefined
          ? {}
          : { KITE_COORDINATOR_BUILD_ID: executable.buildId }),
      }),
      detached: true as const,
      stdout: 'ignore' as const,
    };
    let child: CoordinatorProcessChild;
    let spawned: Promise<CoordinatorProcessChild> | undefined;
    try {
      spawned = Promise.resolve().then(() => options.spawn.spawn(input));
      const pendingSpawn = spawned;
      child = await launchInvoke(() => pendingSpawn);
    } catch {
      // A timed-out detached spawn may still resolve. Releasing readiness is the only cleanup
      // authority on this port; it never kills the child.
      if (spawned) {
        void spawned.then(
          (lateChild) => lateChild.readiness.release().catch(() => undefined),
          () => undefined,
        );
      }
      await preserveFailure();
      return result(id, 'ensure', 'outcome_unknown', 'starting', undefined, 'timeout');
    }

    let ready: CoordinatorProcessReadySignal | undefined;
    let readinessError: unknown;
    try {
      ready = await launchInvoke(() => child.waitForReady());
    } catch (error) {
      readinessError = error;
    }
    try {
      await launchInvoke(() => child.readiness.release());
    } catch (error) {
      if (readinessError === undefined) readinessError = error;
    }
    if (readinessError !== undefined || ready === undefined) {
      await preserveFailure();
      return result(id, 'ensure', 'unavailable', 'starting', undefined, 'timeout');
    }
    const readyDiagnostic = assertReadyIdentity(
      ready,
      executable,
      expectedBuildId,
      options.coordinatorIdentity,
    );
    if (ready.pid !== child.pid) {
      await preserveFailure();
      return result(id, 'ensure', 'unavailable', 'starting', undefined, 'identity_uncertain');
    }
    if (readyDiagnostic !== undefined) {
      await preserveFailure();
      return result(
        id,
        'ensure',
        readyDiagnostic === 'protocol_incompatible' ||
          readyDiagnostic === 'client_contract_incompatible' ||
          readyDiagnostic === 'build_mismatch'
          ? 'incompatible'
          : 'unavailable',
        'starting',
        undefined,
        readyDiagnostic,
      );
    }

    let state: Awaited<ReturnType<typeof readState>>;
    try {
      state = await readState();
    } catch {
      await preserveFailure();
      return result(id, 'ensure', 'unavailable', 'starting', undefined, 'identity_uncertain');
    }
    if (
      state.kind !== 'descriptor' ||
      !coordinatorReadyMatchesDescriptor(ready, state.descriptor)
    ) {
      await preserveFailure();
      return result(
        id,
        'ensure',
        'unavailable',
        'starting',
        state.kind === 'descriptor' ? state.descriptor : undefined,
        'identity_uncertain',
      );
    }
    if (!lockMatchesDescriptor(state.instanceLock, state.descriptor)) {
      await preserveFailure();
      return result(
        id,
        'ensure',
        'unavailable',
        'starting',
        state.descriptor,
        'identity_uncertain',
      );
    }
    if (state.endpoint && !endpointMatchesDescriptor(state.endpoint, state.descriptor)) {
      await preserveFailure();
      return result(
        id,
        'ensure',
        'unavailable',
        'starting',
        state.descriptor,
        'identity_uncertain',
      );
    }
    const checked = await probeDescriptor(state.descriptor, 'ensure', id);
    if (checked.outcome === 'applied') {
      return (await clearLaunchIntent(launchIntent))
        ? checked
        : result(id, 'ensure', 'outcome_unknown', 'ready', state.descriptor, 'identity_uncertain');
    }
    return freezeResult({ ...checked, state: checked.state === 'ready' ? 'ready' : checked.state });
  };

  const ensureCore = async (
    id: string,
    request: CoordinatorManagerRequest,
  ): Promise<CoordinatorManagerResult> => {
    const state = await readState();
    const launchIntent = await readLaunchIntent();
    if (launchIntent === 'malformed') {
      return result(id, 'ensure', 'unavailable', 'starting', undefined, 'identity_uncertain');
    }
    if (state.kind === 'malformed') {
      return result(id, 'ensure', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    if (state.kind === 'descriptor') {
      if (
        !lockMatchesDescriptor(state.instanceLock, state.descriptor) ||
        (state.endpoint !== undefined &&
          !endpointMatchesDescriptor(state.endpoint, state.descriptor))
      ) {
        return result(id, 'ensure', 'unavailable', 'ready', state.descriptor, 'identity_uncertain');
      }
      const existing = await probeDescriptor(state.descriptor, 'ensure', id);
      if (existing.outcome !== 'unavailable' || existing.diagnostic !== 'not_running') {
        if (
          existing.outcome === 'applied' &&
          launchIntent !== undefined &&
          !(await clearLaunchIntent(launchIntent))
        ) {
          return result(
            id,
            'ensure',
            'outcome_unknown',
            'ready',
            state.descriptor,
            'identity_uncertain',
          );
        }
        return existing;
      }
      if (!(await clearDescriptorState(state.descriptor, state.instanceLock, state.endpoint))) {
        return result(
          id,
          'ensure',
          'unavailable',
          'absent',
          state.descriptor,
          'identity_uncertain',
        );
      }
      return launch(id, request);
    }
    if (state.kind === 'lock') {
      const processStatus = await inspectProcessIdentity(lockIdentityProbe(state.lock));
      if (processStatus !== 'dead') {
        return result(id, 'ensure', 'unavailable', 'starting', undefined, 'identity_uncertain');
      }
      if (!(await clearLockState(state.lock, state.endpoint))) {
        return result(id, 'ensure', 'unavailable', 'absent', undefined, 'identity_uncertain');
      }
    }
    if (launchIntent !== undefined) {
      return result(id, 'ensure', 'outcome_unknown', 'starting', undefined, 'identity_uncertain');
    }
    return launch(id, request);
  };

  const statusCore = async (id: string): Promise<CoordinatorManagerResult> => {
    const state = await readState();
    const launchIntent = await readLaunchIntent();
    if (launchIntent === 'malformed') {
      return result(id, 'status', 'unavailable', 'starting', undefined, 'identity_uncertain');
    }
    if (state.kind === 'malformed') {
      return result(id, 'status', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    if (state.kind === 'absent' && launchIntent !== undefined)
      return result(id, 'status', 'outcome_unknown', 'starting', undefined, 'identity_uncertain');
    if (state.kind === 'absent')
      return result(id, 'status', 'applied', 'absent', undefined, 'not_running');
    if (state.kind === 'lock') {
      const processStatus = await inspectProcessIdentity(lockIdentityProbe(state.lock));
      if (processStatus === 'dead' && (await clearLockState(state.lock, state.endpoint))) {
        return result(id, 'status', 'applied', 'absent', undefined, 'not_running');
      }
      return result(id, 'status', 'unavailable', 'starting', undefined, 'identity_uncertain');
    }
    if (
      !lockMatchesDescriptor(state.instanceLock, state.descriptor) ||
      (state.endpoint !== undefined && !endpointMatchesDescriptor(state.endpoint, state.descriptor))
    ) {
      return result(id, 'status', 'unavailable', 'ready', state.descriptor, 'identity_uncertain');
    }
    const existing = await probeDescriptor(state.descriptor, 'status', id);
    if (existing.diagnostic !== 'not_running') {
      if (
        existing.outcome === 'applied' &&
        launchIntent !== undefined &&
        !(await clearLaunchIntent(launchIntent))
      ) {
        return result(
          id,
          'status',
          'outcome_unknown',
          'ready',
          state.descriptor,
          'identity_uncertain',
        );
      }
      return existing;
    }
    return (await clearDescriptorState(state.descriptor, state.instanceLock, state.endpoint))
      ? result(id, 'status', 'applied', 'absent', undefined, 'not_running')
      : result(id, 'status', 'unavailable', 'absent', state.descriptor, 'identity_uncertain');
  };

  const stopCore = async (id: string): Promise<CoordinatorManagerResult> => {
    const state = await readState();
    const launchIntent = await readLaunchIntent();
    if (launchIntent === 'malformed') {
      return result(id, 'stop', 'unavailable', 'starting', undefined, 'identity_uncertain');
    }
    if (state.kind === 'malformed') {
      return result(id, 'stop', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    if (state.kind === 'absent' && launchIntent !== undefined)
      return result(id, 'stop', 'outcome_unknown', 'starting', undefined, 'identity_uncertain');
    if (state.kind === 'absent')
      return result(id, 'stop', 'applied', 'absent', undefined, 'not_running');
    if (state.kind === 'lock') {
      const status = await inspectProcessIdentity(lockIdentityProbe(state.lock));
      if (status === 'dead' && (await clearLockState(state.lock, state.endpoint))) {
        return result(id, 'stop', 'applied', 'absent', undefined, 'not_running');
      }
      return result(id, 'stop', 'unavailable', 'starting', undefined, 'identity_uncertain');
    }
    if (
      !lockMatchesDescriptor(state.instanceLock, state.descriptor) ||
      (state.endpoint !== undefined && !endpointMatchesDescriptor(state.endpoint, state.descriptor))
    ) {
      return result(id, 'stop', 'unavailable', 'ready', state.descriptor, 'identity_uncertain');
    }
    const current = await probeDescriptor(state.descriptor, 'stop', id);
    if (current.diagnostic === 'not_running') {
      return (await clearDescriptorState(state.descriptor, state.instanceLock, state.endpoint))
        ? result(id, 'stop', 'applied', 'absent', undefined, 'not_running')
        : result(id, 'stop', 'unavailable', 'absent', state.descriptor, 'identity_uncertain');
    }
    if (current.outcome !== 'applied') return current;
    if (launchIntent !== undefined && !(await clearLaunchIntent(launchIntent))) {
      return result(id, 'stop', 'outcome_unknown', 'ready', state.descriptor, 'identity_uncertain');
    }
    if (!options.stop) {
      return result(id, 'stop', 'unavailable', 'ready', state.descriptor, 'unsupported');
    }
    let stopResult: Awaited<ReturnType<CoordinatorProcessStopPort['stop']>>;
    try {
      stopResult = normalizeStop(
        await invokeOperation(() =>
          options.stop!.stop({ descriptor: state.descriptor, requestId: id }),
        ),
      );
    } catch {
      return result(
        id,
        'stop',
        'outcome_unknown',
        'draining',
        state.descriptor,
        'identity_uncertain',
      );
    }
    if (stopResult.outcome === 'outcome_unknown') {
      return result(
        id,
        'stop',
        'outcome_unknown',
        'draining',
        state.descriptor,
        'identity_uncertain',
      );
    }
    if (stopResult.outcome === 'unavailable') {
      return result(
        id,
        'stop',
        'unavailable',
        'ready',
        state.descriptor,
        stopResult.diagnostic === 'unsupported' ? 'unsupported' : 'identity_uncertain',
      );
    }
    if (!(await waitForStopped(state.descriptor))) {
      return result(id, 'stop', 'outcome_unknown', 'draining', state.descriptor, 'timeout');
    }
    return (await clearDescriptorState(state.descriptor, state.instanceLock, state.endpoint))
      ? result(id, 'stop', 'applied', 'absent', undefined, 'not_running')
      : result(id, 'stop', 'unavailable', 'draining', state.descriptor, 'identity_uncertain');
  };

  const run = <T extends CoordinatorManagerOperation>(
    operation: T,
    request: CoordinatorManagerRequest | undefined,
    callback: (id: string, request: CoordinatorManagerRequest) => Promise<CoordinatorManagerResult>,
  ): Promise<CoordinatorManagerResult> =>
    serial(async () => {
      const id = requestId(request?.requestId);
      if (!managerIdentityAvailable) {
        return result(id, operation, 'unavailable', 'absent', undefined, 'identity_uncertain');
      }
      let leaseResult: CoordinatorManagerResult | undefined;
      try {
        leaseResult = await withLifecycleLock(() => callback(id, request ?? {}));
      } catch {
        return result(id, operation, 'unavailable', 'absent', undefined, 'identity_uncertain');
      }
      return leaseResult ?? result(id, operation, 'busy', 'absent', undefined, 'process_busy');
    });

  return Object.freeze({
    ensure: (request?: CoordinatorManagerRequest) => run('ensure', request, ensureCore),
    status: (request?: CoordinatorManagerRequest) => run('status', request, (id) => statusCore(id)),
    stop: (request?: CoordinatorManagerRequest) => run('stop', request, (id) => stopCore(id)),
  });
}

export const createCoordinatorManager = createCoordinatorProcessManager;

/** Convert an applied ensure/status result into the only data needed to connect a client. */
export function coordinatorManagedConnection(
  value: CoordinatorManagerResult,
): CoordinatorManagedConnection {
  if (
    value.outcome !== 'applied' ||
    value.descriptor === undefined ||
    value.endpoint === undefined
  ) {
    if (value.outcome === 'incompatible') {
      throw new CoordinatorProcessManagerError(
        'incompatible',
        'Coordinator identity is incompatible.',
      );
    }
    if (value.outcome === 'outcome_unknown') {
      throw new CoordinatorProcessManagerError(
        'outcome_unknown',
        'Coordinator lifecycle outcome is unknown.',
      );
    }
    throw new CoordinatorProcessManagerError('unavailable', 'Coordinator is unavailable.');
  }
  return Object.freeze({ descriptor: value.descriptor, endpoint: value.endpoint });
}

export const connectCoordinatorDescriptor = coordinatorManagedConnection;
