import type { SubagentTaskArtifact, SubagentTaskRequestArtifact } from '@kite-ai/runtime-spi';
import {
  canonicalModelJson,
  PrivateArtifactStorageError,
  type PrivateArtifactWriteFaultPoint,
  PrivateImmutableArtifactStorage,
  type PrivateImmutableArtifactStorageBackend,
} from '../model';
import { subagentTaskArtifactRoot } from './artifact-paths';
import { subagentTaskDigest } from './continuation-codec';

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
  readonly backend?: PrivateImmutableArtifactStorageBackend<
    'subagent_task_request' | 'subagent_task'
  >;
  readonly platform?: NodeJS.Platform;
  readonly secureWindowsPath?: (path: string) => void;
  readonly faultInjector?: (point: PrivateArtifactWriteFaultPoint) => void;
}

export interface SubagentResultArtifactRef {
  readonly artifactId: string;
  readonly kind: 'subagent_task';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}

export interface SubagentResultArtifactAccess {
  write(input: {
    readonly ownerKey: string;
    readonly taskId: string;
    readonly displayName?: string;
    readonly result: Readonly<Record<string, unknown>>;
  }): SubagentResultArtifactRef;
  read(ref: SubagentResultArtifactRef, taskId: string): Readonly<Record<string, unknown>>;
  lookup(
    ownerKey: string,
    taskId: string,
  ):
    | Readonly<{
        ref: SubagentResultArtifactRef;
        displayName?: string;
        result: Readonly<Record<string, unknown>>;
      }>
    | undefined;
  list(ownerKey: string): readonly Readonly<{
    taskId: string;
    ref: SubagentResultArtifactRef;
    displayName?: string;
    result: Readonly<Record<string, unknown>>;
  }>[];
}

/** Immutable terminal report store. Repeated reads never consume Provider observation. */
export class SubagentResultArtifactStore implements SubagentResultArtifactAccess {
  readonly #storage: PrivateImmutableArtifactStorage<'subagent_task'>;
  constructor(
    options: {
      root?: string;
      backend?: PrivateImmutableArtifactStorageBackend<'subagent_task_request' | 'subagent_task'>;
    } = {},
  ) {
    this.#storage = new PrivateImmutableArtifactStorage({
      ...(options.backend
        ? { backend: options.backend as PrivateImmutableArtifactStorageBackend<'subagent_task'> }
        : { root: options.root ?? subagentTaskArtifactRoot() }),
      namespace: 'subagent-tasks',
      partitions: [{ kind: 'subagent_task', directory: 'results', extension: '.json' }],
    });
  }
  write(input: {
    readonly ownerKey: string;
    readonly taskId: string;
    readonly displayName?: string;
    readonly result: Readonly<Record<string, unknown>>;
  }): SubagentResultArtifactRef {
    if (!SAFE_ID.test(input.taskId))
      throw new SubagentTaskArtifactError(
        'invalid_task',
        'Subagent result task identity is invalid.',
      );
    if (input.ownerKey.length === 0)
      throw new SubagentTaskArtifactError(
        'invalid_task',
        'Subagent result owner identity is invalid.',
      );
    if (input.displayName !== undefined && input.displayName.length === 0)
      throw new SubagentTaskArtifactError(
        'invalid_task',
        'Subagent result display name is invalid.',
      );
    const payload = Object.freeze({
      artifactFormatVersion: 1,
      ownerKey: input.ownerKey,
      taskId: input.taskId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      result: input.result,
    });
    return this.#storage.write('subagent_task', Buffer.from(canonicalModelJson(payload), 'utf8'));
  }
  lookup(ownerKey: string, taskId: string) {
    const ref = this.#storage.findByOwnerTask?.(ownerKey, taskId) as
      | SubagentResultArtifactRef
      | undefined;
    if (!ref) return undefined;
    const payload = this.#readPayload(ref, taskId);
    return Object.freeze({
      ref,
      ...(payload.displayName ? { displayName: payload.displayName } : {}),
      result: payload.result,
    });
  }
  list(ownerKey: string) {
    return this.#storage.listByOwner(ownerKey).map((ref) => {
      const taskId = JSON.parse(new TextDecoder().decode(this.#storage.read(ref))).taskId as string;
      const payload = this.#readPayload(ref as SubagentResultArtifactRef, taskId);
      return Object.freeze({
        taskId,
        ref: ref as SubagentResultArtifactRef,
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
        result: payload.result,
      });
    });
  }
  read(ref: SubagentResultArtifactRef, taskId: string): Readonly<Record<string, unknown>> {
    return this.#readPayload(ref, taskId).result;
  }
  #readPayload(
    ref: SubagentResultArtifactRef,
    taskId: string,
  ): Readonly<{
    displayName?: string;
    result: Readonly<Record<string, unknown>>;
  }> {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#storage.read(ref));
      const value = JSON.parse(text) as {
        artifactFormatVersion?: unknown;
        taskId?: unknown;
        displayName?: unknown;
        result?: unknown;
      };
      if (
        canonicalModelJson(value) !== text ||
        value.artifactFormatVersion !== 1 ||
        value.taskId !== taskId ||
        (value.displayName !== undefined &&
          (typeof value.displayName !== 'string' || value.displayName.length === 0)) ||
        !value.result ||
        typeof value.result !== 'object' ||
        Array.isArray(value.result)
      )
        corrupt();
      return Object.freeze({
        ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
        result: Object.freeze(value.result as Record<string, unknown>),
      });
    } catch (error) {
      throw mapStorageError(error, 'artifact_corrupt');
    }
  }
}

