import { randomUUID } from 'node:crypto';
import {
  KiteLocalNativeConnectionError,
  type KiteSingleServiceClient,
  KiteSingleServiceClientError,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LOCAL_RUNTIME_LIFECYCLE_RESULT_SCHEMA_,
  type LocalRuntimeLifecycleResult,
} from '../client';
import {
  clearDeadKiteLocalRuntimeEndpoint,
  type KiteLocalRuntimeDeadEndpointCleanupResult,
  type KiteLocalRuntimeEndpoint,
  type KiteLocalRuntimeLifecycleReservation,
  type KiteLocalRuntimeProcessIdentityProbe,
  readKiteLocalRuntimeLifecycleReservation,
} from '../service';
import type { KiteServiceManager, KiteServiceManagerRequest } from './ports';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

export interface KiteSingleServiceSpawnedChild {
  waitForReady(): Promise<void>;
  releaseReadiness(): Promise<void>;
}

export interface KiteSingleServiceSpawnPort {
  spawn(): Promise<KiteSingleServiceSpawnedChild>;
}

export interface KiteSingleServiceManagerOptions {
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly client: KiteSingleServiceClient;
  readonly clientForBuild?: (buildId: string) => KiteSingleServiceClient;
  readonly expectedBuildId?: string;
  readonly canReplaceInstalledBuild?: () => boolean;
  readonly canReplaceSourceBuild?: () => boolean;
  readonly process: KiteLocalRuntimeProcessIdentityProbe;
  readonly spawn: KiteSingleServiceSpawnPort;
  readonly startupTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly requestId?: () => string;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly readReservation?: typeof readKiteLocalRuntimeLifecycleReservation;
  readonly clearDead?: (input: {
    readonly endpoint: KiteLocalRuntimeEndpoint;
    readonly expected: KiteLocalRuntimeLifecycleReservation;
    readonly process: KiteLocalRuntimeProcessIdentityProbe;
  }) => Promise<KiteLocalRuntimeDeadEndpointCleanupResult>;
}

/**
 * Lifecycle manager for the one endpoint/one Service target. It never reads a descriptor/token
 * file. Existing live/starting owners are waited, exact dead owners are cleared, and uncertain
 * identity never authorizes replacement.
 */
