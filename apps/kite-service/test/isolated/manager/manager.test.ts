import { describe, expect, test } from 'bun:test';
import {
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
  LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
  type LocalRuntimeServiceDescriptor,
} from '@kite-ai/kite-local-runtime/service';
import { createKiteServiceExecutableResolver } from '../../../src/manager/executable-resolver';
import { createKiteServiceManager } from '../../../src/manager/manager';
import type {
  KiteServiceManager,
  KiteServiceManagerControlResult,
  KiteServiceManagerEnvironment,
  KiteServiceManagerExecutable,
  KiteServiceManagerHandshake,
  KiteServiceManagerLifecycleLockLease,
  KiteServiceManagerLifecycleLockPort,
  KiteServiceManagerOptions,
  KiteServiceManagerProcessStatus,
  KiteServiceManagerReadinessHandle,
} from '../../../src/manager/ports';

const accessToken = 'a'.repeat(32);
const controlToken = 'c'.repeat(32);

function descriptor(
  instanceId = 'instance-1',
  pid = 41,
  buildId = 'build-1',
): LocalRuntimeServiceDescriptor {
  return {
    schema: LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
    instanceId,
    pid,
    startedAt: '2026-08-27T00:00:00.000Z',
    endpoint: {
      origin: 'http://127.0.0.1:43123',
      websocketUrl: 'ws://127.0.0.1:43123/rpc',
    },
    protocolVersion: 1,
    clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    serverVersion: 'service-1',
    buildId,
  };
}

function instanceLockFor(value: { readonly instanceId: string; readonly pid: number }) {
  return {
    schema: LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
    nonce: `lock-${value.instanceId}`,
    pid: value.pid,
    operation: 'start' as const,
    instanceId: value.instanceId,
    createdAt: '2026-08-27T00:00:00.000Z',
  };
}

type FakeState = {
  descriptor: unknown;
  accessToken?: string;
  controlToken?: string;
  instanceLock?: unknown;
  clearStaleCount: number;
  preserveFailureCount: number;
};

type FakeHarness = {
  readonly state: FakeState;
  readonly counts: {
    acquire: number;
    release: number;
    inspectProcess: number;
    quarantine: number;
    spawn: number;
    readinessRelease: number;
    kill: number;
    controlStop: number;
  };
  processStatus: KiteServiceManagerProcessStatus;
  lockOwnerStatus: 'absent' | KiteServiceManagerProcessStatus;
  handshake: KiteServiceManagerHandshake;
  controlResult: KiteServiceManagerControlResult;
  controlCleanup: 'all' | 'descriptor_only' | 'none';
  readiness: {
    resolve(value: { readonly instanceId: string }): void;
    reject(error: unknown): void;
  };
  setReadiness(value: Promise<{ readonly instanceId: string }>): void;
  options: KiteServiceManagerOptions;
};

function healthyHandshake(
  value: Partial<{
    instanceId: string;
    protocolVersion: number;
    clientContractRevision: string;
    buildId: string;
  }> = {},
) {
  return {
    outcome: 'healthy' as const,
    instanceId: value.instanceId ?? 'instance-1',
    protocolVersion: value.protocolVersion ?? 1,
    clientContractRevision: value.clientContractRevision ?? LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    buildId: value.buildId ?? 'build-1',
  };
}

