import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorCatalogStorageIdentity,
  type CoordinatorIdentity,
  type CoordinatorProcessReadySignal,
  createCoordinatorRequestClient,
  createCoordinatorSocketRequestTransport,
  openCoordinatorCatalog,
} from '@kite-ai/kite-local-runtime/coordinator';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  createCoordinatorReadinessPort,
  createKiteCoordinatorComposition,
} from '../../src/coordinator/composition';
import type {
  KiteCoordinatorCompositionOptions,
  KiteCoordinatorReadinessPort,
  KiteCoordinatorSignal,
  KiteCoordinatorSignalPort,
} from '../../src/coordinator/ports';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const uid = typeof process.getuid === 'function' ? process.getuid() : 1;

function createStorage(root: string): CoordinatorCatalogStorageIdentity {
  const generation = 'generation-1';
  mkdirSync(join(root, 'layouts', generation), { recursive: true, mode: 0o700 });
  const target = {
    canonicalKiteHomeRoot: root,
    layoutGeneration: generation,
    catalogPath: join(root, 'layouts', generation, 'catalog.sqlite'),
    mode: 'initialize_target' as const,
  };
  if (!existsSync(target.catalogPath)) {
    const catalog = openCoordinatorCatalog(target);
    catalog.close();
  }
  return {
    ...target,
    mode: 'open_active',
    beforeWrite: () => undefined,
  };
}

function createIdentity(instanceId = 'service-coordinator-1'): CoordinatorIdentity {
  return {
    role: 'coordinator',
    instanceId,
    buildId: 'build-coordinator-test',
    protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
    clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
  };
}

function createReadiness(
  onPublish?: (signal: CoordinatorProcessReadySignal) => void,
): KiteCoordinatorReadinessPort {
  return {
    publish(signal) {
      onPublish?.(signal);
    },
  };
}

function createSignals() {
  const listeners = new Map<KiteCoordinatorSignal, () => void>();
  const signals: KiteCoordinatorSignalPort = {
    subscribe(signal, listener) {
      listeners.set(signal, listener);
      return () => listeners.delete(signal);
    },
  };
  return { signals, listeners };
}

