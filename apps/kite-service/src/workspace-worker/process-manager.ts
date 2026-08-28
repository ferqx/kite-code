import { randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, resolve, win32 } from 'node:path';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  COORDINATOR_WORKER_ENDPOINT_SCHEMA,
  COORDINATOR_WORKER_IDENTITY_SCHEMA,
  type CoordinatorWorkerRegistration,
} from '@kite-ai/kite-local-runtime/coordinator';
import { z } from 'zod';
import { createWorkspaceWorkerControlLink } from './control-carrier';
import {
  WORKSPACE_WORKER_PROCESS_DESCRIPTOR_SCHEMA_,
  WORKSPACE_WORKER_READY_SCHEMA_,
  WORKSPACE_WORKER_STORE_PROFILE_,
  type WorkspaceWorkerControlIdentity,
  type WorkspaceWorkerControlLink,
  type WorkspaceWorkerDirectoryOutboxPage,
  type WorkspaceWorkerDirectoryOutboxRequest,
  type WorkspaceWorkerProcessChild,
  type WorkspaceWorkerProcessEnvironment,
  type WorkspaceWorkerProcessEnvironmentResolver,
  type WorkspaceWorkerProcessExecutable,
  type WorkspaceWorkerProcessExecutableResolver,
  type WorkspaceWorkerProcessProbePort,
  type WorkspaceWorkerProcessSpawnInput,
  type WorkspaceWorkerProcessSpawnPort,
  type WorkspaceWorkerProcessStatus,
  type WorkspaceWorkerReadySignal,
} from './process-host';
import {
  WORKSPACE_OWNER_COORDINATION_HOME_ENV,
  WORKSPACE_OWNER_RESERVATION_NONCE_ENV,
} from './reservation';
import type { WorkerConnectionCapabilityRequest } from './worker';

export type { WorkspaceWorkerControlIdentity } from './process-host';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_WORKER_ARGS = Object.freeze(['worker', 'run'] as const);
const WORKER_CONTROL_CREDENTIAL_ENV = 'KITE_WORKER_CONTROL_CREDENTIAL' as const;
const WORKER_PROCESS_DESCRIPTOR_SCHEMA = WORKSPACE_WORKER_PROCESS_DESCRIPTOR_SCHEMA_;
const workspaceDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const boundedText = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)));
const workspacePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value),
    'Workspace path must be absolute',
  );
const workspaceIdentitySchema = z
  .object({
    canonicalPath: workspacePath,
    projectId: boundedText,
    workspaceDigest,
  })
  .strict();
const processStartIdentity = boundedText.max(256);
const layoutGeneration = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u, 'Layout generation is invalid');
const pid = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const controlCredential = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

/** Path-free descriptor retained by a Coordinator/Worker process state owner. */
const processDescriptorSchema = z
  .object({
    schema: z.literal(WORKER_PROCESS_DESCRIPTOR_SCHEMA),
    identity: COORDINATOR_WORKER_IDENTITY_SCHEMA,
    workspaceDigest,
    pid,
    startedAt: z.iso.datetime({ offset: true }),
    processStartIdentity,
    storeProfile: z.literal(WORKSPACE_WORKER_STORE_PROFILE_),
    layoutGeneration,
    endpoint: COORDINATOR_WORKER_ENDPOINT_SCHEMA,
    controlOrigin: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/u)
      .refine((value) => {
        const port = Number(value.slice(value.lastIndexOf(':') + 1));
        return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
      }),
  })
  .strict();

export type WorkspaceWorkerProcessDescriptor = z.infer<typeof processDescriptorSchema>;
export const WORKSPACE_WORKER_PROCESS_DESCRIPTOR_SCHEMA = processDescriptorSchema;

export function decodeWorkspaceWorkerProcessDescriptor(
  value: unknown,
): WorkspaceWorkerProcessDescriptor {
  return processDescriptorSchema.parse(value);
}

/** Coordinator registry entry; it intentionally contains no Workspace path or process path. */
export type WorkspaceWorkerProcessRegistration = CoordinatorWorkerRegistration;

export interface WorkspaceOwnerReservation {
  readonly workerScopeId: string;
  readonly workspaceDigest: string;
  /** Raw nonce is passed only to the explicit child environment, never descriptor/registry. */
  readonly nonce?: string;
  /** Explicit shared OS-user coordination root required by the child claim. */
  readonly coordinationHomeRoot?: string;
  /** Mark the reservation as an unknown-outcome launch before spawn. */
  readonly prepare?: (input: { readonly workerInstanceId: string }) => Promise<void>;
  /** Transfer the already-held OS-user reservation to the Worker after exact readiness. */
  handoff(input?: {
    readonly workerInstanceId?: string;
    readonly workerPid?: number;
    readonly workerProcessStartIdentity?: string;
  }): Promise<void>;
  /** Release only while the Coordinator still owns the reservation. */
  release(): Promise<void>;
}

export type WorkspaceOwnerReservationAcquireResult =
  | WorkspaceOwnerReservation
  | { readonly outcome: 'unknown' };

export interface WorkspaceOwnerReservationPort {
  acquire(input: {
    readonly workerScopeId: string;
    readonly workspace: KiteWorkspaceIdentity;
  }): Promise<WorkspaceOwnerReservationAcquireResult | undefined>;
  /** Recover a Worker-owned reservation after Coordinator restart. */
  readonly recover?: (input: {
    readonly workerScopeId: string;
    readonly workspaceDigest: string;
    readonly workerInstanceId: string;
    readonly workerPid: number;
    readonly workerProcessStartIdentity: string;
  }) => Promise<WorkspaceOwnerReservation | undefined>;
}

export interface WorkspaceWorkerProcessRegistryPort {
  register(value: WorkspaceWorkerProcessRegistration): Promise<void> | void;
  unregister(workerScopeId: string, workerInstanceId: string): Promise<void> | void;
}

export interface WorkspaceWorkerProcessStatePort {
  /** State is keyed by worker scope and must never contain Workspace canonicalPath. */
  read(workerScopeId: string): Promise<unknown | undefined>;
  readControlCredential(workerScopeId: string): Promise<string | undefined>;
  listDescriptors?(): Promise<readonly unknown[]>;
  publish(value: WorkspaceWorkerProcessDescriptor): Promise<void>;
  publishControlCredential(workerScopeId: string, value: string): Promise<string>;
  clear(value: WorkspaceWorkerProcessDescriptor): Promise<void>;
  clearControlCredential(workerScopeId: string, expected: string): Promise<void>;
  preserveFailure?(): Promise<void>;
}