function createHarness(initialDescriptor: unknown = undefined): FakeHarness {
  const descriptorIdentity =
    typeof initialDescriptor === 'object' &&
    initialDescriptor !== null &&
    'instanceId' in initialDescriptor &&
    typeof initialDescriptor.instanceId === 'string' &&
    'pid' in initialDescriptor &&
    typeof initialDescriptor.pid === 'number'
      ? { instanceId: initialDescriptor.instanceId, pid: initialDescriptor.pid }
      : undefined;
  const state: FakeState = {
    descriptor: initialDescriptor,
    accessToken,
    controlToken,
    instanceLock: descriptorIdentity ? instanceLockFor(descriptorIdentity) : undefined,
    clearStaleCount: 0,
    preserveFailureCount: 0,
  };
  const counts = {
    acquire: 0,
    release: 0,
    inspectProcess: 0,
    quarantine: 0,
    spawn: 0,
    readinessRelease: 0,
    kill: 0,
    controlStop: 0,
  };
  let lockHeld = false;
  let readinessPromise: Promise<{ readonly instanceId: string }> = Promise.resolve({
    instanceId: 'instance-1',
  });
  const readiness = {
    resolve: (_value: { readonly instanceId: string }) => undefined,
    reject: (_error: unknown) => undefined,
  };
  const setReadiness = (value: Promise<{ readonly instanceId: string }>) => {
    readinessPromise = value;
  };
  const lifecycleLock: KiteServiceManagerLifecycleLockPort = {
    async acquire() {
      counts.acquire += 1;
      if (harness.lockOwnerStatus !== 'absent') return undefined;
      if (lockHeld) return undefined;
      lockHeld = true;
      const release = async () => {
        if (!lockHeld) return;
        lockHeld = false;
        counts.release += 1;
      };
      const lease: KiteServiceManagerLifecycleLockLease = {
        release,
        [Symbol.asyncDispose]: release,
      };
      return lease;
    },
    async inspect() {
      const status = harness.lockOwnerStatus;
      if (status === 'absent') return { status } as const;
      return { status, pid: 777 } as const;
    },
    async quarantineStale() {
      counts.quarantine += 1;
      harness.lockOwnerStatus = 'absent';
    },
  };
  const harness = {
    state,
    counts,
    processStatus: 'dead' as KiteServiceManagerProcessStatus,
    lockOwnerStatus: 'absent' as 'absent' | KiteServiceManagerProcessStatus,
    handshake: healthyHandshake(),
    controlResult: { outcome: 'applied' as const },
    controlCleanup: 'all' as const,
    readiness,
    setReadiness,
    options: undefined as unknown as KiteServiceManagerOptions,
  } as FakeHarness;
  harness.options = {
    state: {
      async readDescriptor() {
        return state.descriptor;
      },
      async readToken(kind: 'access' | 'control') {
        return kind === 'access' ? state.accessToken : state.controlToken;
      },
      async readInstanceLock() {
        return state.instanceLock;
      },
      async clearStale() {
        state.clearStaleCount += 1;
        state.descriptor = undefined;
        state.instanceLock = undefined;
        state.accessToken = undefined;
        state.controlToken = undefined;
      },
      async preserveFailure() {
        state.preserveFailureCount += 1;
      },
    },
    lifecycleLock,
    probe: {
      async handshake() {
        if (counts.spawn > 0 && harness.handshake.outcome === 'unavailable') {
          return healthyHandshake();
        }
        return harness.handshake;
      },
    },
    process: {
      async inspect() {
        counts.inspectProcess += 1;
        return harness.processStatus;
      },
    },
    environment: {
      async resolve(): Promise<KiteServiceManagerEnvironment> {
        return { cwd: '/tmp/kite-service-neutral', env: { KITE_CODE_HOME: '/tmp/kite-home' } };
      },
    },
    executableResolver: {
      async resolve(mode: 'source' | 'installed') {
        return {
          path: `/tmp/kite-${mode}`,
          mode,
          buildId: 'build-1',
        } as KiteServiceManagerExecutable;
      },
    },
    spawn: {
      async spawn() {
        counts.spawn += 1;
        const launched = descriptor();
        state.descriptor = launched;
        state.instanceLock = instanceLockFor(launched);
        state.accessToken = accessToken;
        state.controlToken = controlToken;
        const readinessHandle: KiteServiceManagerReadinessHandle = {
          async release() {
            counts.readinessRelease += 1;
          },
        };
        return {
          pid: 41,
          readiness: readinessHandle,
          waitForReady: async () => readinessPromise,
        };
      },
    },
    control: {
      async stop() {
        counts.controlStop += 1;
        if (
          harness.controlResult.outcome === 'applied' &&
          harness.controlResult.diagnostic === undefined &&
          harness.controlCleanup !== 'none'
        ) {
          state.descriptor = undefined;
          if (harness.controlCleanup === 'all') {
            state.instanceLock = undefined;
            state.accessToken = undefined;
            state.controlToken = undefined;
          }
        }
        return harness.controlResult;
      },
    },
    startupTimeoutMs: 25,
    operationTimeoutMs: 250,
  };
  return harness;
}

function manager(
  harness: FakeHarness,
  extra: Partial<KiteServiceManagerOptions> = {},
): KiteServiceManager {
  return createKiteServiceManager({ ...harness.options, ...extra });
}

