import type { SubagentTaskArtifactV1, SubagentTaskRequestArtifactV1 } from '@kite/runtime-spi';
import {
  canonicalModelJsonV1,
  PrivateArtifactStorageError,
  type PrivateArtifactWriteFaultPointV1,
  PrivateImmutableArtifactStorageV1,
} from '../model';
import { subagentTaskArtifactRootV1 } from './artifact-paths';
import { subagentTaskDigestV1 } from './continuation-codec';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;

export interface SubagentTaskArtifactOwnerV1 {
  readonly parentInvocationId: string;
  readonly parentAttempt: number;
  readonly parentToolCallId: string;
  readonly childInvocationId: string;
}

export interface SubagentTaskArtifactPayloadV1 {
  readonly artifactFormatVersion: 1;
  readonly owner: SubagentTaskArtifactOwnerV1;
  readonly task: string;
  readonly taskDigest: string;
  readonly taskByteLength: number;
}

export interface SubagentTaskArtifactStoreOptionsV1 {
  readonly root?: string;
  readonly maxArtifactBytes?: number;
  readonly platform?: NodeJS.Platform;
  readonly secureWindowsPath?: (path: string) => void;
  readonly faultInjector?: (point: PrivateArtifactWriteFaultPointV1) => void;
}

export interface SubagentTaskArtifactAccessV1 {
  write(input: { readonly owner: SubagentTaskArtifactOwnerV1; readonly task: string }): {
    readonly ref: SubagentTaskArtifactV1;
    readonly taskDigest: string;
  };
  read(
    ref: SubagentTaskArtifactV1,
    expected: Readonly<SubagentTaskArtifactOwnerV1> & { readonly taskDigest: string },
  ): Readonly<SubagentTaskArtifactPayloadV1>;
}

export interface SubagentTaskRequestArtifactAccessV1 {
  write(input: {
    parentModelInvocationId: string;
    parentToolCallId: string;
    role: 'explore' | 'plan' | 'code' | 'review';
    task: string;
  }): SubagentTaskRequestArtifactV1;
  read(
    ref: SubagentTaskRequestArtifactV1,
    expected: { parentModelInvocationId: string; parentToolCallId: string },
  ): Readonly<{ role: 'explore' | 'plan' | 'code' | 'review'; task: string }>;
}

/** Queue-time private request storage; Runtime tool facts retain only its opaque ref. */
export class SubagentTaskRequestArtifactStoreV1 implements SubagentTaskRequestArtifactAccessV1 {
  readonly #storage: PrivateImmutableArtifactStorageV1<'subagent_task_request'>;

  constructor(options: { root?: string } = {}) {
    try {
      this.#storage = new PrivateImmutableArtifactStorageV1({
        root: options.root ?? subagentTaskArtifactRootV1(),
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
    role: 'explore' | 'plan' | 'code' | 'review';
    task: string;
  }): SubagentTaskRequestArtifactV1 {
    try {
      const payload = validateRequestPayload({
        artifactFormatVersion: 1,
        parentModelInvocationId: input.parentModelInvocationId,
        parentToolCallId: input.parentToolCallId,
        role: input.role,
        task: input.task,
        taskDigest: subagentTaskDigestV1(input.task),
      });
      return this.#storage.write(
        'subagent_task_request',
        Buffer.from(canonicalModelJsonV1(payload), 'utf8'),
      );
    } catch (error) {
      throw mapStorageError(error, 'invalid_task');
    }
  }

  read(
    ref: SubagentTaskRequestArtifactV1,
    expected: { parentModelInvocationId: string; parentToolCallId: string },
  ): Readonly<{ role: 'explore' | 'plan' | 'code' | 'review'; task: string }> {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#storage.read(ref));
      const parsed: unknown = JSON.parse(text);
      if (canonicalModelJsonV1(parsed) !== text) corrupt();
      const payload = validateRequestPayload(parsed);
      if (
        payload.parentModelInvocationId !== expected.parentModelInvocationId ||
        payload.parentToolCallId !== expected.parentToolCallId
      ) {
        corrupt();
      }
      return Object.freeze({ role: payload.role, task: payload.task });
    } catch (error) {
      if (error instanceof SubagentTaskArtifactErrorV1) {
        if (error.code === 'invalid_task') corrupt();
        throw error;
      }
      throw mapStorageError(error, 'artifact_corrupt');
    }
  }
}

export class SubagentTaskArtifactErrorV1 extends Error {
  readonly code:
    | 'invalid_task'
    | 'artifact_missing'
    | 'artifact_corrupt'
    | 'artifact_too_large'
    | 'storage_boundary_violation'
    | 'publish_failed';

