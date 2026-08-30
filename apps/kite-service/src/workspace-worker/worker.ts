import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';

export interface WorkspaceWorkerIdentity {
  readonly workerScopeId: string;
  readonly workerInstanceId: string;
  readonly buildId: string;
  readonly workspace: KiteWorkspaceIdentity;
}

export interface WorkspaceWorkerOwnerLock extends AsyncDisposable {
  readonly identity: WorkspaceWorkerIdentity;
}

export interface WorkspaceWorkerOwnerLockPort {
  acquire(identity: WorkspaceWorkerIdentity): Promise<WorkspaceWorkerOwnerLock>;
}

export interface WorkspaceWorkerRuntime extends AsyncDisposable {
  readonly ready: Promise<void>;
}

export interface WorkspaceWorkerRegistryPort {
  register(identity: WorkspaceWorkerIdentity): Promise<void>;
  unregister(identity: WorkspaceWorkerIdentity): Promise<void>;
}

export interface WorkspaceWorkerOptions {
  readonly identity: WorkspaceWorkerIdentity;
  readonly ownerLock: WorkspaceWorkerOwnerLockPort;
  readonly composeRuntime: (identity: WorkspaceWorkerIdentity) => WorkspaceWorkerRuntime;
  readonly registry: WorkspaceWorkerRegistryPort;
  readonly now?: () => number;
  readonly random?: (size: number) => Uint8Array;
  readonly capabilityTtlMs?: number;
}

export type WorkerConnectionCapabilityPurpose =
  | 'native_client'
  | 'web_observer'
  | 'agent_api_observer'
  | 'agent_api_controller';

export interface WorkerConnectionCapabilityRequest {
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly purpose: WorkerConnectionCapabilityPurpose;
}

export interface WorkerConnectionCapability {
  readonly secret: string;
  readonly expiresAt: number;
}

export interface WorkerConnectionCapabilityProof extends WorkerConnectionCapabilityRequest {
  readonly workerInstanceId: string;
  readonly workerScopeId: string;
  readonly workspaceDigest: string;
  readonly secret: string;
}

export interface WorkspaceWorker extends AsyncDisposable {
  readonly identity: WorkspaceWorkerIdentity;
  readonly state: 'ready' | 'closed';
  mintConnectionCapability(request: WorkerConnectionCapabilityRequest): WorkerConnectionCapability;
  consumeConnectionCapability(proof: WorkerConnectionCapabilityProof): boolean;
}

interface CapabilityRecord extends WorkerConnectionCapabilityRequest {
  readonly digest: Uint8Array;
  readonly expiresAt: number;
}

const DEFAULT_CAPABILITY_TTL_MS = 30_000;

/**
 * Start one Workspace Worker. The owner lock is acquired before Runtime
 * composition can open its Store, and registry publication waits for Runtime
 * readiness. There is no fallback composition or second writer path.
 */
export async function startWorkspaceWorker(
  options: WorkspaceWorkerOptions,
): Promise<WorkspaceWorker> {
  assertWorkerIdentity(options.identity);
  const ttl = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 120_000) {
    throw new RangeError('Worker capability TTL is invalid.');
  }
  const now = options.now ?? Date.now;
  const random = options.random ?? randomBytes;
  const lock = await options.ownerLock.acquire(options.identity);
  let runtime: WorkspaceWorkerRuntime | undefined;
  let registered = false;
  try {
    runtime = options.composeRuntime(options.identity);
    await runtime.ready;
    await options.registry.register(options.identity);
    registered = true;
    return createReadyWorker(options, lock, runtime, now, random, ttl);
  } catch (error) {
    if (registered) await options.registry.unregister(options.identity).catch(() => undefined);
    if (runtime) await Promise.resolve(runtime[Symbol.asyncDispose]()).catch(() => undefined);
    await Promise.resolve(lock[Symbol.asyncDispose]()).catch(() => undefined);
    throw error;
  }
}

function createReadyWorker(
  options: WorkspaceWorkerOptions,
  lock: WorkspaceWorkerOwnerLock,
  runtime: WorkspaceWorkerRuntime,
  now: () => number,
  random: (size: number) => Uint8Array,
  ttl: number,
): WorkspaceWorker {
  const capabilities = new Map<string, CapabilityRecord>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const keyFor = (request: WorkerConnectionCapabilityRequest): string =>
    `${request.clientId}\0${request.connectionGeneration}\0${request.purpose}`;

  return Object.freeze({
    identity: options.identity,
    get state() {
      return closed ? 'closed' : 'ready';
    },
    mintConnectionCapability(request: WorkerConnectionCapabilityRequest) {
      if (closed) throw new Error('Workspace Worker is closed.');
      assertCapabilityRequest(request);
      const bytes = random(32);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
        throw new Error('Worker capability source returned invalid material.');
      }
      const secret = Buffer.from(bytes).toString('base64url');
      bytes.fill(0);
      const expiresAt = checkedNow(now) + ttl;
      capabilities.set(keyFor(request), {
        ...request,
        digest: digestSecret(secret),
        expiresAt,
      });
      return Object.freeze({ secret, expiresAt });
    },
    consumeConnectionCapability(proof: WorkerConnectionCapabilityProof) {
      if (closed) return false;
      assertCapabilityRequest(proof);
      if (
        proof.workerInstanceId !== options.identity.workerInstanceId ||
        proof.workerScopeId !== options.identity.workerScopeId ||
        proof.workspaceDigest !== options.identity.workspace.workspaceDigest
      ) {
        return false;
      }
      const key = keyFor(proof);
      const record = capabilities.get(key);
      if (!record) return false;
      capabilities.delete(key);
      if (checkedNow(now) > record.expiresAt) return false;
      const actual = digestSecret(proof.secret);
      return (
        actual.byteLength === record.digest.byteLength && timingSafeEqual(actual, record.digest)
      );
    },
    [Symbol.asyncDispose]() {
      if (closePromise) return closePromise;
      closed = true;
      capabilities.clear();
      closePromise = (async () => {
        let failure: unknown;
        try {
          await options.registry.unregister(options.identity);
        } catch (error) {
          failure = error;
        }
        try {
          await runtime[Symbol.asyncDispose]();
        } catch (error) {
          failure ??= error;
        }
        try {
          await lock[Symbol.asyncDispose]();
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
      })();
      return closePromise;
    },
  });
}

function digestSecret(secret: string): Uint8Array {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Worker clock is invalid.');
  return value;
}

function assertCapabilityRequest(request: WorkerConnectionCapabilityRequest): void {
  if (
    !safeId(request.clientId) ||
    !Number.isSafeInteger(request.connectionGeneration) ||
    request.connectionGeneration < 1 ||
    !isWorkerConnectionCapabilityPurpose(request.purpose)
  ) {
    throw new TypeError('Worker capability request is invalid.');
  }
}

export function isWorkerConnectionCapabilityPurpose(
  value: unknown,
): value is WorkerConnectionCapabilityPurpose {
  return (
    value === 'native_client' ||
    value === 'web_observer' ||
    value === 'agent_api_observer' ||
    value === 'agent_api_controller'
  );
}

function assertWorkerIdentity(identity: WorkspaceWorkerIdentity): void {
  if (
    !safeId(identity.workerScopeId) ||
    !safeId(identity.workerInstanceId) ||
    !safeId(identity.buildId) ||
    !safeId(identity.workspace.projectId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(identity.workspace.workspaceDigest) ||
    identity.workspace.canonicalPath.length === 0
  ) {
    throw new TypeError('Workspace Worker identity is invalid.');
  }
}

function safeId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
}
