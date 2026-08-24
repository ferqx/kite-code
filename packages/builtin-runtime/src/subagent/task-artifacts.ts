import type { SubagentTaskArtifact, SubagentTaskRequestArtifact } from '@kite/runtime-spi';
import {
  canonicalModelJson,
  PrivateArtifactStorageError,
  type PrivateArtifactWriteFaultPoint,
  PrivateImmutableArtifactStorage,
} from '../model';
import { subagentTaskArtifactRoot } from './artifact-paths';
import { subagentTaskDigest } from './continuation-codec';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;

export interface SubagentTaskArtifactOwner {
  readonly parentInvocationId: string;
  readonly parentAttempt: number;
  readonly parentToolCallId: string;
  readonly childInvocationId: string;
}

export interface SubagentTaskArtifactPayload {
  readonly artifactFormatVersion: 1;
  readonly owner: SubagentTaskArtifactOwner;
  readonly task: string;
  readonly taskDigest: string;
  readonly taskByteLength: number;
}

export interface SubagentTaskArtifactStoreOptions {
  readonly root?: string;
  readonly maxArtifactBytes?: number;
  readonly platform?: NodeJS.Platform;
  readonly secureWindowsPath?: (path: string) => void;
  readonly faultInjector?: (point: PrivateArtifactWriteFaultPoint) => void;
}

export interface SubagentTaskArtifactAccess {
  write(input: { readonly owner: SubagentTaskArtifactOwner; readonly task: string }): {
    readonly ref: SubagentTaskArtifact;
    readonly taskDigest: string;
  };
  read(
    ref: SubagentTaskArtifact,
    expected: Readonly<SubagentTaskArtifactOwner> & { readonly taskDigest: string },
  ): Readonly<SubagentTaskArtifactPayload>;
}

export interface SubagentTaskRequestArtifactAccess {
  write(input: {
    parentModelInvocationId: string;
    parentToolCallId: string;
    name?: string;
    role: 'explore' | 'plan' | 'code' | 'review';
    task: string;
  }): SubagentTaskRequestArtifact;
  read(
    ref: SubagentTaskRequestArtifact,
    expected: { parentModelInvocationId: string; parentToolCallId: string },
  ): Readonly<{ name: string; role: 'explore' | 'plan' | 'code' | 'review'; task: string }>;
}

/** Queue-time private request storage; Runtime tool facts retain only its opaque ref. */
export class SubagentTaskRequestArtifactStore implements SubagentTaskRequestArtifactAccess {
  readonly #storage: PrivateImmutableArtifactStorage<'subagent_task_request'>;

  constructor(options: { root?: string } = {}) {
    try {
      this.#storage = new PrivateImmutableArtifactStorage({
        root: options.root ?? subagentTaskArtifactRoot(),
        namespace: 'subagent-tasks',
        partitions: [{ kind: 'subagent_task_request', directory: 'requests', extension: '.json' }],
        maxArtifactBytes: DEFAULT_MAX_BYTES,
      });
    } catch (error) {
      throw mapStorageError(error, 'storage_boundary_violation');
    }
  }

  write(input: {
    parentModelInvocationId: string;
    parentToolCallId: string;
    name?: string;
    role: 'explore' | 'plan' | 'code' | 'review';
    task: string;
  }): SubagentTaskRequestArtifact {
    try {
      const payload = validateRequestPayload({
        artifactFormatVersion: 1,
        name: input.name ?? 'Delegated task',
        parentModelInvocationId: input.parentModelInvocationId,
        parentToolCallId: input.parentToolCallId,
        role: input.role,
        task: input.task,
        taskDigest: subagentTaskDigest(input.task),
      });
      return this.#storage.write(
        'subagent_task_request',
        Buffer.from(canonicalModelJson(payload), 'utf8'),
      );
    } catch (error) {
      throw mapStorageError(error, 'invalid_task');
    }
  }

  read(
    ref: SubagentTaskRequestArtifact,
    expected: { parentModelInvocationId: string; parentToolCallId: string },
  ): Readonly<{ name: string; role: 'explore' | 'plan' | 'code' | 'review'; task: string }> {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#storage.read(ref));
      const parsed: unknown = JSON.parse(text);
      if (canonicalModelJson(parsed) !== text) corrupt();
      const payload = validateRequestPayload(parsed);
      if (
        payload.parentModelInvocationId !== expected.parentModelInvocationId ||
        payload.parentToolCallId !== expected.parentToolCallId
      ) {
        corrupt();
      }
      return Object.freeze({ name: payload.name, role: payload.role, task: payload.task });
    } catch (error) {
      if (error instanceof SubagentTaskArtifactError) {
        if (error.code === 'invalid_task') corrupt();
        throw error;
      }
      throw mapStorageError(error, 'artifact_corrupt');
    }
  }
}

