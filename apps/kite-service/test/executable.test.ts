import { describe, expect, test } from 'bun:test';
import { createKiteServiceExecutable, runKiteService } from '../src/executable';
import type {
  KiteRuntimeApplicationPort,
  KiteServiceSignal,
  KiteServiceSignalPort,
  KiteServiceStatePort,
  KiteServiceTransportPort,
} from '../src/ports';

function createPorts(): {
  readonly state: KiteServiceStatePort;
  readonly transport: KiteServiceTransportPort;
  readonly signals: KiteServiceSignalPort;
  emit(signal: KiteServiceSignal): void;
} {
  const listeners = new Map<KiteServiceSignal, Set<() => void>>();
  const state: KiteServiceStatePort = {
    prepareStart: async () => undefined,
    publishReady: async () => undefined,
    preserveFailure: async () => undefined,
    clear: async () => undefined,
  };
  const transport: KiteServiceTransportPort = {
    start: async () => undefined,
    stop: async () => undefined,
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

describe('Kite Service internal executable adapter', () => {
  test('uses injected application and signal source without constructing a backend', async () => {
    const ports = createPorts();
    const calls: string[] = [];
    const application: KiteRuntimeApplicationPort = {
      async start() {
        calls.push('start');
      },
      async quiesceMutations() {
        calls.push('quiesce');
        return {
          activeOperations: false,
          resume: () => undefined,
          commitDrain: async () => {
            calls.push('commitDrain');
          },
        };
      },
      async cancelAll(reason) {
        calls.push(`cancel:${reason}`);
      },
      async [Symbol.asyncDispose]() {
        calls.push('dispose');
      },
    };
    const shell = createKiteServiceExecutable({
      application,
      state: ports.state,
      transport: ports.transport,
      signals: ports.signals,
    });
    await shell.start();
    ports.emit('SIGINT');
    await expect(shell.waitForSignalShutdown()).resolves.toMatchObject({
      operation: 'signal_shutdown',
      outcome: 'applied',
    });
    expect(calls).toEqual([
      'start',
      'cancel:service_sigint_shutdown',
      'quiesce',
      'commitDrain',
      'dispose',
    ]);
  });

  test('propagates signal cleanup failure instead of exiting successfully', async () => {
    const ports = createPorts();
    const application: KiteRuntimeApplicationPort = {
      start: async () => undefined,
      quiesceMutations: async () => ({
        activeOperations: false,
        resume: () => undefined,
        commitDrain: async () => undefined,
      }),
      cancelAll: async () => undefined,
      [Symbol.asyncDispose]: async () => undefined,
    };
    const running = runKiteService({
      application,
      state: ports.state,
      transport: {
        start: ports.transport.start,
        stop: async () => {
          throw new Error('carrier close failed');
        },
      },
      signals: ports.signals,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    ports.emit('SIGTERM');
    await expect(running).rejects.toThrow('shutdown_failed');
  });
});