export interface SubagentTaskArtifactAccess {
  write(input: { readonly owner: SubagentTaskArtifactOwner; readonly task: string }): {
    readonly ref: SubagentTaskArtifact;
    readonly taskDigest: string;
  };
  read(
    ref: SubagentTaskArtifact,
    expected: Readonly<SubagentTaskArtifactOwner> & {
      readonly taskDigest: string;
    },
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
  ): Readonly<{
    name: string;
    role: 'explore' | 'plan' | 'code' | 'review';
    task: string;
  }>;
}

/** Queue-time private request storage; Runtime tool facts retain only its opaque ref. */
export class SubagentTaskRequestArtifactStore implements SubagentTaskRequestArtifactAccess {
  readonly #storage: PrivateImmutableArtifactStorage<'subagent_task_request'>;

  constructor(
    options: {
      root?: string;
      backend?: PrivateImmutableArtifactStorageBackend<'subagent_task_request' | 'subagent_task'>;
    } = {},
  ) {
    try {
      this.#storage = new PrivateImmutableArtifactStorage({
        ...(options.backend
          ? {
              backend:
                options.backend as PrivateImmutableArtifactStorageBackend<'subagent_task_request'>,
            }
          : { root: options.root ?? subagentTaskArtifactRoot() }),
        namespace: 'subagent-tasks',
        partitions: [
          {
            kind: 'subagent_task_request',
            directory: 'requests',
            extension: '.json',
          },
        ],
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
  ): Readonly<{
    name: string;
    role: 'explore' | 'plan' | 'code' | 'review';
    task: string;
  }> {
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
      return Object.freeze({
        name: payload.name,
        role: payload.role,
        task: payload.task,
      });
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
    expected: Readonly<SubagentTaskArtifactOwner> & {
      readonly taskDigest: string;
    },
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
        ...(this.#options.backend
          ? {
              backend: this.#options
                .backend as PrivateImmutableArtifactStorageBackend<'subagent_task'>,
            }
          : { root: this.#options.root ?? subagentTaskArtifactRoot() }),
        namespace: 'subagent-tasks',
        partitions: [{ kind: 'subagent_task', directory: 'tasks', extension: '.json' }],
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
    value.name.length < 1 ||
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
