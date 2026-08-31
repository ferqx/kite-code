import { describe, expect, test } from 'bun:test';
import {
  KiteLocalNativeConnectionError,
  type KiteSingleServiceClient,
  KiteSingleServiceClientError,
} from '../src/client';
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
const windowsEndpoint = resolveKiteLocalRuntimeEndpoint({
  home: createKiteHomeIdentity('/tmp/kite-single-manager-windows-home'),
  platform: 'win32',
});

const reservation: KiteLocalRuntimeLifecycleReservation = {
  schema: KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
  pid: 42_001,
  processStartIdentity: 'start-1',
  instanceId: 'service-1',
  buildId: 'build-1',
  startedAt: '2026-08-30T00:00:00.000Z',
};
const previousInstalledReservation: KiteLocalRuntimeLifecycleReservation = {
  ...reservation,
  buildId: '1'.repeat(24),
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

  test('installed ensure waits out a busy previous build, stops it, and launches the current build', async () => {
    const runtime = installedUpgradeRuntime(['service_busy', 'service_busy', 'applied']);
    const manager = createKiteSingleServiceManager({
      endpoint,
      client: runtime.currentClient,
      clientForBuild: (buildId) => {
        expect(buildId).toBe(previousInstalledReservation.buildId);
        return runtime.previousClient;
      },
      canReplaceInstalledBuild: () => true,
      process: { inspect: async () => 'alive' },
      readReservation: () => (runtime.previousReady ? previousInstalledReservation : undefined),
      spawn: {
        async spawn() {
          runtime.spawns += 1;
          return {
            waitForReady: async () => {
              runtime.currentReady = true;
            },
            releaseReadiness: async () => undefined,
          };
        },
      },
      now: () => runtime.time,
      wait: async (milliseconds) => {
        runtime.time += milliseconds;
      },
      pollIntervalMs: 1,
      stopTimeoutMs: 10,
      requestId: () => 'installed-upgrade',
    });

    await expect(manager.ensure({ executableMode: 'installed' })).resolves.toMatchObject({
      operation: 'ensure',
      outcome: 'applied',
      state: 'ready',
    });
    expect(runtime.stopCalls).toBe(3);
    expect(runtime.spawns).toBe(1);
  });

  test('installed ensure never forces a permanently busy previous build', async () => {
    const runtime = installedUpgradeRuntime([]);
    const manager = createKiteSingleServiceManager({
      endpoint,
      client: runtime.currentClient,
      clientForBuild: () => runtime.previousClient,
      canReplaceInstalledBuild: () => true,
      process: { inspect: async () => 'alive' },
      readReservation: () => previousInstalledReservation,
      spawn: {
        async spawn() {
          runtime.spawns += 1;
          throw new Error('must not spawn');
        },
      },
      now: () => runtime.time,
      wait: async (milliseconds) => {
        runtime.time += milliseconds;
      },
      pollIntervalMs: 1,
      stopTimeoutMs: 3,
      requestId: () => 'installed-upgrade-busy',
    });

    await expect(manager.ensure({ executableMode: 'installed' })).resolves.toMatchObject({
      operation: 'ensure',
      outcome: 'service_busy',
      state: 'ready',
      diagnostic: 'service_busy',
    });
    expect(runtime.stopCalls).toBeGreaterThan(1);
    expect(runtime.spawns).toBe(0);
  });

  test('installed ensure resolves an ambiguous stop from exact absence without replaying it', async () => {
    const runtime = installedUpgradeRuntime(['outcome_unknown']);
    const manager = createKiteSingleServiceManager({
      endpoint,
      client: runtime.currentClient,
      clientForBuild: () => runtime.previousClient,
      canReplaceInstalledBuild: () => true,
      process: { inspect: async () => (runtime.previousReady ? 'alive' : 'dead') },
      readReservation: () => (runtime.previousReady ? previousInstalledReservation : undefined),
      spawn: {
        async spawn() {
          runtime.spawns += 1;
          return {
            waitForReady: async () => {
              runtime.currentReady = true;
            },
            releaseReadiness: async () => undefined,
          };
        },
      },
      requestId: () => 'installed-upgrade-ambiguous',
    });

    await expect(manager.ensure({ executableMode: 'installed' })).resolves.toMatchObject({
      outcome: 'applied',
      state: 'ready',
    });
    expect(runtime.stopCalls).toBe(1);
    expect(runtime.spawns).toBe(1);
  });

  test('Windows installed ensure replaces the previous build without a filesystem reservation', async () => {
    const runtime = installedUpgradeRuntime(['applied']);
    runtime.currentClient = {
      ...runtime.currentClient,
      stopService: runtime.previousClient.stopService,
    };
    const manager = createKiteSingleServiceManager({
      endpoint: windowsEndpoint,
      client: runtime.currentClient,
      canReplaceInstalledBuild: () => true,
      process: { inspect: async () => 'uncertain' },
      readReservation: () => undefined,
      spawn: {
        async spawn() {
          runtime.spawns += 1;
          return {
            waitForReady: async () => {
              runtime.currentReady = true;
            },
            releaseReadiness: async () => undefined,
          };
        },
      },
      requestId: () => 'windows-installed-upgrade',
    });

    await expect(manager.ensure({ executableMode: 'installed' })).resolves.toMatchObject({
      outcome: 'applied',
      state: 'ready',
    });
    expect(runtime.stopCalls).toBe(1);
    expect(runtime.spawns).toBe(1);
  });

  test('an inactive installed candidate cannot replace the current Service', async () => {
    const runtime = installedUpgradeRuntime(['applied']);
    const manager = createKiteSingleServiceManager({
      endpoint,
      client: runtime.currentClient,
      clientForBuild: () => runtime.previousClient,
      canReplaceInstalledBuild: () => false,
      process: { inspect: async () => 'alive' },
      readReservation: () => previousInstalledReservation,
      spawn: { spawn: async () => Promise.reject(new Error('must not spawn')) },
      requestId: () => 'inactive-installed-candidate',
    });

    await expect(manager.ensure({ executableMode: 'installed' })).resolves.toMatchObject({
      outcome: 'incompatible',
      state: 'ready',
      diagnostic: 'build_mismatch',
    });
    expect(runtime.stopCalls).toBe(0);
    expect(runtime.spawns).toBe(0);
  });

  test('source ensure does not replace an incompatible installed owner', async () => {
    const runtime = installedUpgradeRuntime(['applied']);
    let compatibilityClients = 0;
    const manager = createKiteSingleServiceManager({
      endpoint,
      client: runtime.currentClient,
      clientForBuild: () => {
        compatibilityClients += 1;
        return runtime.previousClient;
      },
      process: { inspect: async () => 'alive' },
      readReservation: () => previousInstalledReservation,
      spawn: { spawn: async () => Promise.reject(new Error('must not spawn')) },
      requestId: () => 'source-mismatch',
    });

    await expect(manager.ensure({ executableMode: 'source' })).resolves.toMatchObject({
      outcome: 'incompatible',
      diagnostic: 'build_mismatch',
    });
    expect(compatibilityClients).toBe(0);
    expect(runtime.stopCalls).toBe(0);
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

function installedUpgradeRuntime(
  stopOutcomes: Array<'service_busy' | 'applied' | 'outcome_unknown'>,
) {
  const runtime = {
    previousReady: true,
    currentReady: false,
    stopCalls: 0,
    spawns: 0,
    time: 0,
    currentClient: undefined as unknown as KiteSingleServiceClient,
    previousClient: undefined as unknown as KiteSingleServiceClient,
  };
  runtime.currentClient = unusedClient({
    describe: async () => {
      if (runtime.currentReady) return described('2'.repeat(24), 'service-2');
      if (runtime.previousReady) throw new KiteSingleServiceClientError('incompatible');
      throw new KiteLocalNativeConnectionError('unavailable');
    },
  });
  runtime.previousClient = unusedClient({
    describe: async () => described(previousInstalledReservation.buildId, 'service-1'),
    stopService: async () => {
      runtime.stopCalls += 1;
      const outcome = stopOutcomes.shift() ?? 'service_busy';
      if (outcome === 'service_busy') {
        return {
          schema: 'kite.local-native.response.v1',
          requestId: `stop-${runtime.stopCalls}`,
          operation: 'service_stop',
          outcome,
          state: 'ready',
        };
      }
      runtime.previousReady = false;
      if (outcome === 'outcome_unknown') throw new Error('response lost after accepted stop');
      return {
        schema: 'kite.local-native.response.v1',
        requestId: `stop-${runtime.stopCalls}`,
        operation: 'service_stop',
        outcome,
        state: 'draining',
      };
    },
  });
  return runtime;
}

function described(buildId: string, instanceId: string) {
  return {
    schema: 'kite.local-native.response.v1',
    requestId: 'describe',
    operation: 'describe',
    outcome: 'ready',
    service: {
      instanceId,
      pid: 42_001,
      startedAt: '2026-08-30T00:00:00.000Z',
      protocolVersion: 1,
      clientContractRevision: 'kite-local-runtime-contract-v2',
      serverVersion: 'service-1',
      buildId,
      httpOrigin: 'http://127.0.0.1:43170',
    },
    accessToken: 'a'.repeat(43),
  } as const;
}

function unusedClient(overrides: Partial<KiteSingleServiceClient> = {}): KiteSingleServiceClient {
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    describe: unused,
    ensureWeb: unused,
    statusWeb: unused,
    stopWeb: unused,
    stopService: unused,
    ...overrides,
  };
}
