import { randomBytes as systemRandomBytes } from 'node:crypto';
import {
  acquireLocalRuntimeServiceLock,
  clearLocalRuntimeServiceState,
  createLocalRuntimeServiceToken,
  ensureLocalRuntimeServiceStateRoot,
  type KiteHomeIdentity,
  LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
  type LocalRuntimeServiceDescriptor,
  type LocalRuntimeServiceDirectoryLock,
  type LocalRuntimeServiceStatePaths,
  type LocalRuntimeToken,
  type LocalServiceLockIdentity,
  publishLocalRuntimeServiceDescriptor,
  publishLocalRuntimeServiceToken,
  readLocalRuntimeServiceDescriptor,
  readLocalRuntimeServiceToken,
} from '@kite-ai/kite-local-runtime/service';
import {
  createKiteServiceCarrier,
  type KiteServiceApplicationPort,
  type KiteServiceCarrier,
  type KiteServiceCarrierLimits,
} from './carrier';
import type {
  KiteRuntimeApplicationPort,
  KiteServiceLifecycleResult,
  KiteServiceReadinessPort,
  KiteServiceShell,
  KiteServiceSignalPort,
  KiteServiceStatePort,
  KiteServiceTransportPort,
} from './ports';
import { createKiteServiceShell } from './shell';

export interface NativeKiteServiceApplicationPort
  extends KiteRuntimeApplicationPort,
    KiteServiceApplicationPort {}

export interface NativeKiteServiceInfrastructureOptions {
  /** Already validated/canonical Kite home identity; never derived from ambient process.env here. */
  readonly home: KiteHomeIdentity;
  readonly application: NativeKiteServiceApplicationPort;
  readonly instanceId: string;
  readonly serverVersion: string;
  readonly buildId: string;
  readonly readiness?: KiteServiceReadinessPort;
  readonly signals?: KiteServiceSignalPort;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly carrierLimits?: KiteServiceCarrierLimits;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export interface NativeKiteServiceInfrastructure extends AsyncDisposable {
  readonly shell: KiteServiceShell;
  readonly paths: LocalRuntimeServiceStatePaths;
  readonly descriptor: LocalRuntimeServiceDescriptor | undefined;
  start(): Promise<KiteServiceLifecycleResult>;
  stop(): Promise<KiteServiceLifecycleResult>;
  requestStop(): Promise<KiteServiceLifecycleResult>;
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Service clock is invalid.');
  return Math.floor(value);
}

function randomIdentity(random: (size: number) => Uint8Array): string {
  const bytes = random(32);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new TypeError('Service identity source must return exactly 32 bytes.');
  }
  const material = Buffer.from(bytes);
  try {
    return material.toString('base64url');
  } finally {
    material.fill(0);
    bytes.fill(0);
  }
}

function freezeDescriptor(value: LocalRuntimeServiceDescriptor): LocalRuntimeServiceDescriptor {
  return Object.freeze({
    ...value,
    endpoint: Object.freeze({ ...value.endpoint }),
  });
}

/**
 * Compose the KLSV1-04 Native state owner, loopback carrier and lifecycle shell around an injected
 * fake/application port.  It intentionally does not construct Host, Store, Builtin or CLI code.
 */
