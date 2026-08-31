import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_GATEWAY_REGISTRATION_SCHEMA,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorGatewayRegistration,
  type CoordinatorWebGatewayControlPort,
} from '@kite-ai/kite-local-runtime/coordinator';
import type { KiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import { z } from 'zod';
import type {
  WebGatewayControlLink,
  WebGatewayProcessChild,
  WebGatewayProcessEnvironment,
  WebGatewayProcessEnvironmentResolver,
  WebGatewayProcessExecutable,
  WebGatewayProcessExecutableResolver,
  WebGatewayProcessProbePort,
  WebGatewayProcessSpawnInput,
  WebGatewayProcessSpawnPort,
  WebGatewayProcessStatus,
  WebGatewayProcessStopResult,
  WebGatewayReadySignal,
} from './process-host';
import { readWebGatewayProcessStartIdentity } from './process-host';
import {
  createWebGatewayProcessLockIdentity,
  decodeWebGatewayProcessDescriptor,
  decodeWebGatewayProcessLockIdentity,
  gatewayRegistrationFromDescriptor,
  WEB_GATEWAY_PROCESS_LAUNCH_INTENT_SCHEMA,
  type WebGatewayProcessDescriptor,
  type WebGatewayProcessLaunchIntent,
  type WebGatewayProcessLockIdentity,
  type WebGatewayProcessLockLease,
  type WebGatewayProcessOperation,
  type WebGatewayProcessStatePort,
} from './process-state';
import { preflightWebGatewayStaticAssets, WebGatewayStaticAssetsError } from './static-assets';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_GATEWAY_ARGS = Object.freeze(['web-gateway', 'run'] as const);
const origin = z
  .string()
  .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/u)
  .refine(
    (value) => Number(value.split(':').at(-1)) >= 1 && Number(value.split(':').at(-1)) <= 65_535,
  );
const controlCredential = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export interface WebGatewayProcessRegistryPort {
  register(value: CoordinatorGatewayRegistration): Promise<void> | void;
  unregister(instanceId: string): Promise<void> | void;
}

export interface WebGatewayProcessManagerOptions {
  /** Already validated canonical home. The manager never derives a path from HOME/cwd. */
  readonly home?: KiteHomeIdentity;
  readonly state: WebGatewayProcessStatePort;
  readonly executableResolver: WebGatewayProcessExecutableResolver;
  readonly environment: WebGatewayProcessEnvironmentResolver;
  readonly spawn: WebGatewayProcessSpawnPort;
  readonly process: WebGatewayProcessProbePort;
  /** Validate the fixed static payload before any credential, launch intent, or child exists. */
  readonly preflightStaticAssets?: (environment: WebGatewayProcessEnvironment) => void;
  /** Resolve the exact child start token immediately after native spawn. */
  readonly readChildProcessStartIdentity?: (pid: number) => Promise<string | undefined>;
  readonly registry?: WebGatewayProcessRegistryPort;
  /** Reconnect to a live Gateway after Coordinator restart. */
  readonly controlLinkFor?: (
    descriptor: WebGatewayProcessDescriptor,
    credential: string,
  ) => Promise<WebGatewayControlLink | undefined>;
  /** Construct a native control link for a freshly spawned process. */
  readonly createControlLink?: (input: {
    readonly descriptor: WebGatewayProcessDescriptor;
    readonly credential: string;
  }) => Promise<WebGatewayControlLink | undefined>;
  /** Explicit bundle selection; no source/installed inference from cwd or PATH. */
  readonly executableMode?: 'source' | 'installed';
  readonly expectedBuildId?: string;
  readonly args?: readonly string[];
  readonly createGatewayInstanceId?: () => string;
  readonly managerInstanceId?: string;
  readonly managerBuildId?: string;
  /** Explicit manager process start identity; when absent it is resolved by the native host. */
  readonly managerProcessStartIdentity?: string;
  readonly resolveManagerProcessStartIdentity?: () => Promise<string | undefined>;
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly now?: () => number;
}

export interface WebGatewayProcessManager
  extends CoordinatorWebGatewayControlPort,
    AsyncDisposable {
  readonly detailedStop: () => Promise<WebGatewayProcessStopResult>;
}

export type WebGatewayProcessDiagnostic =
  | 'not_running'
  | 'web_assets_missing'
  | 'recovery_required'
  | 'identity_uncertain'
  | 'ready_mismatch'
  | 'build_mismatch'
  | 'unsupported'
  | 'timeout'
  | 'state_corrupt'
  | 'outcome_unknown';

export class WebGatewayProcessManagerError extends Error {
  readonly diagnostic: WebGatewayProcessDiagnostic;

