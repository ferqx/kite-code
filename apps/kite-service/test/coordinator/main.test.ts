import { describe, expect, test } from 'bun:test';
import {
  type KiteCoordinatorProcessEnvironment,
  resolveKiteCoordinatorMainEnvironment,
  runKiteCoordinatorMain,
} from '../../src/coordinator/main';
import type { KiteCoordinatorComposition } from '../../src/coordinator/ports';

const managerEnvironment = Object.freeze({
  KITE_COORDINATOR_HOME: '/tmp/kite-home',
  KITE_COORDINATOR_COORDINATION_HOME: '/tmp/kite-coordination',
  KITE_COORDINATOR_CATALOG_PATH: '/tmp/kite-home/layouts/generation-1/catalog.sqlite',
  KITE_COORDINATOR_LAYOUT_GENERATION: 'generation-1',
  KITE_COORDINATOR_BUILD_ID: 'build-1',
  KITE_COORDINATOR_EXECUTABLE_MODE: 'source',
  KITE_COORDINATOR_COMPANION_ROOT: '/tmp/kite-source',
  KITE_COORDINATOR_WEB_STATIC_ROOT: '/tmp/kite-source/apps/kite-web/dist',
  KITE_COORDINATOR_READY_FD: '3',
  KITE_COORDINATOR_OS_UID: '501',
});

describe('Kite Coordinator process main', () => {
  test('parses only manager-known values and derives the child start identity after spawn', async () => {
    expect(resolveKiteCoordinatorMainEnvironment(managerEnvironment)).toEqual({
      home: '/tmp/kite-home',
      coordinationHome: '/tmp/kite-coordination',
      catalogPath: '/tmp/kite-home/layouts/generation-1/catalog.sqlite',
      layoutGeneration: 'generation-1',
      buildId: 'build-1',
      executableMode: 'source',
      companionRoot: '/tmp/kite-source',
      webStaticRoot: '/tmp/kite-source/apps/kite-web/dist',
      readinessFd: 3,
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
    });

    let captured: KiteCoordinatorProcessEnvironment | undefined;
    let disposed = 0;
    await runKiteCoordinatorMain(['coordinator', 'run'], {
      environment: managerEnvironment,
      readProcessStartIdentity: async () => 'linux:boot-id:123',
      createInstanceId: () => 'coordinator-instance-1',
      createComposition(environment) {
        captured = environment;
        return fakeComposition(() => {
          disposed += 1;
        });
      },
    });

    expect(captured).toMatchObject({
      processStartIdentity: 'linux:boot-id:123',
      instanceId: 'coordinator-instance-1',
    });
    expect(disposed).toBe(1);
  });

  test('fails before composition when the server-owned process identity is unavailable', async () => {
    let composed = false;
    await expect(
      runKiteCoordinatorMain(['coordinator', 'run'], {
        environment: managerEnvironment,
        readProcessStartIdentity: async () => undefined,
        createComposition() {
          composed = true;
          return fakeComposition();
        },
      }),
    ).rejects.toThrow('process start identity is unavailable');
    expect(composed).toBe(false);
  });

  test('rejects missing, extra, or unknown entry arguments', async () => {
    for (const args of [[], ['coordinator'], ['coordinator', 'run', 'extra'], ['service', 'run']]) {
      await expect(runKiteCoordinatorMain(args)).rejects.toThrow('exact `coordinator run`');
    }
  });
});

function fakeComposition(onDispose: () => void = () => undefined): KiteCoordinatorComposition {
  return {
    server: {
      phase: 'ready',
      descriptor: undefined,
      instanceLock: undefined,
      start: async () => ({ operation: 'start', outcome: 'applied', state: 'ready' }),
      stop: async () => ({ operation: 'stop', outcome: 'applied', state: 'absent' }),
      waitForShutdown: async () => ({
        operation: 'signal_shutdown',
        outcome: 'applied',
        state: 'absent',
      }),
      [Symbol.asyncDispose]: async () => undefined,
    },
    state: {} as KiteCoordinatorComposition['state'],
    registry: {} as KiteCoordinatorComposition['registry'],
    catalog: undefined,
    controlPlane: undefined,
    dispatcher: undefined,
    carrier: undefined,
    [Symbol.asyncDispose]: async () => {
      onDispose();
    },
  };
}