describe('Kite Service app-private lifecycle manager', () => {
  test('serializes twenty concurrent ensure calls and spawns one healthy child', async () => {
    const harness = createHarness();
    const service = manager(harness);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => service.ensure({ requestId: `ensure-${index}` })),
    );

    expect(results).toHaveLength(20);
    expect(results.every((value) => value.outcome === 'applied')).toBe(true);
    expect(harness.counts.spawn).toBe(1);
    expect(harness.counts.acquire).toBe(20);
    expect(harness.counts.release).toBe(20);
    expect(harness.counts.readinessRelease).toBe(1);
  });

  test('healthy instance is returned without spawning and reports build mismatch diagnostically', async () => {
    const harness = createHarness(descriptor());
    harness.handshake = healthyHandshake({ buildId: 'old-build' });
    const result = await manager(harness, { expectedBuildId: 'new-build' }).ensure({
      requestId: 'healthy',
    });

    expect(result).toMatchObject({
      outcome: 'applied',
      state: 'ready',
      diagnostic: 'build_mismatch',
    });
    expect(harness.counts.spawn).toBe(0);
    expect(harness.counts.inspectProcess).toBe(0);
  });

  test.each([
    'missing',
    'mismatched',
  ] as const)('rejects a healthy descriptor whose instance lock is %s', async (lockState) => {
    const current = descriptor();
    const harness = createHarness(current);
    harness.state.instanceLock =
      lockState === 'missing'
        ? undefined
        : instanceLockFor({ instanceId: 'other-instance', pid: current.pid });

    const result = await manager(harness).ensure({ requestId: `lock-${lockState}` });

    expect(result).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
    expect(harness.counts.spawn).toBe(0);
    expect(harness.state.clearStaleCount).toBe(0);
  });

  test('quarantines an orphan lifecycle owner and retries only after positive dead inspection', async () => {
    const harness = createHarness();
    harness.lockOwnerStatus = 'dead';
    const result = await manager(harness).ensure({ requestId: 'orphan' });

    expect(result.outcome).toBe('applied');
    expect(harness.counts.quarantine).toBe(1);
    expect(harness.counts.spawn).toBe(1);
  });

  test.each([
    'alive',
    'uncertain',
  ] as const)('does not spawn when lifecycle owner is %s', async (ownerStatus) => {
    const harness = createHarness();
    harness.lockOwnerStatus = ownerStatus;
    const result = await manager(harness).ensure({ requestId: `owner-${ownerStatus}` });

    expect(result).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
    expect(harness.counts.spawn).toBe(0);
    expect(harness.counts.quarantine).toBe(0);
  });

  test.each([
    'alive',
    'uncertain',
  ] as const)('does not spawn in the descriptor publication window while instance owner is %s', async (processStatus) => {
    const harness = createHarness();
    harness.state.instanceLock = {
      schema: LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
      nonce: 'instance-publication-window',
      pid: 41,
      operation: 'start',
      instanceId: 'instance-1',
      createdAt: '2026-08-27T00:00:00.000Z',
    };
    harness.processStatus = processStatus;

    const result = await manager(harness).ensure({ requestId: `window-${processStatus}` });

    expect(result).toMatchObject({
      outcome: 'unavailable',
      state: 'starting',
      diagnostic: 'identity_uncertain',
    });
    expect(harness.counts.spawn).toBe(0);
    expect(harness.state.clearStaleCount).toBe(0);
  });

  test('clears a dead descriptorless instance owner before one replacement spawn', async () => {
    const harness = createHarness();
    harness.state.instanceLock = {
      schema: LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
      nonce: 'dead-instance-publication-window',
      pid: 41,
      operation: 'start',
      instanceId: 'instance-1',
      createdAt: '2026-08-27T00:00:00.000Z',
    };
    harness.processStatus = 'dead';

    const result = await manager(harness).ensure({ requestId: 'dead-window' });

    expect(result.outcome).toBe('applied');
    expect(harness.state.clearStaleCount).toBe(1);
    expect(harness.counts.spawn).toBe(1);
  });

  test.each([
    'alive',
    'uncertain',
  ] as const)('does not clear or replace a descriptor when its process is %s', async (processStatus) => {
    const harness = createHarness(descriptor());
    harness.handshake = { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
    harness.processStatus = processStatus;
    const result = await manager(harness).ensure({ requestId: `pid-${processStatus}` });

    expect(result).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
    expect(harness.state.clearStaleCount).toBe(0);
    expect(harness.counts.spawn).toBe(0);
  });

  test('clears stale state only after a dead process and then launches', async () => {
    const harness = createHarness(descriptor());
    harness.handshake = { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
    harness.processStatus = 'dead';
    const result = await manager(harness).ensure({ requestId: 'dead' });

    expect(result.outcome).toBe('applied');
    expect(harness.state.clearStaleCount).toBe(1);
    expect(harness.counts.spawn).toBe(1);
  });

  test('releases the independent readiness handle on startup timeout without killing the child', async () => {
    const harness = createHarness();
    harness.setReadiness(new Promise(() => undefined));
    const result = await manager(harness).ensure({ requestId: 'timeout' });

    expect(result).toMatchObject({ outcome: 'unavailable', state: 'absent' });
    expect(harness.counts.readinessRelease).toBe(1);
    expect(harness.counts.kill).toBe(0);
    expect(harness.state.preserveFailureCount).toBe(1);
    expect(harness.state.descriptor).toBeDefined();
  });

  test('releases readiness and preserves failure when the child publishes a wrong identity', async () => {
    const harness = createHarness();
    harness.setReadiness(Promise.resolve({ instanceId: 'wrong-instance' }));
    const result = await manager(harness).ensure({ requestId: 'wrong-ready' });

    expect(result).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
    expect(harness.counts.readinessRelease).toBe(1);
    expect(harness.state.preserveFailureCount).toBe(1);
    expect(harness.state.clearStaleCount).toBe(0);
  });

  test.each([
    ['protocol', { ...descriptor(), protocolVersion: 99 }],
    ['client contract', { ...descriptor(), clientContractRevision: 'other-contract' }],
  ] as const)('rejects a %s-mismatched descriptor without spawning', async (_label, raw) => {
    const harness = createHarness(raw);
    const result = await manager(harness).ensure({ requestId: 'descriptor-mismatch' });

    expect(result.outcome).toBe('incompatible');
    expect(result.diagnostic).toMatch(/protocol_incompatible|client_contract_incompatible/);
    expect(harness.counts.spawn).toBe(0);
    expect(harness.state.clearStaleCount).toBe(0);
  });

  test('stop busy leaves state published and restart does not retry the control mutation', async () => {
    const harness = createHarness(descriptor());
    harness.controlResult = { outcome: 'service_busy', diagnostic: 'service_busy' };
    const service = manager(harness);
    const busy = await service.stop({ requestId: 'busy' });

    expect(busy).toMatchObject({ outcome: 'service_busy', state: 'ready' });
    expect(harness.state.clearStaleCount).toBe(0);
    expect(harness.counts.controlStop).toBe(1);
    expect(harness.counts.spawn).toBe(0);
  });

  test('restart waits for Service-owned cleanup and launches exactly one replacement', async () => {
    const harness = createHarness(descriptor());
    const service = manager(harness);
    const result = await service.restart({ requestId: 'restart', executableMode: 'installed' });

    expect(result).toMatchObject({ operation: 'restart', outcome: 'applied', state: 'ready' });
    expect(harness.counts.controlStop).toBe(1);
    expect(harness.state.clearStaleCount).toBe(0);
    expect(harness.counts.spawn).toBe(1);
    expect(harness.counts.readinessRelease).toBe(1);
  });

  test('does not treat descriptor-only removal as a completed stop or mutate after deadline', async () => {
    const harness = createHarness(descriptor());
    harness.controlCleanup = 'descriptor_only';
    harness.processStatus = 'alive';
    const result = await manager(harness, { operationTimeoutMs: 25 }).stop({
      requestId: 'partial-cleanup',
    });

    expect(result).toMatchObject({ outcome: 'unavailable', state: 'draining' });
    expect(harness.state.instanceLock).toBeDefined();
    expect(harness.state.accessToken).toBeDefined();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(harness.state.clearStaleCount).toBe(0);
  });

  test('rejects malformed access and control token material before invoking ports', async () => {
    const ensureHarness = createHarness(descriptor());
    ensureHarness.state.accessToken = 'short';
    const ensure = await manager(ensureHarness).ensure({ requestId: 'bad-access' });
    expect(ensure).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });

    const stopHarness = createHarness(descriptor());
    stopHarness.state.controlToken = 'bad\ncontrol';
    const stop = await manager(stopHarness).stop({ requestId: 'bad-control' });
    expect(stop).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
    expect(stopHarness.counts.controlStop).toBe(0);
  });

  test('rejects missing runtime build identity and inconsistent machine results', async () => {
    const missingBuild = createHarness(descriptor());
    missingBuild.handshake = {
      outcome: 'healthy',
      instanceId: 'instance-1',
      protocolVersion: 1,
      clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    };
    expect(
      await manager(missingBuild, { expectedBuildId: 'build-1' }).ensure({
        requestId: 'missing-build',
      }),
    ).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });

    const inconsistentHandshake = createHarness(descriptor());
    inconsistentHandshake.handshake = {
      ...healthyHandshake(),
      diagnostic: 'protocol_incompatible',
    };
    expect(
      await manager(inconsistentHandshake).ensure({ requestId: 'inconsistent-handshake' }),
    ).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });

    const inconsistentControl = createHarness(descriptor());
    inconsistentControl.controlResult = { outcome: 'applied', diagnostic: 'service_busy' };
    expect(
      await manager(inconsistentControl).stop({ requestId: 'inconsistent-control' }),
    ).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
    expect(inconsistentControl.state.descriptor).toBeDefined();
  });

  test('rejects an executable build mismatch and a child PID mismatch', async () => {
    const buildHarness = createHarness();
    const buildResult = await manager(buildHarness, { expectedBuildId: 'build-2' }).ensure({
      requestId: 'executable-build',
    });
    expect(buildResult).toMatchObject({ outcome: 'unavailable', diagnostic: 'build_mismatch' });
    expect(buildHarness.counts.spawn).toBe(0);

    const pidHarness = createHarness();
    const originalSpawn = pidHarness.options.spawn;
    const pidResult = await manager(pidHarness, {
      spawn: {
        async spawn(input) {
          const child = await originalSpawn.spawn(input);
          return { ...child, pid: 999 };
        },
      },
    }).ensure({ requestId: 'pid-mismatch' });
    expect(pidResult).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
  });

  test('unknown stop outcome preserves state and does not clear or retry', async () => {
    const harness = createHarness(descriptor());
    harness.controlResult = { outcome: 'outcome_unknown' };
    const result = await manager(harness).stop({ requestId: 'unknown' });

    expect(result).toMatchObject({ outcome: 'outcome_unknown', state: 'ready' });
    expect(harness.state.clearStaleCount).toBe(0);
    expect(harness.counts.controlStop).toBe(1);
  });

  test('maps an unavailable control diagnostic to the public fail-closed identity diagnostic', async () => {
    const harness = createHarness(descriptor());
    harness.controlResult = { outcome: 'unavailable', diagnostic: 'service_unavailable' };
    const result = await manager(harness).stop({ requestId: 'unavailable' });

    expect(result).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
    expect(harness.state.clearStaleCount).toBe(0);
  });

  test('resolves source and installed executables explicitly without cwd or PATH fallback', async () => {
    const resolver = createKiteServiceExecutableResolver({
      source: '/opt/kite/source/service',
      installed: '/opt/kite/installed/service',
      sourceBuildId: 'dev:abc123',
      installedBuildId: 'release:1',
    });

    await expect(resolver.resolve('source')).resolves.toEqual({
      path: '/opt/kite/source/service',
      mode: 'source',
      buildId: 'dev:abc123',
    });
    await expect(resolver.resolve('installed')).resolves.toEqual({
      path: '/opt/kite/installed/service',
      mode: 'installed',
      buildId: 'release:1',
    });
    expect(() =>
      createKiteServiceExecutableResolver({ source: 'service', installed: '/opt/service' }),
    ).toThrow();
  });

  test('rejects unbounded lifecycle deadlines at construction', () => {
    const harness = createHarness();
    expect(() => manager(harness, { startupTimeoutMs: 0.5 })).toThrow();
    expect(() => manager(harness, { operationTimeoutMs: 300_001 })).toThrow();
  });
});