export class SubagentTaskArtifactError extends Error {
  readonly code:
    | 'invalid_task'
    | 'artifact_missing'
    | 'artifact_corrupt'
    | 'artifact_too_large'
    | 'storage_boundary_violation'
    | 'publish_failed';

  constructor(code: SubagentTaskArtifactError['code'], message: string) {
    super(message);
    this.name = 'SubagentTaskArtifactError';
    this.code = code;
  }
}

/** Independent private namespace for delegated task bodies. */
export class SubagentTaskArtifactStore implements SubagentTaskArtifactAccess {
  readonly #options: SubagentTaskArtifactStoreOptions;
  #storage: PrivateImmutableArtifactStorage<'subagent_task'> | undefined;

  constructor(options: SubagentTaskArtifactStoreOptions = {}) {
    this.#options = Object.freeze({ ...options });
  }

  write(input: { readonly owner: SubagentTaskArtifactOwner; readonly task: string }): {
    readonly ref: SubagentTaskArtifact;
    readonly taskDigest: string;
  } {
    try {
      const taskDigest = subagentTaskDigest(input.task);
      const payload = validatePayload({
        artifactFormatVersion: 1,
        owner: input.owner,
        task: input.task,
        taskDigest,
        taskByteLength: Buffer.byteLength(input.task, 'utf8'),
      });
      const ref = this.#resolveStorage().write(
        'subagent_task',
        Buffer.from(canonicalModelJson(payload), 'utf8'),
      );
      return { ref, taskDigest };
    } catch (error) {
      throw mapStorageError(error, 'invalid_task');
    }
  }

  read(
    ref: SubagentTaskArtifact,
    expected: Readonly<SubagentTaskArtifactOwner> & { readonly taskDigest: string },
  ): Readonly<SubagentTaskArtifactPayload> {
    try {
      const bytes = this.#resolveStorage().read(ref);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      if (canonicalModelJson(parsed) !== text) corrupt();
      const payload = validatePayload(parsed);
      if (
        payload.taskDigest !== expected.taskDigest ||
        payload.owner.parentInvocationId !== expected.parentInvocationId ||
        payload.owner.parentAttempt !== expected.parentAttempt ||
        payload.owner.parentToolCallId !== expected.parentToolCallId ||
        payload.owner.childInvocationId !== expected.childInvocationId
      ) {
        corrupt();
      }
      return payload;
    } catch (error) {
      if (error instanceof SubagentTaskArtifactError) {
        if (error.code === 'invalid_task') corrupt();
        throw error;
      }
      throw mapStorageError(error, 'artifact_corrupt');
    }
  }

  #resolveStorage(): PrivateImmutableArtifactStorage<'subagent_task'> {
    if (this.#storage) return this.#storage;
    try {
      this.#storage = new PrivateImmutableArtifactStorage({
        root: this.#options.root ?? subagentTaskArtifactRoot(),
        namespace: 'subagent-tasks',
        partitions: [{ kind: 'subagent_task', directory: 'tasks', extension: '.json' }],
        maxArtifactBytes: this.#options.maxArtifactBytes ?? DEFAULT_MAX_BYTES,
        ...(this.#options.platform ? { platform: this.#options.platform } : {}),
        ...(this.#options.secureWindowsPath
          ? { secureWindowsPath: this.#options.secureWindowsPath }
          : {}),
        ...(this.#options.faultInjector ? { faultInjector: this.#options.faultInjector } : {}),
      });
      return this.#storage;
    } catch (error) {
      throw mapStorageError(error, 'storage_boundary_violation');
    }
  }
}

