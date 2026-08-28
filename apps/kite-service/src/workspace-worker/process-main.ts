import { closeSync, writeSync } from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
} from '@kite-ai/kite-local-runtime/coordinator';
import { createKiteHomeIdentity, type KiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  decodeWorkspaceWorkerReadySignal,
  WORKSPACE_WORKER_READY_SCHEMA_,
  WORKSPACE_WORKER_STORE_PROFILE_,
  type WorkspaceWorkerReadySignal,
} from './process-host';
import {
  WORKSPACE_OWNER_COORDINATION_HOME_ENV,
  WORKSPACE_OWNER_RESERVATION_NONCE_ENV,
} from './reservation';
import type { WorkspaceWorkerRuntimeComposition } from './runtime-composition';
import type { WorkspaceWorkerOwnerLockPort } from './worker';
import { canonicalWorkspaceIdentity } from './workspace-identity';
import { createNativeWorkspaceOwnerLockPort } from './workspace-owner-lock';

export const WORKSPACE_WORKER_ENTRY_ARGS = Object.freeze(['worker', 'run'] as const);

export interface WorkspaceWorkerMainEnvironment {
  readonly home: KiteHomeIdentity;
  /** OS-user coordination root shared across explicit Kite homes. */
  readonly coordinationHome: KiteHomeIdentity;
  readonly workspace: KiteWorkspaceIdentity;
  readonly workerScopeId: string;
  readonly workerInstanceId: string;
  readonly buildId: string;
  readonly layoutGeneration: string;
  /** Restart-scoped control secret supplied only through the explicit child environment. */
  readonly controlCredential: string;
  /** One-shot Coordinator reservation proof; never included in readiness or descriptors. */
  readonly ownerReservationNonce: string;
  readonly readinessFd: number;
}

export interface WorkspaceWorkerMainSignalPort {
  subscribe(listener: () => void): () => void;
}

export interface WorkspaceWorkerMainDependencies {
  /** Explicit manager-provided environment; ambient process.env is never consulted implicitly. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly ownerLock?: WorkspaceWorkerOwnerLockPort;
  readonly createRuntime?: (input: {
    readonly environment: WorkspaceWorkerMainEnvironment;
    readonly processStartIdentity: string;
    readonly ownerLock: WorkspaceWorkerOwnerLockPort;
  }) => WorkspaceWorkerRuntimeComposition | Promise<WorkspaceWorkerRuntimeComposition>;
  readonly signals?: WorkspaceWorkerMainSignalPort;
  readonly writeReady?: (value: WorkspaceWorkerReadySignal, fd: number) => void;
  readonly readProcessStartIdentity?: (
    pid: number,
    platform: NodeJS.Platform,
  ) => Promise<string | undefined>;
}

/**
 * Parse only manager-owned Worker environment. Workspace identity is reconstructed from explicit
 * fields and revalidated by the Store7/runtime composition before any writer opens.
 */
export function resolveWorkspaceWorkerMainEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): WorkspaceWorkerMainEnvironment {
  const home = createKiteHomeIdentity(requiredAbsolute(source, 'KITE_WORKER_HOME'));
  const coordinationHome = createKiteHomeIdentity(
    requiredAbsolute(source, WORKSPACE_OWNER_COORDINATION_HOME_ENV),
    'os_user_home',
  );
  const workspace = canonicalWorkspaceIdentity({
    canonicalPath: requiredAbsolute(source, 'KITE_WORKER_WORKSPACE'),
    projectId: requiredText(source, 'KITE_WORKER_PROJECT_ID'),
    workspaceDigest: requiredDigest(source, 'KITE_WORKER_WORKSPACE_DIGEST'),
  });
  return Object.freeze({
    home,
    coordinationHome,
    workspace,
    workerScopeId: requiredText(source, 'KITE_WORKER_SCOPE_ID'),
    workerInstanceId: requiredText(source, 'KITE_WORKER_INSTANCE_ID'),
    buildId: requiredText(source, 'KITE_WORKER_BUILD_ID'),
    layoutGeneration: requiredGeneration(source, 'KITE_WORKER_LAYOUT_GENERATION'),
    controlCredential: requiredCredential(source, 'KITE_WORKER_CONTROL_CREDENTIAL'),
    ownerReservationNonce: requiredCredential(source, WORKSPACE_OWNER_RESERVATION_NONCE_ENV),
    readinessFd: parseFd(source.KITE_WORKER_READY_FD),
  });
}

