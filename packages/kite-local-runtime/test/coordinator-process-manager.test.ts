import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorIdentity,
  type CoordinatorProcessDescriptor,
  type CoordinatorProcessLockIdentity,
  type CoordinatorProcessStatePort,
  coordinatorManagedConnection,
  createCoordinatorProcessLockIdentity,
  createCoordinatorProcessManager,
  createCoordinatorProcessStatePort,
  createCoordinatorUnixSocketEndpoint,
} from '@kite-ai/kite-local-runtime/coordinator';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';

const identity: CoordinatorIdentity = {
  role: 'coordinator',
  instanceId: 'coordinator-manager-instance',
  buildId: 'build-manager-1',
  protocolVersion: COORDINATOR_PROTOCOL_VERSION,
  protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
  clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
};

function createHarness(
  options: { readonly managerProcessStartIdentity?: string; readonly spawnFails?: boolean } = {},
) {
  const managerProcessStartIdentity =
    'managerProcessStartIdentity' in options
      ? options.managerProcessStartIdentity
      : 'manager-start-1';
  let descriptor: CoordinatorProcessDescriptor | undefined;
  let launchIntent: unknown | undefined;
  let instanceLock: CoordinatorProcessLockIdentity | undefined;
  let lifecycleLock: CoordinatorProcessLockIdentity | undefined;
  let processStatus: 'dead' | 'alive' | 'uncertain' = 'dead';
  let spawnCount = 0;
  let stopCount = 0;
  const endpoint = createCoordinatorUnixSocketEndpoint({
    endpointId: 'manager-endpoint',
    ownerUid: typeof process.getuid === 'function' ? process.getuid() : 1,
    coordinator: identity,
  });

  const state: CoordinatorProcessStatePort = {
    async readDescriptor() {
      return descriptor;
    },
    async readEndpoint() {
      return descriptor?.endpoint;
    },
    async readLaunchIntent() {
      return launchIntent;
    },
    async readInstanceLock() {
      return instanceLock;
    },
    async readLifecycleLock() {
      return lifecycleLock;
    },
    async publishDescriptor(value) {
      descriptor = value as CoordinatorProcessDescriptor;
      return descriptor;
    },
    async publishEndpoint() {
      return endpoint;
    },
    async publishLaunchIntent(value) {
      launchIntent = value;
      return value as Awaited<ReturnType<CoordinatorProcessStatePort['publishLaunchIntent']>>;
    },
    async clearLaunchIntent(expected) {
      if (JSON.stringify(launchIntent) !== JSON.stringify(expected)) {
        throw new Error('launch intent changed');
      }
      launchIntent = undefined;
    },
    async acquireLock(kind, value) {
      if (kind === 'lifecycle' && lifecycleLock !== undefined) return undefined;
      if (kind === 'lifecycle') lifecycleLock = value;
      return {
        kind,
        identity: value,
        async release() {
          if (kind === 'lifecycle' && lifecycleLock?.nonce === value.nonce) {
            lifecycleLock = undefined;
          }
        },
      };
    },
    async clearStale(expected) {
      if (expected.descriptor?.instanceId === descriptor?.instanceId) descriptor = undefined;
      if (expected.endpoint?.endpointId === endpoint.endpointId) {
        // The endpoint is tied to this descriptor in the fixture.
      }
      if (expected.instanceLock?.nonce === instanceLock?.nonce) instanceLock = undefined;
      if (expected.lifecycleLock?.nonce === lifecycleLock?.nonce) lifecycleLock = undefined;
    },
    async preserveFailure() {},
  };

  const executableResolver = {
    async resolve(mode: 'source' | 'installed') {
      return {
        path: mode === 'source' ? '/repo/coordinator.ts' : '/opt/kite/coordinator',
        mode,
        buildId: identity.buildId,
      };
    },
  };

  const processPort = {
    async inspect() {
      return processStatus;
    },
  };

  const spawn = {
    async spawn() {
      spawnCount += 1;
      if (options.spawnFails) throw new Error('detached spawn outcome is unknown');
      const instanceId = `manager-spawn-${spawnCount}`;
      const nextIdentity = { ...identity, instanceId };
      const nextDescriptor: CoordinatorProcessDescriptor = {
        schema: 'kite.local-coordinator-process.v1',
        instanceId,
        pid: 10_000 + spawnCount,
        startedAt: `2026-08-29T00:0${spawnCount}:00.000Z`,
        processStartIdentity: `start-${spawnCount}`,
        buildId: nextIdentity.buildId,
        protocolVersion: nextIdentity.protocolVersion,
        protocolRevision: nextIdentity.protocolRevision,
        clientContractRevision: nextIdentity.clientContractRevision,
        endpoint: createCoordinatorUnixSocketEndpoint({
          endpointId: `manager-endpoint-${spawnCount}`,
          ownerUid: typeof process.getuid === 'function' ? process.getuid() : 1,
          coordinator: nextIdentity,
        }),
      };
      descriptor = nextDescriptor;
      instanceLock = createCoordinatorProcessLockIdentity({
        kind: 'instance',
        pid: nextDescriptor.pid,
        instanceId: nextDescriptor.instanceId,
        startedAt: nextDescriptor.startedAt,
        processStartIdentity: nextDescriptor.processStartIdentity,
        buildId: nextDescriptor.buildId,
      });
      processStatus = 'alive';
      const ready = {
        schema: 'kite.local-coordinator-ready.v1' as const,
        instanceId: nextDescriptor.instanceId,
        pid: nextDescriptor.pid,
        startedAt: nextDescriptor.startedAt,
        processStartIdentity: nextDescriptor.processStartIdentity,
        buildId: nextDescriptor.buildId,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        protocolRevision: nextDescriptor.protocolRevision,
        clientContractRevision: nextDescriptor.clientContractRevision,
      };
      return {
        pid: nextDescriptor.pid,
        readiness: { async release() {} },
        async waitForReady() {
          return ready;
        },
      };
    },
  };

  const manager = createCoordinatorProcessManager({
    state,
    process: processPort,
    environment: { resolve: async () => ({ cwd: '/repo', env: { PATH: '/usr/bin' } }) },
    executableResolver,
    spawn,
    probe: {
      async handshake(input) {
        return {
          outcome: 'healthy' as const,
          instanceId: input.descriptor.instanceId,
          buildId: input.descriptor.buildId,
          protocolVersion: input.descriptor.protocolVersion,
          protocolRevision: input.descriptor.protocolRevision,
          clientContractRevision: input.descriptor.clientContractRevision,
        };
      },
    },
    stop: {
      async stop() {
        stopCount += 1;
        processStatus = 'dead';
        return { outcome: 'applied' as const };
      },
    },
    expectedBuildId: identity.buildId,
    managerProcessStartIdentity: managerProcessStartIdentity as string,
    startupTimeoutMs: 1_000,
    operationTimeoutMs: 1_000,
  });

  return {
    manager,
    state,
    endpoint,
    get descriptor() {
      return descriptor;
    },
    set descriptor(value: CoordinatorProcessDescriptor | undefined) {
      descriptor = value;
    },
    get instanceLock() {
      return instanceLock;
    },
    set instanceLock(value: CoordinatorProcessLockIdentity | undefined) {
      instanceLock = value;
    },
    set processStatus(value: 'dead' | 'alive' | 'uncertain') {
      processStatus = value;
    },
    get spawnCount() {
      return spawnCount;
    },
    get stopCount() {
      return stopCount;
    },
  };
}