  constructor(diagnostic: WebGatewayProcessDiagnostic, message: string) {
    super(message);
    this.name = 'WebGatewayProcessManagerError';
    this.diagnostic = diagnostic;
  }
}

interface ManagedGateway {
  readonly descriptor: WebGatewayProcessDescriptor;
  readonly control?: WebGatewayControlLink;
}

type LoadedGateway =
  | { readonly kind: 'none' }
  | { readonly kind: 'record'; readonly gateway: ManagedGateway }
  | { readonly kind: 'corrupt' };

/**
 * Coordinator-owned Gateway process lifecycle. It stores only path-free process identity and
 * origin. Launch tokens remain inside the Gateway process and are returned only at mint time.
 */
export function createWebGatewayProcessManager(
  options: WebGatewayProcessManagerOptions,
): WebGatewayProcessManager {
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
  const managerInstanceId = options.managerInstanceId ?? `gateway-manager-${randomUUID()}`;
  const managerBuildId = options.managerBuildId ?? 'kite-web-gateway-manager-v1';
  assertSafeText(managerInstanceId, 512);
  assertSafeText(managerBuildId, 512);
  const records = new Map<string, ManagedGateway>();
  let serialTail = Promise.resolve();

  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = serialTail.then(operation, operation);
    serialTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  const invoke = <T>(
    operation: () => PromiseLike<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> => withTimeout(Promise.resolve().then(operation), timeoutMs, label);

  const managerStartIdentity = async (): Promise<string> => {
    const value =
      options.managerProcessStartIdentity ?? (await options.resolveManagerProcessStartIdentity?.());
    if (!value || !safeText(value, 256)) {
      throw new WebGatewayProcessManagerError(
        'identity_uncertain',
        'Web Gateway manager process identity is unavailable.',
      );
    }
    return value;
  };

  const acquireLifecycle = async (
    operation: WebGatewayProcessOperation,
  ): Promise<WebGatewayProcessLockLease> => {
    const startedAt = nowIso(options.now);
    const identity = createWebGatewayProcessLockIdentity({
      kind: 'lifecycle',
      pid: process.pid,
      instanceId: managerInstanceId,
      startedAt,
      processStartIdentity: await managerStartIdentity(),
      buildId: managerBuildId,
      operation,
      createdAt: startedAt,
    });
    let lease = await invoke(
      () => options.state.acquireLock('lifecycle', identity),
      operationTimeoutMs,
      'Gateway lifecycle lock',
    );
    if (lease) return lease;
    const raw = await invoke(
      () => options.state.readLifecycleLock(),
      operationTimeoutMs,
      'Gateway lifecycle lock inspect',
    );
    if (raw === undefined) {
      lease = await invoke(
        () => options.state.acquireLock('lifecycle', identity),
        operationTimeoutMs,
        'Gateway lifecycle lock retry',
      );
      if (lease) return lease;
      throw new WebGatewayProcessManagerError(
        'identity_uncertain',
        'Gateway lifecycle lock was replaced.',
      );
    }
    let existing: WebGatewayProcessLockIdentity;
    try {
      existing = decodeWebGatewayProcessLockIdentity(raw);
      if (existing.kind !== 'lifecycle') {
        throw new TypeError('Gateway lifecycle lock kind mismatches.');
      }
    } catch {
      throw new WebGatewayProcessManagerError(
        'state_corrupt',
        'Gateway lifecycle lock is invalid.',
      );
    }
    const status = await inspectIdentity(existing);
    if (status !== 'dead') {
      throw new WebGatewayProcessManagerError(
        status === 'uncertain' ? 'identity_uncertain' : 'outcome_unknown',
        status === 'uncertain'
          ? 'Gateway lifecycle owner identity is uncertain.'
          : 'Gateway lifecycle lock owner could not be replaced.',
      );
    }
    await invoke(
      () => options.state.clearStale({ lifecycleLock: existing }),
      operationTimeoutMs,
      'Gateway stale lifecycle lock cleanup',
    );
    lease = await invoke(
      () => options.state.acquireLock('lifecycle', identity),
      operationTimeoutMs,
      'Gateway lifecycle lock reacquire',
    );
    if (!lease)
      throw new WebGatewayProcessManagerError(
        'outcome_unknown',
        'Gateway lifecycle lock remained busy.',
      );
    return lease;
  };

  const load = async (): Promise<LoadedGateway> => {
    const inMemory = [...records.values()][0];
    if (inMemory) return { kind: 'record', gateway: inMemory };
    let raw: unknown | undefined;
    try {
      raw = await invoke(
        () => options.state.readDescriptor(),
        operationTimeoutMs,
        'Gateway state read',
      );
    } catch {
      return { kind: 'corrupt' };
    }
    if (raw === undefined) return { kind: 'none' };
    try {
      const descriptor = decodeWebGatewayProcessDescriptor(raw);
      const rawLock = await invoke(
        () => options.state.readInstanceLock(),
        operationTimeoutMs,
        'Gateway instance lock read',
      );
      if (rawLock === undefined) {
        // The child releases its instance lock during graceful shutdown before the manager clears
        // the parent-owned descriptor/credential. A manager crash in that window is recoverable
        // only after the descriptor's exact PID/start identity is confirmed dead.
        if ((await inspectDescriptor(descriptor)) !== 'dead') return { kind: 'corrupt' };
      } else {
        const instanceLock = decodeInstanceLock(rawLock);
        if (
          instanceLock.pid !== descriptor.pid ||
          instanceLock.instanceId !== descriptor.identity.instanceId ||
          instanceLock.startedAt !== descriptor.startedAt ||
          instanceLock.processStartIdentity !== descriptor.processStartIdentity ||
          instanceLock.buildId !== descriptor.identity.buildId
        ) {
          return { kind: 'corrupt' };
        }
      }
      const credential = await invoke(
        () => options.state.readControlCredential(),
        operationTimeoutMs,
        'Gateway control credential read',
      );
      if (credential === undefined || !controlCredential.safeParse(credential).success) {
        return { kind: 'corrupt' };
      }
      const control =
        rawLock !== undefined && options.controlLinkFor
          ? await invoke(
              () => options.controlLinkFor!(descriptor, credential),
              operationTimeoutMs,
              'Gateway control reconnect',
            )
          : undefined;
      const gateway = Object.freeze({ descriptor, ...(control ? { control } : {}) });
      records.set(descriptor.identity.instanceId, gateway);
      return { kind: 'record', gateway };
    } catch {
      return { kind: 'corrupt' };
    }
  };

  const inspectDescriptor = async (
    descriptor: WebGatewayProcessDescriptor,
  ): Promise<WebGatewayProcessStatus> => {
    try {
      return await invoke(
        () =>
          options.process.inspect({
            pid: descriptor.pid,
            processStartIdentity: descriptor.processStartIdentity,
          }),
        operationTimeoutMs,
        'Gateway process identity probe',
      );
    } catch {
      return 'uncertain';
    }
  };

  const inspectIdentity = async (
    identity: WebGatewayProcessLockIdentity,
  ): Promise<WebGatewayProcessStatus> => {
    try {
      return await invoke(
        () =>
          options.process.inspect({
            pid: identity.pid,
            processStartIdentity: identity.processStartIdentity,
          }),
        operationTimeoutMs,
        'Gateway lock owner probe',
      );
    } catch {
      return 'uncertain';
    }
  };

  const registryRegister = async (registration: CoordinatorGatewayRegistration): Promise<void> => {
    if (!options.registry) return;
    try {
      COORDINATOR_GATEWAY_REGISTRATION_SCHEMA.parse(registration);
      await invoke(
        () => Promise.resolve(options.registry!.register(registration)),
        operationTimeoutMs,
        'Gateway registry register',
      );
    } catch (error) {
      if (error instanceof WebGatewayProcessManagerError) throw error;
      throw new WebGatewayProcessManagerError(
        'outcome_unknown',
        'Gateway registry registration failed.',
      );
    }
  };

  const registryUnregister = async (instanceId: string): Promise<void> => {
    if (!options.registry) return;
    try {
      await invoke(
        () => Promise.resolve(options.registry!.unregister(instanceId)),
        operationTimeoutMs,
        'Gateway registry unregister',
      );
    } catch {
      throw new WebGatewayProcessManagerError(
        'identity_uncertain',
        'Gateway registry cleanup failed.',
      );
    }
  };

  const clearDead = async (gateway: ManagedGateway): Promise<void> => {
    let firstError: unknown;
    try {
      await registryUnregister(gateway.descriptor.identity.instanceId);
    } catch (error) {
      firstError = error;
    }
    try {
      const rawLock = await invoke(
        () => options.state.readInstanceLock(),
        operationTimeoutMs,
        'Gateway instance lock read',
      );
      const credential = await invoke(
        () => options.state.readControlCredential(),
        operationTimeoutMs,
        'Gateway control credential read',
      );
      const cleanup =
        rawLock === undefined
          ? credential === undefined
            ? { descriptor: gateway.descriptor }
            : { descriptor: gateway.descriptor, controlCredential: credential }
          : credential === undefined
            ? {
                descriptor: gateway.descriptor,
                instanceLock: decodeInstanceLock(rawLock),
              }
            : {
                descriptor: gateway.descriptor,
                instanceLock: decodeInstanceLock(rawLock),
                controlCredential: credential,
              };
      await invoke(
        () => options.state.clearStale(cleanup),
        operationTimeoutMs,
        'Gateway dead state cleanup',
      );
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
    if (firstError !== undefined) {
      try {
        await invoke(
          () => options.state.preserveFailure(),
          operationTimeoutMs,
          'Gateway failure evidence',
        );
      } catch {
        // Preserve the first lifecycle failure.
      }
      throw firstError;
    }
    records.delete(gateway.descriptor.identity.instanceId);
  };

  const credentialHash = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

  const readLaunchIntent = async (): Promise<WebGatewayProcessLaunchIntent | undefined> => {
    const raw = await invoke(
      () => options.state.readLaunchIntent(),
      operationTimeoutMs,
      'Gateway launch intent read',
    );
    if (raw === undefined) return undefined;
    const decoded = WEB_GATEWAY_PROCESS_LAUNCH_INTENT_SCHEMA.safeParse(raw);
    if (!decoded.success) {
      throw new WebGatewayProcessManagerError('state_corrupt', 'Gateway launch intent is invalid.');
    }
    return decoded.data;
  };

  const lockMatchesIntent = (
    lock: WebGatewayProcessLockIdentity,
    intent: WebGatewayProcessLaunchIntent,
  ): boolean =>
    lock.kind === 'instance' &&
    lock.pid === intent.pid &&
    lock.instanceId === intent.instanceId &&
    lock.processStartIdentity === intent.processStartIdentity &&
    lock.buildId === intent.buildId;

  const clearDeadIntent = async (intent: WebGatewayProcessLaunchIntent): Promise<void> => {
    const credential = await invoke(
      () => options.state.readControlCredential(),
      operationTimeoutMs,
      'Gateway control credential read',
    );
    if (credential !== undefined && credentialHash(credential) !== intent.credentialDigest) {
      throw new WebGatewayProcessManagerError(
        'state_corrupt',
        'Gateway launch credential mismatches its intent.',
      );
    }
    const rawLock = await invoke(
      () => options.state.readInstanceLock(),
      operationTimeoutMs,
      'Gateway instance lock read',
    );
    let instanceLock: WebGatewayProcessLockIdentity | undefined;
    if (rawLock !== undefined) {
      try {
        instanceLock = decodeInstanceLock(rawLock);
      } catch {
        throw new WebGatewayProcessManagerError(
          'state_corrupt',
          'Gateway instance lock is invalid.',
        );
      }
      if (!lockMatchesIntent(instanceLock, intent)) {
        throw new WebGatewayProcessManagerError(
          'state_corrupt',
          'Gateway instance lock mismatches its launch intent.',
        );
      }
    }
    await invoke(
      () =>
        options.state.clearStale({
          launchIntent: intent,
          ...(instanceLock ? { instanceLock } : {}),
          ...(credential ? { controlCredential: credential } : {}),
        }),
      operationTimeoutMs,
      'Gateway dead launch cleanup',
    );
  };

  const recoverOrphanedLaunch = async (): Promise<void> => {
    const intent = await readLaunchIntent();
    if (intent) {
      const status = await inspectIdentity({
        schema: 'kite.web-gateway-lock.v1',
        kind: 'instance',
        nonce: 'launch-intent-probe',
        pid: intent.pid,
        instanceId: intent.instanceId,
        startedAt: intent.createdAt,
        processStartIdentity: intent.processStartIdentity,
        buildId: intent.buildId,
        createdAt: intent.createdAt,
      });
      if (status === 'dead') {
        await clearDeadIntent(intent);
        return;
      }
      throw new WebGatewayProcessManagerError(
        status === 'uncertain' ? 'identity_uncertain' : 'recovery_required',
        status === 'uncertain'
          ? 'Gateway launch process identity is uncertain.'
          : 'Gateway launch process is still alive.',
      );
    }

    const rawLock = await invoke(
      () => options.state.readInstanceLock(),
      operationTimeoutMs,
      'Gateway instance lock read',
    );
    const credential = await invoke(
      () => options.state.readControlCredential(),
      operationTimeoutMs,
      'Gateway control credential read',
    );
    if (rawLock !== undefined) {
      let instanceLock: WebGatewayProcessLockIdentity;
      try {
        instanceLock = decodeInstanceLock(rawLock);
      } catch {
        throw new WebGatewayProcessManagerError(
          'state_corrupt',
          'Gateway instance lock is invalid.',
        );
      }
      const status = await inspectIdentity(instanceLock);
      if (status === 'dead') {
        await invoke(
          () =>
            options.state.clearStale({
              instanceLock,
              ...(credential ? { controlCredential: credential } : {}),
            }),
          operationTimeoutMs,
          'Gateway dead orphan cleanup',
        );
        return;
      }
      throw new WebGatewayProcessManagerError(
        status === 'uncertain' ? 'identity_uncertain' : 'recovery_required',
        status === 'uncertain'
          ? 'Gateway orphan process identity is uncertain.'
          : 'Gateway orphan process is still alive.',
      );
    }
    if (credential !== undefined) {
      throw new WebGatewayProcessManagerError(
        'recovery_required',
        'Legacy Gateway launch state has no exact process proof.',
      );
    }
  };

  const launchUrl = async (gateway: ManagedGateway): Promise<string> => {
    if (!gateway.control) {
      throw new WebGatewayProcessManagerError(
        'unsupported',
        'Gateway launch URL control is unavailable after process discovery.',
      );
    }
    let value: string;
    try {
      value = await invoke(
        () => gateway.control!.mintLaunchUrl(),
        operationTimeoutMs,
        'Gateway launch URL mint',
      );
    } catch {
      throw new WebGatewayProcessManagerError('outcome_unknown', 'Gateway launch URL mint failed.');
    }
    const parsed = new URL(value);
    if (
      parsed.origin !== gateway.descriptor.endpoint.origin ||
      !origin.safeParse(parsed.origin).success ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.hash !== ''
    ) {
      throw new WebGatewayProcessManagerError(
        'outcome_unknown',
        'Gateway returned an invalid launch URL.',
      );
    }
    return value;
  };

  const registrationFor = (
    descriptor: WebGatewayProcessDescriptor,
  ): CoordinatorGatewayRegistration =>
    gatewayRegistrationFromDescriptor(descriptor, nowIso(options.now));

  const ensureCore = async (): Promise<
    Awaited<ReturnType<CoordinatorWebGatewayControlPort['ensure']>>
  > => {
    const loaded = await load();
    if (loaded.kind === 'corrupt')
      throw new WebGatewayProcessManagerError('state_corrupt', 'Gateway process state is invalid.');
    if (loaded.kind === 'record') {
      const status = await inspectDescriptor(loaded.gateway.descriptor);
      if (status === 'uncertain')
        throw new WebGatewayProcessManagerError(
          'identity_uncertain',
          'Gateway process identity is uncertain.',
        );
      if (status === 'alive') {
        const registration = registrationFor(loaded.gateway.descriptor);
        await registryRegister(registration);
        return { registration, launchUrl: await launchUrl(loaded.gateway) };
      }
      await clearDead(loaded.gateway);
    }

    // Recover only state bound to an exact PID/start token that is now confirmed dead. Legacy
    // credential-only state remains fail closed because it contains no no-process proof.
    await recoverOrphanedLaunch();

    const instanceId = createGatewayInstanceId(options.createGatewayInstanceId);
    const executable = await invoke(
      () => options.executableResolver.resolve(options.executableMode ?? 'source'),
      startupTimeoutMs,
      'Gateway executable resolution',
    );
    assertExecutable(executable, options.expectedBuildId);
    const environment = await invoke(
      () => options.environment.resolve({ instanceId, buildId: executable.buildId }),
      startupTimeoutMs,
      'Gateway environment resolution',
    );
    assertEnvironment(environment);
    try {
      (options.preflightStaticAssets ?? defaultStaticAssetPreflight)(environment);
    } catch (error) {
      if (error instanceof WebGatewayStaticAssetsError) {
        throw new WebGatewayProcessManagerError(
          'web_assets_missing',
          'Gateway static assets are unavailable.',
        );
      }
      throw error;
    }
    const credential = randomBytes(32).toString('base64url');
    controlCredential.parse(credential);
    const args = options.args ?? DEFAULT_GATEWAY_ARGS;
    assertArgs(args);
    const input: WebGatewayProcessSpawnInput = {
      executable,
      args: Object.freeze([...args]),
      cwd: environment.cwd,
      env: Object.freeze({
        ...environment.env,
        KITE_WEB_GATEWAY_INSTANCE_ID: instanceId,
        KITE_WEB_GATEWAY_BUILD_ID: executable.buildId,
        KITE_WEB_GATEWAY_CONTROL_CREDENTIAL: credential,
      }),
      detached: true,
      stdout: 'ignore',
    };
    let child: WebGatewayProcessChild;
    try {
      child = await invoke(
        () => options.spawn.spawn(input),
        startupTimeoutMs,
        'Gateway process spawn',
      );
      assertChild(child);
    } catch (error) {
      await preserveFailure();
      if (error instanceof WebGatewayProcessManagerError) throw error;
      throw new WebGatewayProcessManagerError('outcome_unknown', 'Gateway process spawn failed.');
    }

    const childProcessStartIdentity = await invoke(
      () =>
        (options.readChildProcessStartIdentity ?? readWebGatewayProcessStartIdentity)(child.pid),
      operationTimeoutMs,
      'Gateway child process identity',
    );
    if (!childProcessStartIdentity || !safeText(childProcessStartIdentity, 256)) {
      await preserveFailure();
      throw new WebGatewayProcessManagerError(
        'identity_uncertain',
        'Gateway child process identity is unavailable.',
      );
    }
    const launchIntent = WEB_GATEWAY_PROCESS_LAUNCH_INTENT_SCHEMA.parse({
      schema: 'kite.web-gateway-launch-intent.v1',
      pid: child.pid,
      instanceId,
      processStartIdentity: childProcessStartIdentity,
      buildId: executable.buildId,
      credentialDigest: credentialHash(credential),
      createdAt: nowIso(options.now),
    });
    try {
      await invoke(
        () => options.state.publishLaunchIntent(launchIntent),
        operationTimeoutMs,
        'Gateway launch intent publish',
      );
      await invoke(
        () => options.state.publishControlCredential(credential),
        operationTimeoutMs,
        'Gateway control credential publish',
      );
    } catch (error) {
      await preserveFailure();
      if (error instanceof WebGatewayProcessManagerError) throw error;
      throw new WebGatewayProcessManagerError(
        'outcome_unknown',
        'Gateway launch state publication failed.',
      );
    }

    let ready: WebGatewayReadySignal | undefined;
    let readyFailed = false;
    try {
      ready = await invoke(() => child.waitForReady(), startupTimeoutMs, 'Gateway readiness');
    } catch {
      readyFailed = true;
    } finally {
      try {
        await invoke(
          () => child.readiness.release(),
          operationTimeoutMs,
          'Gateway readiness release',
        );
      } catch {
        readyFailed = true;
      }
    }
    if (readyFailed || !ready || !readyMatches(ready, child.pid, instanceId, executable)) {
      const status = await inspectIdentity({
        schema: 'kite.web-gateway-lock.v1',
        kind: 'instance',
        nonce: 'failed-launch-probe',
        pid: launchIntent.pid,
        instanceId: launchIntent.instanceId,
        startedAt: launchIntent.createdAt,
        processStartIdentity: launchIntent.processStartIdentity,
        buildId: launchIntent.buildId,
        createdAt: launchIntent.createdAt,
      });
      if (status === 'dead') await clearDeadIntent(launchIntent);
      else await preserveFailure();
      throw new WebGatewayProcessManagerError(
        status === 'uncertain' ? 'identity_uncertain' : 'ready_mismatch',
        'Gateway readiness did not prove its process identity.',
      );
    }
    if (ready.processStartIdentity !== launchIntent.processStartIdentity) {
      await preserveFailure();
      throw new WebGatewayProcessManagerError(
        'identity_uncertain',
        'Gateway readiness start identity mismatches its launch intent.',
      );
    }
    const alive = await inspectDescriptor({
      schema: 'kite.web-gateway-process.v1',
      identity: ready.identity,
      pid: ready.pid,
      startedAt: ready.startedAt,
      processStartIdentity: ready.processStartIdentity,
      endpoint: ready.endpoint,
    });
    if (alive !== 'alive') {
      if (alive === 'dead') await clearDeadIntent(launchIntent);
      else await preserveFailure();
      if (alive === 'uncertain')
        throw new WebGatewayProcessManagerError(
          'identity_uncertain',
          'Gateway process identity is uncertain after readiness.',
        );
      throw new WebGatewayProcessManagerError(
        'not_running',
        'Gateway process exited before registration.',
      );
    }
    const descriptor: WebGatewayProcessDescriptor = {
      schema: 'kite.web-gateway-process.v1',
      identity: ready.identity,
      pid: ready.pid,
      startedAt: ready.startedAt,
      processStartIdentity: ready.processStartIdentity,
      endpoint: ready.endpoint,
    };
    const control =
      child.control ??
      (options.createControlLink
        ? await invoke(
            () => options.createControlLink!({ descriptor, credential }),
            operationTimeoutMs,
            'Gateway native control link',
          )
        : undefined);
    const managed = Object.freeze({ descriptor, ...(control ? { control } : {}) });
    records.set(instanceId, managed);
    const registration = registrationFor(descriptor);
    try {
      await invoke(
        () => options.state.publishDescriptor(descriptor),
        operationTimeoutMs,
        'Gateway descriptor publish',
      );
      await invoke(
        () => options.state.clearStale({ launchIntent }),
        operationTimeoutMs,
        'Gateway launch intent commit',
      );
      await registryRegister(registration);
    } catch (error) {
      await preserveFailure();
      if (error instanceof WebGatewayProcessManagerError) throw error;
      throw new WebGatewayProcessManagerError(
        'outcome_unknown',
        'Gateway registration state is uncertain.',
      );
    }
    return { registration, launchUrl: await launchUrl(managed) };
  };

  const discoverCore = async (): Promise<
    Awaited<ReturnType<CoordinatorWebGatewayControlPort['discover']>>
  > => {
    const loaded = await load();
    if (loaded.kind === 'none') return null;
    if (loaded.kind === 'corrupt')
      throw new WebGatewayProcessManagerError('state_corrupt', 'Gateway process state is invalid.');
    const status = await inspectDescriptor(loaded.gateway.descriptor);
    if (status === 'uncertain')
      throw new WebGatewayProcessManagerError(
        'identity_uncertain',
        'Gateway process identity is uncertain.',
      );
    if (status === 'dead') {
      await clearDead(loaded.gateway);
      return null;
    }
    const registration = registrationFor(loaded.gateway.descriptor);
    await registryRegister(registration);
    return { registration, launchUrl: await launchUrl(loaded.gateway) };
  };

  const stopCore = async (): Promise<WebGatewayProcessStopResult> => {
    const loaded = await load();
    if (loaded.kind === 'none') {
      await recoverOrphanedLaunch();
      return 'closed';
    }
    if (loaded.kind === 'corrupt')
      throw new WebGatewayProcessManagerError('state_corrupt', 'Gateway process state is invalid.');
    const gateway = loaded.gateway;
    const status = await inspectDescriptor(gateway.descriptor);
    if (status === 'uncertain')
      throw new WebGatewayProcessManagerError(
        'identity_uncertain',
        'Gateway process identity is uncertain.',
      );
    if (status === 'dead') {
      await clearDead(gateway);
      return 'closed';
    }
    if (!gateway.control)
      throw new WebGatewayProcessManagerError(
        'unsupported',
        'Gateway graceful stop control is unavailable.',
      );
    let requested: WebGatewayProcessStopResult;
    try {
      await invoke(() => gateway.control!.stop(), operationTimeoutMs, 'Gateway graceful stop');
      requested = 'closed';
    } catch {
      throw new WebGatewayProcessManagerError(
        'outcome_unknown',
        'Gateway graceful stop outcome is unknown.',
      );
    }
    if (requested !== 'closed') return requested;
    const stopped = await waitForDead(gateway.descriptor);
    if (stopped !== 'dead') {
      throw new WebGatewayProcessManagerError(
        stopped === 'uncertain' ? 'identity_uncertain' : 'timeout',
        stopped === 'uncertain'
          ? 'Gateway process identity became uncertain while stopping.'
          : 'Gateway did not stop before the deadline.',
      );
    }
    await clearDead(gateway);
    return 'closed';
  };

  const withLifecycle = async <T>(
    operation: WebGatewayProcessOperation,
    action: () => Promise<T>,
  ): Promise<T> => {
    const lease = await acquireLifecycle(operation);
    let value!: T;
    let firstError: unknown;
    try {
      value = await action();
    } catch (error) {
      firstError = error;
    }
    let releaseError: unknown;
    try {
      await invoke(() => lease.release(), operationTimeoutMs, 'Gateway lifecycle lock release');
    } catch (error) {
      releaseError = error;
      await preserveFailure();
    }
    if (firstError !== undefined) throw firstError;
    if (releaseError !== undefined) {
      throw new WebGatewayProcessManagerError(
        'identity_uncertain',
        'Gateway lifecycle lock release failed.',
      );
    }
    return value;
  };

  return Object.freeze({
    ensure: () => serial(() => withLifecycle('ensure', ensureCore)),
    discover: () => serial(() => withLifecycle('discover', discoverCore)),
    stop: () =>
      serial(async () => {
        await withLifecycle('stop', async () => {
          await stopCore();
        });
      }),
    detailedStop: () => serial(() => withLifecycle('stop', stopCore)),
    [Symbol.asyncDispose]: async () => {
      await serial(async () => {
        await withLifecycle('stop', async () => {
          await stopCore();
        });
      });
    },
  });

  async function waitForDead(
    descriptor: WebGatewayProcessDescriptor,
  ): Promise<WebGatewayProcessStatus> {
    const deadline = Date.now() + operationTimeoutMs;
    while (Date.now() < deadline) {
      const status = await inspectDescriptor(descriptor);
      if (status !== 'alive') return status;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(25, remaining)),
      );
    }
    return 'alive';
  }

  async function preserveFailure(): Promise<void> {
    try {
      await invoke(
        () => options.state.preserveFailure(),
        operationTimeoutMs,
        'Gateway failure evidence',
      );
    } catch {
      // State itself remains the evidence; diagnostics never contain native paths/tokens.
    }
  }
}