export { subagentTaskDigest };

function validatePayload(value: unknown): Readonly<SubagentTaskArtifactPayload> {
  if (
    !plain(value) ||
    !exact(value, ['artifactFormatVersion', 'owner', 'task', 'taskByteLength', 'taskDigest'])
  )
    invalid();
  if (value.artifactFormatVersion !== 1 || typeof value.task !== 'string') invalid();
  if (
    !plain(value.owner) ||
    !exact(value.owner, [
      'childInvocationId',
      'parentAttempt',
      'parentInvocationId',
      'parentToolCallId',
    ])
  )
    invalid();
  for (const field of ['childInvocationId', 'parentInvocationId', 'parentToolCallId'] as const) {
    if (typeof value.owner[field] !== 'string' || !SAFE_ID.test(value.owner[field] as string))
      invalid();
  }
  if (!Number.isSafeInteger(value.owner.parentAttempt) || Number(value.owner.parentAttempt) < 1)
    invalid();
  if (typeof value.taskDigest !== 'string' || !SHA256_DIGEST.test(value.taskDigest)) invalid();
  const byteLength = Buffer.byteLength(value.task, 'utf8');
  if (value.taskByteLength !== byteLength || value.taskDigest !== subagentTaskDigest(value.task))
    invalid();
  return deepFreeze(structuredClone(value)) as Readonly<SubagentTaskArtifactPayload>;
}

function validateRequestPayload(value: unknown): Readonly<{
  artifactFormatVersion: 1;
  name: string;
  parentModelInvocationId: string;
  parentToolCallId: string;
  role: 'explore' | 'plan' | 'code' | 'review';
  task: string;
  taskDigest: string;
}> {
  if (
    !plain(value) ||
    !exact(value, [
      'artifactFormatVersion',
      'name',
      'parentModelInvocationId',
      'parentToolCallId',
      'role',
      'task',
      'taskDigest',
    ]) ||
    value.artifactFormatVersion !== 1 ||
    typeof value.name !== 'string' ||
    value.name.trim() !== value.name ||
    value.name.length < 2 ||
    value.name.length > 80 ||
    /[\r\n]/u.test(value.name) ||
    typeof value.parentModelInvocationId !== 'string' ||
    !SAFE_ID.test(value.parentModelInvocationId) ||
    typeof value.parentToolCallId !== 'string' ||
    !SAFE_ID.test(value.parentToolCallId) ||
    !['explore', 'plan', 'code', 'review'].includes(String(value.role)) ||
    typeof value.task !== 'string' ||
    typeof value.taskDigest !== 'string' ||
    value.taskDigest !== subagentTaskDigest(value.task)
  ) {
    invalid();
  }
  return deepFreeze(structuredClone(value)) as Readonly<{
    artifactFormatVersion: 1;
    name: string;
    parentModelInvocationId: string;
    parentToolCallId: string;
    role: 'explore' | 'plan' | 'code' | 'review';
    task: string;
    taskDigest: string;
  }>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function invalid(): never {
  throw new SubagentTaskArtifactError('invalid_task', 'Subagent task Artifact payload is invalid.');
}

function corrupt(): never {
  throw new SubagentTaskArtifactError(
    'artifact_corrupt',
    'Subagent task Artifact is corrupt or cross-bound.',
  );
}

function mapStorageError(
  error: unknown,
  fallback: SubagentTaskArtifactError['code'],
): SubagentTaskArtifactError {
  if (error instanceof SubagentTaskArtifactError) return error;
  if (error instanceof PrivateArtifactStorageError) {
    const code = error.code === 'invalid_reference' ? 'artifact_corrupt' : error.code;
    return new SubagentTaskArtifactError(
      code as SubagentTaskArtifactError['code'],
      'Subagent task Artifact operation failed.',
    );
  }
  return new SubagentTaskArtifactError(fallback, 'Subagent task Artifact operation failed.');
}