/** Internal foreground entry. Only exact `worker run` is accepted. */
export async function runWorkspaceWorkerMain(
  args: readonly string[] = [],
  dependencies: WorkspaceWorkerMainDependencies = {},
): Promise<void> {
  if (
    args.length !== WORKSPACE_WORKER_ENTRY_ARGS.length ||
    args.some((value, index) => value !== WORKSPACE_WORKER_ENTRY_ARGS[index])
  ) {
    throw new Error('Workspace Worker internal entry requires the exact `worker run` arguments.');
  }
  if (!dependencies.environment || !dependencies.createRuntime) {
    throw new Error(
      'Workspace Worker requires explicit manager environment and runtime composition.',
    );
  }
  const environment = resolveWorkspaceWorkerMainEnvironment(dependencies.environment);
  const processStartIdentity = await (
    dependencies.readProcessStartIdentity ?? readProcessStartIdentity
  )(process.pid, process.platform);
  if (!processStartIdentity)
    throw new Error('Workspace Worker process start identity is unavailable.');
  const ownerLock =
    dependencies.ownerLock ??
    createNativeWorkspaceOwnerLockPort({
      coordinationHome: environment.coordinationHome,
      // The child claim and readiness must bind the same server-owned OS start token. A second
      // probe can race process startup or use a different platform fallback and would create two
      // conflicting identities for the same Worker.
      currentProcessIdentity: () => processStartIdentity,
      childReservation: {
        coordinationHome: environment.coordinationHome,
        workerScopeId: environment.workerScopeId,
        workspaceDigest: environment.workspace.workspaceDigest,
        workerInstanceId: environment.workerInstanceId,
        nonce: environment.ownerReservationNonce,
      },
    });
  const runtime = await dependencies.createRuntime({
    environment,
    processStartIdentity,
    ownerLock,
  });
  let primaryError: unknown;
  let unsubscribe: (() => void) | undefined;
  try {
    const ready: WorkspaceWorkerReadySignal = decodeWorkspaceWorkerReadySignal({
      schema: WORKSPACE_WORKER_READY_SCHEMA_,
      identity: {
        role: 'worker',
        workerScopeId: environment.workerScopeId,
        instanceId: environment.workerInstanceId,
        buildId: environment.buildId,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
        clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
      },
      workspace: environment.workspace,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      processStartIdentity,
      storeProfile: WORKSPACE_WORKER_STORE_PROFILE_,
      layoutGeneration: environment.layoutGeneration,
      endpoint: { origin: runtime.origin, websocketUrl: runtime.rpcUrl },
      controlOrigin: runtime.controlOrigin,
    });
    (dependencies.writeReady ?? writeWorkspaceWorkerReadySignal)(ready, environment.readinessFd);
    const onShutdown = (): void => {
      void runtime?.requestShutdown('process_signal');
    };
    unsubscribe = subscribeSignals(dependencies.signals, onShutdown);
    await runtime.waitForShutdown();
  } catch (error) {
    primaryError = error;
  }
  try {
    unsubscribe?.();
  } catch {
    // Signal cleanup cannot restore a closed Worker owner.
  }
  try {
    await runtime.close();
  } catch (error) {
    if (primaryError === undefined) primaryError = error;
  }
  if (primaryError !== undefined) throw primaryError;
}

function subscribeSignals(
  signals: WorkspaceWorkerMainSignalPort | undefined,
  listener: () => void,
): () => void {
  if (signals) return signals.subscribe(listener);
  const onSignal = (): void => listener();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  return () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  };
}

function readProcessStartIdentity(
  pid: number,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  return import('@kite-ai/kite-local-runtime/coordinator').then(
    ({ readCoordinatorProcessStartIdentity }) => readCoordinatorProcessStartIdentity(pid, platform),
  );
}

export function writeWorkspaceWorkerReadySignal(
  value: WorkspaceWorkerReadySignal,
  fd: number,
): void {
  const ready = decodeWorkspaceWorkerReadySignal(value);
  if (!Number.isSafeInteger(fd) || fd < 0 || fd > 1_024) {
    throw new TypeError('Workspace Worker readiness fd is invalid.');
  }
  const bytes = Buffer.from(`${JSON.stringify(ready)}\n`, 'utf8');
  if (bytes.byteLength > 16 * 1024) throw new Error('Workspace Worker readiness is oversized.');
  try {
    writeSync(fd, bytes);
    closeSync(fd);
  } catch {
    throw new Error('Workspace Worker readiness could not be published.');
  }
}

function requiredText(source: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = source[name];
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 512 ||
    [...value].some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new Error(`Workspace Worker requires explicit ${name}.`);
  }
  return value;
}

function requiredAbsolute(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = requiredText(source, name);
  if (!(isAbsolute(value) || win32.isAbsolute(value))) {
    throw new Error(`Workspace Worker ${name} must be an absolute path.`);
  }
  return win32.isAbsolute(value) && !isAbsolute(value) ? win32.normalize(value) : resolve(value);
}

function requiredDigest(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): `sha256:${string}` {
  const value = requiredText(source, name);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Workspace Worker ${name} is invalid.`);
  }
  return value as `sha256:${string}`;
}

function requiredGeneration(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = requiredText(source, name);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`Workspace Worker ${name} is invalid.`);
  }
  return value;
}

function requiredCredential(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = requiredText(source, name);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error(`Workspace Worker ${name} is invalid.`);
  }
  return value;
}

function parseFd(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new Error('Workspace Worker requires an explicit readiness fd.');
  }
  const fd = Number(value);
  if (!Number.isSafeInteger(fd) || fd < 0 || fd > 1_024) {
    throw new Error('Workspace Worker readiness fd is invalid.');
  }
  return fd;
}