/** Adapter alias emphasizing that the manager exposes only the Coordinator's closed Gateway port. */
export function createCoordinatorWebGatewayControlPort(
  options: WebGatewayProcessManagerOptions,
): CoordinatorWebGatewayControlPort & AsyncDisposable {
  return createWebGatewayProcessManager(options);
}

function readyMatches(
  ready: WebGatewayReadySignal,
  childPid: number,
  expectedInstanceId: string,
  executable: WebGatewayProcessExecutable,
): boolean {
  return (
    ready.schema === 'kite.web-gateway-ready.v1' &&
    ready.pid === childPid &&
    ready.identity.role === 'web_gateway' &&
    ready.identity.instanceId === expectedInstanceId &&
    ready.identity.buildId === executable.buildId &&
    ready.identity.protocolVersion === COORDINATOR_PROTOCOL_VERSION &&
    ready.identity.protocolRevision === COORDINATOR_PROTOCOL_REVISION_ &&
    ready.identity.clientContractRevision === COORDINATOR_CLIENT_CONTRACT_REVISION_ &&
    safeText(ready.processStartIdentity, 256) &&
    origin.safeParse(ready.endpoint.origin).success
  );
}

function assertChild(child: WebGatewayProcessChild): void {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new WebGatewayProcessManagerError(
      'outcome_unknown',
      'Gateway child identity is invalid.',
    );
  }
}