export function createKiteSingleServiceManager(
  options: KiteSingleServiceManagerOptions,
): KiteServiceManager {
  const startupTimeoutMs = bounded(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const stopTimeoutMs = bounded(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
  const pollIntervalMs = bounded(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const requestId = options.requestId ?? randomUUID;
  const now = options.now ?? Date.now;
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const readReservation = options.readReservation ?? readKiteLocalRuntimeLifecycleReservation;
  const clearDead = options.clearDead ?? clearDeadKiteLocalRuntimeEndpoint;
  let ensureFlight: Promise<LocalRuntimeLifecycleResult> | undefined;

  const manager: KiteServiceManager = {
    ensure(request) {
      ensureFlight ??= ensure(request).finally(() => {
        ensureFlight = undefined;
      });
      return ensureFlight;
    },
    status: (request) => status(request),
    stop: (request) => stop(request),
    restart: async (request) => {
      const stopped = await stop(request, 'restart');
      if (stopped.outcome !== 'applied') return stopped;
      return ensure(request, 'restart');
    },
  };
  return Object.freeze(manager);

  async function ensure(
    request: KiteServiceManagerRequest | undefined,
    operation: 'ensure' | 'restart' = 'ensure',
  ): Promise<LocalRuntimeLifecycleResult> {
    const id = checkedRequest(request, requestId);
    const initial = await describe();
    if (initial.kind === 'ready') {
      const expectedBuildId = options.expectedBuildId;
      if (expectedBuildId === undefined || initial.buildId === expectedBuildId) {
        return result(id, operation, 'applied', 'ready');
      }
      if (request?.executableMode === 'source') {
        return isSourceBuildId(expectedBuildId) && isSourceBuildId(initial.buildId)
          ? result(id, operation, 'applied', 'ready')
          : result(id, operation, 'incompatible', 'ready', 'build_mismatch');
      }
      if (request?.executableMode !== 'installed') {
        return result(id, operation, 'applied', 'ready');
      }
      if (!isInstalledBuildId(initial.buildId) || !isInstalledBuildId(expectedBuildId)) {
        return result(id, operation, 'incompatible', 'ready', 'build_mismatch');
      }
      if (options.canReplaceInstalledBuild?.() !== true) {
        return result(id, operation, 'applied', 'ready');
      }
      const stopped = await stopInstalledBuild(id, operation, initial.buildId);
      if (stopped.outcome !== 'applied' || stopped.state !== 'absent') return stopped;
      return ensure({ ...request, requestId: id }, operation);
    }
    if (initial.kind === 'incompatible') {
      if (request?.executableMode === 'installed') {
        if (options.canReplaceInstalledBuild?.() !== true) {
          return result(id, operation, 'incompatible', 'ready', 'build_mismatch');
        }
        const stopped = await stopInstalledBuild(id, operation);
        if (stopped.outcome !== 'applied' || stopped.state !== 'absent') return stopped;
        return ensure({ ...request, requestId: id }, operation);
      }
      return result(id, operation, 'incompatible', 'absent', 'build_mismatch');
    }
    if (initial.kind === 'uncertain') {
      return result(id, operation, 'unavailable', 'absent', 'identity_uncertain');
    }
    const lifecycle = readLifecycle();
    if (lifecycle === 'corrupt') {
      return result(id, operation, 'unavailable', 'starting', 'identity_uncertain');
    }
    const reservation = lifecycle ?? undefined;
    if (reservation) {
      const owner = await options.process.inspect(
        reservation.pid,
        reservation.processStartIdentity,
      );
      if (owner === 'uncertain') {
        return result(id, operation, 'unavailable', 'starting', 'identity_uncertain');
      }
      if (owner === 'alive') {
        const waited = await waitUntilReady(now() + startupTimeoutMs);
        if (waited.kind === 'ready') return ensure({ ...request, requestId: id }, operation);
        return waited.kind === 'incompatible'
          ? result(id, operation, 'incompatible', 'starting', 'build_mismatch')
          : result(id, operation, 'unavailable', 'starting', 'identity_uncertain');
      }
      const cleanup = await clearDead({
        endpoint: options.endpoint,
        expected: reservation,
        process: options.process,
      });
      if (cleanup.outcome === 'blocked') {
        return result(id, operation, 'unavailable', 'starting', 'identity_uncertain');
      }
    }

    let child: KiteSingleServiceSpawnedChild | undefined;
    try {
      child = await options.spawn.spawn();
      await deadline(child.waitForReady(), startupTimeoutMs);
    } catch {
      // A concurrent manager may have won the endpoint race while this child lost its reservation.
      const raced = await waitUntilReady(now() + startupTimeoutMs);
      if (raced.kind === 'ready') return ensure({ ...request, requestId: id }, operation);
      return raced.kind === 'incompatible'
        ? result(id, operation, 'incompatible', 'starting', 'build_mismatch')
        : result(id, operation, 'unavailable', 'starting', 'identity_uncertain');
    } finally {
      await child?.releaseReadiness().catch(() => undefined);
    }
    const ready = await waitUntilReady(now() + startupTimeoutMs);
    if (ready.kind === 'ready') return ensure({ ...request, requestId: id }, operation);
    return ready.kind === 'incompatible'
      ? result(id, operation, 'incompatible', 'starting', 'build_mismatch')
      : result(id, operation, 'unavailable', 'starting', 'identity_uncertain');
  }

  async function status(request: KiteServiceManagerRequest | undefined) {
    const id = checkedRequest(request, requestId);
    const current = await describe();
    if (current.kind === 'ready') return result(id, 'status', 'applied', 'ready');
    if (current.kind === 'incompatible') {
      return result(id, 'status', 'incompatible', 'ready', 'build_mismatch');
    }
    if (current.kind === 'uncertain') {
      return result(id, 'status', 'unavailable', 'starting', 'identity_uncertain');
    }
    const lifecycle = readLifecycle();
    if (lifecycle === 'corrupt') {
      return result(id, 'status', 'unavailable', 'starting', 'identity_uncertain');
    }
    const reservation = lifecycle ?? undefined;
    if (!reservation) return result(id, 'status', 'applied', 'absent', 'not_running');
    const owner = await options.process.inspect(reservation.pid, reservation.processStartIdentity);
    return owner === 'alive'
      ? result(id, 'status', 'applied', 'starting')
      : result(id, 'status', 'unavailable', 'starting', 'identity_uncertain');
  }

  async function stop(
    request: KiteServiceManagerRequest | undefined,
    operation: 'stop' | 'restart' = 'stop',
  ): Promise<LocalRuntimeLifecycleResult> {
    const id = checkedRequest(request, requestId);
    const current = await describe();
    if (current.kind === 'incompatible') {
      return result(id, operation, 'incompatible', 'ready', 'build_mismatch');
    }
    if (current.kind === 'uncertain') {
      return result(id, operation, 'unavailable', 'starting', 'identity_uncertain');
    }
    if (current.kind !== 'ready') {
      const lifecycle = readLifecycle();
      if (lifecycle === 'corrupt') {
        return result(id, operation, 'unavailable', 'starting', 'identity_uncertain');
      }
      const reservation = lifecycle ?? undefined;
      if (!reservation) return result(id, operation, 'applied', 'absent', 'not_running');
      return result(id, operation, 'unavailable', 'starting', 'identity_uncertain');
    }
    const stoppingLifecycle = readLifecycle();
    if (
      stoppingLifecycle === 'corrupt' ||
      (options.endpoint.kind === 'unix' && stoppingLifecycle === null)
    ) {
      return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
    }
    try {
      const stopped = await options.client.stopService();
      if (stopped.outcome === 'service_busy') {
        return result(id, operation, 'service_busy', 'ready', 'service_busy');
      }
      if (stopped.outcome !== 'applied') {
        return result(id, operation, 'unavailable', stopped.state, 'identity_uncertain');
      }
    } catch (error) {
      if (error instanceof KiteSingleServiceClientError && error.diagnostic === 'incompatible') {
        if (request?.executableMode === 'source' && options.canReplaceSourceBuild?.() === true) {
          return stopSourceBuild(id, operation);
        }
        return result(id, operation, 'incompatible', 'ready', 'build_mismatch');
      }
      return result(id, operation, 'outcome_unknown', 'draining', 'identity_uncertain');
    }
    const absent = await waitUntilAbsent(
      now() + stopTimeoutMs,
      stoppingLifecycle === null ? undefined : stoppingLifecycle,
    );
    return absent
      ? result(id, operation, 'applied', 'absent')
      : result(id, operation, 'outcome_unknown', 'draining', 'identity_uncertain');
  }

  async function stopInstalledBuild(
    id: string,
    operation: 'ensure' | 'restart',
    observedBuildId?: string,
  ): Promise<LocalRuntimeLifecycleResult> {
    const lifecycle = readLifecycle();
    if (lifecycle === 'corrupt') {
      return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
    }
    if (lifecycle === null) {
      if (
        options.endpoint.kind !== 'named_pipe' ||
        observedBuildId === undefined ||
        !isInstalledBuildId(observedBuildId) ||
        options.clientForBuild === undefined
      ) {
        return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
      }
      const previousClient = options.clientForBuild(observedBuildId);
      try {
        const current = await previousClient.describe();
        if (current.service.buildId !== observedBuildId) {
          return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
        }
      } catch {
        return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
      }
      return stopInstalledClient(id, operation, previousClient);
    }
    if (!isInstalledBuildId(lifecycle.buildId) || options.clientForBuild === undefined) {
      return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
    }
    const owner = await options.process.inspect(lifecycle.pid, lifecycle.processStartIdentity);
    if (owner === 'uncertain') {
      return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
    }
    if (owner === 'dead') {
      const cleanup = await clearDead({
        endpoint: options.endpoint,
        expected: lifecycle,
        process: options.process,
      });
      return cleanup.outcome === 'cleared'
        ? result(id, operation, 'applied', 'absent')
        : result(id, operation, 'unavailable', 'starting', 'identity_uncertain');
    }

    const previousClient = options.clientForBuild(lifecycle.buildId);
    try {
      const previous = await previousClient.describe();
      if (
        previous.service.instanceId !== lifecycle.instanceId ||
        previous.service.pid !== lifecycle.pid ||
        previous.service.startedAt !== lifecycle.startedAt ||
        previous.service.buildId !== lifecycle.buildId
      ) {
        return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
      }
    } catch {
      return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
    }

    return stopInstalledClient(id, operation, previousClient, lifecycle);
  }

  async function stopSourceBuild(
    id: string,
    operation: 'stop' | 'restart',
  ): Promise<LocalRuntimeLifecycleResult> {
    const expectedBuildId = options.expectedBuildId;
    if (
      expectedBuildId === undefined ||
      !isSourceBuildId(expectedBuildId) ||
      options.clientForBuild === undefined
    ) {
      return result(id, operation, 'incompatible', 'ready', 'build_mismatch');
    }

    let current: Awaited<ReturnType<KiteSingleServiceClient['describe']>>;
    try {
      current = await options.client.describe();
    } catch {
      return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
    }
    if (!isSourceBuildId(current.service.buildId) || current.service.buildId === expectedBuildId) {
      return result(id, operation, 'incompatible', 'ready', 'build_mismatch');
    }

    const lifecycle = readLifecycle();
    if (lifecycle === 'corrupt') {
      return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
    }
    if (lifecycle === null && options.endpoint.kind === 'unix') {
      return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
    }
    if (lifecycle) {
      if (
        lifecycle.instanceId !== current.service.instanceId ||
        lifecycle.pid !== current.service.pid ||
        lifecycle.startedAt !== current.service.startedAt ||
        lifecycle.buildId !== current.service.buildId
      ) {
        return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
      }
      const owner = await options.process.inspect(lifecycle.pid, lifecycle.processStartIdentity);
      if (owner !== 'alive') {
        return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
      }
    }

    const previousClient = options.clientForBuild(current.service.buildId);
    try {
      const previous = await previousClient.describe();
      if (
        previous.service.instanceId !== current.service.instanceId ||
        previous.service.pid !== current.service.pid ||
        previous.service.startedAt !== current.service.startedAt ||
        previous.service.buildId !== current.service.buildId
      ) {
        return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
      }
    } catch {
      return result(id, operation, 'unavailable', 'ready', 'identity_uncertain');
    }

    return stopInstalledClient(id, operation, previousClient, lifecycle ?? undefined);
  }

  async function stopInstalledClient(
    id: string,
    operation: 'ensure' | 'stop' | 'restart',
    client: KiteSingleServiceClient,
    lifecycle?: KiteLocalRuntimeLifecycleReservation,
  ): Promise<LocalRuntimeLifecycleResult> {
    const deadlineAt = now() + stopTimeoutMs;
    for (;;) {
      let stopped: Awaited<ReturnType<KiteSingleServiceClient['stopService']>>;
      try {
        stopped = await client.stopService();
      } catch {
        const absent = await waitUntilAbsent(deadlineAt, lifecycle);
        return absent
          ? result(id, operation, 'applied', 'absent')
          : result(id, operation, 'outcome_unknown', 'draining', 'identity_uncertain');
      }
      if (stopped.outcome === 'service_busy') {
        if (now() >= deadlineAt) {
          return result(id, operation, 'service_busy', 'ready', 'service_busy');
        }
        await wait(Math.min(pollIntervalMs, Math.max(1, deadlineAt - now())));
        continue;
      }
      if (stopped.outcome !== 'applied') {
        return result(id, operation, 'unavailable', stopped.state, 'identity_uncertain');
      }
      const absent = await waitUntilAbsent(deadlineAt, lifecycle);
      return absent
        ? result(id, operation, 'applied', 'absent')
        : result(id, operation, 'outcome_unknown', 'draining', 'identity_uncertain');
    }
  }

  async function describe(): Promise<
    | { readonly kind: 'ready'; readonly buildId: string }
    | { readonly kind: 'absent' | 'incompatible' | 'uncertain' }
  > {
    try {
      const current = await options.client.describe();
      return { kind: 'ready', buildId: current.service.buildId };
    } catch (error) {
      if (error instanceof KiteSingleServiceClientError && error.diagnostic === 'incompatible') {
        return { kind: 'incompatible' };
      }
      if (
        (error instanceof KiteLocalNativeConnectionError && error.code === 'unavailable') ||
        (error instanceof KiteSingleServiceClientError && error.diagnostic === 'unavailable')
      ) {
        return { kind: 'absent' };
      }
      return { kind: 'uncertain' };
    }
  }

  async function waitUntilReady(deadlineAt: number) {
    for (;;) {
      const current = await describe();
      if (current.kind !== 'absent') return current;
      if (now() >= deadlineAt) return { kind: 'absent' } as const;
      await wait(Math.min(pollIntervalMs, Math.max(1, deadlineAt - now())));
    }
  }

  async function waitUntilAbsent(
    deadlineAt: number,
    expected?: KiteLocalRuntimeLifecycleReservation,
  ): Promise<boolean> {
    for (;;) {
      const current = await describe();
      const lifecycle = readLifecycle();
      if (current.kind === 'absent' && lifecycle === null) return true;
      if (lifecycle === 'corrupt') return false;
      if (expected) {
        if (lifecycle && !sameLifecycle(lifecycle, expected)) return false;
        const owner = await options.process.inspect(expected.pid, expected.processStartIdentity);
        if (owner === 'uncertain') {
          // A just-exited child may remain briefly observable as a zombie while its start token
          // is no longer readable. Accepted stop authorizes waiting, never cleanup or replay.
          if (now() >= deadlineAt) return false;
          await wait(Math.min(pollIntervalMs, Math.max(1, deadlineAt - now())));
          continue;
        }
        if (owner === 'dead' && lifecycle) {
          const cleanup = await clearDead({
            endpoint: options.endpoint,
            expected,
            process: options.process,
          });
          if (cleanup.outcome === 'blocked') return false;
          return true;
        }
        // A just-accepted compatibility stop may leave the exact previous-build endpoint
        // observable until shutdown settles. The unchanged lifecycle identity authorizes waiting,
        // never cleanup or a second stop after an ambiguous response.
      } else if (current.kind === 'uncertain') {
        return false;
      }
      if (now() >= deadlineAt) return false;
      await wait(Math.min(pollIntervalMs, Math.max(1, deadlineAt - now())));
    }
  }

  function readLifecycle(): KiteLocalRuntimeLifecycleReservation | null | 'corrupt' {
    try {
      return readReservation(options.endpoint) ?? null;
    } catch {
      return 'corrupt';
    }
  }
}

function sameLifecycle(
  left: KiteLocalRuntimeLifecycleReservation,
  right: KiteLocalRuntimeLifecycleReservation,
): boolean {
  return (
    left.schema === right.schema &&
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    left.instanceId === right.instanceId &&
    left.buildId === right.buildId &&
    left.startedAt === right.startedAt &&
    left.socketDevice === right.socketDevice &&
    left.socketInode === right.socketInode
  );
}

function isInstalledBuildId(value: string): boolean {
  return /^[a-f0-9]{24}$/u.test(value);
}

function isSourceBuildId(value: string): boolean {
  return value.startsWith('dev:');
}

function checkedRequest(
  request: KiteServiceManagerRequest | undefined,
  allocate: () => string,
): string {
  if (
    request?.clientContractRevision !== undefined &&
    request.clientContractRevision !== LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_
  ) {
    throw new TypeError('Single-Service manager client contract is invalid.');
  }
  const value = request?.requestId ?? allocate();
  if (value.length < 1 || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw new TypeError('Single-Service manager request identity is invalid.');
  }
  return value;
}

function result(
  requestId: string,
  operation: LocalRuntimeLifecycleResult['operation'],
  outcome: LocalRuntimeLifecycleResult['outcome'],
  state: LocalRuntimeLifecycleResult['state'],
  diagnostic?: LocalRuntimeLifecycleResult['diagnostic'],
): LocalRuntimeLifecycleResult {
  return Object.freeze({
    schema: LOCAL_RUNTIME_LIFECYCLE_RESULT_SCHEMA_,
    requestId,
    operation,
    outcome,
    state,
    ...(diagnostic ? { diagnostic } : {}),
  });
}

function bounded(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 300_000) {
    throw new RangeError('Single-Service manager deadline is invalid.');
  }
  return selected;
}

function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Single-Service readiness deadline exceeded.')),
        milliseconds,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
