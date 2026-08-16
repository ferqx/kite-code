import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { digestCapability } from '@/core/capabilities/catalog';
import { capabilityArtifactRoot, userKiteCodeDir } from '@/core/config/paths';
import { loadOrCreateModelArtifactIntegrityKeyV1 } from '@/core/model/model-artifact-key';
import { modelArtifactRoot } from '@/core/model/model-artifact-paths';
import { canonicalModelJsonV1 } from '@/core/model/surface-canonicalizer';
import {
  PrivateArtifactStorageError,
  type PrivateArtifactWriteFaultPointV1,
  PrivateImmutableArtifactStorageV1,
} from '@/core/persistence/private-immutable-artifacts';
import type {
  CapabilityArtifactRef,
  CapabilityResult,
  LegacyCapabilityArtifactRefV1,
  PrivateCapabilityArtifactRefV1,
} from '@/protocol/capabilities';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const SAFE_INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CAPABILITY_ARTIFACT_PARTITIONS = Object.freeze([
  { kind: 'capability_result', directory: 'results', extension: '.json' },
] as const);

export type CapabilityArtifactErrorCodeV1 =
  | 'invalid_reference'
  | 'key_unavailable'
  | 'artifact_missing'
  | 'artifact_corrupt'
  | 'artifact_too_large'
  | 'storage_boundary_violation'
  | 'publish_failed';

export class CapabilityArtifactError extends Error {
  readonly code: CapabilityArtifactErrorCodeV1;

  constructor(message: string, code: CapabilityArtifactErrorCodeV1) {
    super(message);
    this.name = 'CapabilityArtifactError';
    this.code = code;
  }
}

export interface CapabilityArtifactStoreOptionsV1 {
  integrityKey?: Uint8Array;
  root?: string;
  maxArtifactBytes?: number;
  platform?: NodeJS.Platform;
  secureWindowsPath?: (path: string) => void;
  faultInjector?: (point: PrivateArtifactWriteFaultPointV1) => void;
}

export type CapabilityArtifactWriterV1 = Pick<CapabilityArtifactStore, 'write'>;

/**
 * Schema-aware private store for canonical capability receipts.
 *
 * The public reference is keyed and opaque. It never exposes a filesystem path
 * or an unkeyed content digest. The optional numeric constructor is retained as
 * a source-compatible byte-limit shorthand for existing callers.
 */
export class CapabilityArtifactStore {
  private readonly options: CapabilityArtifactStoreOptionsV1;
  private storage: PrivateImmutableArtifactStorageV1<'capability_result'> | undefined;

  constructor(options: CapabilityArtifactStoreOptionsV1 | number = {}) {
    this.options =
      typeof options === 'number' ? { maxArtifactBytes: options } : Object.freeze({ ...options });
  }