function assertExecutable(
  executable: WebGatewayProcessExecutable,
  expectedBuildId: string | undefined,
): void {
  if (
    !executable ||
    !safeAbsolutePath(executable.path) ||
    (executable.mode !== 'source' && executable.mode !== 'installed') ||
    !safeText(executable.buildId, 512) ||
    (expectedBuildId !== undefined && executable.buildId !== expectedBuildId)
  ) {
    throw new WebGatewayProcessManagerError(
      expectedBuildId !== undefined ? 'build_mismatch' : 'unsupported',
      'Gateway executable identity is invalid.',
    );
  }
}

function assertEnvironment(environment: WebGatewayProcessEnvironment): void {
  if (!environment || !safeAbsolutePath(environment.cwd)) {
    throw new WebGatewayProcessManagerError('unsupported', 'Gateway environment cwd is invalid.');
  }
  const entries = Object.entries(environment.env);
  if (entries.length > 128)
    throw new WebGatewayProcessManagerError('unsupported', 'Gateway environment is oversized.');
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !safeText(value, 16_384)) {
      throw new WebGatewayProcessManagerError('unsupported', 'Gateway environment is invalid.');
    }
  }
}

function defaultStaticAssetPreflight(environment: WebGatewayProcessEnvironment): void {
  const root = environment.env.KITE_WEB_GATEWAY_STATIC_ROOT;
  if (!root) throw new WebGatewayStaticAssetsError();
  preflightWebGatewayStaticAssets(root);
}

