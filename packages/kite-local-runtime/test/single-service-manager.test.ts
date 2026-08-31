import { describe, expect, test } from 'bun:test';
import { KiteLocalNativeConnectionError, type KiteSingleServiceClient } from '../src/client';
import {
  createKiteSingleServiceManager,
  createKiteSingleServiceNativeProcessIdentityProbe,
} from '../src/manager';
import {
  createKiteHomeIdentity,
  KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
  type KiteLocalRuntimeLifecycleReservation,
  readLocalProcessStartIdentity,
  resolveKiteLocalRuntimeEndpoint,
} from '../src/service';

const endpoint = resolveKiteLocalRuntimeEndpoint({
  home: createKiteHomeIdentity('/tmp/kite-single-manager-home'),
  runtimeParent: '/tmp',
  platform: 'linux',
});

const reservation: KiteLocalRuntimeLifecycleReservation = {
  schema: KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
  pid: 42_001,
  processStartIdentity: 'start-1',
  instanceId: 'service-1',
  buildId: 'build-1',
  startedAt: '2026-08-30T00:00:00.000Z',
};

describe('single-Service process manager', () => {
  test('uses PID plus OS start identity rather than PID existence alone', async () => {
    const current = await readLocalProcessStartIdentity(process.pid, process.platform);
    if (!current) return;
    const probe = createKiteSingleServiceNativeProcessIdentityProbe();
    await expect(probe.inspect(process.pid, current)).resolves.toBe('alive');
    await expect(probe.inspect(process.pid, `${current}-different`)).resolves.toBe('dead');
  });

  test('single-flights concurrent ensure and spawns only one ready Service', async () => {
    const runtime = fakeRuntime();
    let spawns = 0;
    let releases = 0;
    const manager = createKiteSingleServiceManager({
      endpoint,
      client: runtime.client,
      process: { inspect: async () => 'dead' },
      readReservation: () => undefined,
      spawn: {
        async spawn() {
          spawns += 1;
          return {
            waitForReady: async () => {
              runtime.ready = true;
            },
            releaseReadiness: async () => {
              releases += 1;
            },
          };
        },
      },
      requestId: () => 'ensure-1',
    });

    const [first, second] = await Promise.all([manager.ensure(), manager.ensure()]);
    expect(first).toMatchObject({
      operation: 'ensure',
      outcome: 'applied',
      state: 'ready',
    });
    expect(second).toEqual(first);
    expect(spawns).toBe(1);
    expect(releases).toBe(1);
  });

  test('waits an exact alive startup owner and never spawns a replacement', async () => {
    const runtime = fakeRuntime();
    let time = 0;
    let spawns = 0;
    const probes: Array<[number, string]> = [];
    const manager = createKiteSingleServiceManager({
      endpoint,
      client: runtime.client,
      process: {
        inspect: async (pid, start) => {
          probes.push([pid, start]);
          return 'alive';
        },
      },
      readReservation: () => reservation,
      spawn: {
        async spawn() {
          spawns += 1;
          throw new Error('must not spawn');
        },
      },
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
        runtime.ready = true;
      },
      pollIntervalMs: 1,
      startupTimeoutMs: 10,
      requestId: () => 'ensure-alive',
    });

    await expect(manager.ensure()).resolves.toMatchObject({
      outcome: 'applied',
      state: 'ready',
    });
    expect(probes).toEqual([[42_001, 'start-1']]);
    expect(spawns).toBe(0);
  });

  test('clears only an exact dead reservation before spawning', async () => {
    const runtime = fakeRuntime();
    let cleared = 0;
    let spawns = 0;
    const manager = createKiteSingleServiceManager({
      endpoint,
      client: runtime.client,
      process: { inspect: async () => 'dead' },
      readReservation: () => (cleared === 0 ? reservation : undefined),
      clearDead: async ({ expected }) => {
        expect(expected).toEqual(reservation);
        cleared += 1;
        return { outcome: 'cleared' };
      },
      spawn: {
        async spawn() {
          spawns += 1;
          return {
            waitForReady: async () => {
              runtime.ready = true;
            },
            releaseReadiness: async () => undefined,
          };
        },
      },
      requestId: () => 'ensure-dead',
    });
    await expect(manager.ensure()).resolves.toMatchObject({
      outcome: 'applied',
      state: 'ready',
    });
    expect(cleared).toBe(1);
    expect(spawns).toBe(1);
  });

  test('keeps uncertain identity and does not spawn or replay stop', async () => {
    const runtime = fakeRuntime();
    let spawns = 0;
    const uncertain = createKiteSingleServiceManager({
      endpoint,
      client: runtime.client,
      process: { inspect: async () => 'uncertain' },
      readReservation: () => reservation,
      spawn: {
        async spawn() {
          spawns += 1;
          throw new Error('must not spawn');
        },
      },
      requestId: () => 'ensure-uncertain',
    });
    await expect(uncertain.ensure()).resolves.toMatchObject({
      outcome: 'unavailable',
      diagnostic: 'identity_uncertain',
    });
    expect(spawns).toBe(0);

    runtime.ready = true;
    runtime.stopOutcome = 'service_busy';
    await expect(uncertain.stop()).resolves.toMatchObject({
      outcome: 'service_busy',
      state: 'ready',
    });
    expect(runtime.stopCalls).toBe(1);
  });

  test('does not treat corrupt lifecycle evidence or malformed endpoint responses as absence', async () => {
    const runtime = fakeRuntime();
    let spawns = 0;
    runtime.client.describe = async () => {
      throw new Error('malformed response');
    };
    const manager = createKiteSingleServiceManager({
      endpoint,
      client: runtime.client,
      process: { inspect: async () => 'dead' },
      readReservation: () => {
        throw new Error('corrupt reservation');
      },
      spawn: {
        async spawn() {
          spawns += 1;
          throw new Error('must not spawn');
        },
      },
      requestId: () => 'ensure-corrupt',
    });
    await expect(manager.ensure()).resolves.toMatchObject({
      outcome: 'unavailable',
      diagnostic: 'identity_uncertain',
    });
    expect(spawns).toBe(0);
  });

  test('waits through a post-stop zombie window without replaying stop', async () => {
    const runtime = fakeRuntime();
    runtime.ready = true;
    let reservationReads = 0;
    let waits = 0;
    const manager = createKiteSingleServiceManager({
      endpoint,
      client: runtime.client,
      process: { inspect: async () => 'uncertain' },
      readReservation: () => (++reservationReads < 3 ? reservation : undefined),
      spawn: {
        spawn: async () => {
          throw new Error('not used');
        },
      },
      wait: async () => {
        waits += 1;
      },
      now: () => waits,
      pollIntervalMs: 1,
      stopTimeoutMs: 10,
      requestId: () => 'stop-zombie',
    });
    await expect(manager.stop()).resolves.toMatchObject({
      outcome: 'applied',
      state: 'absent',
    });
    expect(runtime.stopCalls).toBe(1);
    expect(waits).toBe(1);
  });
});

