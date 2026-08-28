import { describe, expect, test } from 'bun:test';
import { createTuiExitCoordinator } from '#kite-cli/tui/exit-coordinator';

describe('TUI exit coordinator', () => {
  test('awaits bounded observability shutdown before dispose, unmount, and exit', async () => {
    const order: string[] = [];
    let releaseShutdown: (() => void) | undefined;
    const shutdown = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const coordinator = createTuiExitCoordinator({
      getSessionLifecycle: () => ({
        shutdownObservability: async (timeoutMs) => {
          order.push(`shutdown:${timeoutMs}`);
          await shutdown;
        },
        dispose: () => {
          order.push('dispose');
        },
      }),
      unmount: () => order.push('unmount'),
      exit: (code) => order.push(`exit:${code}`),
    });

    const first = coordinator.requestExit();
    const second = coordinator.requestExit();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(order).toEqual(['shutdown:250']);
    releaseShutdown?.();
    await first;
    expect(order).toEqual(['shutdown:250', 'dispose', 'unmount', 'exit:0']);
  });

  test('restores the terminal and exits even when telemetry shutdown fails', async () => {
    const order: string[] = [];
    const coordinator = createTuiExitCoordinator({
      getSessionLifecycle: () => ({
        shutdownObservability: async () => {
          throw new Error('exporter unavailable');
        },
        dispose: () => {
          order.push('dispose');
        },
      }),
      unmount: () => order.push('unmount'),
      exit: () => order.push('exit'),
    });

    await coordinator.requestExit(1);
    expect(order).toEqual(['dispose', 'unmount', 'exit']);
  });

  test('still unmounts and exits when dispose fails', async () => {
    const order: string[] = [];
    const coordinator = createTuiExitCoordinator({
      getSessionLifecycle: () => ({
        shutdownObservability: async () => {
          order.push('shutdown');
        },
        dispose: () => {
          order.push('dispose');
          throw new Error('stats store unavailable');
        },
      }),
      unmount: () => order.push('unmount'),
      exit: (code) => order.push(`exit:${code}`),
    });

    await coordinator.requestExit(1);
    expect(order).toEqual(['shutdown', 'dispose', 'unmount', 'exit:1']);
  });

  test('aborts the in-flight startup prewarm before client shutdown', async () => {
    const order: string[] = [];
    const coordinator = createTuiExitCoordinator({
      getSessionLifecycle: () => ({
        shutdownObservability: async () => {
          order.push('shutdown');
        },
        dispose: () => {
          order.push('dispose');
        },
      }),
      getShellExecutor: () => ({
        abortPreparation: () => order.push('abort-preparation'),
      }),
      unmount: () => order.push('unmount'),
      exit: () => order.push('exit'),
    });

    await coordinator.requestExit();
    expect(order).toEqual(['abort-preparation', 'shutdown', 'dispose', 'unmount', 'exit']);
  });

  test('a failing prewarm abort cannot strand terminal teardown', async () => {
    const order: string[] = [];
    const coordinator = createTuiExitCoordinator({
      getSessionLifecycle: () => ({
        shutdownObservability: async () => {
          order.push('shutdown');
        },
        dispose: () => {
          order.push('dispose');
        },
      }),
      getShellExecutor: () => ({
        abortPreparation: () => {
          throw new Error('prewarm abort failed');
        },
      }),
      unmount: () => order.push('unmount'),
      exit: () => order.push('exit'),
    });

    await coordinator.requestExit(1);
    expect(order).toEqual(['shutdown', 'dispose', 'unmount', 'exit']);
  });
});
