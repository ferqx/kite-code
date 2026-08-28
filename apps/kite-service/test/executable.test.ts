import { describe, expect, test } from 'bun:test';
import type { KiteServiceRuntimeComposition } from '../src/composition';
import {
  createKiteServiceExecutable,
  isKiteServiceMcpStdioInvocation,
  resolveKiteServiceMainEnvironment,
  runKiteService,
  runKiteServiceMain,
} from '../src/executable';
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
  test('recognizes the final private MCP marker in source and Windows standalone argv layouts', () => {
    const marker = '--kite-internal-mcp-stdio-v1';
    expect(isKiteServiceMcpStdioInvocation([marker], ['bun', 'service.ts', marker])).toBe(true);
    expect(isKiteServiceMcpStdioInvocation([], ['C:\\install\\kite-service.exe', marker])).toBe(
      true,
    );
    expect(
      isKiteServiceMcpStdioInvocation(
        [],
        ['C:\\install\\kite-service.exe', '--kite-internal-posix-supervisor-v1', marker],
      ),
    ).toBe(false);
  });

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

  test('requires manager-provided home, OS home, and build identity before composition', async () => {
    const osHomeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const createComposition = () => {
      throw new Error('composition must not be constructed');
    };
    const base = {
      KITE_CODE_HOME: '/tmp/kite-service-code',
      [osHomeKey]: '/tmp/kite-service-os-home',
      KITE_SERVICE_BUILD_ID: 'dev:test',
    } satisfies Record<string, string>;

    await expect(
      runKiteServiceMain(['service', 'run'], {
        environment: { ...base, KITE_CODE_HOME: 'relative-home' },
        createComposition,
      }),
    ).rejects.toThrow();
    await expect(
      runKiteServiceMain(['service', 'run'], {
        environment: { ...base, KITE_CODE_HOME: '/tmp/evil\nroot' },
        createComposition,
      }),
    ).rejects.toThrow();
    const withoutOsHome: Record<string, string | undefined> = { ...base };
    withoutOsHome[osHomeKey] = undefined;
    await expect(
      runKiteServiceMain(['service', 'run'], {
        environment: withoutOsHome,
        createComposition,
      }),
    ).rejects.toThrow();
    const withoutBuildId: Record<string, string | undefined> = { ...base };
    withoutBuildId.KITE_SERVICE_BUILD_ID = undefined;
    await expect(
      runKiteServiceMain(['service', 'run'], {
        environment: withoutBuildId,
        createComposition,
      }),
    ).rejects.toThrow();
  });

  test('passes the exact neutral manager environment to the concrete seam', async () => {
    const osHomeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const environment = {
      KITE_CODE_HOME: '/tmp/kite-service-code',
      [osHomeKey]: '/tmp/kite-service-os-home',
      KITE_SERVICE_BUILD_ID: 'installed:2026-08-27',
    } satisfies Record<string, string>;
    let captured: Parameters<KiteServiceRuntimeComposition['createInfrastructure']>[0] | undefined;
    const infrastructure = {
      shell: {
        waitForShutdown: async () => ({
          operation: 'signal_shutdown' as const,
          outcome: 'applied' as const,
          state: 'absent' as const,
        }),
      },
      start: async () => ({
        operation: 'start' as const,
        outcome: 'applied' as const,
        state: 'ready' as const,
      }),
      stop: async () => ({
        operation: 'stop' as const,
        outcome: 'applied' as const,
        state: 'absent' as const,
      }),
      requestStop: async () => ({
        operation: 'stop' as const,
        outcome: 'applied' as const,
        state: 'absent' as const,
      }),
      [Symbol.asyncDispose]: async () => undefined,
    } as const;
    type InfrastructureOptions = Parameters<
      KiteServiceRuntimeComposition['createInfrastructure']
    >[0];
    const composition = {
      createInfrastructure(options: InfrastructureOptions) {
        captured = options;
        return infrastructure;
      },
      [Symbol.asyncDispose]: async () => undefined,
    } as unknown as KiteServiceRuntimeComposition;
    // Keep the composition callback typed while capturing the exact input at the seam.
    const createComposition: typeof import('../src/composition').createKiteServiceRuntimeComposition =
      () => composition;

    await runKiteServiceMain(['service', 'run'], { environment, createComposition });
    expect(captured?.home.root).toBe(environment.KITE_CODE_HOME);
    expect(captured?.buildId).toBe(environment.KITE_SERVICE_BUILD_ID);
    expect(captured?.instanceId).toStartWith('service_');
    expect(resolveKiteServiceMainEnvironment(environment)).toEqual({
      codeRoot: environment.KITE_CODE_HOME,
      osHome: environment[osHomeKey]!,
      buildId: environment.KITE_SERVICE_BUILD_ID,
    });
  });
});