function fakeRuntime(): {
  ready: boolean;
  stopCalls: number;
  stopOutcome: 'applied' | 'service_busy';
  readonly client: KiteSingleServiceClient;
} {
  const runtime = {
    ready: false,
    stopCalls: 0,
    stopOutcome: 'applied' as 'applied' | 'service_busy',
    client: undefined as unknown as KiteSingleServiceClient,
  };
  runtime.client = {
    describe: async () => {
      if (!runtime.ready) throw new KiteLocalNativeConnectionError('unavailable');
      return {
        schema: 'kite.local-native.response.v1',
        requestId: 'describe',
        operation: 'describe',
        outcome: 'ready',
        service: {
          instanceId: 'service-1',
          pid: 42_001,
          startedAt: '2026-08-30T00:00:00.000Z',
          protocolVersion: 1,
          clientContractRevision: 'kite-local-runtime-contract-v2',
          serverVersion: 'service-1',
          buildId: 'build-1',
          httpOrigin: 'http://127.0.0.1:43170',
        },
        accessToken: 'a'.repeat(43),
      };
    },
    ensureWeb: async () => {
      throw new Error('not used');
    },
    statusWeb: async () => {
      throw new Error('not used');
    },
    stopWeb: async () => {
      throw new Error('not used');
    },
    stopService: async () => {
      runtime.stopCalls += 1;
      if (runtime.stopOutcome === 'service_busy') {
        return {
          schema: 'kite.local-native.response.v1',
          requestId: 'stop',
          operation: 'service_stop',
          outcome: 'service_busy',
          state: 'ready',
        };
      }
      runtime.ready = false;
      return {
        schema: 'kite.local-native.response.v1',
        requestId: 'stop',
        operation: 'service_stop',
        outcome: 'applied',
        state: 'draining',
      };
    },
  };
  return runtime;
}