function assertArgs(args: readonly string[]): void {
  if (args.length > 128 || args.some((argument) => !safeText(argument, 16_384))) {
    throw new WebGatewayProcessManagerError(
      'unsupported',
      'Gateway process arguments are invalid.',
    );
  }
}

function createGatewayInstanceId(factory: (() => string) | undefined): string {
  const value = factory?.() ?? `web-gateway-${randomUUID()}`;
  if (!safeText(value, 512))
    throw new WebGatewayProcessManagerError('unsupported', 'Gateway instance identity is invalid.');
  return value;
}

function boundedTimeout(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0 || result > MAX_TIMEOUT_MS) {
    throw new RangeError(`${label} timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`);
  }
  return Math.max(1, Math.floor(result));
}

function withTimeout<T>(promise: PromiseLike<T>, duration: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WebGatewayProcessManagerError('timeout', `${label} deadline exceeded.`)),
      duration,
    );
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function nowIso(now: (() => number) | undefined): string {
  const value = now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Gateway lifecycle clock is invalid.');
  return new Date(value).toISOString();
}

function safeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}

function assertSafeText(value: unknown, maxLength: number): asserts value is string {
  if (!safeText(value, maxLength)) throw new TypeError('Web Gateway identity is invalid.');
}

function decodeInstanceLock(value: unknown): WebGatewayProcessLockIdentity {
  const identity = decodeWebGatewayProcessLockIdentity(value);
  if (identity.kind !== 'instance') {
    throw new TypeError('Gateway instance lock kind mismatches.');
  }
  return identity;
}

function safeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)) &&
    safeText(value, 4_096)
  );
}