export type WorkspaceWorkerProcessDiagnostic =
  | 'not_running'
  | 'workspace_owner_busy'
  | 'identity_uncertain'
  | 'ready_mismatch'
  | 'build_mismatch'
  | 'layout_mismatch'
  | 'protocol_incompatible'
  | 'client_contract_incompatible'
  | 'process_busy'
  | 'unsupported'
  | 'timeout'
  | 'state_corrupt'
  | 'outcome_unknown';

export type WorkspaceWorkerProcessOutcome =
  | 'applied'
  | 'busy'
  | 'incompatible'
  | 'unavailable'
  | 'outcome_unknown';

export type WorkspaceWorkerProcessState = 'absent' | 'starting' | 'ready' | 'draining';

export interface WorkspaceWorkerProcessResult {
  readonly operation: 'ensure' | 'resolve' | 'stop';
  readonly outcome: WorkspaceWorkerProcessOutcome;
  readonly state: WorkspaceWorkerProcessState;
  readonly registration?: WorkspaceWorkerProcessRegistration;
  readonly diagnostic?: WorkspaceWorkerProcessDiagnostic;
}

export type WorkspaceWorkerCapabilityResult =
  | {
      readonly outcome: 'applied';
      /** Returned once to the caller; never retained in manager state. */
      readonly capability: string;
      readonly expiresAt: string;
    }
  | { readonly outcome: 'unavailable'; readonly diagnostic: WorkspaceWorkerProcessDiagnostic }
  | { readonly outcome: 'outcome_unknown' };

export interface WorkspaceWorkerEnsureRequest {
  readonly workerScopeId: string;
  readonly workspace: KiteWorkspaceIdentity;
  readonly executableMode?: 'source' | 'installed';
}

export interface WorkspaceWorkerResolveRequest {
  readonly workerScopeId: string;
  readonly workspace?: KiteWorkspaceIdentity;
}

export interface WorkspaceWorkerStopRequest {
  readonly workerScopeId: string;
}

export interface WorkspaceWorkerCapabilityRequest extends WorkerConnectionCapabilityRequest {
  readonly workerScopeId: string;
  readonly workspace?: KiteWorkspaceIdentity;
}

export interface WorkspaceWorkerProcessManagerOptions {
  readonly executableResolver: WorkspaceWorkerProcessExecutableResolver;
  readonly environment: WorkspaceWorkerProcessEnvironmentResolver;
  readonly spawn: WorkspaceWorkerProcessSpawnPort;
  readonly process: WorkspaceWorkerProcessProbePort;
  readonly ownerReservation: WorkspaceOwnerReservationPort;
  /** Admit an already materialized Store 7 target while the owner reservation is held. */
  readonly admitWorkspaceStore: (input: {
    readonly workspace: KiteWorkspaceIdentity;
    readonly workerScopeId: string;
    readonly layoutGeneration: string;
  }) => Promise<void>;
  readonly registry: WorkspaceWorkerProcessRegistryPort;
  readonly state?: WorkspaceWorkerProcessStatePort;
  /** The active Store 7 LayoutGeneration is read before every new Worker spawn. */
  readonly activeLayoutGeneration: () => Promise<string>;
  /** Worker executable/build identity expected by this Coordinator process. */
  readonly expectedBuildId?: string;
  readonly args?: readonly string[];
  readonly argsFor?: (input: {
    readonly workerScopeId: string;
    readonly workerInstanceId: string;
    readonly workspace: KiteWorkspaceIdentity;
    readonly layoutGeneration: string;
  }) => readonly string[];
  readonly createWorkerInstanceId?: () => string;
  /** Reconnect to an already-running Worker without reading a capability from state. */
  readonly controlLinkFor?: (
    descriptor: WorkspaceWorkerProcessDescriptor,
    credential: string,
  ) => Promise<WorkspaceWorkerControlLink | undefined>;
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
}

export interface WorkspaceWorkerProcessManager {
  ensure(request: WorkspaceWorkerEnsureRequest): Promise<WorkspaceWorkerProcessResult>;
  resolve(request: WorkspaceWorkerResolveRequest): Promise<WorkspaceWorkerProcessResult>;
  /** Recover the exact server-owned Workspace identity after a Coordinator restart. */
  describeScope(workerScopeId: string): Promise<WorkspaceWorkerControlIdentity | undefined>;
  stopIfIdle(request: WorkspaceWorkerStopRequest): Promise<WorkspaceWorkerProcessResult>;
  mintConnectionCapability(
    request: WorkspaceWorkerCapabilityRequest,
  ): Promise<WorkspaceWorkerCapabilityResult>;
  /** Read only the authenticated Worker's current-format Directory outbox. */
  readDirectoryOutbox(input: {
    readonly workerScopeId: string;
    readonly cursor?: number;
    readonly limit?: number;
  }): Promise<WorkspaceWorkerDirectoryOutboxPage | undefined>;
  /** Validated scope seeds from live memory and restart state; no Workspace path is returned. */
  listKnownScopes(): Promise<readonly string[]>;
}

interface ManagedWorker {
  readonly descriptor: WorkspaceWorkerProcessDescriptor;
  readonly registration: WorkspaceWorkerProcessRegistration;
  readonly workspace?: KiteWorkspaceIdentity;
  readonly control?: WorkspaceWorkerControlLink;
  readonly registryRegistered: boolean;
  readonly statePublished: boolean;
  readonly reservation?: WorkspaceOwnerReservation;
}

type ScopeLoad =
  | { readonly kind: 'none' }
  | { readonly kind: 'record'; readonly record: ManagedWorker }
  | { readonly kind: 'blocked'; readonly diagnostic: WorkspaceWorkerProcessDiagnostic }
  | { readonly kind: 'corrupt' };

/**
 * Coordinator-owned Worker process lifecycle. Per-scope operations are serialized, while
 * different canonical Worker scopes proceed independently. This manager never kills a process,
 * stores a capability, or writes a Workspace path into state/registry metadata.
 */