export function createNativeKiteServiceInfrastructure(
  options: NativeKiteServiceInfrastructureOptions,
): NativeKiteServiceInfrastructure {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? ((size: number) => systemRandomBytes(size));
  const paths = ensureLocalRuntimeServiceStateRoot(options.home);
  let instanceLock: LocalRuntimeServiceDirectoryLock | undefined;
  let accessToken: LocalRuntimeToken | undefined;
  let controlToken: LocalRuntimeToken | undefined;
  let descriptor: LocalRuntimeServiceDescriptor | undefined;
  let carrier: KiteServiceCarrier | undefined;
  let publishedReady = false;
  let shell!: KiteServiceShell;

  const state: KiteServiceStatePort = {
    async prepareStart(startOptions) {
      if (startOptions?.signal?.aborted) throw new Error('Service startup was cancelled.');
      if (instanceLock) throw new Error('Service state is already prepared.');
      const createdAt = new Date(safeNow(now)).toISOString();
      const identity: LocalServiceLockIdentity = {
        schema: LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
        nonce: randomIdentity(random),
        pid: process.pid,
        operation: 'start',
        instanceId: options.instanceId,
        createdAt,
      };
      instanceLock = acquireLocalRuntimeServiceLock(paths, 'instance', identity);
      if (
        readLocalRuntimeServiceDescriptor(paths) !== undefined ||
        readLocalRuntimeServiceToken(paths, 'access') !== undefined ||
        readLocalRuntimeServiceToken(paths, 'control') !== undefined
      ) {
        throw new Error('Service state contains stale owner evidence.');
      }
      accessToken = createLocalRuntimeServiceToken();
      controlToken = createLocalRuntimeServiceToken();
      if (accessToken === controlToken) throw new Error('Service token source repeated material.');
      publishLocalRuntimeServiceToken(paths, 'access', accessToken);
      publishLocalRuntimeServiceToken(paths, 'control', controlToken);
    },
    async publishReady(startOptions) {
      if (startOptions?.signal?.aborted) throw new Error('Service startup was cancelled.');
      if (!carrier || !instanceLock || !accessToken || !controlToken) {
        throw new Error('Service infrastructure is incomplete.');
      }
      descriptor = freezeDescriptor(
        publishLocalRuntimeServiceDescriptor(paths, carrier.descriptor),
      );
      publishedReady = true;
    },
    async preserveFailure() {
      publishedReady = false;
    },
    async clear(clearOptions) {
      if (clearOptions?.signal?.aborted) throw new Error('Service cleanup was cancelled.');
      if (!instanceLock || !accessToken || !controlToken) {
        throw new Error('Service state cleanup identity is incomplete.');
      }
      clearLocalRuntimeServiceState(paths, {
        ...(descriptor ? { descriptor } : {}),
        accessToken,
        controlToken,
        instanceLock: instanceLock.identity,
      });
      publishedReady = false;
      descriptor = undefined;
      accessToken = undefined;
      controlToken = undefined;
      instanceLock = undefined;
    },
  };

  const carrierApplication: KiteServiceApplicationPort = {
    server: options.application.server,
    history: options.application.history,
    workspaceAdmission: options.application.workspaceAdmission,
    runtimeAdmission: options.application.runtimeAdmission,
    appControl: options.application.appControl,
    ...(options.application.credential ? { credential: options.application.credential } : {}),
    control: {
      stop: async () => {
        const result = await shell.requestStop();
        return { outcome: result.outcome, state: result.state };
      },
    },
    ...(options.application.onConnectionBound
      ? { onConnectionBound: options.application.onConnectionBound }
      : {}),
    ...(options.application.onConnectionClosed
      ? { onConnectionClosed: options.application.onConnectionClosed }
      : {}),
  };

  const transport: KiteServiceTransportPort = {
    async start(startOptions) {
      if (startOptions?.signal?.aborted) throw new Error('Service startup was cancelled.');
      if (carrier || !accessToken || !controlToken || !instanceLock) {
        throw new Error('Service transport state is invalid.');
      }
      carrier = createKiteServiceCarrier({
        application: carrierApplication,
        instanceId: options.instanceId,
        serverVersion: options.serverVersion,
        buildId: options.buildId,
        accessToken,
        controlToken,
        isReady: () => publishedReady,
        ...(options.carrierLimits ? { limits: options.carrierLimits } : {}),
        now,
        randomBytes: random,
      });
    },
    async stop() {
      const current = carrier;
      if (!current) return;
      await current.close();
      carrier = undefined;
    },
  };

  shell = createKiteServiceShell({
    application: options.application,
    state,
    transport,
    ...(options.readiness ? { readiness: options.readiness } : {}),
    ...(options.signals ? { signals: options.signals } : {}),
    ...(options.startupTimeoutMs !== undefined
      ? { startupTimeoutMs: options.startupTimeoutMs }
      : {}),
    ...(options.shutdownTimeoutMs !== undefined
      ? { shutdownTimeoutMs: options.shutdownTimeoutMs }
      : {}),
  });

  const infrastructure: NativeKiteServiceInfrastructure = {
    shell,
    paths,
    get descriptor() {
      return descriptor;
    },
    start: () => shell.start(),
    stop: () => shell.stop(),
    requestStop: () => shell.requestStop(),
    [Symbol.asyncDispose]: async () => shell[Symbol.asyncDispose](),
  };
  return Object.freeze(infrastructure);
}
