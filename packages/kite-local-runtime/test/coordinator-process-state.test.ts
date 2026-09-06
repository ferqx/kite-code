import { afterEach, describe, expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorIdentity,
  type CoordinatorProcessDescriptor,
  createCoordinatorProcessLockIdentity,
  createCoordinatorProcessStatePort,
  createCoordinatorUnixSocketEndpoint,
  decodeCoordinatorProcessDescriptor,
} from '@kite-ai/kite-local-runtime/coordinator';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const identity: CoordinatorIdentity = {
  role: 'coordinator',
  instanceId: 'coordinator-state-instance',
  buildId: 'build-state-1',
  protocolVersion: COORDINATOR_PROTOCOL_VERSION,
  protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
  clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
};

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-process-state-')));
  roots.push(root);
  const state = createCoordinatorProcessStatePort(createKiteHomeIdentity(root));
  const endpoint = createCoordinatorUnixSocketEndpoint({
    endpointId: 'state-endpoint',
    ownerUid: typeof process.getuid === 'function' ? process.getuid() : 1,
    coordinator: identity,
  });
  const descriptor: CoordinatorProcessDescriptor = {
    schema: 'kite.local-coordinator-process.v1',
    instanceId: identity.instanceId,
    pid: 42,
    startedAt: '2026-08-29T00:00:00.000Z',
    processStartIdentity: 'fixture-start-42',
    buildId: identity.buildId,
    protocolVersion: identity.protocolVersion,
    protocolRevision: identity.protocolRevision,
    clientContractRevision: identity.clientContractRevision,
    endpoint,
  };
  const instanceLock = createCoordinatorProcessLockIdentity({
    kind: 'instance',
    pid: descriptor.pid,
    instanceId: descriptor.instanceId,
    startedAt: descriptor.startedAt,
    processStartIdentity: descriptor.processStartIdentity,
    buildId: descriptor.buildId,
  });
  const lifecycleLock = createCoordinatorProcessLockIdentity({
    kind: 'lifecycle',
    pid: descriptor.pid,
    instanceId: descriptor.instanceId,
    startedAt: descriptor.startedAt,
    processStartIdentity: descriptor.processStartIdentity,
    buildId: descriptor.buildId,
    operation: 'status',
  });
  return { state, descriptor, endpoint, instanceLock, lifecycleLock };
}

describe('Coordinator process state', () => {
  test('publishes owner-only descriptors and locks in the fixed state root', async () => {
    const fixture = createFixture();
    const { state, descriptor, endpoint, instanceLock, lifecycleLock } = fixture;
    expect(await state.readDescriptor()).toBeUndefined();
    const launchIntent = {
      schema: COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA_,
      nonce: '0123456789abcdefghijklmnopqrstuv',
      buildId: identity.buildId,
      createdAt: '2026-08-29T00:00:00.000Z',
    } as const;
    await state.publishLaunchIntent(launchIntent);
    await state.publishDescriptor(descriptor);
    await state.publishEndpoint(endpoint);
    const instance = await state.acquireLock('instance', instanceLock);
    const lifecycle = await state.acquireLock('lifecycle', lifecycleLock);
    expect(instance?.identity).toEqual(instanceLock);
    expect(lifecycle?.identity).toEqual(lifecycleLock);
    expect(await state.readDescriptor()).toEqual(descriptor);
    expect(await state.readEndpoint()).toEqual(endpoint);
    expect(await state.readInstanceLock()).toEqual(instanceLock);
    expect(await state.readLifecycleLock()).toEqual(lifecycleLock);
    expect(await state.readLaunchIntent()).toEqual(launchIntent);
    expect(lstatSync(state.paths.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(state.paths.processDescriptor).mode & 0o777).toBe(0o600);
    expect(lstatSync(state.paths.launchIntent).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(state.paths.instanceLock, 'identity.json')).mode & 0o777).toBe(0o600);
    await instance?.release();
    await lifecycle?.release();
    await state.clearLaunchIntent(launchIntent);
    expect(await state.readInstanceLock()).toBeUndefined();
    expect(await state.readLifecycleLock()).toBeUndefined();
    expect(await state.readLaunchIntent()).toBeUndefined();
  });

  test('requires strict process identity and exact cleanup evidence', async () => {
    const fixture = createFixture();
    const { state, descriptor, endpoint, instanceLock } = fixture;
    expect(() => decodeCoordinatorProcessDescriptor({ ...descriptor, unknown: true })).toThrow();
    await state.publishDescriptor(descriptor);
    await state.publishEndpoint(endpoint);
    const lease = await state.acquireLock('instance', instanceLock);
    expect(lease).toBeDefined();
    await expect(
      state.clearStale({
        descriptor: { ...descriptor, processStartIdentity: 'different-start' },
        endpoint,
        instanceLock,
      }),
    ).rejects.toMatchObject({ code: 'corrupt' });
    expect(await state.readDescriptor()).toEqual(descriptor);
    await state.clearStale({ descriptor, endpoint, instanceLock });
    expect(await state.readDescriptor()).toBeUndefined();
    expect(await state.readEndpoint()).toBeUndefined();
    expect(await state.readInstanceLock()).toBeUndefined();
  });
});
