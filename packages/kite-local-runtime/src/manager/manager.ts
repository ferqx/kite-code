import {
  encodeLocalRuntimeLifecycleResult,
  LOCAL_RUNTIME_LIFECYCLE_RESULT_SCHEMA_,
  type LocalRuntimeLifecycleResult,
} from '../client';
import {
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  type LocalRuntimeServiceDescriptor,
  safeDecodeLocalRuntimeServiceDescriptor,
  safeDecodeLocalRuntimeToken,
  safeDecodeLocalServiceLockIdentity,
} from '../service';
import type {
  KiteServiceManager,
  KiteServiceManagerControlResult,
  KiteServiceManagerExecutable,
  KiteServiceManagerHandshake,
  KiteServiceManagerLifecycleLockLease,
  KiteServiceManagerOptions,
  KiteServiceManagerProcessStatus,
  KiteServiceManagerReadinessHandle,
  KiteServiceManagerRequest,
} from './ports';

const DEFAULT_PROTOCOL_VERSION = 1;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

type LifecycleOperation = 'ensure' | 'status' | 'stop' | 'restart';
type LifecycleState = 'absent' | 'starting' | 'ready' | 'quiescing' | 'draining';
type LifecycleDiagnostic =
  | 'not_running'
  | 'identity_uncertain'
  | 'protocol_incompatible'
  | 'client_contract_incompatible'
  | 'build_mismatch'
  | 'service_busy';

interface ManagerRuntimeOptions {
  readonly protocolVersion: number;
  readonly clientContractRevision: string;
  readonly expectedBuildId?: string;
  readonly startupTimeoutMs: number;
  readonly operationTimeoutMs: number;
}

interface DecodedDescriptor {
  readonly descriptor?: LocalRuntimeServiceDescriptor;
  readonly diagnostic?:
    | 'protocol_incompatible'
    | 'client_contract_incompatible'
    | 'identity_uncertain';
}

type DescriptorlessInstanceState =
  | { readonly status: 'absent' }
  | { readonly status: KiteServiceManagerProcessStatus; readonly pid: number }
  | { readonly status: 'invalid' };

let generatedRequestId = 0;

function timeoutError(operation: string): Error {
  return new Error(`Service ${operation} deadline exceeded.`);
}

function boundedTimeout(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0 || result > MAX_TIMEOUT_MS) {
    throw new RangeError(`${label} timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`);
  }
  const normalized = Math.floor(result);
  if (normalized < 1) {
    throw new RangeError(`${label} timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`);
  }
  return normalized;
}

function withTimeout<T>(promise: PromiseLike<T>, duration: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(operation)), duration);
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function invoke<T>(operation: () => PromiseLike<T>, duration: number, label: string): Promise<T> {
  // Deferring the callback also turns a synchronous port throw into a bounded Promise failure.
  return withTimeout(Promise.resolve().then(operation), duration, label);
}

function safeRequestId(value: string | undefined): string {
  const requestId = value ?? `service-manager-${++generatedRequestId}`;
  if (
    requestId.length === 0 ||
    requestId.length > 512 ||
    [...requestId].some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new TypeError(
      'Service manager requestId must be a bounded string without control characters.',
    );
  }
  return requestId;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function descriptorDiagnostic(
  raw: unknown,
  expectedProtocol: number,
  expectedContract: string,
): DecodedDescriptor {
  if (!isRecord(raw)) return { diagnostic: 'identity_uncertain' };
  if (raw.protocolVersion !== expectedProtocol) return { diagnostic: 'protocol_incompatible' };
  if (raw.clientContractRevision !== expectedContract) {
    return { diagnostic: 'client_contract_incompatible' };
  }
  return { diagnostic: 'identity_uncertain' };
}

function decodeDescriptor(
  raw: unknown,
  expectedProtocol: number,
  expectedContract: string,
): DecodedDescriptor {
  if (raw === undefined) return {};
  const decoded = safeDecodeLocalRuntimeServiceDescriptor(raw);
  if (decoded.success) return { descriptor: decoded.data };
  return descriptorDiagnostic(raw, expectedProtocol, expectedContract);
}

function normalizeHandshake(value: unknown): KiteServiceManagerHandshake {
  try {
    if (!isRecord(value)) return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
    const outcome = value.outcome;
    if (outcome !== 'healthy' && outcome !== 'incompatible' && outcome !== 'unavailable') {
      return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
    }
    const instanceId = typeof value.instanceId === 'string' ? value.instanceId : undefined;
    const protocolVersion =
      typeof value.protocolVersion === 'number' ? value.protocolVersion : undefined;
    const clientContractRevision =
      typeof value.clientContractRevision === 'string' ? value.clientContractRevision : undefined;
    const serverVersion = typeof value.serverVersion === 'string' ? value.serverVersion : undefined;
    const buildId = typeof value.buildId === 'string' ? value.buildId : undefined;
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
      ...(instanceId !== undefined ? { instanceId } : {}),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      ...(clientContractRevision !== undefined ? { clientContractRevision } : {}),
      ...(serverVersion !== undefined ? { serverVersion } : {}),
      ...(buildId !== undefined ? { buildId } : {}),
      ...(diagnostic !== undefined ? { diagnostic } : {}),
    };
  } catch {
    return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
  }
}

