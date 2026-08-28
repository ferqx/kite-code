import { randomUUID } from 'node:crypto';
import {
  assertCoordinatorEndpointIdentity,
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorCarrier,
  type CoordinatorCatalog,
  type CoordinatorControlPlane,
  type CoordinatorDispatcher,
  type CoordinatorEndpointDescriptor,
  type CoordinatorIdentity,
  type CoordinatorOsIdentity,
  type CoordinatorProcessDescriptor,
  type CoordinatorProcessLockLease,
  type CoordinatorProcessReadySignal,
  createCoordinatorCarrier,
  createCoordinatorControlPlane,
  createCoordinatorDispatcher,
  createCoordinatorNamedPipeEndpoint,
  createCoordinatorProcessLockIdentity,
  createCoordinatorProcessStatePort,
  createCoordinatorRegistry,
  createCoordinatorUnixSocketEndpoint,
  encodeCoordinatorProcessDescriptor,
  openCoordinatorCatalog,
  writeCoordinatorProcessReadySignal,
} from '@kite-ai/kite-local-runtime/coordinator';
import type {
  KiteCoordinatorComposition,
  KiteCoordinatorCompositionOptions,
  KiteCoordinatorLifecycleResult,
  KiteCoordinatorPhase,
  KiteCoordinatorReadinessPort,
  KiteCoordinatorServer,
  KiteCoordinatorSignal,
  KiteCoordinatorSignalPort,
} from './ports';
/**
 * Compose the one foreground Coordinator process around explicit, already-admitted owners. The
 * composition contains no Runtime Host/Store/Web data plane and never starts Worker/Gateway
 * children itself.
 */