function createOptions(
  root: string,
  overrides: Partial<KiteCoordinatorCompositionOptions> = {},
): KiteCoordinatorCompositionOptions {
  const home = createKiteHomeIdentity(root);
  const identity = createIdentity();
  return {
    home,
    catalogStorage: createStorage(root),
    identity,
    processStartIdentity: 'test-coordinator-process-start',
    peerOsIdentity: { kind: 'posix_uid', uid },
    workers: {
      resolveWorkspace: async () => null,
      ensureWorkspace: async () => {
        throw new Error('not used');
      },
      describeScope: async () => null,
      mintCapability: async () => {
        throw new Error('not used');
      },
    },
    gateway: {
      ensure: async () => {
        throw new Error('not used');
      },
      discover: async () => null,
      stop: async () => undefined,
    },
    reconcile: { reconcile: async () => ({}) },
    readiness: createReadiness(),
    pid: process.pid,
    startedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('Kite Coordinator Service composition', () => {
  test('publishes one exact readiness frame and leaves fd closure to the native helper', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-ready-')));
    roots.push(root);
    const path = join(root, 'ready.jsonl');
    const fd = openSync(path, 'w');
    const signal: CoordinatorProcessReadySignal = {
      schema: 'kite.local-coordinator-ready.v1',
      instanceId: 'coordinator-ready',
      pid: 42,
      startedAt: '2026-08-29T00:00:00.000Z',
      processStartIdentity: 'process-start-42',
      buildId: 'build-ready',
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
      clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
    };
    const readiness = createCoordinatorReadinessPort(fd);
    readiness.publish(signal);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(signal);
    expect(() => readiness.publish(signal)).toThrow('already published');
  });

  test('reconciles before readiness and serves a real owner-only Unix carrier', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-service-coordinator-')));
    roots.push(root);
    let reconciled = false;
    let ready: CoordinatorProcessReadySignal | undefined;
    const composition = createKiteCoordinatorComposition(
      createOptions(root, {
        reconcile: {
          reconcile: async () => {
            reconciled = true;
            return {};
          },
        },
        readiness: createReadiness((signal) => {
          expect(reconciled).toBe(true);
          ready = signal;
        }),
      }),
    );

    await expect(composition.server.start()).resolves.toMatchObject({
      operation: 'start',
      outcome: 'applied',
      state: 'ready',
    });
    expect(ready).toMatchObject({
      instanceId: 'service-coordinator-1',
      pid: process.pid,
      buildId: 'build-coordinator-test',
    });
    expect(composition.carrier?.supported).toBe(true);
    const endpoint = composition.server.descriptor?.endpoint;
    expect(endpoint?.transport).toBe('unix_socket');
    expect(composition.registry.snapshot().directoryRevision).toBe('0');

    const transport = createCoordinatorSocketRequestTransport({
      home: createKiteHomeIdentity(root),
      endpoint: endpoint!,
    });
    const client = createCoordinatorRequestClient({
      transport,
      identity: {
        role: 'client',
        instanceId: 'coordinator-test-client',
        buildId: 'build-coordinator-test',
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
        clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
      },
      expectedCoordinator: createIdentity(),
      peerOsIdentity: { kind: 'posix_uid', uid },
    });
    await expect(client.handshake()).resolves.toMatchObject({ accepted: true });
    await expect(client.status()).resolves.toMatchObject({
      outcome: 'ok',
      result: { state: 'ready' },
    });
    await transport.close?.();
    await expect(composition.server.stop()).resolves.toMatchObject({
      operation: 'stop',
      outcome: 'applied',
      state: 'absent',
    });
    expect(await composition.state.readDescriptor()).toBeUndefined();
    expect(await composition.state.readEndpoint()).toBeUndefined();
    expect(await composition.state.readInstanceLock()).toBeUndefined();
  });

  test('cleans partial endpoint/process state when readiness publication fails', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-service-coordinator-partial-')));
    roots.push(root);
    const failing = createKiteCoordinatorComposition(
      createOptions(root, {
        readiness: {
          publish() {
            throw new Error('readiness failed');
          },
        },
      }),
    );
    await expect(failing.server.start()).resolves.toMatchObject({
      operation: 'start',
      outcome: 'unavailable',
      state: 'absent',
      diagnostic: 'startup_failed',
    });
    expect(await failing.state.readDescriptor()).toBeUndefined();
    expect(await failing.state.readEndpoint()).toBeUndefined();
    expect(await failing.state.readInstanceLock()).toBeUndefined();

    const retry = createKiteCoordinatorComposition(createOptions(root));
    await expect(retry.server.start()).resolves.toMatchObject({
      outcome: 'applied',
      state: 'ready',
    });
    await retry.server.stop();
  });

  test('signal/stop cleanup never asks Worker or Gateway controls to stop', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-service-coordinator-signal-')));
    roots.push(root);
    const workerStops = 0;
    let gatewayStops = 0;
    const { signals, listeners } = createSignals();
    const options = createOptions(root, {
      signals,
      workers: {
        resolveWorkspace: async () => null,
        ensureWorkspace: async () => {
          throw new Error('not used');
        },
        describeScope: async () => null,
        mintCapability: async () => {
          throw new Error('not used');
        },
      },
      gateway: {
        ensure: async () => {
          throw new Error('not used');
        },
        discover: async () => null,
        stop: async () => {
          gatewayStops += 1;
        },
      },
    });
    const composition = createKiteCoordinatorComposition(options);
    await composition.server.start();
    listeners.get('SIGTERM')?.();
    await expect(composition.server.waitForShutdown()).resolves.toMatchObject({
      operation: 'signal_shutdown',
      outcome: 'applied',
      state: 'absent',
    });
    expect(workerStops).toBe(0);
    expect(gatewayStops).toBe(0);
  });
});