export function createWorkspaceWorkerProcessManager(
  options: WorkspaceWorkerProcessManagerOptions,
): WorkspaceWorkerProcessManager {
  const startupTimeoutMs = boundedTimeout(
    options.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
    'startup',
  );
  const operationTimeoutMs = boundedTimeout(
    options.operationTimeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    'operation',
  );
  if (options.expectedBuildId !== undefined) assertSafeText(options.expectedBuildId, 512);
  const records = new Map<string, ManagedWorker>();
  const blocked = new Map<string, WorkspaceWorkerProcessDiagnostic>();
  const stopUnknown = new Set<string>();
  const tails = new Map<string, Promise<void>>();

  const serial = <T>(workerScopeId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(workerScopeId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    tails.set(
      workerScopeId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  };

  const invoke = <T>(operation: () => PromiseLike<T>, timeoutMs: number): Promise<T> =>
    withTimeout(operation, timeoutMs);

  const createAuthenticatedControlLink = async (
    descriptor: WorkspaceWorkerProcessDescriptor,
    credential: string,
  ): Promise<WorkspaceWorkerControlLink | undefined> => {
    if (options.controlLinkFor) {
      return invoke(() => options.controlLinkFor!(descriptor, credential), operationTimeoutMs);
    }
    try {
      return createWorkspaceWorkerControlLink({
        origin: descriptor.controlOrigin,
        credential,
        expectedWorker: {
          workerScopeId: descriptor.identity.workerScopeId,
          workerInstanceId: descriptor.identity.instanceId,
          buildId: descriptor.identity.buildId,
          workspaceDigest: descriptor.workspaceDigest as `sha256:${string}`,
        },
      });
    } catch {
      return undefined;
    }
  };

  const load = async (workerScopeId: string): Promise<ScopeLoad> => {
    const blockedDiagnostic = blocked.get(workerScopeId);
    if (blockedDiagnostic !== undefined) {
      return { kind: 'blocked', diagnostic: blockedDiagnostic };
    }
    const inMemory = records.get(workerScopeId);
    if (inMemory) return { kind: 'record', record: inMemory };
    if (!options.state) return { kind: 'none' };
    let raw: unknown | undefined;
    let credential: string | undefined;
    try {
      raw = await invoke(() => options.state!.read(workerScopeId), operationTimeoutMs);
      credential = await invoke(
        () => options.state!.readControlCredential(workerScopeId),
        operationTimeoutMs,
      );
    } catch {
      return { kind: 'corrupt' };
    }
    if (raw === undefined) {
      return credential === undefined
        ? { kind: 'none' }
        : { kind: 'blocked', diagnostic: 'outcome_unknown' };
    }
    if (credential === undefined || !controlCredential.safeParse(credential).success) {
      return { kind: 'blocked', diagnostic: 'outcome_unknown' };
    }
    try {
      const descriptor = decodeWorkspaceWorkerProcessDescriptor(raw);
      if (descriptor.identity.workerScopeId !== workerScopeId) return { kind: 'corrupt' };
      const control = await createAuthenticatedControlLink(descriptor, credential);
      if (!control) return { kind: 'blocked', diagnostic: 'identity_uncertain' };
      const identity = await invoke(() => control.describeIdentity(), operationTimeoutMs);
      if (!identity || !controlIdentityMatches(descriptor, identity)) {
        return { kind: 'blocked', diagnostic: 'identity_uncertain' };
      }
      let reservation: WorkspaceOwnerReservation | undefined;
      if (options.ownerReservation.recover) {
        reservation = await invoke(
          () =>
            options.ownerReservation.recover!({
              workerScopeId,
              workspaceDigest: descriptor.workspaceDigest,
              workerInstanceId: descriptor.identity.instanceId,
              workerPid: descriptor.pid,
              workerProcessStartIdentity: descriptor.processStartIdentity,
            }),
          operationTimeoutMs,
        ).catch(() => undefined);
        if (!reservation) return { kind: 'blocked', diagnostic: 'outcome_unknown' };
      }
      const registration = registrationFor(descriptor);
      try {
        await invoke(
          () => Promise.resolve(options.registry.register(registration)),
          operationTimeoutMs,
        );
      } catch {
        return { kind: 'blocked', diagnostic: 'outcome_unknown' };
      }
      const record = makeManagedWorker({
        descriptor,
        control,
        workspace: identity.workspace,
        registryRegistered: true,
        statePublished: true,
        ...(reservation ? { reservation } : {}),
      });
      records.set(workerScopeId, record);
      return { kind: 'record', record };
    } catch {
      return { kind: 'corrupt' };
    }
  };

  const inspect = async (
    descriptor: WorkspaceWorkerProcessDescriptor,
  ): Promise<WorkspaceWorkerProcessStatus> => {
    try {
      return await invoke(
        () =>
          options.process.inspect({
            pid: descriptor.pid,
            processStartIdentity: descriptor.processStartIdentity,
          }),
        operationTimeoutMs,
      );
    } catch {
      return 'uncertain';
    }
  };

  const preserveFailure = async (): Promise<void> => {
    try {
      await options.state?.preserveFailure?.();
    } catch {
      // Path-free state remains recovery evidence; diagnostics never expose native errors.
    }
  };

  const cleanupDead = async (record: ManagedWorker): Promise<boolean> => {
    try {
      if (record.reservation) {
        await invoke(() => record.reservation!.release(), operationTimeoutMs);
      }
      if (record.registryRegistered) {
        await invoke(
          () =>
            Promise.resolve(
              options.registry.unregister(
                record.descriptor.identity.workerScopeId,
                record.descriptor.identity.instanceId,
              ),
            ),
          operationTimeoutMs,
        );
      }
      if (record.statePublished) {
        await invoke(() => options.state!.clear(record.descriptor), operationTimeoutMs);
        const credential = await invoke(
          () => options.state!.readControlCredential(record.descriptor.identity.workerScopeId),
          operationTimeoutMs,
        );
        if (credential !== undefined) {
          await invoke(
            () =>
              options.state!.clearControlCredential(
                record.descriptor.identity.workerScopeId,
                credential,
              ),
            operationTimeoutMs,
          );
        }
      }
      records.delete(record.descriptor.identity.workerScopeId);
      stopUnknown.delete(record.descriptor.identity.workerScopeId);
      return true;
    } catch {
      await preserveFailure();
      return false;
    }
  };

  const releaseReservation = async (reservation: WorkspaceOwnerReservation): Promise<boolean> => {
    try {
      await invoke(() => reservation.release(), operationTimeoutMs);
      return true;
    } catch {
      await preserveFailure();
      return false;
    }
  };

  const clearLaunchCredential = async (
    workerScopeId: string,
    credential: string,
  ): Promise<boolean> => {
    try {
      await invoke(
        () => options.state!.clearControlCredential(workerScopeId, credential),
        operationTimeoutMs,
      );
      return true;
    } catch {
      await preserveFailure();
      return false;
    }
  };

  const ensureCore = async (
    request: WorkspaceWorkerEnsureRequest,
  ): Promise<WorkspaceWorkerProcessResult> => {
    assertEnsureRequest(request);
    const existing = await load(request.workerScopeId);
    if (existing.kind === 'blocked') {
      return result('ensure', 'outcome_unknown', 'starting', undefined, existing.diagnostic);
    }
    if (existing.kind === 'corrupt') {
      blocked.set(request.workerScopeId, 'state_corrupt');
      return result('ensure', 'unavailable', 'absent', undefined, 'state_corrupt');
    }
    if (!options.state) {
      return result('ensure', 'unavailable', 'absent', undefined, 'unsupported');
    }
    const activeLayout = await readActiveLayout();
    if (activeLayout === undefined) {
      return result('ensure', 'unavailable', 'absent', undefined, 'layout_mismatch');
    }
    if (existing.kind === 'record') {
      const status = await inspect(existing.record.descriptor);
      if (status === 'alive') {
        if (stopUnknown.has(request.workerScopeId)) {
          return result(
            'ensure',
            'outcome_unknown',
            'draining',
            existing.record.registration,
            'outcome_unknown',
          );
        }
        return existingWorkerResult(existing.record, request, activeLayout, 'ensure');
      }
      if (status === 'uncertain') {
        return result(
          'ensure',
          'unavailable',
          'ready',
          existing.record.registration,
          'identity_uncertain',
        );
      }
      if (!(await cleanupDead(existing.record))) {
        return result('ensure', 'unavailable', 'absent', undefined, 'identity_uncertain');
      }
    }

    let reservation: WorkspaceOwnerReservation | undefined;
    let reservationOutcome: WorkspaceOwnerReservationAcquireResult | undefined;
    try {
      reservationOutcome = await invoke(
        () =>
          options.ownerReservation.acquire({
            workerScopeId: request.workerScopeId,
            workspace: request.workspace,
          }),
        operationTimeoutMs,
      );
    } catch {
      return result('ensure', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    if (reservationOutcome && 'outcome' in reservationOutcome) {
      blocked.set(request.workerScopeId, 'outcome_unknown');
      return result('ensure', 'outcome_unknown', 'starting', undefined, 'outcome_unknown');
    }
    reservation = reservationOutcome;
    if (!reservation) {
      return result('ensure', 'busy', 'absent', undefined, 'workspace_owner_busy');
    }
    if (
      reservation.workerScopeId !== request.workerScopeId ||
      reservation.workspaceDigest !== request.workspace.workspaceDigest
    ) {
      const released = await releaseReservation(reservation);
      if (!released) blocked.set(request.workerScopeId, 'identity_uncertain');
      return result('ensure', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }

    const workerInstanceId = createWorkerInstanceId(options.createWorkerInstanceId);
    if (reservation.prepare && !reservation.nonce) {
      const released = await releaseReservation(reservation);
      if (!released) blocked.set(request.workerScopeId, 'identity_uncertain');
      return result('ensure', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    try {
      await invoke(
        () => reservation.prepare?.({ workerInstanceId }) ?? Promise.resolve(),
        operationTimeoutMs,
      );
    } catch {
      const released = await releaseReservation(reservation);
      if (!released) blocked.set(request.workerScopeId, 'identity_uncertain');
      return result('ensure', 'unavailable', 'absent', undefined, 'unsupported');
    }

    try {
      await invoke(
        () =>
          options.admitWorkspaceStore({
            workspace: request.workspace,
            workerScopeId: request.workerScopeId,
            layoutGeneration: activeLayout,
          }),
        operationTimeoutMs,
      );
    } catch {
      const released = await releaseReservation(reservation);
      if (!released) blocked.set(request.workerScopeId, 'identity_uncertain');
      return result('ensure', 'unavailable', 'absent', undefined, 'layout_mismatch');
    }

    const controlCredential = createControlCredential();
    try {
      await invoke(
        () => options.state!.publishControlCredential(request.workerScopeId, controlCredential),
        operationTimeoutMs,
      );
    } catch {
      const released = await releaseReservation(reservation);
      if (!released) blocked.set(request.workerScopeId, 'identity_uncertain');
      return result('ensure', 'unavailable', 'absent', undefined, 'unsupported');
    }
    let executable: WorkspaceWorkerProcessExecutable;
    let environment: WorkspaceWorkerProcessEnvironment;
    try {
      environment = await invoke(
        () =>
          options.environment.resolve({
            workspace: request.workspace,
            workerScopeId: request.workerScopeId,
            workerInstanceId,
            layoutGeneration: activeLayout,
          }),
        startupTimeoutMs,
      );
      assertEnvironment(environment, request.workspace);
      executable = await invoke(
        () => options.executableResolver.resolve(request.executableMode ?? 'source'),
        startupTimeoutMs,
      );
      assertExecutable(executable, options.expectedBuildId);
    } catch {
      const released = await releaseReservation(reservation);
      await clearLaunchCredential(request.workerScopeId, controlCredential);
      if (!released) blocked.set(request.workerScopeId, 'identity_uncertain');
      return result('ensure', 'unavailable', 'absent', undefined, 'unsupported');
    }

    const args = options.argsFor
      ? options.argsFor({
          workerScopeId: request.workerScopeId,
          workerInstanceId,
          workspace: request.workspace,
          layoutGeneration: activeLayout,
        })
      : (options.args ?? DEFAULT_WORKER_ARGS);
    if (!validateArgs(args)) {
      const released = await releaseReservation(reservation);
      await clearLaunchCredential(request.workerScopeId, controlCredential);
      if (!released) blocked.set(request.workerScopeId, 'identity_uncertain');
      return result('ensure', 'unavailable', 'absent', undefined, 'unsupported');
    }

    const spawnInput: WorkspaceWorkerProcessSpawnInput = {
      executable,
      args: Object.freeze([...args]),
      cwd: environment.cwd,
      env: Object.freeze({
        ...environment.env,
        [WORKER_CONTROL_CREDENTIAL_ENV]: controlCredential,
        ...(reservation.nonce === undefined
          ? {}
          : { [WORKSPACE_OWNER_RESERVATION_NONCE_ENV]: reservation.nonce }),
        ...(reservation.coordinationHomeRoot === undefined
          ? {}
          : { [WORKSPACE_OWNER_COORDINATION_HOME_ENV]: reservation.coordinationHomeRoot }),
      }),
      detached: true,
      stdout: 'ignore',
    };
    let child: WorkspaceWorkerProcessChild;
    try {
      child = await invoke(() => options.spawn.spawn(spawnInput), startupTimeoutMs);
      assertChild(child);
    } catch {
      // The spawn call is outcome-unknown: a detached child may have been created even when the
      // host returned an error or timed out. Keep the OS-user reservation as the durable fence so
      // a Coordinator restart cannot race a late child with a replacement spawn.
      blocked.set(request.workerScopeId, 'outcome_unknown');
      await preserveFailure();
      return result('ensure', 'outcome_unknown', 'starting', undefined, 'outcome_unknown');
    }

    let ready: WorkspaceWorkerReadySignal;
    let readyFailed = false;
    try {
      ready = await invoke(() => child.waitForReady(), startupTimeoutMs);
    } catch {
      readyFailed = true;
      ready = undefined as never;
    } finally {
      try {
        await invoke(() => child.readiness.release(), operationTimeoutMs);
      } catch {
        readyFailed = true;
      }
    }
    if (
      readyFailed ||
      !ready ||
      !readyMatches(ready, request, workerInstanceId, child.pid, executable, activeLayout)
    ) {
      // Readiness mismatch is also outcome-unknown. The reservation remains held until the
      // child/Worker independently proves absence; no replacement may be spawned from this path.
      blocked.set(request.workerScopeId, 'outcome_unknown');
      await preserveFailure();
      return result('ensure', 'outcome_unknown', 'starting', undefined, 'ready_mismatch');
    }

    const readinessStatus = await inspect({
      schema: WORKER_PROCESS_DESCRIPTOR_SCHEMA,
      identity: ready.identity,
      workspaceDigest: ready.workspace.workspaceDigest,
      pid: ready.pid,
      startedAt: ready.startedAt,
      processStartIdentity: ready.processStartIdentity,
      storeProfile: ready.storeProfile,
      layoutGeneration: ready.layoutGeneration,
      endpoint: ready.endpoint,
      controlOrigin: ready.controlOrigin,
    });
    if (readinessStatus !== 'alive') {
      if (readinessStatus === 'uncertain') {
        // Do not release a reservation on an unprovable child identity. The reservation is the
        // cross-process fence against a PID-reuse/late-readiness race.
        blocked.set(request.workerScopeId, 'identity_uncertain');
      } else {
        const cleared = await clearLaunchCredential(request.workerScopeId, controlCredential);
        const released = await releaseReservation(reservation);
        if (!cleared || !released) blocked.set(request.workerScopeId, 'identity_uncertain');
      }
      return result(
        'ensure',
        readinessStatus === 'uncertain' ? 'unavailable' : 'applied',
        readinessStatus === 'uncertain' ? 'starting' : 'absent',
        undefined,
        readinessStatus === 'uncertain' ? 'identity_uncertain' : 'not_running',
      );
    }

    const descriptor: WorkspaceWorkerProcessDescriptor = {
      schema: WORKER_PROCESS_DESCRIPTOR_SCHEMA,
      identity: ready.identity,
      workspaceDigest: ready.workspace.workspaceDigest,
      pid: ready.pid,
      startedAt: ready.startedAt,
      processStartIdentity: ready.processStartIdentity,
      storeProfile: ready.storeProfile,
      layoutGeneration: ready.layoutGeneration,
      endpoint: ready.endpoint,
      controlOrigin: ready.controlOrigin,
    };
    let control: WorkspaceWorkerControlLink | undefined;
    try {
      control = await createAuthenticatedControlLink(descriptor, controlCredential);
      const identity = await control?.describeIdentity();
      if (!control || !identity || !controlIdentityMatches(descriptor, identity)) {
        throw new Error('Worker control identity did not authenticate.');
      }
    } catch {
      blocked.set(request.workerScopeId, 'outcome_unknown');
      await preserveFailure();
      return result('ensure', 'outcome_unknown', 'starting', undefined, 'ready_mismatch');
    }
    const registration = registrationFor(descriptor);
    try {
      await invoke(
        () => Promise.resolve(options.registry.register(registration)),
        operationTimeoutMs,
      );
    } catch {
      // The Worker is alive and readiness was exact, but registry publication is outcome-unknown.
      // Retain the reservation instead of permitting another process to claim this Workspace.
      blocked.set(request.workerScopeId, 'outcome_unknown');
      await preserveFailure();
      return result('ensure', 'outcome_unknown', 'starting', undefined, 'outcome_unknown');
    }
    try {
      await invoke(
        () =>
          reservation!.handoff({
            workerInstanceId,
            workerPid: ready.pid,
            workerProcessStartIdentity: ready.processStartIdentity,
          }),
        operationTimeoutMs,
      );
    } catch {
      blocked.set(request.workerScopeId, 'outcome_unknown');
      const record = makeManagedWorker({
        descriptor,
        registration,
        workspace: request.workspace,
        control,
        registryRegistered: true,
        statePublished: false,
        reservation,
      });
      records.set(request.workerScopeId, record);
      await preserveFailure();
      return result('ensure', 'outcome_unknown', 'starting', registration, 'outcome_unknown');
    }

    let statePublished = false;
    if (options.state) {
      try {
        await invoke(() => options.state!.publish(descriptor), operationTimeoutMs);
        statePublished = true;
      } catch {
        blocked.set(request.workerScopeId, 'outcome_unknown');
        const record = makeManagedWorker({
          descriptor,
          registration,
          workspace: request.workspace,
          control,
          registryRegistered: true,
          statePublished: false,
          reservation,
        });
        records.set(request.workerScopeId, record);
        await preserveFailure();
        return result('ensure', 'outcome_unknown', 'ready', registration, 'outcome_unknown');
      }
    }
    const record = makeManagedWorker({
      descriptor,
      registration,
      workspace: request.workspace,
      control,
      registryRegistered: true,
      statePublished,
      reservation,
    });
    records.set(request.workerScopeId, record);
    return result('ensure', 'applied', 'ready', registration);
  };

  const resolveCore = async (
    request: WorkspaceWorkerResolveRequest,
  ): Promise<WorkspaceWorkerProcessResult> => {
    assertResolveRequest(request);
    const loaded = await load(request.workerScopeId);
    if (loaded.kind === 'blocked') {
      return result('resolve', 'unavailable', 'starting', undefined, loaded.diagnostic);
    }
    if (loaded.kind === 'corrupt') {
      return result('resolve', 'unavailable', 'absent', undefined, 'state_corrupt');
    }
    if (loaded.kind === 'none')
      return result('resolve', 'applied', 'absent', undefined, 'not_running');
    const activeLayout = await readActiveLayout();
    if (activeLayout === undefined) {
      return result('resolve', 'unavailable', 'absent', undefined, 'layout_mismatch');
    }
    if (loaded.record.descriptor.layoutGeneration !== activeLayout) {
      return result(
        'resolve',
        'incompatible',
        'ready',
        loaded.record.registration,
        'layout_mismatch',
      );
    }
    if (stopUnknown.has(request.workerScopeId)) {
      return result(
        'resolve',
        'outcome_unknown',
        'draining',
        loaded.record.registration,
        'outcome_unknown',
      );
    }
    const status = await inspect(loaded.record.descriptor);
    if (status === 'uncertain') {
      return result(
        'resolve',
        'unavailable',
        'ready',
        loaded.record.registration,
        'identity_uncertain',
      );
    }
    if (status === 'dead') {
      return (await cleanupDead(loaded.record))
        ? result('resolve', 'applied', 'absent', undefined, 'not_running')
        : result('resolve', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    if (
      !loaded.record.workspace ||
      (request.workspace &&
        (loaded.record.descriptor.workspaceDigest !== request.workspace.workspaceDigest ||
          !sameWorkspace(request.workspace, loaded.record.workspace)))
    ) {
      return result(
        'resolve',
        'unavailable',
        'ready',
        loaded.record.registration,
        'identity_uncertain',
      );
    }
    return result('resolve', 'applied', 'ready', loaded.record.registration);
  };

  const stopCore = async (
    request: WorkspaceWorkerStopRequest,
  ): Promise<WorkspaceWorkerProcessResult> => {
    assertStopRequest(request);
    const loaded = await load(request.workerScopeId);
    if (loaded.kind === 'blocked') {
      return result('stop', 'outcome_unknown', 'draining', undefined, loaded.diagnostic);
    }
    if (loaded.kind === 'corrupt') {
      return result('stop', 'unavailable', 'absent', undefined, 'state_corrupt');
    }
    if (loaded.kind === 'none')
      return result('stop', 'applied', 'absent', undefined, 'not_running');
    const record = loaded.record;
    const status = await inspect(record.descriptor);
    if (status === 'uncertain') {
      return result('stop', 'unavailable', 'ready', record.registration, 'identity_uncertain');
    }
    if (status === 'dead') {
      return (await cleanupDead(record))
        ? result('stop', 'applied', 'absent', undefined, 'not_running')
        : result('stop', 'unavailable', 'absent', undefined, 'identity_uncertain');
    }
    if (stopUnknown.has(request.workerScopeId)) {
      return result('stop', 'outcome_unknown', 'draining', record.registration, 'outcome_unknown');
    }
    if (!record.control) {
      return result('stop', 'unavailable', 'ready', record.registration, 'identity_uncertain');
    }
    let stopResult: Awaited<ReturnType<WorkspaceWorkerControlLink['requestIdleStop']>>;
    try {
      stopResult = await invoke(() => record.control!.requestIdleStop(), operationTimeoutMs);
    } catch {
      stopUnknown.add(request.workerScopeId);
      return result('stop', 'outcome_unknown', 'draining', record.registration, 'outcome_unknown');
    }
    if (stopResult === 'busy') {
      return result('stop', 'busy', 'ready', record.registration, 'process_busy');
    }
    if (stopResult === 'unavailable') {
      return result('stop', 'unavailable', 'ready', record.registration, 'unsupported');
    }
    if (stopResult === 'outcome_unknown') {
      stopUnknown.add(request.workerScopeId);
      return result('stop', 'outcome_unknown', 'draining', record.registration, 'outcome_unknown');
    }
    const stopped = await waitForDead(record.descriptor);
    if (stopped === 'uncertain') {
      stopUnknown.add(request.workerScopeId);
      return result(
        'stop',
        'outcome_unknown',
        'draining',
        record.registration,
        'identity_uncertain',
      );
    }
    if (stopped === 'alive') {
      stopUnknown.add(request.workerScopeId);
      return result('stop', 'outcome_unknown', 'draining', record.registration, 'timeout');
    }
    return (await cleanupDead(record))
      ? result('stop', 'applied', 'absent', undefined, 'not_running')
      : result('stop', 'unavailable', 'draining', record.registration, 'identity_uncertain');
  };

  const mintCore = async (
    request: WorkspaceWorkerCapabilityRequest,
  ): Promise<WorkspaceWorkerCapabilityResult> => {
    assertCapabilityRequest(request);
    const loaded = await load(request.workerScopeId);
    if (loaded.kind === 'blocked') return { outcome: 'outcome_unknown' };
    if (loaded.kind === 'corrupt') {
      return { outcome: 'unavailable', diagnostic: 'state_corrupt' };
    }
    if (loaded.kind === 'none') return { outcome: 'unavailable', diagnostic: 'not_running' };
    if (stopUnknown.has(request.workerScopeId)) return { outcome: 'outcome_unknown' };
    const record = loaded.record;
    if (!record.workspace) {
      return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
    }
    if (
      request.workspace &&
      (record.descriptor.workspaceDigest !== request.workspace.workspaceDigest ||
        (record.workspace && !sameWorkspace(request.workspace, record.workspace)))
    ) {
      return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
    }
    const status = await inspect(record.descriptor);
    if (status !== 'alive') {
      return {
        outcome: 'unavailable',
        diagnostic: status === 'dead' ? 'not_running' : 'identity_uncertain',
      };
    }
    if (!record.control) return { outcome: 'unavailable', diagnostic: 'unsupported' };
    try {
      const minted = await invoke(
        // The persisted routing fields authorize this manager call, but they are not part of the
        // closed Worker control request. Never leak scope/path metadata into the native carrier.
        () =>
          record.control!.mintConnectionCapability({
            clientId: request.clientId,
            connectionGeneration: request.connectionGeneration,
            purpose: request.purpose,
          }),
        operationTimeoutMs,
      );
      if (minted.outcome === 'outcome_unknown') return minted;
      if (minted.outcome === 'unavailable') {
        return { outcome: 'unavailable', diagnostic: 'unsupported' };
      }
      if (!safeCapability(minted.capability) || !safeTimestamp(minted.expiresAt)) {
        return { outcome: 'outcome_unknown' };
      }
      return minted;
    } catch {
      return { outcome: 'outcome_unknown' };
    }
  };

  const describeScopeCore = async (
    workerScopeId: string,
  ): Promise<WorkspaceWorkerControlIdentity | undefined> => {
    assertSafeText(workerScopeId, 512);
    const loaded = await load(workerScopeId);
    if (loaded.kind !== 'record' || !loaded.record.control) return undefined;
    const status = await inspect(loaded.record.descriptor);
    if (status !== 'alive') return undefined;
    const identity = await invoke(
      () => loaded.record.control!.describeIdentity(),
      operationTimeoutMs,
    ).catch(() => undefined);
    return identity && controlIdentityMatches(loaded.record.descriptor, identity)
      ? identity
      : undefined;
  };

  const readDirectoryOutboxCore = async (
    request: WorkspaceWorkerDirectoryOutboxRequest & { readonly workerScopeId: string },
  ): Promise<WorkspaceWorkerDirectoryOutboxPage | undefined> => {
    assertDirectoryOutboxRequest(request);
    const loaded = await load(request.workerScopeId);
    if (loaded.kind !== 'record' || !loaded.record.control) return undefined;
    if ((await inspect(loaded.record.descriptor)) !== 'alive') return undefined;
    const identity = await invoke(
      () => loaded.record.control!.describeIdentity(),
      operationTimeoutMs,
    ).catch(() => undefined);
    if (!identity || !controlIdentityMatches(loaded.record.descriptor, identity)) return undefined;
    const read = loaded.record.control.readDirectoryOutbox;
    if (!read) return undefined;
    const page = await invoke(
      () => read.call(loaded.record.control!, request),
      operationTimeoutMs,
    ).catch(() => undefined);
    return page && validDirectoryOutboxPage(page, request.workerScopeId, request.cursor)
      ? page
      : undefined;
  };

  const readActiveLayout = async (): Promise<string | undefined> => {
    try {
      const value = await invoke(() => options.activeLayoutGeneration(), operationTimeoutMs);
      return safeLayoutGeneration(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const waitForDead = async (
    descriptor: WorkspaceWorkerProcessDescriptor,
  ): Promise<'dead' | 'alive' | 'uncertain'> => {
    const deadline = Date.now() + operationTimeoutMs;
    while (Date.now() < deadline) {
      const status = await inspect(descriptor);
      if (status === 'dead') return 'dead';
      if (status === 'uncertain') return 'uncertain';
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(25, remaining)),
      );
    }
    return 'alive';
  };

  return Object.freeze({
    ensure: (request: WorkspaceWorkerEnsureRequest) =>
      serial(request.workerScopeId, () => ensureCore(request)),
    resolve: (request: WorkspaceWorkerResolveRequest) =>
      serial(request.workerScopeId, () => resolveCore(request)),
    describeScope: (workerScopeId: string) =>
      serial(workerScopeId, () => describeScopeCore(workerScopeId)),
    stopIfIdle: (request: WorkspaceWorkerStopRequest) =>
      serial(request.workerScopeId, () => stopCore(request)),
    mintConnectionCapability: (request: WorkspaceWorkerCapabilityRequest) =>
      serial(request.workerScopeId, () => mintCore(request)),
    readDirectoryOutbox: (
      request: WorkspaceWorkerDirectoryOutboxRequest & { readonly workerScopeId: string },
    ) => serial(request.workerScopeId, () => readDirectoryOutboxCore(request)),
    async listKnownScopes() {
      const scopes = new Set(records.keys());
      const persisted = await options.state?.listDescriptors?.();
      for (const raw of persisted ?? []) {
        const descriptor = decodeWorkspaceWorkerProcessDescriptor(raw);
        scopes.add(descriptor.identity.workerScopeId);
      }
      return Object.freeze([...scopes].sort());
    },
  });
}

function makeManagedWorker(input: {
  readonly descriptor: WorkspaceWorkerProcessDescriptor;
  readonly registration?: WorkspaceWorkerProcessRegistration;
  readonly workspace?: KiteWorkspaceIdentity;
  readonly control?: WorkspaceWorkerControlLink;
  readonly registryRegistered: boolean;
  readonly statePublished: boolean;
  readonly reservation?: WorkspaceOwnerReservation;
}): ManagedWorker {
  return Object.freeze({
    descriptor: input.descriptor,
    registration: input.registration ?? registrationFor(input.descriptor),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.control ? { control: input.control } : {}),
    registryRegistered: input.registryRegistered,
    statePublished: input.statePublished,
    ...(input.reservation ? { reservation: input.reservation } : {}),
  });
}

function registrationFor(
  descriptor: WorkspaceWorkerProcessDescriptor,
): WorkspaceWorkerProcessRegistration {
  return Object.freeze({
    identity: descriptor.identity,
    workspaceDigest: descriptor.workspaceDigest,
    endpoint: descriptor.endpoint,
    state: 'ready' as const,
    startedAt: descriptor.startedAt,
    lastSeenAt: descriptor.startedAt,
  });
}

function existingWorkerResult(
  record: ManagedWorker,
  request: WorkspaceWorkerEnsureRequest,
  activeLayout: string,
  operation: 'ensure',
): WorkspaceWorkerProcessResult {
  if (record.descriptor.workspaceDigest !== request.workspace.workspaceDigest) {
    return result(operation, 'unavailable', 'ready', record.registration, 'identity_uncertain');
  }
  if (!record.workspace || !sameWorkspace(request.workspace, record.workspace)) {
    return result(operation, 'unavailable', 'ready', record.registration, 'identity_uncertain');
  }
  if (record.descriptor.layoutGeneration !== activeLayout) {
    return result(operation, 'incompatible', 'ready', record.registration, 'layout_mismatch');
  }
  return result(operation, 'applied', 'ready', record.registration);
}

function result(
  operation: WorkspaceWorkerProcessResult['operation'],
  outcome: WorkspaceWorkerProcessOutcome,
  state: WorkspaceWorkerProcessState,
  registration?: WorkspaceWorkerProcessRegistration,
  diagnostic?: WorkspaceWorkerProcessDiagnostic,
): WorkspaceWorkerProcessResult {
  return Object.freeze({
    operation,
    outcome,
    state,
    ...(registration ? { registration } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  });
}

function readyMatches(
  ready: WorkspaceWorkerReadySignal,
  request: WorkspaceWorkerEnsureRequest,
  workerInstanceId: string,
  childPid: number,
  executable: WorkspaceWorkerProcessExecutable,
  activeLayout: string,
): boolean {
  return (
    ready.schema === WORKSPACE_WORKER_READY_SCHEMA_ &&
    ready.identity.workerScopeId === request.workerScopeId &&
    ready.identity.instanceId === workerInstanceId &&
    ready.identity.buildId === executable.buildId &&
    ready.workspace.canonicalPath === request.workspace.canonicalPath &&
    ready.workspace.projectId === request.workspace.projectId &&
    ready.workspace.workspaceDigest === request.workspace.workspaceDigest &&
    ready.pid === childPid &&
    ready.storeProfile === WORKSPACE_WORKER_STORE_PROFILE_ &&
    ready.layoutGeneration === activeLayout &&
    safeControlOrigin(ready.controlOrigin) &&
    safeText(ready.processStartIdentity, 256)
  );
}

function assertChild(child: WorkspaceWorkerProcessChild): void {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0 || !child.control) {
    throw new TypeError('Workspace Worker process child is invalid.');
  }
}

function assertExecutable(
  executable: WorkspaceWorkerProcessExecutable,
  expectedBuildId: string | undefined,
): void {
  if (
    !executable ||
    !safeAbsolutePath(executable.path) ||
    (executable.mode !== 'source' && executable.mode !== 'installed') ||
    !safeText(executable.buildId, 512) ||
    (expectedBuildId !== undefined && executable.buildId !== expectedBuildId)
  ) {
    throw new TypeError(
      expectedBuildId !== undefined
        ? 'Worker executable build identity mismatches.'
        : 'Worker executable is invalid.',
    );
  }
}

function assertEnvironment(
  environment: WorkspaceWorkerProcessEnvironment,
  workspace: KiteWorkspaceIdentity,
): void {
  if (!environment || !safeAbsolutePath(environment.cwd)) {
    throw new TypeError('Worker environment cwd is invalid.');
  }
  if (!samePath(environment.cwd, workspace.canonicalPath)) {
    throw new TypeError('Worker environment cwd does not match the canonical Workspace.');
  }
  const entries = Object.entries(environment.env);
  if (entries.length > 128) throw new RangeError('Worker environment is oversized.');
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !safeText(value, 16 * 1024)) {
      throw new TypeError('Worker environment is invalid.');
    }
  }
}

function assertEnsureRequest(request: WorkspaceWorkerEnsureRequest): void {
  assertWorkerScopeId(request.workerScopeId);
  assertWorkspace(request.workspace);
  if (
    request.executableMode !== undefined &&
    request.executableMode !== 'source' &&
    request.executableMode !== 'installed'
  ) {
    throw new TypeError('Worker executable mode is invalid.');
  }
}

function assertResolveRequest(request: WorkspaceWorkerResolveRequest): void {
  assertWorkerScopeId(request.workerScopeId);
  if (request.workspace) assertWorkspace(request.workspace);
}

function assertStopRequest(request: WorkspaceWorkerStopRequest): void {
  assertWorkerScopeId(request.workerScopeId);
}

function assertCapabilityRequest(request: WorkspaceWorkerCapabilityRequest): void {
  assertWorkerScopeId(request.workerScopeId);
  if (
    !safeText(request.clientId, 512) ||
    !Number.isSafeInteger(request.connectionGeneration) ||
    request.connectionGeneration < 1 ||
    (request.purpose !== 'native_client' && request.purpose !== 'web_observer')
  ) {
    throw new TypeError('Worker capability request is invalid.');
  }
  if (request.workspace) assertWorkspace(request.workspace);
}

function assertDirectoryOutboxRequest(request: {
  readonly workerScopeId: string;
  readonly cursor?: number;
  readonly limit?: number;
}): void {
  assertWorkerScopeId(request.workerScopeId);
  if (
    (request.cursor !== undefined &&
      (!Number.isSafeInteger(request.cursor) || request.cursor < 0)) ||
    (request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 200))
  ) {
    throw new TypeError('Workspace Directory outbox request is invalid.');
  }
}

function validDirectoryOutboxPage(
  page: WorkspaceWorkerDirectoryOutboxPage,
  workerScopeId: string,
  cursor: number | undefined,
): boolean {
  if (
    !page ||
    !Array.isArray(page.entries) ||
    page.entries.length > 200 ||
    typeof page.hasMore !== 'boolean' ||
    (page.nextCursor !== undefined &&
      (!Number.isSafeInteger(page.nextCursor) ||
        page.nextCursor < 1 ||
        page.nextCursor <= (cursor ?? 0))) ||
    (page.hasMore && (page.entries.length === 0 || page.nextCursor === undefined))
  ) {
    return false;
  }
  for (const entry of page.entries) {
    if (
      !safeText(entry.sessionId, 512) ||
      entry.workerScopeId !== workerScopeId ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 0 ||
      !Number.isSafeInteger(entry.updatedAt) ||
      entry.updatedAt < 0 ||
      typeof entry.tombstone !== 'boolean'
    ) {
      return false;
    }
  }
  return true;
}

function assertWorkerScopeId(value: string): void {
  if (!safeText(value, 512)) throw new TypeError('Worker scope identity is invalid.');
}

function assertWorkspace(value: KiteWorkspaceIdentity): void {
  try {
    workspaceIdentitySchema.parse(value);
  } catch {
    throw new TypeError('Workspace identity is invalid.');
  }
}

function createWorkerInstanceId(factory: (() => string) | undefined): string {
  const value = factory ? factory() : `worker-${randomUUID()}`;
  if (!safeText(value, 512)) throw new TypeError('Worker instance identity is invalid.');
  return value;
}

function validateArgs(args: readonly string[]): boolean {
  return args.length <= 128 && args.every((argument) => safeText(argument, 16 * 1024));
}

function safeCapability(value: string): boolean {
  return safeText(value, 1_024) && /^[A-Za-z0-9_-]+$/u.test(value);
}

function createControlCredential(): string {
  const value = randomBytes(32).toString('base64url');
  if (!controlCredential.safeParse(value).success) {
    throw new Error('Worker control credential generation failed.');
  }
  return value;
}

function safeTimestamp(value: string): boolean {
  return safeText(value, 512) && !Number.isNaN(Date.parse(value));
}

function safeLayoutGeneration(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}

function safeControlOrigin(value: string): boolean {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(value)) return false;
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function safeAbsolutePath(value: string): boolean {
  return safeText(value, 4_096) && (isAbsolute(value) || win32.isAbsolute(value));
}

function samePath(left: string, right: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(left) || /^[A-Za-z]:[\\/]/u.test(right)
    ? win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function sameWorkspace(left: KiteWorkspaceIdentity, right: KiteWorkspaceIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

function controlIdentityMatches(
  descriptor: WorkspaceWorkerProcessDescriptor,
  identity: WorkspaceWorkerControlIdentity,
): boolean {
  try {
    assertWorkerScopeId(identity.workerScopeId);
    assertWorkerScopeId(identity.workerInstanceId);
    assertSafeText(identity.buildId, 512);
    assertWorkspace(identity.workspace);
  } catch {
    return false;
  }
  return (
    identity.workerScopeId === descriptor.identity.workerScopeId &&
    identity.workerInstanceId === descriptor.identity.instanceId &&
    identity.buildId === descriptor.identity.buildId &&
    identity.workspace.workspaceDigest === descriptor.workspaceDigest
  );
}

function safeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}

function assertSafeText(value: string, maxLength: number): void {
  if (!safeText(value, maxLength)) throw new TypeError('Worker identity is invalid.');
}

function boundedTimeout(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 1 || result > MAX_TIMEOUT_MS) {
    throw new RangeError(`Worker ${label} timeout is invalid.`);
  }
  return Math.floor(result);
}

function withTimeout<T>(operation: () => PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Worker operation timed out.')), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