function result(
  requestId: string,
  operation: LifecycleOperation,
  outcome: LocalRuntimeLifecycleResult['outcome'],
  state: LifecycleState,
  descriptor?: LocalRuntimeServiceDescriptor,
  diagnostic?: LifecycleDiagnostic,
): LocalRuntimeLifecycleResult {
  return encodeLocalRuntimeLifecycleResult({
    schema: LOCAL_RUNTIME_LIFECYCLE_RESULT_SCHEMA_,
    requestId,
    operation,
    outcome,
    state,
    ...(descriptor ? { descriptor } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  });
}

function diagnosticForHandshake(
  handshake: KiteServiceManagerHandshake,
  runtime: ManagerRuntimeOptions,
  descriptor: LocalRuntimeServiceDescriptor,
): LifecycleDiagnostic | undefined {
  if (descriptor.protocolVersion !== runtime.protocolVersion) return 'protocol_incompatible';
  if (descriptor.clientContractRevision !== runtime.clientContractRevision) {
    return 'client_contract_incompatible';
  }
  if (handshake.outcome === 'incompatible') {
    if (handshake.diagnostic === 'protocol_incompatible') return 'protocol_incompatible';
    if (handshake.diagnostic === 'client_contract_incompatible') {
      return 'client_contract_incompatible';
    }
    if (handshake.protocolVersion !== runtime.protocolVersion) return 'protocol_incompatible';
    if (handshake.clientContractRevision !== runtime.clientContractRevision) {
      return 'client_contract_incompatible';
    }
    return 'identity_uncertain';
  }
  if (handshake.outcome === 'unavailable') {
    // `service_unavailable` is an internal control-port label. The public lifecycle result has
    // deliberately narrower diagnostics, so it is fail-closed as identity uncertainty.
    return handshake.diagnostic === 'protocol_incompatible'
      ? 'protocol_incompatible'
      : handshake.diagnostic === 'client_contract_incompatible'
        ? 'client_contract_incompatible'
        : 'identity_uncertain';
  }
  if (handshake.instanceId === undefined) return 'identity_uncertain';
  if (handshake.protocolVersion !== runtime.protocolVersion) return 'protocol_incompatible';
  if (handshake.clientContractRevision !== runtime.clientContractRevision) {
    return 'client_contract_incompatible';
  }
  if (
    handshake.serverVersion === undefined ||
    handshake.serverVersion !== descriptor.serverVersion ||
    handshake.buildId === undefined ||
    handshake.buildId !== descriptor.buildId
  ) {
    return 'identity_uncertain';
  }
  return runtime.expectedBuildId !== undefined && handshake.buildId !== runtime.expectedBuildId
    ? 'build_mismatch'
    : undefined;
}

function controlDiagnostic(
  diagnostic: KiteServiceManagerControlResult['diagnostic'],
): LifecycleDiagnostic {
  if (diagnostic === 'service_busy') return 'service_busy';
  // `service_unavailable` has no wire-level lifecycle diagnostic. Do not leak a new public
  // diagnostic; preserve the fail-closed identity uncertainty contract.
  if (diagnostic === 'identity_uncertain' || diagnostic === 'service_unavailable') {
    return 'identity_uncertain';
  }
  return 'identity_uncertain';
}

function normalizeControlResult(value: unknown): KiteServiceManagerControlResult {
  try {
    if (!isRecord(value)) return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
    const outcome = value.outcome;
    if (
      outcome !== 'applied' &&
      outcome !== 'service_busy' &&
      outcome !== 'outcome_unknown' &&
      outcome !== 'unavailable'
    ) {
      return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
    }
    const diagnostic =
      value.diagnostic === 'service_busy' ||
      value.diagnostic === 'service_unavailable' ||
      value.diagnostic === 'identity_uncertain'
        ? value.diagnostic
        : undefined;
    if (
      (outcome === 'applied' && diagnostic !== undefined) ||
      (outcome === 'service_busy' && diagnostic !== undefined && diagnostic !== 'service_busy') ||
      (outcome !== 'service_busy' && diagnostic === 'service_busy')
    ) {
      return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
    }
    return diagnostic === undefined ? { outcome } : { outcome, diagnostic };
  } catch {
    return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
  }
}

function isLifecycleResult(value: unknown): value is LocalRuntimeLifecycleResult {
  return (
    isRecord(value) && typeof value.operation === 'string' && typeof value.outcome === 'string'
  );
}

/**
 * App-private Service lifecycle manager. All process/filesystem/network behavior is injected;
 * this object owns only serial orchestration and identity decisions.
 */
export function createKiteServiceManager(options: KiteServiceManagerOptions): KiteServiceManager {
  const runtime: ManagerRuntimeOptions = {
    protocolVersion: options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    clientContractRevision:
      options.clientContractRevision ?? LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    ...(options.expectedBuildId ? { expectedBuildId: options.expectedBuildId } : {}),
    startupTimeoutMs: boundedTimeout(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      'startup',
    ),
    operationTimeoutMs: boundedTimeout(
      options.operationTimeoutMs,
      DEFAULT_OPERATION_TIMEOUT_MS,
      'operation',
    ),
  };

  let serialTail = Promise.resolve();

  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = serialTail.then(operation, operation);
    // A failed operation must not poison the queue for subsequent status/ensure calls.
    serialTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  const boundedInvoke = <T>(operation: () => PromiseLike<T>): Promise<T> =>
    invoke(operation, runtime.operationTimeoutMs, 'operation');

  const preserveFailure = async (): Promise<void> => {
    try {
      await boundedInvoke(() => options.state.preserveFailure());
    } catch {
      // Failure evidence is best effort; never replace the lifecycle decision with a token/path
      // bearing native exception.
    }
  };

  const acquireLock = async (
    operation: LifecycleOperation,
  ): Promise<KiteServiceManagerLifecycleLockLease | undefined> => {
    let lease: KiteServiceManagerLifecycleLockLease | undefined;
    try {
      lease = await boundedInvoke(() => options.lifecycleLock.acquire(operation));
    } catch {
      return undefined;
    }
    if (lease) return lease;

    let inspected: Awaited<ReturnType<typeof options.lifecycleLock.inspect>>;
    try {
      inspected = await boundedInvoke(() => options.lifecycleLock.inspect());
    } catch {
      return undefined;
    }
    if (inspected.status === 'absent') {
      try {
        return await boundedInvoke(() => options.lifecycleLock.acquire(operation));
      } catch {
        return undefined;
      }
    }
    // Only a positively dead owner can be quarantined. Alive and uncertain owners both fail
    // closed, avoiding a second process or an unsafe lock/state deletion.
    if (inspected.status !== 'dead') return undefined;
    try {
      await boundedInvoke(() => options.lifecycleLock.quarantineStale());
      return await boundedInvoke(() => options.lifecycleLock.acquire(operation));
    } catch {
      return undefined;
    }
  };

  const withLock = async <T>(
    operation: LifecycleOperation,
    requestId: string,
    callback: () => Promise<T>,
  ): Promise<T> => {
    const lease = await acquireLock(operation);
    if (!lease) {
      return result(
        requestId,
        operation,
        'unavailable',
        'absent',
        undefined,
        'identity_uncertain',
      ) as T;
    }

    let value: T | undefined;
    let callbackError: unknown;
    try {
      value = await callback();
    } catch (error) {
      callbackError = error;
    }

    let releaseError: unknown;
    try {
      await boundedInvoke(() => lease.release());
    } catch (error) {
      releaseError = error;
      await preserveFailure();
    }

    if (callbackError !== undefined) {
      if (releaseError !== undefined) throw new AggregateError([callbackError, releaseError]);
      throw callbackError;
    }
    if (releaseError !== undefined) {
      if (value !== undefined && isLifecycleResult(value)) {
        return result(
          requestId,
          operation,
          'unavailable',
          'draining',
          value.descriptor,
          'identity_uncertain',
        ) as T;
      }
      throw releaseError;
    }
    return value as T;
  };

  const invalidContract = (
    requestId: string,
    operation: LifecycleOperation,
  ): LocalRuntimeLifecycleResult =>
    result(
      requestId,
      operation,
      'incompatible',
      'absent',
      undefined,
      'client_contract_incompatible',
    );

  const validateRequest = (
    request: KiteServiceManagerRequest | undefined,
    operation: LifecycleOperation,
  ):
    | { readonly requestId: string; readonly request: KiteServiceManagerRequest }
    | LocalRuntimeLifecycleResult => {
    const requestId = safeRequestId(request?.requestId);
    const normalized = request ?? {};
    if (
      normalized.clientContractRevision !== undefined &&
      normalized.clientContractRevision !== runtime.clientContractRevision
    ) {
      return invalidContract(requestId, operation);
    }
    if (
      normalized.executableMode !== undefined &&
      normalized.executableMode !== 'source' &&
      normalized.executableMode !== 'installed'
    ) {
      return result(requestId, operation, 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    return { requestId, request: normalized };
  };

  const inspectProcess = async (pid: number): Promise<KiteServiceManagerProcessStatus> => {
    try {
      return await boundedInvoke(() => options.process.inspect(pid));
    } catch {
      return 'uncertain';
    }
  };

  const inspectDescriptorlessInstance = async (): Promise<DescriptorlessInstanceState> => {
    let raw: unknown | undefined;
    try {
      raw = await boundedInvoke(() => options.state.readInstanceLock());
    } catch {
      return { status: 'invalid' };
    }
    if (raw === undefined) return { status: 'absent' };
    const decoded = safeDecodeLocalServiceLockIdentity(raw);
    if (!decoded.success) return { status: 'invalid' };
    return { status: await inspectProcess(decoded.data.pid), pid: decoded.data.pid };
  };

  const descriptorHasMatchingInstanceLock = async (
    descriptor: LocalRuntimeServiceDescriptor,
  ): Promise<boolean> => {
    let raw: unknown | undefined;
    try {
      raw = await boundedInvoke(() => options.state.readInstanceLock());
    } catch {
      return false;
    }
    if (raw === undefined) return false;
    const decoded = safeDecodeLocalServiceLockIdentity(raw);
    return (
      decoded.success &&
      decoded.data.pid === descriptor.pid &&
      decoded.data.instanceId === descriptor.instanceId
    );
  };

  const readToken = async (kind: 'access' | 'control'): Promise<string | undefined> => {
    let raw: string | undefined;
    try {
      raw = await boundedInvoke(() => options.state.readToken(kind));
    } catch {
      return undefined;
    }
    if (raw === undefined) return undefined;
    const decoded = safeDecodeLocalRuntimeToken(raw);
    return decoded.success ? decoded.data : undefined;
  };

  const clearDeadState = async (): Promise<boolean> => {
    try {
      await boundedInvoke(() => options.state.clearStale());
      return true;
    } catch {
      return false;
    }
  };

  const waitForAppliedStop = async (
    descriptor: LocalRuntimeServiceDescriptor,
  ): Promise<boolean> => {
    const deadline = Date.now() + runtime.operationTimeoutMs;
    const remaining = (): number => {
      const value = deadline - Date.now();
      if (value <= 0) throw timeoutError('stop');
      return value;
    };
    const withinDeadline = <T>(operation: () => PromiseLike<T>): Promise<T> =>
      invoke(operation, remaining(), 'stop');
    try {
      while (true) {
        const [rawDescriptor, rawLock, accessToken, controlToken] = await Promise.all([
          withinDeadline(() => options.state.readDescriptor()),
          withinDeadline(() => options.state.readInstanceLock()),
          withinDeadline(() => options.state.readToken('access')),
          withinDeadline(() => options.state.readToken('control')),
        ]);
        if (
          rawDescriptor === undefined &&
          rawLock === undefined &&
          accessToken === undefined &&
          controlToken === undefined
        ) {
          return true;
        }

        let ownerPid = descriptor.pid;
        if (rawDescriptor !== undefined) {
          const decoded = decodeDescriptor(
            rawDescriptor,
            runtime.protocolVersion,
            runtime.clientContractRevision,
          );
          if (!decoded.descriptor || decoded.descriptor.instanceId !== descriptor.instanceId) {
            return false;
          }
          ownerPid = decoded.descriptor.pid;
        } else if (rawLock !== undefined) {
          const decoded = safeDecodeLocalServiceLockIdentity(rawLock);
          if (!decoded.success || decoded.data.instanceId !== descriptor.instanceId) return false;
          ownerPid = decoded.data.pid;
        }

        const processStatus = await withinDeadline(() => options.process.inspect(ownerPid));
        if (processStatus === 'dead') {
          await withinDeadline(() => options.state.clearStale());
          continue;
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(10, Math.max(1, remaining()))),
        );
      }
    } catch {
      return false;
    }
  };

  const probeExisting = async (
    requestId: string,
    operation: LifecycleOperation,
    descriptor: LocalRuntimeServiceDescriptor,
  ): Promise<LocalRuntimeLifecycleResult> => {
    if (!(await descriptorHasMatchingInstanceLock(descriptor))) {
      return result(requestId, operation, 'unavailable', 'ready', descriptor, 'identity_uncertain');
    }
    const accessToken = await readToken('access');
    if (accessToken === undefined) {
      return result(requestId, operation, 'unavailable', 'ready', descriptor, 'identity_uncertain');
    }

    let handshake: KiteServiceManagerHandshake;
    try {
      handshake = normalizeHandshake(
        await boundedInvoke(() => options.probe.handshake({ descriptor, accessToken })),
      );
    } catch {
      handshake = { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
    }
    const diagnostic = diagnosticForHandshake(handshake, runtime, descriptor);
    if (diagnostic) {
      if (handshake.outcome !== 'unavailable') {
        const outcome = diagnostic === 'identity_uncertain' ? 'unavailable' : 'incompatible';
        return result(requestId, operation, outcome, 'ready', descriptor, diagnostic);
      }
      const processStatus = await inspectProcess(descriptor.pid);
      if (processStatus === 'dead') {
        return result(requestId, operation, 'unavailable', 'absent', descriptor, 'not_running');
      }
      // Alive and uncertain are deliberately indistinguishable to callers: neither permits
      // stale cleanup or a replacement spawn.
      return result(requestId, operation, 'unavailable', 'ready', descriptor, 'identity_uncertain');
    }
    if (handshake.instanceId !== descriptor.instanceId) {
      return result(requestId, operation, 'unavailable', 'ready', descriptor, 'identity_uncertain');
    }
    return result(requestId, operation, 'applied', 'ready', descriptor);
  };

  const launchFailure = async (
    requestId: string,
    operation: LifecycleOperation,
    diagnostic: LifecycleDiagnostic = 'identity_uncertain',
    state: LifecycleState = 'absent',
    descriptor?: LocalRuntimeServiceDescriptor,
    outcome: LocalRuntimeLifecycleResult['outcome'] = diagnostic === 'protocol_incompatible' ||
    diagnostic === 'client_contract_incompatible'
      ? 'incompatible'
      : 'unavailable',
  ): Promise<LocalRuntimeLifecycleResult> => {
    await preserveFailure();
    return result(requestId, operation, outcome, state, descriptor, diagnostic);
  };

  const launch = async (
    requestId: string,
    operation: LifecycleOperation,
    request: KiteServiceManagerRequest,
  ): Promise<LocalRuntimeLifecycleResult> => {
    const deadline = Date.now() + runtime.startupTimeoutMs;
    const launchInvoke = <T>(action: () => PromiseLike<T>): Promise<T> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(timeoutError('startup'));
      return invoke(action, remaining, 'startup');
    };
    let environment: Awaited<ReturnType<typeof options.environment.resolve>>;
    let executable: KiteServiceManagerExecutable;
    try {
      environment = await launchInvoke(() => options.environment.resolve());
      executable = await launchInvoke(() =>
        options.executableResolver.resolve(request.executableMode ?? 'source'),
      );
    } catch {
      return launchFailure(requestId, operation);
    }
    if (runtime.expectedBuildId !== undefined && executable.buildId !== runtime.expectedBuildId) {
      return launchFailure(requestId, operation, 'build_mismatch');
    }

    let child: Awaited<ReturnType<typeof options.spawn.spawn>>;
    const spawned = Promise.resolve().then(() =>
      options.spawn.spawn({
        executable,
        args: ['service', 'run'],
        cwd: environment.cwd,
        env: Object.freeze({
          ...environment.env,
          ...(executable.buildId === undefined
            ? {}
            : { KITE_SERVICE_BUILD_ID: executable.buildId }),
        }),
        detached: true,
        stdout: 'ignore',
      }),
    );
    try {
      child = await launchInvoke(() => spawned);
    } catch {
      // A timed-out detached spawn may still resolve. Release only its readiness resource; there
      // is deliberately no kill/terminate authority on this port.
      void spawned.then(
        async (lateChild) => {
          try {
            await boundedInvoke(() => lateChild.readiness.release());
          } catch {
            await preserveFailure();
          }
        },
        () => undefined,
      );
      return launchFailure(requestId, operation);
    }

    let readinessReleased = false;
    const releaseReadiness = async (): Promise<unknown> => {
      if (readinessReleased) return undefined;
      readinessReleased = true;
      let handle: KiteServiceManagerReadinessHandle | undefined;
      try {
        handle = child?.readiness;
      } catch (error) {
        return error;
      }
      if (!handle || typeof handle.release !== 'function') {
        return new TypeError('Service child readiness handle is unavailable.');
      }
      try {
        await boundedInvoke(() => handle.release());
        return undefined;
      } catch (error) {
        return error;
      }
    };

    let readiness: Awaited<ReturnType<typeof child.waitForReady>> | undefined;
    let readinessError: unknown;
    try {
      readiness = await launchInvoke(() => child.waitForReady());
    } catch (error) {
      readinessError = error;
    }
    const releaseError = await releaseReadiness();
    if (readinessError !== undefined || releaseError !== undefined) {
      return launchFailure(requestId, operation);
    }
    let readinessInstanceId: unknown;
    try {
      readinessInstanceId = readiness?.instanceId;
    } catch {
      return launchFailure(requestId, operation);
    }
    if (
      typeof readinessInstanceId !== 'string' ||
      readinessInstanceId.length === 0 ||
      readinessInstanceId.length > 512 ||
      [...readinessInstanceId].some((character) => /\p{Cc}/u.test(character))
    ) {
      return launchFailure(requestId, operation);
    }

    let decoded: DecodedDescriptor;
    try {
      decoded = decodeDescriptor(
        await launchInvoke(() => options.state.readDescriptor()),
        runtime.protocolVersion,
        runtime.clientContractRevision,
      );
    } catch {
      decoded = { diagnostic: 'identity_uncertain' };
    }
    if (!decoded.descriptor) {
      const diagnostic = decoded.diagnostic ?? 'identity_uncertain';
      return launchFailure(
        requestId,
        operation,
        diagnostic,
        'absent',
        undefined,
        diagnostic === 'identity_uncertain' ? 'unavailable' : 'incompatible',
      );
    }
    const descriptor = decoded.descriptor;
    if (descriptor.instanceId !== readinessInstanceId) {
      return launchFailure(requestId, operation, 'identity_uncertain', 'absent', descriptor);
    }
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.pid !== descriptor.pid) {
      return launchFailure(requestId, operation, 'identity_uncertain', 'absent', descriptor);
    }
    if (!(await descriptorHasMatchingInstanceLock(descriptor))) {
      return launchFailure(requestId, operation, 'identity_uncertain', 'ready', descriptor);
    }

    let accessToken: string | undefined;
    try {
      const raw = await launchInvoke(() => options.state.readToken('access'));
      const decodedToken = raw === undefined ? undefined : safeDecodeLocalRuntimeToken(raw);
      accessToken = decodedToken?.success ? decodedToken.data : undefined;
    } catch {
      return launchFailure(requestId, operation, 'identity_uncertain', 'ready', descriptor);
    }
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return launchFailure(requestId, operation, 'identity_uncertain', 'ready', descriptor);
    }

    let handshake: KiteServiceManagerHandshake;
    try {
      handshake = normalizeHandshake(
        await launchInvoke(() => options.probe.handshake({ descriptor, accessToken })),
      );
    } catch {
      return launchFailure(requestId, operation, 'identity_uncertain', 'ready', descriptor);
    }
    const diagnostic = diagnosticForHandshake(handshake, runtime, descriptor);
    if (diagnostic) {
      return launchFailure(
        requestId,
        operation,
        diagnostic,
        'ready',
        descriptor,
        diagnostic === 'identity_uncertain' ? 'unavailable' : 'incompatible',
      );
    }
    if (handshake.instanceId !== descriptor.instanceId) {
      return launchFailure(requestId, operation, 'identity_uncertain', 'ready', descriptor);
    }
    return result(requestId, operation, 'applied', 'ready', descriptor);
  };

  const ensureCore = async (
    requestId: string,
    request: KiteServiceManagerRequest,
  ): Promise<LocalRuntimeLifecycleResult> => {
    let rawDescriptor: unknown | undefined;
    try {
      rawDescriptor = await boundedInvoke(() => options.state.readDescriptor());
    } catch {
      return result(requestId, 'ensure', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    const decoded = decodeDescriptor(
      rawDescriptor,
      runtime.protocolVersion,
      runtime.clientContractRevision,
    );
    if (decoded.descriptor) {
      const existing = await probeExisting(requestId, 'ensure', decoded.descriptor);
      if (existing.outcome !== 'unavailable' || existing.diagnostic !== 'not_running')
        return existing;
      try {
        // This path is reached only after a positive dead-PID observation from probeExisting.
        await boundedInvoke(() => options.state.clearStale());
      } catch {
        return result(
          requestId,
          'ensure',
          'unavailable',
          'absent',
          decoded.descriptor,
          'identity_uncertain',
        );
      }
      return launch(requestId, 'ensure', request);
    }
    if (rawDescriptor !== undefined) {
      const diagnostic = decoded.diagnostic ?? 'identity_uncertain';
      return result(
        requestId,
        'ensure',
        diagnostic === 'identity_uncertain' ? 'unavailable' : 'incompatible',
        'absent',
        undefined,
        diagnostic,
      );
    }
    const instance = await inspectDescriptorlessInstance();
    if (instance.status === 'absent') return launch(requestId, 'ensure', request);
    if (instance.status === 'dead') {
      if (!(await clearDeadState())) {
        return result(
          requestId,
          'ensure',
          'unavailable',
          'absent',
          undefined,
          'identity_uncertain',
        );
      }
      return launch(requestId, 'ensure', request);
    }
    return result(requestId, 'ensure', 'unavailable', 'starting', undefined, 'identity_uncertain');
  };

  const statusCore = async (requestId: string): Promise<LocalRuntimeLifecycleResult> => {
    let rawDescriptor: unknown | undefined;
    try {
      rawDescriptor = await boundedInvoke(() => options.state.readDescriptor());
    } catch {
      return result(requestId, 'status', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    const decoded = decodeDescriptor(
      rawDescriptor,
      runtime.protocolVersion,
      runtime.clientContractRevision,
    );
    if (decoded.descriptor) {
      const existing = await probeExisting(requestId, 'status', decoded.descriptor);
      if (
        existing.outcome === 'unavailable' &&
        existing.state === 'absent' &&
        existing.diagnostic === 'not_running'
      ) {
        return (await clearDeadState())
          ? result(requestId, 'status', 'applied', 'absent', undefined, 'not_running')
          : result(requestId, 'status', 'unavailable', 'absent', undefined, 'identity_uncertain');
      }
      return existing;
    }
    if (rawDescriptor !== undefined) {
      const diagnostic = decoded.diagnostic ?? 'identity_uncertain';
      return result(
        requestId,
        'status',
        diagnostic === 'identity_uncertain' ? 'unavailable' : 'incompatible',
        'absent',
        undefined,
        diagnostic,
      );
    }
    const instance = await inspectDescriptorlessInstance();
    if (instance.status === 'absent') {
      return result(requestId, 'status', 'applied', 'absent', undefined, 'not_running');
    }
    if (instance.status === 'dead') {
      return (await clearDeadState())
        ? result(requestId, 'status', 'applied', 'absent', undefined, 'not_running')
        : result(requestId, 'status', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    return result(requestId, 'status', 'unavailable', 'starting', undefined, 'identity_uncertain');
  };

  const stopCore = async (
    requestId: string,
    operation: 'stop' | 'restart',
  ): Promise<LocalRuntimeLifecycleResult> => {
    let rawDescriptor: unknown | undefined;
    try {
      rawDescriptor = await boundedInvoke(() => options.state.readDescriptor());
    } catch {
      return result(requestId, operation, 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    const decoded = decodeDescriptor(
      rawDescriptor,
      runtime.protocolVersion,
      runtime.clientContractRevision,
    );
    if (!decoded.descriptor) {
      if (rawDescriptor === undefined) {
        const instance = await inspectDescriptorlessInstance();
        if (instance.status === 'absent') {
          return result(requestId, operation, 'applied', 'absent', undefined, 'not_running');
        }
        if (instance.status === 'dead' && (await clearDeadState())) {
          return result(requestId, operation, 'applied', 'absent', undefined, 'not_running');
        }
        return result(
          requestId,
          operation,
          'unavailable',
          'starting',
          undefined,
          'identity_uncertain',
        );
      }
      const diagnostic = decoded.diagnostic ?? 'identity_uncertain';
      return result(
        requestId,
        operation,
        diagnostic === 'identity_uncertain' ? 'unavailable' : 'incompatible',
        'absent',
        undefined,
        diagnostic,
      );
    }
    const descriptor = decoded.descriptor;
    if (!(await descriptorHasMatchingInstanceLock(descriptor))) {
      return result(requestId, operation, 'unavailable', 'ready', descriptor, 'identity_uncertain');
    }
    const controlToken = await readToken('control');
    if (controlToken === undefined) {
      return result(requestId, operation, 'unavailable', 'ready', descriptor, 'identity_uncertain');
    }

    let control: KiteServiceManagerControlResult;
    try {
      control = normalizeControlResult(
        await boundedInvoke(() => options.control.stop({ descriptor, controlToken, requestId })),
      );
    } catch {
      return result(requestId, operation, 'unavailable', 'ready', descriptor, 'identity_uncertain');
    }
    if (control.outcome === 'service_busy') {
      return result(requestId, operation, 'service_busy', 'ready', descriptor, 'service_busy');
    }
    if (control.outcome === 'outcome_unknown') {
      return result(requestId, operation, 'outcome_unknown', 'ready', descriptor);
    }
    if (control.outcome === 'unavailable') {
      return result(
        requestId,
        operation,
        'unavailable',
        'ready',
        descriptor,
        controlDiagnostic(control.diagnostic),
      );
    }
    // `applied` acknowledges the quiesce/drain request; the Service remains the state owner and
    // removes descriptor/token/instance.lock only after carrier/application cleanup. The manager
    // holds lifecycle.lock while it waits. A crashed child is cleaned only after a dead PID.
    if (!(await waitForAppliedStop(descriptor))) {
      await preserveFailure();
      return result(
        requestId,
        operation,
        'unavailable',
        'draining',
        descriptor,
        'identity_uncertain',
      );
    }
    return result(requestId, operation, 'applied', 'absent', undefined, 'not_running');
  };

  const operation = (
    operationName: LifecycleOperation,
    request: KiteServiceManagerRequest | undefined,
    callback: (
      requestId: string,
      normalized: KiteServiceManagerRequest,
    ) => Promise<LocalRuntimeLifecycleResult>,
  ): Promise<LocalRuntimeLifecycleResult> => {
    let checked:
      | { readonly requestId: string; readonly request: KiteServiceManagerRequest }
      | LocalRuntimeLifecycleResult;
    try {
      checked = validateRequest(request, operationName);
    } catch (error) {
      return Promise.reject(error);
    }
    if ('operation' in checked) return Promise.resolve(checked);
    return serial(() =>
      withLock(operationName, checked.requestId, () =>
        callback(checked.requestId, checked.request),
      ),
    );
  };

  return Object.freeze({
    ensure(request: KiteServiceManagerRequest | undefined) {
      return operation('ensure', request, ensureCore);
    },
    status(request: KiteServiceManagerRequest | undefined) {
      return operation('status', request, (requestId) => statusCore(requestId));
    },
    stop(request: KiteServiceManagerRequest | undefined) {
      return operation('stop', request, (requestId) => stopCore(requestId, 'stop'));
    },
    restart(request: KiteServiceManagerRequest | undefined) {
      return operation('restart', request, async (requestId, normalized) => {
        const stopped = await stopCore(requestId, 'restart');
        if (stopped.outcome !== 'applied') return stopped;
        const ensured = await ensureCore(requestId, normalized);
        return encodeLocalRuntimeLifecycleResult({ ...ensured, operation: 'restart' });
      });
    },
  });
}