  write(invocationId: string, result: CapabilityResult): PrivateCapabilityArtifactRefV1 {
    assertInvocationId(invocationId);
    assertCapabilityResult(result);
    const payload = Buffer.from(
      canonicalModelJsonV1({ artifactFormatVersion: 2, invocationId, result }),
      'utf8',
    );
    try {
      return this.resolveStorage().write('capability_result', payload);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  read(ref: CapabilityArtifactRef): CapabilityResult {
    if (isLegacyReference(ref)) return readLegacyArtifact(ref);
    try {
      const bytes = this.resolveStorage().read(ref);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      if (canonicalModelJsonV1(parsed) !== text || !isPlainObject(parsed)) {
        throw new CapabilityArtifactError(
          'Capability Artifact is not canonical JSON.',
          'artifact_corrupt',
        );
      }
      assertExactKeys(parsed, ['artifactFormatVersion', 'invocationId', 'result']);
      if (parsed.artifactFormatVersion !== 2) {
        throw new CapabilityArtifactError(
          'Capability Artifact format is unsupported.',
          'artifact_corrupt',
        );
      }
      assertInvocationId(parsed.invocationId);
      assertCapabilityResult(parsed.result);
      return parsed.result;
    } catch (error) {
      if (error instanceof CapabilityArtifactError) throw error;
      throw mapStorageError(error);
    }
  }

  private resolveStorage(): PrivateImmutableArtifactStorageV1<'capability_result'> {
    if (this.storage) return this.storage;
    let integrityKey: Uint8Array;
    try {
      integrityKey =
        this.options.integrityKey ??
        loadOrCreateModelArtifactIntegrityKeyV1({
          artifactRoot: modelArtifactRoot(),
          additionalArtifactRoots: [capabilityArtifactRoot()],
        });
    } catch {
      throw new CapabilityArtifactError(
        'Capability Artifact integrity key is unavailable.',
        'key_unavailable',
      );
    }
    try {
      this.storage = new PrivateImmutableArtifactStorageV1({
        root: this.options.root ?? capabilityArtifactRoot(),
        namespace: 'capability-artifacts',
        integrityKey,
        partitions: CAPABILITY_ARTIFACT_PARTITIONS,
        maxArtifactBytes: this.options.maxArtifactBytes ?? DEFAULT_MAX_BYTES,
        ...(this.options.platform ? { platform: this.options.platform } : {}),
        ...(this.options.secureWindowsPath
          ? { secureWindowsPath: this.options.secureWindowsPath }
          : {}),
        ...(this.options.faultInjector ? { faultInjector: this.options.faultInjector } : {}),
      });
      return this.storage;
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}

function isLegacyReference(ref: CapabilityArtifactRef): ref is LegacyCapabilityArtifactRefV1 {
  return 'relativePath' in ref || 'digest' in ref;
}

/** Same-epoch compatibility reader. New dispatch and writes never use this namespace. */
function readLegacyArtifact(ref: LegacyCapabilityArtifactRefV1): CapabilityResult {
  const legacyId = /^[a-f0-9]{64}$/;
  if (!legacyId.test(ref.artifactId)) {
    throw new CapabilityArtifactError(
      'Invalid legacy capability Artifact ID.',
      'invalid_reference',
    );
  }
  const expectedRelative = `capability-results/${ref.artifactId}.json`;
  if (ref.relativePath !== expectedRelative) {
    throw new CapabilityArtifactError(
      'Legacy capability Artifact path does not match its identity.',
      'invalid_reference',
    );
  }
  const root = resolve(join(userKiteCodeDir(), 'capability-results'));
  const target = resolve(join(root, `${ref.artifactId}.json`));
  const inside = relative(root, target);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new CapabilityArtifactError(
      'Legacy capability Artifact escapes its root.',
      'invalid_reference',
    );
  }
  let descriptor: number | undefined;
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new CapabilityArtifactError(
        'Legacy capability Artifact root is not a real directory.',
        'storage_boundary_violation',
      );
    }
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new CapabilityArtifactError(
        'Legacy capability Artifact is not a regular file.',
        'storage_boundary_violation',
      );
    }
    descriptor = openSync(
      target,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== ref.byteLength) {
      throw new CapabilityArtifactError(
        'Legacy capability Artifact changed while opening.',
        'artifact_corrupt',
      );
    }
    const payload = readFileSync(descriptor, 'utf8');
    if (digestCapability(payload) !== ref.digest) {
      throw new CapabilityArtifactError(
        'Legacy capability Artifact digest mismatch.',
        'artifact_corrupt',
      );
    }
    const parsed: unknown = JSON.parse(payload);
    if (!isPlainObject(parsed) || parsed.artifactFormatVersion !== 1) {
      throw new CapabilityArtifactError(
        'Legacy capability Artifact is invalid.',
        'artifact_corrupt',
      );
    }
    assertExactKeys(parsed, ['artifactFormatVersion', 'invocationId', 'result']);
    if (parsed.invocationId !== ref.artifactId) {
      throw new CapabilityArtifactError(
        'Legacy capability Artifact identity mismatch.',
        'artifact_corrupt',
      );
    }
    assertCapabilityResult(parsed.result);
    return parsed.result;
  } catch (error) {
    if (error instanceof CapabilityArtifactError) throw error;
    if (isFileSystemError(error, 'ENOENT')) {
      throw new CapabilityArtifactError(
        'Legacy capability Artifact is missing.',
        'artifact_missing',
      );
    }
    throw new CapabilityArtifactError('Legacy capability Artifact is corrupt.', 'artifact_corrupt');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function assertCapabilityResult(value: unknown): asserts value is CapabilityResult {
  canonicalModelJsonV1(value);
  if (!isPlainObject(value)) corrupt('Capability result must be an object.');
  const allowed = ['status', 'content', 'structuredContent', 'error', 'providerMeta'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    corrupt('Capability result contains unsupported fields.');
  }
  if (!['success', 'partial', 'error', 'cancelled', 'unknown'].includes(String(value.status))) {
    corrupt('Capability result status is invalid.');
  }
  if (!Array.isArray(value.content) || value.content.some((item) => !isPlainObject(item))) {
    corrupt('Capability result content is invalid.');
  }
  if (value.error !== undefined) {
    if (!isPlainObject(value.error)) corrupt('Capability result failure is invalid.');
    assertExactKeys(value.error, [
      'kind',
      'message',
      'retryable',
      'modelFixable',
      'needsUserIntervention',
      'terminatesTurn',
      'journal',
      ...(value.error.parseFailureCode === undefined ? [] : ['parseFailureCode']),
    ]);
    if (
      typeof value.error.kind !== 'string' ||
      typeof value.error.message !== 'string' ||
      typeof value.error.retryable !== 'boolean' ||
      typeof value.error.modelFixable !== 'boolean' ||
      typeof value.error.needsUserIntervention !== 'boolean' ||
      typeof value.error.terminatesTurn !== 'boolean' ||
      typeof value.error.journal !== 'boolean' ||
      (value.error.parseFailureCode !== undefined &&
        typeof value.error.parseFailureCode !== 'string')
    ) {
      corrupt('Capability result failure fields are invalid.');
    }
  }
  if (value.providerMeta !== undefined && !isPlainObject(value.providerMeta)) {
    corrupt('Capability result provider metadata is invalid.');
  }
}

function assertInvocationId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SAFE_INVOCATION_ID.test(value)) {
    throw new CapabilityArtifactError('Invalid capability invocation ID.', 'invalid_reference');
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    corrupt('Capability Artifact contains unsupported fields.');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function corrupt(message: string): never {
  throw new CapabilityArtifactError(message, 'artifact_corrupt');
}

function mapStorageError(error: unknown): CapabilityArtifactError {
  if (error instanceof CapabilityArtifactError) return error;
  if (error instanceof PrivateArtifactStorageError) {
    const code: CapabilityArtifactErrorCodeV1 =
      error.code === 'artifact_corrupt' || error.code === 'artifact_missing'
        ? error.code
        : error.code === 'artifact_too_large'
          ? 'artifact_too_large'
          : error.code === 'key_unavailable'
            ? 'key_unavailable'
            : error.code === 'invalid_reference'
              ? 'invalid_reference'
              : error.code === 'publish_failed'
                ? 'publish_failed'
                : 'storage_boundary_violation';
    return new CapabilityArtifactError(error.message, code);
  }
  return new CapabilityArtifactError('Capability Artifact is corrupt.', 'artifact_corrupt');
}

export const defaultCapabilityArtifactStore = new CapabilityArtifactStore();