function descriptorFor(instanceId: string, pid: number): CoordinatorProcessDescriptor {
  const nextIdentity = { ...identity, instanceId };
  return {
    schema: 'kite.local-coordinator-process.v1',
    instanceId,
    pid,
    startedAt: '2026-08-29T00:00:00.000Z',
    processStartIdentity: 'stale-start',
    buildId: nextIdentity.buildId,
    protocolVersion: nextIdentity.protocolVersion,
    protocolRevision: nextIdentity.protocolRevision,
    clientContractRevision: nextIdentity.clientContractRevision,
    endpoint: createCoordinatorUnixSocketEndpoint({
      endpointId: 'stale-endpoint',
      ownerUid: typeof process.getuid === 'function' ? process.getuid() : 1,
      coordinator: nextIdentity,
    }),
  };
}

describe('Coordinator process manager', () => {
  test('single-flights concurrent ensure calls and returns a connectable descriptor', async () => {
    const harness = createHarness();
    const [first, second] = await Promise.all([
      harness.manager.ensure({ requestId: 'ensure-1' }),
      harness.manager.ensure({ requestId: 'ensure-2' }),
    ]);
    expect(first.outcome).toBe('applied');
    expect(second.outcome).toBe('applied');
    expect(harness.spawnCount).toBe(1);
    expect(coordinatorManagedConnection(first).endpoint.transport).toBe('unix_socket');
  });

  test('cleans only a confirmed-dead exact descriptor and starts a replacement', async () => {
    const harness = createHarness();
    const stale = descriptorFor('stale-instance', 501);
    harness.descriptor = stale;
    harness.instanceLock = createCoordinatorProcessLockIdentity({
      kind: 'instance',
      pid: stale.pid,
      instanceId: stale.instanceId,
      startedAt: stale.startedAt,
      processStartIdentity: stale.processStartIdentity,
      buildId: stale.buildId,
    });
    const result = await harness.manager.ensure({ requestId: 'ensure-stale' });
    expect(result.outcome).toBe('applied');
    expect(result.descriptor?.instanceId).toBe('manager-spawn-1');
    expect(harness.spawnCount).toBe(1);
  });

  test('keeps alive and uncertain owners untouched', async () => {
    const harness = createHarness();
    const existing = descriptorFor('live-instance', 502);
    harness.descriptor = existing;
    harness.instanceLock = createCoordinatorProcessLockIdentity({
      kind: 'instance',
      pid: existing.pid,
      instanceId: existing.instanceId,
      startedAt: existing.startedAt,
      processStartIdentity: existing.processStartIdentity,
      buildId: existing.buildId,
    });
    harness.processStatus = 'uncertain';
    const status = await harness.manager.status({ requestId: 'status-uncertain' });
    expect(status.outcome).toBe('unavailable');
    expect(status.diagnostic).toBe('identity_uncertain');
    expect(harness.descriptor).toEqual(existing);
    expect(harness.spawnCount).toBe(0);
  });

  test('stops through the injected graceful control port and never kills a PID', async () => {
    const harness = createHarness();
    const ensured = await harness.manager.ensure({ requestId: 'ensure-stop' });
    await harness.state.publishLaunchIntent({
      schema: COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA_,
      nonce: '0123456789abcdefghijklmnopqrstuv',
      buildId: identity.buildId,
      createdAt: '2026-08-29T00:00:00.000Z',
    });
    expect((await harness.manager.status({ requestId: 'status-clears-intent' })).outcome).toBe(
      'applied',
    );
    expect(await harness.state.readLaunchIntent()).toBeUndefined();
    const stopped = await harness.manager.stop({ requestId: 'stop-1' });
    expect(ensured.outcome).toBe('applied');
    expect(stopped).toMatchObject({
      outcome: 'applied',
      state: 'absent',
      diagnostic: 'not_running',
    });
    expect(harness.stopCount).toBe(1);
  });

  test('fails closed without a verified manager process-start identity', async () => {
    const harness = createHarness({ managerProcessStartIdentity: undefined });
    const result = await harness.manager.ensure({ requestId: 'ensure-no-manager-start' });
    expect(result).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
    expect(harness.spawnCount).toBe(0);
    expect(await harness.state.readLifecycleLock()).toBeUndefined();
  });

  test('persists an unknown launch fence and never replays a detached spawn', async () => {
    const harness = createHarness({ spawnFails: true });
    const first = await harness.manager.ensure({ requestId: 'ensure-unknown-1' });
    const second = await harness.manager.ensure({ requestId: 'ensure-unknown-2' });
    const status = await harness.manager.status({ requestId: 'status-unknown' });
    expect(first).toMatchObject({ outcome: 'outcome_unknown', diagnostic: 'timeout' });
    expect(second).toMatchObject({ outcome: 'outcome_unknown', state: 'starting' });
    expect(status).toMatchObject({ outcome: 'outcome_unknown', state: 'starting' });
    expect(harness.spawnCount).toBe(1);
    expect(await harness.state.readLaunchIntent()).toBeDefined();
  });

  test('retains the launch fence across a new manager using native state', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-launch-intent-')));
    try {
      const state = createCoordinatorProcessStatePort(createKiteHomeIdentity(root));
      let spawnCount = 0;
      const manager = () =>
        createCoordinatorProcessManager({
          state,
          process: { inspect: async () => 'dead' },
          environment: { resolve: async () => ({ cwd: root, env: {} }) },
          executableResolver: {
            resolve: async (mode) => ({
              path: '/explicit/coordinator',
              mode,
              buildId: identity.buildId,
            }),
          },
          spawn: {
            async spawn() {
              spawnCount += 1;
              throw new Error('detached spawn outcome unknown');
            },
          },
          expectedBuildId: identity.buildId,
          managerProcessStartIdentity: 'native-manager-start',
          startupTimeoutMs: 1_000,
          operationTimeoutMs: 1_000,
        });
      expect((await manager().ensure({ requestId: 'native-unknown-1' })).diagnostic).toBe(
        'timeout',
      );
      expect(await state.readLaunchIntent()).toBeDefined();
      expect(await manager().ensure({ requestId: 'native-unknown-2' })).toMatchObject({
        outcome: 'outcome_unknown',
        state: 'starting',
      });
      expect(spawnCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
