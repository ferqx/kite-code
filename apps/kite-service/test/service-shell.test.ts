import { describe, expect, test } from 'bun:test';
import {
  createKiteServiceReadinessChannel,
  createKiteServiceShell,
  type KiteRuntimeApplicationPort,
  type KiteRuntimeApplicationQuiesceLease,
  type KiteServiceSignal,
  type KiteServiceSignalPort,
  type KiteServiceStatePort,
  type KiteServiceTransportPort,
} from '@kite-ai/kite-service';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createFakeApplication(
  log: string[],
  active = false,
): {
  readonly application: KiteRuntimeApplicationPort;
  setActive(value: boolean): void;
  readonly counts: { start: number; cancel: number; dispose: number; quiesce: number };
} {
  let hasActiveOperations = active;
  const counts = { start: 0, cancel: 0, dispose: 0, quiesce: 0 };
  const application: KiteRuntimeApplicationPort = {
    async start() {
      counts.start += 1;
      log.push('application.start');
    },
    async quiesceMutations(): Promise<KiteRuntimeApplicationQuiesceLease> {
      counts.quiesce += 1;
      log.push('application.quiesce');
      return {
        get activeOperations() {
          return hasActiveOperations;
        },
        resume() {
          log.push('application.resume');
        },
        async commitDrain() {
          log.push('application.commitDrain');
        },
      };
    },
    async cancelAll(reason: string) {
      counts.cancel += 1;
      log.push(`application.cancel:${reason}`);
    },
    async [Symbol.asyncDispose]() {
      counts.dispose += 1;
      log.push('application.dispose');
    },
  };
  return {
    application,
    setActive(value: boolean) {
      hasActiveOperations = value;
    },
    counts,
  };
}

