import type {
  KiteRuntimeApplicationPort,
  KiteServiceDiagnostic,
  KiteServiceLifecycleResult,
  KiteServicePhase,
  KiteServiceReadiness,
  KiteServiceReadinessPort,
  KiteServiceShell,
  KiteServiceShellOptions,
  KiteServiceSignal,
} from './ports';
import {
  createKiteServiceReadinessChannel,
  KITE_SERVICE_NOOP_READINESS,
  type KiteServiceReadinessChannel,
} from './readiness';
import { KITE_SERVICE_NOOP_SIGNALS } from './signals';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function timeoutError(operation: string): Error {
  return new Error(`Service ${operation} deadline exceeded.`);
}

function boundedTimeout(value: number | undefined, label: string): number {
  const timeout =
    value ?? (label === 'startup' ? DEFAULT_STARTUP_TIMEOUT_MS : DEFAULT_SHUTDOWN_TIMEOUT_MS);
  const normalized = Math.floor(timeout);
  if (!Number.isFinite(timeout) || normalized < 1 || normalized > 300_000) {
    throw new RangeError(`${label} timeout must be between 1 and 300000 milliseconds.`);
  }
  return normalized;
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(operation)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function withAbsoluteDeadline<T>(
  promise: PromiseLike<T>,
  deadline: number,
  operation: string,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(timeoutError(operation));
  return withTimeout(promise, remaining, operation);
}

function diagnosticFor(error: unknown, fallback: KiteServiceDiagnostic): KiteServiceDiagnostic {
  return error instanceof Error && error.message.includes('deadline exceeded')
    ? 'service_unavailable'
    : fallback;
}

function publishBestEffort(
  readiness: KiteServiceReadinessPort,
  state: KiteServiceReadiness,
  diagnostic?: KiteServiceDiagnostic,
): void {
  try {
    const result = readiness.publish({ ...(diagnostic ? { diagnostic } : {}), state });
    if (result && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Observation failure must not replace lifecycle cleanup evidence.
  }
}

function asSignalResult(result: KiteServiceLifecycleResult): KiteServiceLifecycleResult {
  return { ...result, operation: 'signal_shutdown' };
}

/** Ports-only lifecycle owner. It never constructs a Runtime, Store, listener or filesystem. */
export function createKiteServiceShell(options: KiteServiceShellOptions): KiteServiceShell & {
  readonly readinessChannel?: KiteServiceReadinessChannel;
} {
  const application: KiteRuntimeApplicationPort = options.application;
  const state = options.state;
  const transport = options.transport;
  const readinessChannel = options.readiness ? undefined : createKiteServiceReadinessChannel();
  const readiness = options.readiness ?? readinessChannel ?? KITE_SERVICE_NOOP_READINESS;
  const signals = options.signals ?? KITE_SERVICE_NOOP_SIGNALS;
  const startupTimeoutMs = boundedTimeout(options.startupTimeoutMs, 'startup');
  const shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs, 'shutdown');

  let phase: KiteServicePhase = 'absent';
  let readinessState: KiteServiceReadiness = 'unavailable';
  let disposed = false;
  let startPromise: Promise<KiteServiceLifecycleResult> | undefined;
  let stopPromise: Promise<KiteServiceLifecycleResult> | undefined;
  let applicationStartPromise: Promise<void> | undefined;
  let transportStartPromise: Promise<void> | undefined;
  let applicationClosePromise: Promise<void> | undefined;
  let transportClosePromise: Promise<void> | undefined;
  let acceptedStop: KiteServiceLifecycleResult | undefined;
  let terminalStop: KiteServiceLifecycleResult | undefined;
  let pendingSignal: KiteServiceSignal | undefined;
  let signalUnsubscribe: (() => void) | undefined;
  let shutdownResolve: ((result: KiteServiceLifecycleResult) => void) | undefined;
  let shutdownPromise: Promise<KiteServiceLifecycleResult> | undefined;
  let signalResolve: ((result: KiteServiceLifecycleResult) => void) | undefined;
  let signalPromise: Promise<KiteServiceLifecycleResult> | undefined;

  const publish = async (
    next: KiteServiceReadiness,
    diagnostic?: KiteServiceDiagnostic,
  ): Promise<void> => {
    readinessState = next;
    publishBestEffort(readiness, next, diagnostic);
  };

  const publishFailure = async (diagnostic: KiteServiceDiagnostic): Promise<void> => {
    try {
      await withTimeout(
        Promise.resolve().then(() => state.preserveFailure()),
        shutdownTimeoutMs,
        'shutdown',
      );
    } catch {
      // Keep the lifecycle failure as the public result.
    }
    readinessState = 'unavailable';
    publishBestEffort(readiness, 'unavailable', diagnostic);
  };

  const cleanupSignalSubscription = (): void => {
    try {
      signalUnsubscribe?.();
    } catch {
      // Signal observation cleanup cannot undo owner settlement.
    }
    signalUnsubscribe = undefined;
  };

  const complete = (result: KiteServiceLifecycleResult): KiteServiceLifecycleResult => {
    disposed = true;
    terminalStop = result;
    acceptedStop = undefined;
    shutdownResolve?.(result);
    shutdownResolve = undefined;
    return result;
  };

  const closeTransport = async (deadline = Date.now() + shutdownTimeoutMs): Promise<void> => {
    transportClosePromise ??= (transportStartPromise ?? Promise.resolve()).then(
      () => transport.stop(),
      () => transport.stop(),
    );
    // The underlying promise intentionally continues after timeout. If a timed-out start settles
    // late, the same close promise still invokes stop once and prevents a resurrected listener.
    await withAbsoluteDeadline(transportClosePromise, deadline, 'shutdown');
  };

  const closeApplication = async (deadline = Date.now() + shutdownTimeoutMs): Promise<void> => {
    applicationClosePromise ??= (applicationStartPromise ?? Promise.resolve()).then(
      () => application[Symbol.asyncDispose](),
      () => application[Symbol.asyncDispose](),
    );
    await withAbsoluteDeadline(applicationClosePromise, deadline, 'shutdown');
  };

  const cleanupOwners = async (
    operation: 'stop' | 'signal_shutdown',
    initialFailures: readonly unknown[] = [],
    deadline = Date.now() + shutdownTimeoutMs,
  ): Promise<KiteServiceLifecycleResult> => {
    const failures = [...initialFailures];
    try {
      await closeTransport(deadline);
    } catch (error) {
      failures.push(error);
    }
    try {
      await closeApplication(deadline);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      disposed = true;
      phase = 'draining';
      cleanupSignalSubscription();
      await publishFailure('shutdown_failed');
      return complete({
        operation,
        outcome: 'unavailable',
        state: phase,
        diagnostic: diagnosticFor(failures[0], 'shutdown_failed'),
      });
    }
    try {
      const clearAbort = new AbortController();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError('shutdown');
      const abortTimer = setTimeout(() => clearAbort.abort(), remaining);
      try {
        await withAbsoluteDeadline(
          state.clear({ signal: clearAbort.signal }),
          deadline,
          'shutdown',
        );
      } finally {
        clearTimeout(abortTimer);
      }
    } catch (error) {
      disposed = true;
      phase = 'draining';
      cleanupSignalSubscription();
      await publishFailure('shutdown_failed');
      return complete({
        operation,
        outcome: 'unavailable',
        state: phase,
        diagnostic: diagnosticFor(error, 'shutdown_failed'),
      });
    }
    cleanupSignalSubscription();
    phase = 'absent';
    disposed = true;
    readinessState = 'unavailable';
    publishBestEffort(readiness, 'unavailable');
    return complete({ operation, outcome: 'applied', state: phase });
  };

  const onSignal = (signalName: KiteServiceSignal): void => {
    if (phase === 'starting') {
      pendingSignal ??= signalName;
      return;
    }
    void signal(signalName).catch(() => undefined);
  };
  const unsubscribeInterrupt = signals.subscribe('SIGINT', () => onSignal('SIGINT'));
  const unsubscribeTerminate = signals.subscribe('SIGTERM', () => onSignal('SIGTERM'));
  signalUnsubscribe = () => {
    try {
      unsubscribeInterrupt();
    } finally {
      unsubscribeTerminate();
    }
  };

  const start = (): Promise<KiteServiceLifecycleResult> => {
    if (disposed) return Promise.reject(new Error('Service shell is disposed.'));
    if (phase === 'ready') {
      return Promise.resolve({ operation: 'start', outcome: 'applied', state: phase });
    }
    if (phase === 'starting' && startPromise) return startPromise;
    if (phase !== 'absent') {
      return Promise.reject(new Error(`Cannot start Service in ${phase} state.`));
    }
    phase = 'starting';
    startPromise = (async () => {
      const startupDeadline = Date.now() + startupTimeoutMs;
      const startupAbort = new AbortController();
      publishBestEffort(readiness, 'starting');
      try {
        await withAbsoluteDeadline(
          Promise.resolve().then(() => state.prepareStart({ signal: startupAbort.signal })),
          startupDeadline,
          'startup',
        );
        applicationStartPromise = Promise.resolve().then(() =>
          application.start({ signal: startupAbort.signal }),
        );
        await withAbsoluteDeadline(applicationStartPromise, startupDeadline, 'startup');
        transportStartPromise = Promise.resolve().then(() =>
          transport.start({ signal: startupAbort.signal }),
        );
        await withAbsoluteDeadline(transportStartPromise, startupDeadline, 'startup');
        await withAbsoluteDeadline(
          Promise.resolve().then(() => state.publishReady({ signal: startupAbort.signal })),
          startupDeadline,
          'startup',
        );
        phase = 'ready';
        await publish('ready');
        const queuedSignal = pendingSignal;
        pendingSignal = undefined;
        if (queuedSignal) void signal(queuedSignal).catch(() => undefined);
        return { operation: 'start', outcome: 'applied', state: phase };
      } catch (error) {
        startupAbort.abort();
        phase = 'draining';
        const failures: unknown[] = [error];
        const cleanupDeadline = Date.now() + shutdownTimeoutMs;
        try {
          await closeTransport(cleanupDeadline);
        } catch (closeError) {
          failures.push(closeError);
        }
        try {
          await closeApplication(cleanupDeadline);
        } catch (closeError) {
          failures.push(closeError);
        }
        cleanupSignalSubscription();
        phase = 'absent';
        await publishFailure('startup_failed');
        complete({
          operation: 'stop',
          outcome: 'unavailable',
          state: phase,
          diagnostic: 'startup_failed',
        });
        throw failures.length === 1 ? error : new AggregateError(failures);
      }
    })();
    return startPromise;
  };

  const performStop = async (
    fromSignal: boolean,
    signalName?: KiteServiceSignal,
  ): Promise<KiteServiceLifecycleResult> => {
    const shutdownDeadline = Date.now() + shutdownTimeoutMs;
    const operation = fromSignal ? 'signal_shutdown' : 'stop';
    if (phase === 'absent') return complete({ operation, outcome: 'applied', state: phase });
    if (phase === 'starting' && startPromise) {
      try {
        await startPromise;
      } catch {
        return complete({
          operation,
          outcome: 'unavailable',
          state: phase,
          diagnostic: 'startup_failed',
        });
      }
    }
    phase = 'quiescing';
    publishBestEffort(readiness, 'starting');
    let lease: Awaited<ReturnType<KiteRuntimeApplicationPort['quiesceMutations']>> | undefined;
    let quiescePromise:
      | Promise<Awaited<ReturnType<KiteRuntimeApplicationPort['quiesceMutations']>>>
      | undefined;
    let commitPromise: Promise<void> | undefined;
    const failures: unknown[] = [];
    try {
      if (fromSignal) {
        try {
          await closeTransport(shutdownDeadline);
        } catch (error) {
          failures.push(error);
        }
        try {
          await withAbsoluteDeadline(
            application.cancelAll(`service_${signalName?.toLowerCase() ?? 'signal'}_shutdown`),
            shutdownDeadline,
            'shutdown',
          );
        } catch (error) {
          failures.push(error);
        }
      }
      quiescePromise = Promise.resolve().then(() => application.quiesceMutations());
      lease = await withAbsoluteDeadline(quiescePromise, shutdownDeadline, 'shutdown');
      if (!fromSignal && lease.activeOperations) {
        lease.resume();
        phase = 'ready';
        await publish('ready');
        return {
          operation: 'stop',
          outcome: 'service_busy',
          state: phase,
          diagnostic: 'service_busy',
        };
      }
      phase = 'draining';
      commitPromise = Promise.resolve().then(() => lease!.commitDrain());
      await withAbsoluteDeadline(commitPromise, shutdownDeadline, 'shutdown');
      return cleanupOwners(operation, failures, shutdownDeadline);
    } catch (error) {
      if (!lease && quiescePromise) {
        void quiescePromise.then(
          (lateLease) => {
            try {
              lateLease.resume();
            } catch {
              // Preserve the original timeout result.
            }
          },
          () => undefined,
        );
      }
      if (commitPromise) {
        phase = 'draining';
        void commitPromise.then(
          () => cleanupOwners(operation, [...failures, error], shutdownDeadline),
          () => cleanupOwners(operation, [...failures, error], shutdownDeadline),
        );
        await publishFailure('shutdown_failed');
        return complete({
          operation,
          outcome: 'unavailable',
          state: phase,
          diagnostic: diagnosticFor(error, 'shutdown_failed'),
        });
      }
      try {
        lease?.resume();
      } catch {
        // A failed commit may already have closed admission.
      }
      if (!fromSignal && phase === 'quiescing') {
        phase = 'ready';
        publishBestEffort(readiness, 'ready');
        return {
          operation: 'stop',
          outcome: 'unavailable',
          state: phase,
          diagnostic: diagnosticFor(error, 'shutdown_failed'),
        };
      }
      phase = 'draining';
      return cleanupOwners(operation, [...failures, error], shutdownDeadline);
    }
  };

  const stop = (): Promise<KiteServiceLifecycleResult> => {
    if (terminalStop) return Promise.resolve(terminalStop);
    if (stopPromise) return stopPromise;
    if (disposed) return Promise.reject(new Error('Service shell is disposed.'));
    stopPromise = performStop(false).then((result) => {
      if (result.outcome === 'service_busy' || result.state === 'ready') stopPromise = undefined;
      return result;
    });
    return stopPromise;
  };

  const requestStop = async (): Promise<KiteServiceLifecycleResult> => {
    const shutdownDeadline = Date.now() + shutdownTimeoutMs;
    if (terminalStop) return terminalStop;
    if (acceptedStop) return acceptedStop;
    if (disposed) throw new Error('Service shell is disposed.');
    if (stopPromise) return stopPromise;
    if (phase === 'absent') {
      return complete({ operation: 'stop', outcome: 'applied', state: phase });
    }
    if (phase === 'starting' && startPromise) {
      try {
        await startPromise;
      } catch {
        return (
          terminalStop ?? {
            operation: 'stop',
            outcome: 'unavailable',
            state: phase,
            diagnostic: 'startup_failed',
          }
        );
      }
    }

    phase = 'quiescing';
    publishBestEffort(readiness, 'starting');
    let lease: Awaited<ReturnType<KiteRuntimeApplicationPort['quiesceMutations']>> | undefined;
    let quiescePromise:
      | Promise<Awaited<ReturnType<KiteRuntimeApplicationPort['quiesceMutations']>>>
      | undefined;
    let commitStarted = false;
    let commitPromise: Promise<void> | undefined;
    try {
      quiescePromise = Promise.resolve().then(() => application.quiesceMutations());
      lease = await withAbsoluteDeadline(quiescePromise, shutdownDeadline, 'shutdown');
      if (lease.activeOperations) {
        lease.resume();
        phase = 'ready';
        await publish('ready');
        return {
          operation: 'stop',
          outcome: 'service_busy',
          state: phase,
          diagnostic: 'service_busy',
        };
      }
      commitStarted = true;
      commitPromise = Promise.resolve().then(() => lease!.commitDrain());
      await withAbsoluteDeadline(commitPromise, shutdownDeadline, 'shutdown');
      phase = 'draining';
      acceptedStop = { operation: 'stop', outcome: 'applied', state: phase };
      stopPromise = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
        cleanupOwners('stop', [], shutdownDeadline),
      );
      return acceptedStop;
    } catch (error) {
      if (!lease && quiescePromise) {
        void quiescePromise.then(
          (lateLease) => {
            try {
              lateLease.resume();
            } catch {
              // Preserve the original timeout result.
            }
          },
          () => undefined,
        );
      }
      if (commitStarted && commitPromise) {
        phase = 'draining';
        void commitPromise.then(
          () => cleanupOwners('stop', [error], shutdownDeadline),
          () => cleanupOwners('stop', [error], shutdownDeadline),
        );
        await publishFailure('shutdown_failed');
        return complete({
          operation: 'stop',
          outcome: 'unavailable',
          state: phase,
          diagnostic: diagnosticFor(error, 'shutdown_failed'),
        });
      }
      try {
        lease?.resume();
      } catch {
        // Preserve the fail-closed result.
      }
      phase = 'ready';
      publishBestEffort(readiness, 'ready');
      return {
        operation: 'stop',
        outcome: 'unavailable',
        state: phase,
        diagnostic: diagnosticFor(error, 'shutdown_failed'),
      };
    }
  };

  const resolveSignal = (result: KiteServiceLifecycleResult): KiteServiceLifecycleResult => {
    const signalResult = asSignalResult(result);
    signalResolve?.(signalResult);
    signalResolve = undefined;
    return signalResult;
  };

  const signal = (signalName: KiteServiceSignal): Promise<KiteServiceLifecycleResult> => {
    if (!signalPromise) {
      signalPromise = new Promise<KiteServiceLifecycleResult>((resolve) => {
        signalResolve = resolve;
      });
    }
    if (terminalStop) return Promise.resolve(resolveSignal(terminalStop));
    if (phase === 'starting' && startPromise) {
      pendingSignal ??= signalName;
      return startPromise.then(
        () => signal(signalName),
        () => resolveSignal(terminalStop!),
      );
    }
    if (stopPromise) {
      return stopPromise.then((result) => {
        if (result.outcome === 'applied' || result.state === 'draining') {
          return resolveSignal(result);
        }
        stopPromise = undefined;
        return signal(signalName);
      });
    }
    stopPromise = performStop(true, signalName);
    return stopPromise.then(resolveSignal);
  };

  const waitForShutdown = (): Promise<KiteServiceLifecycleResult> => {
    if (terminalStop) return Promise.resolve(terminalStop);
    shutdownPromise ??= new Promise<KiteServiceLifecycleResult>((resolve) => {
      shutdownResolve = resolve;
    });
    return shutdownPromise;
  };

  const waitForSignalShutdown = (): Promise<KiteServiceLifecycleResult> => {
    if (terminalStop?.operation === 'signal_shutdown') return Promise.resolve(terminalStop);
    signalPromise ??= new Promise<KiteServiceLifecycleResult>((resolve) => {
      signalResolve = resolve;
    });
    return signalPromise;
  };

  const shell: KiteServiceShell & { readonly readinessChannel?: KiteServiceReadinessChannel } = {
    get phase() {
      return phase;
    },
    get readiness() {
      return readinessState;
    },
    ...(readinessChannel ? { readinessChannel } : {}),
    start,
    stop,
    requestStop,
    signal,
    waitForShutdown,
    waitForSignalShutdown,
    [Symbol.asyncDispose]: async () => {
      if (terminalStop) {
        if (terminalStop.outcome === 'unavailable') {
          throw new Error(terminalStop.diagnostic ?? 'Service shutdown failed.');
        }
        return;
      }
      let result = stopPromise ? await stopPromise : await signal('SIGTERM');
      if (!terminalStop && (result.outcome === 'service_busy' || result.state === 'ready')) {
        stopPromise = undefined;
        result = await signal('SIGTERM');
      }
      if (result.outcome !== 'applied') {
        throw new Error(result.diagnostic ?? 'Service shutdown failed.');
      }
    },
  };
  return Object.freeze(shell);
}
