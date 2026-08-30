import { isAbsolute, resolve } from 'node:path';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
} from '@kite-ai/kite-local-runtime/coordinator';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import type { WebGatewayCarrier } from './carrier';
import { readWebGatewayProcessStartIdentity, writeWebGatewayReadySignal } from './process-host';
import {
  createWebGatewayProcessLockIdentity,
  createWebGatewayProcessStatePort,
} from './process-state';

const WEB_GATEWAY_ENTRY_ARGS = Object.freeze(['web-gateway', 'run'] as const);

export interface WebGatewayMainEnvironment {
  readonly home: string;
  readonly staticAssetRoot: string;
  readonly buildId: string;
  readonly instanceId: string;
  readonly controlCredential: string;
  readonly readinessFd: number;
}

export interface WebGatewayMainSignalPort {
  subscribe(listener: () => void): () => void;
}

export interface WebGatewayMainDependencies {
  /** Explicit manager-provided environment; ambient process.env is never consulted implicitly. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Service-owned carrier composition. The carrier itself owns the listener and browser auth. */
  readonly createCarrier?: (
    environment: WebGatewayMainEnvironment,
    requestShutdown: () => void,
  ) => WebGatewayCarrier | Promise<WebGatewayCarrier>;
  readonly signals?: WebGatewayMainSignalPort;
  readonly writeReady?: typeof writeWebGatewayReadySignal;
  readonly readProcessStartIdentity?: (
    pid: number,
    platform: NodeJS.Platform,
  ) => Promise<string | undefined>;
}

/**
 * Resolve only the explicit manager environment for a Gateway child. It never infers a home,
 * asset root, executable, or readiness descriptor from cwd/HOME/PATH.
 */
export function resolveWebGatewayMainEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): WebGatewayMainEnvironment {
  const home = requiredAbsolute(source, 'KITE_WEB_GATEWAY_HOME');
  const staticAssetRoot = requiredAbsolute(source, 'KITE_WEB_GATEWAY_STATIC_ROOT');
  const buildId = requiredText(source, 'KITE_WEB_GATEWAY_BUILD_ID');
  const instanceId = requiredText(source, 'KITE_WEB_GATEWAY_INSTANCE_ID');
  const controlCredential = requiredCredential(source, 'KITE_WEB_GATEWAY_CONTROL_CREDENTIAL');
  const readinessFd = parseFd(source.KITE_WEB_GATEWAY_READY_FD);
  return Object.freeze({
    home,
    staticAssetRoot,
    buildId,
    instanceId,
    controlCredential,
    readinessFd,
  });
}

/** Internal foreground entry. Only exact `web-gateway run` is accepted. */
export async function runWebGatewayMain(
  args: readonly string[] = [],
  dependencies: WebGatewayMainDependencies = {},
): Promise<void> {
  if (
    args.length !== WEB_GATEWAY_ENTRY_ARGS.length ||
    args.some((value, index) => value !== WEB_GATEWAY_ENTRY_ARGS[index])
  ) {
    throw new Error('Web Gateway internal entry requires the exact `web-gateway run` arguments.');
  }
  if (!dependencies.environment || !dependencies.createCarrier) {
    throw new Error('Web Gateway requires explicit manager environment and carrier composition.');
  }
  const environment = resolveWebGatewayMainEnvironment(dependencies.environment);
  const processStartIdentity = await (
    dependencies.readProcessStartIdentity ?? readWebGatewayProcessStartIdentity
  )(process.pid, process.platform);
  if (!processStartIdentity) throw new Error('Web Gateway process start identity is unavailable.');
  const state = createWebGatewayProcessStatePort(
    createKiteHomeIdentity(environment.home, 'explicit_argument'),
  );
  const startedAt = new Date().toISOString();
  const lockIdentity = createWebGatewayProcessLockIdentity({
    kind: 'instance',
    pid: process.pid,
    instanceId: environment.instanceId,
    startedAt,
    processStartIdentity,
    buildId: environment.buildId,
    operation: 'ensure',
    createdAt: startedAt,
  });
  const instanceLock = await state.acquireLock('instance', lockIdentity);
  if (!instanceLock) throw new Error('Web Gateway instance is already running.');
  let resolveInternalShutdown!: () => void;
  const internalShutdown = new Promise<void>((resolvePromise) => {
    resolveInternalShutdown = resolvePromise;
  });
  let lockReleased = false;
  let carrier: WebGatewayCarrier;
  try {
    carrier = await dependencies.createCarrier(environment, resolveInternalShutdown);
  } catch (error) {
    await instanceLock.release().catch(() => undefined);
    throw error;
  }
  let primaryError: unknown;
  let closed = false;
  let unsubscribeSignal: (() => void) | undefined;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    let firstError: unknown;
    try {
      await carrier.close();
    } catch (error) {
      firstError = error;
    }
    if (!lockReleased) {
      try {
        await instanceLock.release();
        lockReleased = true;
      } catch (error) {
        if (firstError === undefined) firstError = error;
      }
    }
    if (firstError !== undefined) throw firstError;
  };
  try {
    const ready = {
      schema: 'kite.web-gateway-ready.v1' as const,
      identity: {
        role: 'web_gateway' as const,
        instanceId: environment.instanceId,
        buildId: environment.buildId,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
        clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
      },
      pid: process.pid,
      startedAt,
      processStartIdentity,
      endpoint: { origin: carrier.origin },
    };
    (dependencies.writeReady ?? writeWebGatewayReadySignal)(ready, environment.readinessFd);
    const shutdown = waitForShutdown(dependencies.signals);
    unsubscribeSignal = shutdown.unsubscribe;
    await Promise.race([shutdown.promise, internalShutdown]);
  } catch (error) {
    primaryError = error;
  }
  try {
    unsubscribeSignal?.();
    await close();
  } catch (cleanupError) {
    if (primaryError === undefined) primaryError = cleanupError;
  }
  if (primaryError !== undefined) throw primaryError;
}

function waitForShutdown(signals: WebGatewayMainSignalPort | undefined): {
  readonly promise: Promise<void>;
  readonly unsubscribe: () => void;
} {
  if (signals) {
    let unsubscribe = (): void => undefined;
    const promise = new Promise<void>((resolvePromise) => {
      unsubscribe = signals.subscribe(resolvePromise);
    });
    return { promise, unsubscribe: () => unsubscribe() };
  }
  let onSignal!: () => void;
  const promise = new Promise<void>((resolve) => {
    onSignal = (): void => resolve();
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  });
  return {
    promise,
    unsubscribe: () => {
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
    },
  };
}

function requiredText(source: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = source[name];
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 512 ||
    [...value].some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new Error(`Web Gateway requires explicit ${name}.`);
  }
  return value;
}

function requiredAbsolute(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = requiredText(source, name);
  if (!isAbsolute(value)) throw new Error(`Web Gateway ${name} must be an absolute path.`);
  return resolve(value);
}

function parseFd(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new Error('Web Gateway requires an explicit readiness fd.');
  }
  const fd = Number(value);
  if (!Number.isSafeInteger(fd) || fd < 0 || fd > 1024) {
    throw new Error('Web Gateway readiness fd is invalid.');
  }
  return fd;
}

function requiredCredential(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = requiredText(source, name);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error(`Web Gateway ${name} is invalid.`);
  }
  return value;
}