  constructor(code: SubagentTaskArtifactErrorV1['code'], message: string) {
    super(message);
    this.name = 'SubagentTaskArtifactErrorV1';
    this.code = code;
  }
}

/** Independent private namespace for delegated task bodies. */
export class SubagentTaskArtifactStoreV1 implements SubagentTaskArtifactAccessV1 {
  readonly #options: SubagentTaskArtifactStoreOptionsV1;
  #storage: PrivateImmutableArtifactStorageV1<'subagent_task'> | undefined;

  constructor(options: SubagentTaskArtifactStoreOptionsV1 = {}) {
    this.#options = Object.freeze({ ...options });
  }

  write(input: { readonly owner: SubagentTaskArtifactOwnerV1; readonly task: string }): {
    readonly ref: SubagentTaskArtifactV1;
    readonly taskDigest: string;
  } {
    try {
      const taskDigest = subagentTaskDigestV1(input.task);
      const payload = validatePayload({
        artifactFormatVersion: 1,
        owner: input.owner,
        task: input.task,
        taskDigest,
        taskByteLength: Buffer.byteLength(input.task, 'utf8'),
      });
      const ref = this.#resolveStorage().write(
        'subagent_task',
        Buffer.from(canonicalModelJsonV1(payload), 'utf8'),
      );
      return { ref, taskDigest };
    } catch (error) {
      throw mapStorageError(error, 'invalid_task');
    }
  }

  read(
    ref: SubagentTaskArtifactV1,
    expected: Readonly<SubagentTaskArtifactOwnerV1> & { readonly taskDigest: string },
  ): Readonly<SubagentTaskArtifactPayloadV1> {
    try {
      const bytes = this.#resolveStorage().read(ref);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      if (canonicalModelJsonV1(parsed) !== text) corrupt();
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
      if (error instanceof SubagentTaskArtifactErrorV1) {
        if (error.code === 'invalid_task') corrupt();
        throw error;
      }
      throw mapStorageError(error, 'artifact_corrupt');
    }
  }

  #resolveStorage(): PrivateImmutableArtifactStorageV1<'subagent_task'> {
    if (this.#storage) return this.#storage;
    try {
      this.#storage = new PrivateImmutableArtifactStorageV1({
        root: this.#options.root ?? subagentTaskArtifactRootV1(),
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

export { subagentTaskDigestV1 };

function validatePayload(value: unknown): Readonly<SubagentTaskArtifactPayloadV1> {
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
  if (value.taskByteLength !== byteLength || value.taskDigest !== subagentTaskDigestV1(value.task))
    invalid();
  return deepFreeze(structuredClone(value)) as Readonly<SubagentTaskArtifactPayloadV1>;
}

function validateRequestPayload(value: unknown): Readonly<{
  artifactFormatVersion: 1;
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
      'parentModelInvocationId',
      'parentToolCallId',
      'role',
      'task',
      'taskDigest',
    ]) ||
    value.artifactFormatVersion !== 1 ||
    typeof value.parentModelInvocationId !== 'string' ||
    !SAFE_ID.test(value.parentModelInvocationId) ||
    typeof value.parentToolCallId !== 'string' ||
    !SAFE_ID.test(value.parentToolCallId) ||
    !['explore', 'plan', 'code', 'review'].includes(String(value.role)) ||
    typeof value.task !== 'string' ||
    typeof value.taskDigest !== 'string' ||
    value.taskDigest !== subagentTaskDigestV1(value.task)
  ) {
    invalid();
  }
  return deepFreeze(structuredClone(value)) as Readonly<{
    artifactFormatVersion: 1;
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
  throw new SubagentTaskArtifactErrorV1(
    'invalid_task',
    'Subagent task Artifact payload is invalid.',
  );
}

function corrupt(): never {
  throw new SubagentTaskArtifactErrorV1(
    'artifact_corrupt',
    'Subagent task Artifact is corrupt or cross-bound.',
  );
}

function mapStorageError(
  error: unknown,
  fallback: SubagentTaskArtifactErrorV1['code'],
): SubagentTaskArtifactErrorV1 {
  if (error instanceof SubagentTaskArtifactErrorV1) return error;
  if (error instanceof PrivateArtifactStorageError) {
    const code = error.code === 'invalid_reference' ? 'artifact_corrupt' : error.code;
    return new SubagentTaskArtifactErrorV1(
      code as SubagentTaskArtifactErrorV1['code'],
      'Subagent task Artifact operation failed.',
    );
  }
  return new SubagentTaskArtifactErrorV1(fallback, 'Subagent task Artifact operation failed.');
}