export function createKiteCoordinatorComposition(
  options: KiteCoordinatorCompositionOptions,
): KiteCoordinatorComposition {
  const identity = validateCoordinatorIdentity(options.identity);
  const peerOsIdentity = validateOsIdentity(options.peerOsIdentity);
  const processStartIdentity = validateProcessStartIdentity(options.processStartIdentity);
  const pid = validatePid(options.pid ?? process.pid);
  const startedAt = validateTimestamp(options.startedAt ?? new Date().toISOString());
  if (options.catalogStorage.mode !== 'open_active' || !options.catalogStorage.beforeWrite) {
    throw new TypeError('Coordinator requires an active-layout Catalog identity and write fence.');
  }

  const state = options.state ?? createCoordinatorProcessStatePort(options.home);
  const registry = options.registry ?? createCoordinatorRegistry();
  const endpoint = createEndpoint(options, identity, peerOsIdentity);
  const descriptor = encodeCoordinatorProcessDescriptor({
    schema: 'kite.local-coordinator-process.v1',
    instanceId: identity.instanceId,
    pid,
    startedAt,
    processStartIdentity,
    buildId: identity.buildId,
    protocolVersion: identity.protocolVersion,
    protocolRevision: identity.protocolRevision,
    clientContractRevision: identity.clientContractRevision,
    endpoint,
  });
  const instanceLockIdentity = createCoordinatorProcessLockIdentity({
    kind: 'instance',
    pid,
    instanceId: identity.instanceId,
    startedAt,
    processStartIdentity,
    buildId: identity.buildId,
    operation: 'ensure',
  });

  let phase: KiteCoordinatorPhase = 'absent';
  let catalog: CoordinatorCatalog | undefined;
  let controlPlane: CoordinatorControlPlane | undefined;
  let dispatcher: CoordinatorDispatcher | undefined;
  let carrier: CoordinatorCarrier | undefined;
  let instanceLock: CoordinatorProcessLockLease | undefined;
  let publishedEndpoint: CoordinatorEndpointDescriptor | undefined;
  let publishedDescriptor: CoordinatorProcessDescriptor | undefined;
  let startPromise: Promise<KiteCoordinatorLifecycleResult> | undefined;
  let stopPromise: Promise<KiteCoordinatorLifecycleResult> | undefined;
  let shutdownPromise: Promise<KiteCoordinatorLifecycleResult> | undefined;
  let shutdownResolve: ((result: KiteCoordinatorLifecycleResult) => void) | undefined;
  let pendingStop = false;
  let signalUnsubscribe: (() => void) | undefined;
  let disposed = false;
  let directorySyncTail = Promise.resolve();

  const server: KiteCoordinatorServer = Object.freeze({
    get phase() {
      return phase;
    },
    get descriptor() {
      return publishedDescriptor;
    },
    get instanceLock() {
      return instanceLock;
    },
    start,
    stop,
    waitForShutdown,
    [Symbol.asyncDispose]: async () => {
      await stop();
    },
  });

  if (options.signals) signalUnsubscribe = subscribeSignals(options.signals, onSignal);

  return Object.freeze({
    server,
    state,
    registry,
    get catalog() {
      return catalog;
    },
    get controlPlane() {
      return controlPlane;
    },
    get dispatcher() {
      return dispatcher;
    },
    get carrier() {
      return carrier;
    },
    [Symbol.asyncDispose]: async () => {
      await stop();
    },
  });

  function start(): Promise<KiteCoordinatorLifecycleResult> {
    if (disposed) return Promise.reject(new Error('Coordinator composition is disposed.'));
    if (phase === 'ready') {
      return Promise.resolve({ operation: 'start', outcome: 'applied', state: phase });
    }
    if (phase === 'starting' || phase === 'reconciling') {
      return startPromise!;
    }
    if (phase !== 'absent') {
      return Promise.resolve({
        operation: 'start',
        outcome: 'unavailable',
        state: phase,
        diagnostic: 'startup_failed',
      });
    }
    phase = 'starting';
    startPromise = startOwned();
    return startPromise;
  }

  async function startOwned(): Promise<KiteCoordinatorLifecycleResult> {
    let firstError: unknown;
    try {
      instanceLock = await state.acquireLock('instance', instanceLockIdentity);
      if (!instanceLock) {
        phase = 'absent';
        return { operation: 'start', outcome: 'unavailable', state: phase, diagnostic: 'busy' };
      }

      catalog = openActiveCatalog(options);
      controlPlane = createCoordinatorControlPlane({
        identity,
        catalog,
        registry,
        workers: options.workers,
        gateway: options.gateway,
        beforeDirectoryRead: syncDirectory,
      });
      dispatcher = createCoordinatorDispatcher({
        identity,
        peerOsIdentity,
        handlers: controlPlane.handlers,
        ...(options.now ? { now: options.now } : {}),
      });

      phase = 'reconciling';
      const reconciliation = await options.reconcile.reconcile();
      for (const metadata of reconciliation.sessions ?? []) {
        catalog.upsertSession(metadata);
      }
      registry.reconcile(reconciliation);
      await syncDirectory();
      controlPlane.completeReconcile();

      carrier = createCoordinatorCarrier({
        home: options.home,
        endpoint,
        dispatcher,
        peerOsIdentity,
        ...(options.carrierAdapter ? { adapter: options.carrierAdapter } : {}),
      });
      await carrier.start();

      publishedEndpoint = await state.publishEndpoint(endpoint);
      publishedDescriptor = await state.publishDescriptor(descriptor);
      await publishReadiness(options.readiness, {
        schema: 'kite.local-coordinator-ready.v1',
        instanceId: descriptor.instanceId,
        pid: descriptor.pid,
        startedAt: descriptor.startedAt,
        processStartIdentity: descriptor.processStartIdentity,
        buildId: descriptor.buildId,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
        clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
      });
      phase = 'ready';
      if (pendingStop && !stopPromise) {
        pendingStop = false;
        stopPromise = stopOwned('signal_shutdown');
        void stopPromise.catch(() => undefined);
      }
      return { operation: 'start', outcome: 'applied', state: phase };
    } catch (error) {
      firstError = error;
    }

    const cleaned = await cleanupOwned(firstError);
    if (cleaned) phase = 'absent';
    return {
      operation: 'start',
      outcome: 'unavailable',
      state: phase,
      diagnostic: cleaned ? 'startup_failed' : 'identity_uncertain',
    };
  }

  function stop(): Promise<KiteCoordinatorLifecycleResult> {
    if (stopPromise) return stopPromise;
    if (phase === 'absent') {
      disposed = true;
      unsubscribeSignals();
      const result = { operation: 'stop', outcome: 'applied', state: phase } as const;
      resolveShutdown(result);
      return Promise.resolve(result);
    }
    if (phase === 'starting' || phase === 'reconciling') {
      pendingStop = true;
      stopPromise = (async () => {
        const started = await startPromise!;
        if (started.outcome !== 'applied') {
          disposed = true;
          unsubscribeSignals();
          const stopped = startedAsStop(started);
          resolveShutdown(stopped);
          return stopped;
        }
        return stopOwned('stop');
      })();
      return stopPromise;
    }
    stopPromise = stopOwned('stop');
    return stopPromise;
  }

  async function stopOwned(
    operation: 'stop' | 'signal_shutdown',
  ): Promise<KiteCoordinatorLifecycleResult> {
    if (phase === 'absent') {
      disposed = true;
      unsubscribeSignals();
      const result = { operation, outcome: 'applied', state: phase } as const;
      resolveShutdown(result);
      return result;
    }
    phase = 'draining';
    const cleaned = await cleanupOwned();
    const result: KiteCoordinatorLifecycleResult = cleaned
      ? { operation, outcome: 'applied', state: 'absent' }
      : { operation, outcome: 'unavailable', state: phase, diagnostic: 'shutdown_failed' };
    if (cleaned) phase = 'absent';
    disposed = true;
    unsubscribeSignals();
    resolveShutdown(result);
    return result;
  }

  async function cleanupOwned(firstError?: unknown): Promise<boolean> {
    // The startup error is reported by the caller; only cleanup errors make the
    // owner state uncertain. A failed startup with successful cleanup must be
    // retryable and must not be reported as an identity/ownership failure.
    const failures: unknown[] = [];
    try {
      await carrier?.close();
    } catch (error) {
      failures.push(error);
    }
    carrier = undefined;
    try {
      catalog?.close();
    } catch (error) {
      failures.push(error);
    }
    catalog = undefined;

    try {
      const cleanup = {
        ...(publishedDescriptor ? { descriptor: publishedDescriptor } : {}),
        ...(publishedEndpoint ? { endpoint: publishedEndpoint } : {}),
        ...(instanceLock ? { instanceLock: instanceLock.identity } : {}),
      };
      if (Object.keys(cleanup).length > 0) await state.clearStale(cleanup);
    } catch (error) {
      failures.push(error);
    }
    publishedDescriptor = undefined;
    publishedEndpoint = undefined;
    instanceLock = undefined;
    controlPlane = undefined;
    dispatcher = undefined;
    if (failures.length > 0) {
      try {
        await state.preserveFailure();
      } catch {
        // Preserve the first lifecycle failure; native diagnostics are not surfaced here.
      }
      if (phase !== 'draining') phase = 'draining';
      return false;
    }
    void firstError;
    return true;
  }

  function waitForShutdown(): Promise<KiteCoordinatorLifecycleResult> {
    if (!shutdownPromise) {
      shutdownPromise = new Promise<KiteCoordinatorLifecycleResult>((resolve) => {
        shutdownResolve = resolve;
      });
    }
    return shutdownPromise;
  }

  function syncDirectory(): Promise<void> {
    if (!options.directorySync) return Promise.resolve();
    const operation = directorySyncTail.then(async () => {
      if (!catalog) throw new Error('Coordinator Catalog is unavailable for Directory sync.');
      await options.directorySync!.sync({ catalog, registry });
    });
    directorySyncTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function resolveShutdown(result: KiteCoordinatorLifecycleResult): void {
    shutdownResolve?.(result);
    shutdownResolve = undefined;
  }

  function onSignal(signal: KiteCoordinatorSignal): void {
    if (signal !== 'SIGINT' && signal !== 'SIGTERM') return;
    if (phase === 'starting' || phase === 'reconciling') {
      pendingStop = true;
      return;
    }
    if (stopPromise) return;
    stopPromise = stopOwned('signal_shutdown');
    void stopPromise.catch(() => undefined);
  }

  function unsubscribeSignals(): void {
    try {
      signalUnsubscribe?.();
    } catch {
      // Signal cleanup cannot restore a closed owner.
    }
    signalUnsubscribe = undefined;
  }
}

function openActiveCatalog(options: KiteCoordinatorCompositionOptions): CoordinatorCatalog {
  // The caller supplies the active-layout identity/fence; this function is intentionally not a
  // path resolver and never creates a default Coordinator Catalog location.
  return openCoordinatorCatalog(options.catalogStorage);
}

function createEndpoint(
  options: KiteCoordinatorCompositionOptions,
  identity: CoordinatorIdentity,
  peerOsIdentity: CoordinatorOsIdentity,
): CoordinatorEndpointDescriptor {
  if (options.endpoint) {
    assertCoordinatorEndpointIdentity(options.endpoint, identity);
    if (
      (options.endpoint.transport === 'unix_socket' &&
        (peerOsIdentity.kind !== 'posix_uid' ||
          options.endpoint.owner.kind !== 'posix_uid' ||
          options.endpoint.owner.uid !== peerOsIdentity.uid)) ||
      (options.endpoint.transport === 'named_pipe' &&
        (peerOsIdentity.kind !== 'windows_sid' ||
          options.endpoint.owner.kind !== 'windows_sid' ||
          options.endpoint.owner.sid !== peerOsIdentity.sid))
    ) {
      throw new TypeError('Coordinator endpoint OS owner identity mismatches.');
    }
    return options.endpoint;
  }
  const endpointId = options.endpointId ?? `coordinator-endpoint-${randomUUID()}`;
  return peerOsIdentity.kind === 'posix_uid'
    ? createCoordinatorUnixSocketEndpoint({
        endpointId,
        ownerUid: peerOsIdentity.uid,
        coordinator: identity,
      })
    : createCoordinatorNamedPipeEndpoint({
        endpointId,
        userSid: peerOsIdentity.sid,
        coordinator: identity,
      });
}

function validateCoordinatorIdentity(identity: CoordinatorIdentity): CoordinatorIdentity {
  if (
    identity.role !== 'coordinator' ||
    identity.protocolVersion !== COORDINATOR_PROTOCOL_VERSION ||
    identity.protocolRevision !== COORDINATOR_PROTOCOL_REVISION_ ||
    identity.clientContractRevision !== COORDINATOR_CLIENT_CONTRACT_REVISION_
  ) {
    throw new TypeError('Coordinator identity is incompatible.');
  }
  return identity;
}

function validateOsIdentity(value: KiteCoordinatorCompositionOptions['peerOsIdentity']) {
  if (value.kind === 'posix_uid' && Number.isSafeInteger(value.uid) && value.uid >= 0) return value;
  if (value.kind === 'windows_sid' && /^S-\d-(?:\d+-){1,15}\d+$/u.test(value.sid)) return value;
  throw new TypeError('Coordinator OS identity is invalid.');
}

function validateProcessStartIdentity(value: string): string {
  if (
    value.length === 0 ||
    value.length > 256 ||
    [...value].some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new TypeError('Coordinator process-start identity is invalid.');
  }
  return value;
}

function validatePid(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError('Coordinator PID is invalid.');
  return value;
}

function validateTimestamp(value: string): string {
  if (Number.isNaN(Date.parse(value))) throw new TypeError('Coordinator timestamp is invalid.');
  return value;
}

async function publishReadiness(
  readiness: KiteCoordinatorReadinessPort,
  signal: CoordinatorProcessReadySignal,
): Promise<void> {
  await readiness.publish(signal);
}

function subscribeSignals(
  signals: KiteCoordinatorSignalPort,
  listener: (signal: KiteCoordinatorSignal) => void,
): () => void {
  const unsubscribeInterrupt = signals.subscribe('SIGINT', () => listener('SIGINT'));
  const unsubscribeTerminate = signals.subscribe('SIGTERM', () => listener('SIGTERM'));
  return () => {
    try {
      unsubscribeInterrupt();
    } finally {
      unsubscribeTerminate();
    }
  };
}

function startedAsStop(started: KiteCoordinatorLifecycleResult): KiteCoordinatorLifecycleResult {
  return started.operation === 'stop'
    ? started
    : {
        operation: 'stop',
        outcome: started.outcome,
        state: started.state,
        ...(started.diagnostic ? { diagnostic: started.diagnostic } : {}),
      };
}

export function createCoordinatorProcessSignalPort(
  target: {
    on(signal: KiteCoordinatorSignal, listener: () => void): unknown;
    off(signal: KiteCoordinatorSignal, listener: () => void): unknown;
  } = process,
): KiteCoordinatorSignalPort {
  return Object.freeze({
    subscribe(signal: KiteCoordinatorSignal, listener: () => void): () => void {
      target.on(signal, listener);
      return () => target.off(signal, listener);
    },
  });
}

export function createCoordinatorReadinessPort(fd: number): KiteCoordinatorReadinessPort {
  if (!Number.isSafeInteger(fd) || fd < 0 || fd > 1_024)
    throw new TypeError('Coordinator readiness fd is invalid.');
  let published = false;
  return Object.freeze({
    publish(signal: CoordinatorProcessReadySignal): void {
      if (published) throw new Error('Coordinator readiness was already published.');
      writeCoordinatorProcessReadySignal(signal, fd);
      published = true;
    },
  });
}
