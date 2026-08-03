import { describe, expect, test } from 'bun:test';
import { createTuiExitCoordinatorV1 } from '@/app/tui/exit-coordinator';

describe('TUI exit coordinator', () => {
  test('awaits bounded observability shutdown before dispose, unmount, and exit', async () => {
    const order: string[] = [];
    let releaseShutdown: (() => void) | undefined;
    const shutdown = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const coordinator = createTuiExitCoordinatorV1({
      getSessionLifecycle: () => ({
        abortAll: () => order.push('abort'),
        shutdownObservability: async (timeoutMs) => {
          order.push(`shutdown:${timeoutMs}`);
          await shutdown;
        },
        dispose: () => order.push('dispose'),
      }),
      unmount: () => order.push('unmount'),
      exit: (code) => order.push(`exit:${code}`),
    });

    const first = coordinator.requestExit();
    const second = coordinator.requestExit();
    expect(second).toBe(first);
    expect(order).toEqual(['abort', 'shutdown:250']);
    releaseShutdown?.();
    await first;
    expect(order).toEqual(['abort', 'shutdown:250', 'dispose', 'unmount', 'exit:0']);
  });

  test('restores the terminal and exits even when telemetry shutdown fails', async () => {
    const order: string[] = [];
    const coordinator = createTuiExitCoordinatorV1({
      getSessionLifecycle: () => ({
        abortAll: () => order.push('abort'),
        shutdownObservability: async () => {
          throw new Error('exporter unavailable');
        },
        dispose: () => order.push('dispose'),
      }),
      unmount: () => order.push('unmount'),
      exit: () => order.push('exit'),
    });

    await coordinator.requestExit(1);
    expect(order).toEqual(['abort', 'dispose', 'unmount', 'exit']);
  });

  test('still unmounts and exits when dispose fails', async () => {
    const order: string[] = [];
    const coordinator = createTuiExitCoordinatorV1({
      getSessionLifecycle: () => ({
        abortAll: () => order.push('abort'),
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
    expect(order).toEqual(['abort', 'shutdown', 'dispose', 'unmount', 'exit:1']);
  });

  test('still attempts telemetry shutdown when abort fails', async () => {
    const order: string[] = [];
    const coordinator = createTuiExitCoordinatorV1({
      getSessionLifecycle: () => ({
        abortAll: () => {
          order.push('abort');
          throw new Error('runtime cancellation failed');
        },
        shutdownObservability: async () => {
          order.push('shutdown');
        },
        dispose: () => order.push('dispose'),
      }),
      unmount: () => order.push('unmount'),
      exit: () => order.push('exit'),
    });

    await coordinator.requestExit();
    expect(order).toEqual(['abort', 'shutdown', 'dispose', 'unmount', 'exit']);
  });
});