function createRecordingPorts(log: string[]): {
  readonly state: KiteServiceStatePort;
  readonly transport: KiteServiceTransportPort;
  readonly signals: KiteServiceSignalPort;
  emit(signal: KiteServiceSignal): void;
} {
  const listeners = new Map<KiteServiceSignal, Set<() => void>>();
  const state: KiteServiceStatePort = {
    async prepareStart() {
      log.push('state.prepareStart');
    },
    async publishReady() {
      log.push('state.publishReady');
    },
    async preserveFailure() {
      log.push('state.preserveFailure');
    },
    async clear() {
      log.push('state.clear');
    },
  };
  const transport: KiteServiceTransportPort = {
    async start() {
      log.push('transport.start');
    },
    async stop() {
      log.push('transport.stop');
    },
  };
  const signals: KiteServiceSignalPort = {
    subscribe(signal, listener) {
      const current = listeners.get(signal) ?? new Set<() => void>();
      current.add(listener);
      listeners.set(signal, current);
      return () => current.delete(listener);
    },
  };
  return {
    state,
    transport,
    signals,
    emit(signal) {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
  };
}

describe('Kite Service lifecycle shell', () => {
  test('pre-start stop, requestStop, and disposal permanently close the shell', async () => {
    for (const close of ['stop', 'requestStop', 'dispose'] as const) {
      const log: string[] = [];
      const fake = createFakeApplication(log);
      const ports = createRecordingPorts(log);
      const shell = createKiteServiceShell({
        application: fake.application,
        state: ports.state,
        transport: ports.transport,
        signals: ports.signals,
      });
      if (close === 'stop') await shell.stop();
      else if (close === 'requestStop') await shell.requestStop();
      else await shell[Symbol.asyncDispose]();
      await expect(shell.start()).rejects.toThrow('disposed');
      expect(fake.counts.start).toBe(0);
    }
  });

  test('starts injected application and transport once, then publishes readiness', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: fake.application,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });

    const first = shell.start();
    const second = shell.start();
    expect(await first).toMatchObject({ operation: 'start', outcome: 'applied', state: 'ready' });
    expect(await second).toMatchObject({ operation: 'start', outcome: 'applied', state: 'ready' });
    expect(fake.counts.start).toBe(1);
    expect(log).toEqual([
      'state.prepareStart',
      'application.start',
      'transport.start',
      'state.publishReady',
    ]);
  });

  test('ordinary stop is fail-closed while active work exists and can be retried', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log, true);
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: fake.application,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });
    await shell.start();

    const busy = await shell.stop();
    expect(busy).toMatchObject({ operation: 'stop', outcome: 'service_busy', state: 'ready' });
    expect(fake.counts.dispose).toBe(0);
    expect(shell.phase).toBe('ready');

    fake.setActive(false);
    const stopped = await shell.stop();
    expect(stopped).toMatchObject({ operation: 'stop', outcome: 'applied', state: 'absent' });
    expect(fake.counts.dispose).toBe(1);
    expect(log.slice(-4)).toEqual([
      'application.commitDrain',
      'transport.stop',
      'application.dispose',
      'state.clear',
    ]);
    await expect(shell.start()).rejects.toThrow('disposed');
  });

  test('control stop returns draining before deferred owner cleanup settles', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: fake.application,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });
    await shell.start();

    const accepted = await shell.requestStop();
    expect(accepted).toMatchObject({ operation: 'stop', outcome: 'applied', state: 'draining' });
    expect(log).toContain('application.commitDrain');
    expect(log).not.toContain('transport.stop');

    const settled = await shell.stop();
    expect(settled).toMatchObject({ operation: 'stop', outcome: 'applied', state: 'absent' });
    expect(log.slice(-3)).toEqual(['transport.stop', 'application.dispose', 'state.clear']);
  });

  test('concurrent control stops share one quiesce and one owner cleanup', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: fake.application,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });
    await shell.start();

    const first = shell.requestStop();
    const second = shell.requestStop();
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { operation: 'stop', outcome: 'applied', state: 'draining' },
      { operation: 'stop', outcome: 'applied', state: 'draining' },
    ]);
    expect(fake.counts.quiesce).toBe(1);

    await expect(shell.stop()).resolves.toMatchObject({ outcome: 'applied', state: 'absent' });
    expect(fake.counts.dispose).toBe(1);
    expect(log.filter((entry) => entry === 'transport.stop')).toHaveLength(1);
    expect(log.filter((entry) => entry === 'state.clear')).toHaveLength(1);
  });

  test('ordinary and signal shutdown join an in-flight control-stop barrier', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const quiesce = deferred<KiteRuntimeApplicationQuiesceLease>();
    const application: KiteRuntimeApplicationPort = {
      ...fake.application,
      async quiesceMutations() {
        fake.counts.quiesce += 1;
        return quiesce.promise;
      },
    };
    const ports = createRecordingPorts(log);
    const cleanup = deferred<void>();
    const transport: KiteServiceTransportPort = {
      ...ports.transport,
      async stop() {
        await ports.transport.stop();
        await cleanup.promise;
      },
    };
    const shell = createKiteServiceShell({
      application,
      state: ports.state,
      transport,
      signals: ports.signals,
    });
    await shell.start();

    const requested = shell.requestStop();
    await Promise.resolve();
    const stopped = shell.stop();
    const signaled = shell.signal('SIGTERM');
    expect(stopped).toBe(requested);
    quiesce.resolve({
      activeOperations: false,
      resume() {},
      async commitDrain() {},
    });

    await expect(requested).resolves.toMatchObject({ outcome: 'applied', state: 'draining' });
    let signalSettled = false;
    void signaled.finally(() => {
      signalSettled = true;
    });
    await Promise.resolve();
    expect(signalSettled).toBe(false);
    cleanup.resolve();
    await expect(signaled).resolves.toMatchObject({
      operation: 'signal_shutdown',
      outcome: 'applied',
    });
    await expect(shell.waitForShutdown()).resolves.toMatchObject({ state: 'absent' });
    expect(fake.counts.quiesce).toBe(1);
    expect(fake.counts.dispose).toBe(1);
    expect(log.filter((entry) => entry === 'state.clear')).toHaveLength(1);
  });

  test('a shared busy control-stop flight releases before one idle retry', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log, true);
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: fake.application,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });
    await shell.start();

    const first = shell.requestStop();
    const second = shell.requestStop();
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        operation: 'stop',
        outcome: 'service_busy',
        state: 'ready',
        diagnostic: 'service_busy',
      },
      {
        operation: 'stop',
        outcome: 'service_busy',
        state: 'ready',
        diagnostic: 'service_busy',
      },
    ]);
    expect(fake.counts.quiesce).toBe(1);

    fake.setActive(false);
    await expect(shell.requestStop()).resolves.toMatchObject({
      outcome: 'applied',
      state: 'draining',
    });
    expect(fake.counts.quiesce).toBe(2);
    await expect(shell.stop()).resolves.toMatchObject({ outcome: 'applied', state: 'absent' });
    expect(fake.counts.dispose).toBe(1);
    expect(log.filter((entry) => entry === 'transport.stop')).toHaveLength(1);
    expect(log.filter((entry) => entry === 'state.clear')).toHaveLength(1);
  });

  test('signal shutdown cancels through the injected application and closes each owner once', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: fake.application,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });
    await shell.start();

    const waiting = shell.waitForSignalShutdown();
    ports.emit('SIGTERM');
    const result = await waiting;
    expect(result).toMatchObject({
      operation: 'signal_shutdown',
      outcome: 'applied',
      state: 'absent',
    });
    expect(fake.counts.cancel).toBe(1);
    expect(fake.counts.dispose).toBe(1);
    expect(log.slice(-6)).toEqual([
      'transport.stop',
      'application.cancel:service_sigterm_shutdown',
      'application.quiesce',
      'application.commitDrain',
      'application.dispose',
      'state.clear',
    ]);
    await expect(shell.start()).rejects.toThrow('disposed');
  });

  test('startup failure closes partial resources and preserves state evidence', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const failingApplication: KiteRuntimeApplicationPort = {
      ...fake.application,
      async start() {
        log.push('application.start');
        throw new Error('application failed');
      },
    };
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: failingApplication,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });
    await expect(shell.start()).rejects.toThrow('application failed');
    expect(fake.counts.dispose).toBe(1);
    expect(shell.phase).toBe('absent');
    expect(shell.readiness).toBe('unavailable');
    expect(log.slice(-3)).toEqual([
      'transport.stop',
      'application.dispose',
      'state.preserveFailure',
    ]);
  });

  test('close faults preserve state evidence after attempting every owner cleanup', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const failingTransport: KiteServiceTransportPort = {
      start: ports.transport.start,
      async stop() {
        log.push('transport.stop');
        throw new Error('listener close failed');
      },
    };
    const shell = createKiteServiceShell({
      application: fake.application,
      state: ports.state,
      transport: failingTransport,
      signals: ports.signals,
    });
    await shell.start();

    const result = await shell.stop();
    expect(result).toMatchObject({ operation: 'stop', outcome: 'unavailable', state: 'draining' });
    expect(fake.counts.dispose).toBe(1);
    expect(log).toContain('application.dispose');
    expect(log).toContain('state.preserveFailure');
    expect(log).not.toContain('state.clear');
    await expect(shell.stop()).resolves.toMatchObject({
      outcome: 'unavailable',
      state: 'draining',
    });
  });

  test('deferred control cleanup failure replaces the accepted draining acknowledgement', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: fake.application,
      state: ports.state,
      transport: {
        start: ports.transport.start,
        async stop() {
          log.push('transport.stop');
          throw new Error('late carrier close failed');
        },
      },
      signals: ports.signals,
    });
    await shell.start();

    expect(await shell.requestStop()).toMatchObject({ outcome: 'applied', state: 'draining' });
    expect(await shell.stop()).toMatchObject({ outcome: 'unavailable', state: 'draining' });
    expect(await shell.requestStop()).toMatchObject({ outcome: 'unavailable', state: 'draining' });
    await expect(shell[Symbol.asyncDispose]()).rejects.toThrow('shutdown_failed');
  });

  test('a transport start that settles after startup timeout is still closed exactly once', async () => {
    const lateStart = deferred<void>();
    let starts = 0;
    let stops = 0;
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: fake.application,
      state: ports.state,
      transport: {
        start() {
          starts += 1;
          return lateStart.promise;
        },
        async stop() {
          stops += 1;
        },
      },
      signals: ports.signals,
      startupTimeoutMs: 5,
      shutdownTimeoutMs: 5,
    });

    await expect(shell.start()).rejects.toBeInstanceOf(Error);
    expect(starts).toBe(1);
    expect(stops).toBe(0);
    lateStart.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(stops).toBe(1);
    ports.emit('SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(stops).toBe(1);
  });

  test('signal during an accepted control drain reports signal_shutdown without a second close', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: fake.application,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });
    await shell.start();
    await shell.requestStop();

    const result = await shell.signal('SIGTERM');
    expect(result).toMatchObject({ operation: 'signal_shutdown', outcome: 'applied' });
    expect(log.filter((entry) => entry === 'transport.stop')).toHaveLength(1);
    expect(fake.counts.dispose).toBe(1);
  });

  test('startup calls are shared while the application is pending', async () => {
    const gate = deferred<void>();
    let starts = 0;
    const application: KiteRuntimeApplicationPort = {
      start: () => {
        starts += 1;
        return gate.promise;
      },
      quiesceMutations: async () => ({
        activeOperations: false,
        resume: () => undefined,
        commitDrain: async () => undefined,
      }),
      cancelAll: async () => undefined,
      [Symbol.asyncDispose]: async () => undefined,
    };
    const ports = createRecordingPorts([]);
    const shell = createKiteServiceShell({
      application,
      state: ports.state,
      transport: ports.transport,
    });
    const first = shell.start();
    const second = shell.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(starts).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
  });

  test('a signal received during startup is queued and drains after readiness', async () => {
    const gate = deferred<void>();
    const log: string[] = [];
    const ports = createRecordingPorts(log);
    const application: KiteRuntimeApplicationPort = {
      start: () => gate.promise,
      quiesceMutations: async () => ({
        activeOperations: false,
        resume: () => undefined,
        commitDrain: async () => undefined,
      }),
      cancelAll: async (reason) => {
        log.push(`cancel:${reason}`);
      },
      [Symbol.asyncDispose]: async () => {
        log.push('dispose');
      },
    };
    const shell = createKiteServiceShell({
      application,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });
    const started = shell.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    ports.emit('SIGINT');
    gate.resolve();
    expect(await started).toMatchObject({ operation: 'start', outcome: 'applied' });
    expect(await shell.waitForSignalShutdown()).toMatchObject({
      operation: 'signal_shutdown',
      outcome: 'applied',
    });
    expect(log).toContain('cancel:service_sigint_shutdown');
    expect(log).toContain('dispose');
  });

  test('startup failure resolves the unified shutdown waiter', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: {
        ...fake.application,
        start: async () => {
          throw new Error('start failed');
        },
      },
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });
    const settled = shell.waitForShutdown();
    await expect(shell.start()).rejects.toThrow('start failed');
    await expect(settled).resolves.toMatchObject({
      outcome: 'unavailable',
      diagnostic: 'startup_failed',
    });
  });

  test('late prepareStart settles behind failure preservation without publishing readiness', async () => {
    const prepare = deferred<void>();
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const state: KiteServiceStatePort = {
      prepareStart: () => prepare.promise,
      async publishReady() {
        log.push('state.publishReady');
      },
      async preserveFailure() {
        log.push('state.preserveFailure');
      },
      async clear() {
        log.push('state.clear');
      },
    };
    const shell = createKiteServiceShell({
      application: fake.application,
      state,
      transport: ports.transport,
      shutdownTimeoutMs: 5,
      startupTimeoutMs: 5,
    });

    await expect(shell.start()).rejects.toBeInstanceOf(Error);
    expect(shell.phase).toBe('absent');
    expect(log).not.toContain('state.publishReady');
    prepare.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(log).toContain('state.preserveFailure');
    expect(shell.readiness).toBe('unavailable');
    await expect(shell.start()).rejects.toThrow('disposed');
  });

  test('late publishReady settles before failure preservation and cannot resurrect the shell', async () => {
    const publishReady = deferred<void>();
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const state: KiteServiceStatePort = {
      async prepareStart() {
        log.push('state.prepareStart');
      },
      publishReady: () => publishReady.promise,
      async preserveFailure() {
        log.push('state.preserveFailure');
      },
      async clear() {
        log.push('state.clear');
      },
    };
    const shell = createKiteServiceShell({
      application: fake.application,
      state,
      transport: ports.transport,
      shutdownTimeoutMs: 5,
      startupTimeoutMs: 5,
    });

    await expect(shell.start()).rejects.toBeInstanceOf(Error);
    expect(shell.phase).toBe('absent');
    publishReady.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual([
      'state.prepareStart',
      'application.start',
      'transport.start',
      'transport.stop',
      'application.dispose',
      'state.preserveFailure',
    ]);
    expect(shell.readiness).toBe('unavailable');
    await expect(shell.start()).rejects.toThrow('disposed');
  });

  test('signal retries recovery shutdown after an in-flight ordinary stop reports busy', async () => {
    const firstQuiesce = deferred<KiteRuntimeApplicationQuiesceLease>();
    let quiesces = 0;
    const log: string[] = [];
    const ports = createRecordingPorts(log);
    const application: KiteRuntimeApplicationPort = {
      start: async () => undefined,
      quiesceMutations: async () => {
        quiesces += 1;
        if (quiesces === 1) return firstQuiesce.promise;
        return {
          activeOperations: false,
          resume: () => undefined,
          commitDrain: async () => undefined,
        };
      },
      cancelAll: async (reason) => {
        log.push(`cancel:${reason}`);
      },
      [Symbol.asyncDispose]: async () => {
        log.push('dispose');
      },
    };
    const shell = createKiteServiceShell({
      application,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });
    await shell.start();
    const stopping = shell.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const signalled = shell.signal('SIGTERM');
    firstQuiesce.resolve({
      activeOperations: true,
      resume: () => log.push('resume'),
      commitDrain: async () => undefined,
    });

    await expect(stopping).resolves.toMatchObject({ outcome: 'service_busy' });
    await expect(signalled).resolves.toMatchObject({
      operation: 'signal_shutdown',
      outcome: 'applied',
    });
    expect(log).toContain('cancel:service_sigterm_shutdown');
    expect(log).toContain('dispose');
    expect(quiesces).toBe(2);
  });

  test('late quiesce is resumed after ordinary stop timeout', async () => {
    const quiesce = deferred<KiteRuntimeApplicationQuiesceLease>();
    let resumed = 0;
    const ports = createRecordingPorts([]);
    const application: KiteRuntimeApplicationPort = {
      start: async () => undefined,
      quiesceMutations: () => quiesce.promise,
      cancelAll: async () => undefined,
      [Symbol.asyncDispose]: async () => undefined,
    };
    const shell = createKiteServiceShell({
      application,
      state: ports.state,
      transport: ports.transport,
      shutdownTimeoutMs: 5,
    });
    await shell.start();
    await expect(shell.stop()).resolves.toMatchObject({ outcome: 'unavailable', state: 'ready' });
    quiesce.resolve({
      activeOperations: false,
      resume: () => {
        resumed += 1;
      },
      commitDrain: async () => undefined,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(resumed).toBe(1);
  });

  test('commit timeout defers owner cleanup until the late commit settles', async () => {
    const commit = deferred<void>();
    let disposedCount = 0;
    const log: string[] = [];
    const ports = createRecordingPorts(log);
    const application: KiteRuntimeApplicationPort = {
      start: async () => undefined,
      quiesceMutations: async () => ({
        activeOperations: false,
        resume: () => undefined,
        commitDrain: () => commit.promise,
      }),
      cancelAll: async () => undefined,
      [Symbol.asyncDispose]: async () => {
        disposedCount += 1;
      },
    };
    const shell = createKiteServiceShell({
      application,
      state: ports.state,
      transport: ports.transport,
      shutdownTimeoutMs: 5,
    });
    await shell.start();
    await expect(shell.requestStop()).resolves.toMatchObject({
      outcome: 'unavailable',
      state: 'draining',
    });
    expect(disposedCount).toBe(0);
    expect(log).not.toContain('state.clear');
    commit.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(disposedCount).toBe(1);
    expect(log).not.toContain('state.clear');
  });

  test('signal quiesce timeout defers commit and owner cleanup until the late lease settles', async () => {
    const quiesce = deferred<KiteRuntimeApplicationQuiesceLease>();
    const commit = deferred<void>();
    let disposedCount = 0;
    const ports = createRecordingPorts([]);
    const application: KiteRuntimeApplicationPort = {
      start: async () => undefined,
      quiesceMutations: () => quiesce.promise,
      cancelAll: async () => undefined,
      [Symbol.asyncDispose]: async () => {
        disposedCount += 1;
      },
    };
    const shell = createKiteServiceShell({
      application,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
      shutdownTimeoutMs: 5,
    });
    await shell.start();

    await expect(shell.signal('SIGTERM')).resolves.toMatchObject({
      operation: 'signal_shutdown',
      outcome: 'unavailable',
      state: 'draining',
    });
    expect(disposedCount).toBe(0);
    quiesce.resolve({
      activeOperations: false,
      resume: () => undefined,
      commitDrain: () => commit.promise,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(disposedCount).toBe(0);
    commit.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(disposedCount).toBe(1);
  });

  test('late state clear is single-flight and cannot replace preserved shutdown failure', async () => {
    const clear = deferred<void>();
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    let clearCalls = 0;
    const state: KiteServiceStatePort = {
      async prepareStart() {
        log.push('state.prepareStart');
      },
      async publishReady() {
        log.push('state.publishReady');
      },
      async preserveFailure() {
        log.push('state.preserveFailure');
      },
      clear: () => {
        clearCalls += 1;
        log.push('state.clear');
        return clear.promise;
      },
    };
    const shell = createKiteServiceShell({
      application: fake.application,
      state,
      transport: ports.transport,
      shutdownTimeoutMs: 5,
    });
    await shell.start();

    await expect(shell.stop()).resolves.toMatchObject({
      outcome: 'unavailable',
      state: 'draining',
    });
    expect(clearCalls).toBe(1);
    expect(log).not.toContain('state.preserveFailure');
    clear.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(log).toContain('state.preserveFailure');
    expect(clearCalls).toBe(1);
    await expect(shell.stop()).resolves.toMatchObject({
      outcome: 'unavailable',
      state: 'draining',
    });
  });

  test('readiness and failure preservation faults remain bounded and observational', async () => {
    const never = new Promise<void>(() => undefined);
    const log: string[] = [];
    const fake = createFakeApplication(log);
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: fake.application,
      state: {
        ...ports.state,
        preserveFailure: () => never,
      },
      transport: {
        start: ports.transport.start,
        async stop() {
          throw new Error('transport close failed');
        },
      },
      readiness: { publish: () => never },
      shutdownTimeoutMs: 5,
    });
    await shell.start();
    await expect(shell.stop()).resolves.toMatchObject({
      outcome: 'unavailable',
      state: 'draining',
    });
  });

  test('a signal unsubscribe fault still releases every signal listener and settles shutdown', async () => {
    const log: string[] = [];
    const fake = createFakeApplication(log);
    let interruptUnsubscribed = 0;
    let terminateUnsubscribed = 0;
    const ports = createRecordingPorts(log);
    const shell = createKiteServiceShell({
      application: fake.application,
      state: ports.state,
      transport: ports.transport,
      signals: {
        subscribe(signal) {
          return () => {
            if (signal === 'SIGINT') {
              interruptUnsubscribed += 1;
              throw new Error('interrupt unsubscribe failed');
            }
            terminateUnsubscribed += 1;
          };
        },
      },
      shutdownTimeoutMs: 5,
    });
    await shell.start();
    await expect(shell.signal('SIGTERM')).resolves.toMatchObject({ outcome: 'applied' });
    expect(interruptUnsubscribed).toBe(1);
    expect(terminateUnsubscribed).toBe(1);
  });

  test('readiness channel waits for ready and rejects after unavailable', async () => {
    const channel = createKiteServiceReadinessChannel();
    const waiting = channel.waitUntilReady();
    channel.publish({ state: 'starting' });
    let settled = false;
    void waiting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    channel.publish({ state: 'ready' });
    await waiting;
    expect(channel.state).toBe('ready');
    channel.publish({ state: 'unavailable', diagnostic: 'service_unavailable' });
    await expect(channel.waitUntilReady()).rejects.toThrow('service_unavailable');
  });
});
