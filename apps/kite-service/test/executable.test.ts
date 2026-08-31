import { describe, expect, test } from 'bun:test';
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
      KITE_SERVICE_WEB_STATIC_ROOT: '/tmp/kite-service-web',
      KITE_SINGLE_SERVICE_RUNTIME_PARENT: '/tmp',
    } satisfies Record<string, string>;

    await expect(
      runKiteServiceMain(['service', 'run-single'], {
        environment: { ...base, KITE_CODE_HOME: 'relative-home' },
        createComposition,
      }),
    ).rejects.toThrow();
    await expect(
      runKiteServiceMain(['service', 'run-single'], {
        environment: { ...base, KITE_CODE_HOME: '/tmp/evil\nroot' },
        createComposition,
      }),
    ).rejects.toThrow();
    const withoutOsHome: Record<string, string | undefined> = { ...base };
    withoutOsHome[osHomeKey] = undefined;
    await expect(
      runKiteServiceMain(['service', 'run-single'], {
        environment: withoutOsHome,
        createComposition,
      }),
    ).rejects.toThrow();
    const withoutBuildId: Record<string, string | undefined> = { ...base };
    withoutBuildId.KITE_SERVICE_BUILD_ID = undefined;
    await expect(
      runKiteServiceMain(['service', 'run-single'], {
        environment: withoutBuildId,
        createComposition,
      }),
    ).rejects.toThrow();
    const withoutRuntimeParent: Record<string, string | undefined> = { ...base };
    withoutRuntimeParent.KITE_SINGLE_SERVICE_RUNTIME_PARENT = undefined;
    await expect(
      runKiteServiceMain(['service', 'run-single'], {
        environment: withoutRuntimeParent,
        createComposition,
      }),
    ).rejects.toThrow('KITE_SINGLE_SERVICE_RUNTIME_PARENT');
  });

  test('rejects the retired Service entry and resolves the exact neutral manager environment', async () => {
    const osHomeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const environment = {
      KITE_CODE_HOME: '/tmp/kite-service-code',
      [osHomeKey]: '/tmp/kite-service-os-home',
      KITE_SERVICE_BUILD_ID: 'installed:2026-08-27',
      KITE_SERVICE_WEB_STATIC_ROOT: '/tmp/kite-service-web',
    } satisfies Record<string, string>;
    await expect(runKiteServiceMain(['service', 'run'], { environment })).rejects.toThrow(
      'run-single',
    );
    expect(resolveKiteServiceMainEnvironment(environment)).toEqual({
      codeRoot: environment.KITE_CODE_HOME,
      osHome: environment[osHomeKey]!,
      buildId: environment.KITE_SERVICE_BUILD_ID,
      webStaticRoot: environment.KITE_SERVICE_WEB_STATIC_ROOT,
    });
  });

  test('rejects missing Web assets before constructing Runtime or Store composition', async () => {
    let composed = false;
    await expect(
      runKiteServiceMain(['service', 'run-single'], {
        environment: {
          KITE_CODE_HOME: '/tmp/kite-service-missing-web-home',
          [process.platform === 'win32' ? 'USERPROFILE' : 'HOME']:
            '/tmp/kite-service-missing-web-os-home',
          KITE_SERVICE_BUILD_ID: 'dev:missing-web',
          KITE_SERVICE_WEB_STATIC_ROOT: '/tmp/kite-service-missing-web-assets',
          KITE_SINGLE_SERVICE_RUNTIME_PARENT: '/tmp',
        },
        createComposition: () => {
          composed = true;
          throw new Error('composition must not be constructed');
        },
      }),
    ).rejects.toThrow('Service Web assets are missing or invalid.');
    expect(composed).toBe(false);
  });
});
