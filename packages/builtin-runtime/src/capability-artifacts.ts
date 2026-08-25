import { join } from 'node:path';
import type {
  CapabilityArtifactRef,
  CapabilityResult,
  PrivateCapabilityArtifactRef,
  WorkspaceFilesystemObservationRecord,
} from '@kite-ai/runtime-contract';
import { digestCapabilityBindingValue as digestCapability } from './capability-binding';
import {
  canonicalModelJson,
  PrivateArtifactStorageError,
  type PrivateArtifactWriteFaultPoint,
  PrivateImmutableArtifactStorage,
} from './model';
import { userKiteCodeDir } from './model/artifact-paths';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const SAFE_INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CAPABILITY_ARTIFACT_PARTITIONS = Object.freeze([
  { kind: 'capability_result', directory: 'results', extension: '.json' },
] as const);

export type CapabilityArtifactErrorCode =
  | 'invalid_reference'
  | 'artifact_missing'
  | 'artifact_corrupt'
  | 'artifact_too_large'
  | 'storage_boundary_violation'
  | 'publish_failed';

export class CapabilityArtifactError extends Error {
  readonly code: CapabilityArtifactErrorCode;

  constructor(message: string, code: CapabilityArtifactErrorCode) {
    super(message);
    this.name = 'CapabilityArtifactError';
    this.code = code;
  }
}

/** Installation-private root for canonical capability result evidence. */
export function capabilityArtifactRoot(): string {
  return join(userKiteCodeDir(), 'capability-artifacts');
}

export interface CapabilityArtifactStoreOptions {
  root?: string;
  maxArtifactBytes?: number;
  platform?: NodeJS.Platform;
  secureWindowsPath?: (path: string) => void;
  faultInjector?: (point: PrivateArtifactWriteFaultPoint) => void;
}

export interface CapabilityArtifactEnvelope {
  readonly artifactFormatVersion: 2;
  readonly invocationId: string;
  readonly result: CapabilityResult;
}

export type CapabilityArtifactWriter = Pick<CapabilityArtifactStore, 'write'>;
export type CapabilityArtifactReader = Pick<CapabilityArtifactStore, 'read' | 'readEnvelope'>;
export type CapabilityArtifactAccess = CapabilityArtifactWriter & CapabilityArtifactReader;

export interface CapabilityArtifactBinding {
  readonly invocationId: string;
  readonly resultDigest: string;
  readonly evidenceDigest: string;
  readonly filesystemObservation?: import('@kite-ai/runtime-contract').WorkspaceFilesystemObservationRecord;
}

export interface CapabilityArtifactEvidenceInvocation {
  readonly invocationId: string;
  readonly status: 'recorded' | 'running' | 'succeeded' | 'failed' | 'unknown';
  readonly artifact?: CapabilityArtifactRef;
  readonly resultDigest?: string;
  readonly evidenceDigest?: string;
  readonly filesystemObservation?: WorkspaceFilesystemObservationRecord;
}

/** Minimal State projection consumed by the Builtin Artifact owner. */
export interface CapabilityArtifactEvidenceState {
  readonly capabilities: {
    readonly invocations: Readonly<Record<string, CapabilityArtifactEvidenceInvocation>>;
  };
}

export function capabilityResultDigest(result: Readonly<CapabilityResult>): string {
  return digestCapability(result);
}

export function capabilityResultEvidenceDigest(result: Readonly<CapabilityResult>): string {
  return digestCapability({
    content: result.content,
    structuredContent: result.structuredContent ?? null,
  });
}

/**
 * Schema-aware private store for canonical capability receipts.
 *
 * The public reference is content-addressed and path-free. The optional numeric
 * constructor is retained as a source-compatible byte-limit shorthand for
 * existing callers.
 */
export class CapabilityArtifactStore {
  private readonly options: CapabilityArtifactStoreOptions;
  private storage: PrivateImmutableArtifactStorage<'capability_result'> | undefined;

  constructor(options: CapabilityArtifactStoreOptions | number = {}) {
    this.options =
      typeof options === 'number' ? { maxArtifactBytes: options } : Object.freeze({ ...options });
  }

  write(invocationId: string, result: CapabilityResult): PrivateCapabilityArtifactRef {
    assertInvocationId(invocationId);
    assertCapabilityResult(result);
    const payload = Buffer.from(
      canonicalModelJson({ artifactFormatVersion: 2, invocationId, result }),
      'utf8',
    );
    try {
      return this.resolveStorage().write('capability_result', payload);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  read(ref: CapabilityArtifactRef): CapabilityResult {
    return this.readEnvelope(ref).result;
  }

  readEnvelope(ref: CapabilityArtifactRef): CapabilityArtifactEnvelope {
    try {
      const bytes = this.resolveStorage().read(ref);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      if (canonicalModelJson(parsed) !== text || !isPlainObject(parsed)) {
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
      return Object.freeze({
        artifactFormatVersion: 2,
        invocationId: parsed.invocationId,
        result: parsed.result,
      });
    } catch (error) {
      if (error instanceof CapabilityArtifactError) throw error;
      throw mapStorageError(error);
    }
  }

  private resolveStorage(): PrivateImmutableArtifactStorage<'capability_result'> {
    if (this.storage) return this.storage;
    try {
      this.storage = new PrivateImmutableArtifactStorage({
        root: this.options.root ?? capabilityArtifactRoot(),
        namespace: 'capability-artifacts',
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

/** Read immutable capability evidence only when it is exactly bound to its Runtime receipt. */
export function readBoundCapabilityArtifact(
  reader: CapabilityArtifactReader,
  ref: CapabilityArtifactRef,
  binding: CapabilityArtifactBinding,
): CapabilityResult {
  const envelope = reader.readEnvelope(ref);
  const result = envelope.result;
  if (
    envelope.invocationId !== binding.invocationId ||
    capabilityResultDigest(result) !== binding.resultDigest ||
    capabilityResultEvidenceDigest(result) !== binding.evidenceDigest
  ) {
    throw new CapabilityArtifactError(
      'Capability Artifact does not match its Runtime receipt.',
      'artifact_corrupt',
    );
  }
  const structured = result.structuredContent;
  const artifactObservation =
    isPlainObject(structured) && Object.hasOwn(structured, 'filesystemObservation')
      ? structured.filesystemObservation
      : undefined;
  if (
    (binding.filesystemObservation === undefined) !== (artifactObservation === undefined) ||
    (binding.filesystemObservation !== undefined &&
      digestCapability(binding.filesystemObservation) !== digestCapability(artifactObservation))
  ) {
    throw new CapabilityArtifactError(
      'Capability Artifact filesystem observation does not match its Runtime receipt.',
      'artifact_corrupt',
    );
  }
  return result;
}

/** Validate every persisted filesystem receipt against Builtin-owned Artifact evidence. */
export function assertRestoredCapabilityArtifactEvidence(
  state: CapabilityArtifactEvidenceState,
  reader: CapabilityArtifactReader,
): void {
  for (const invocation of Object.values(state.capabilities.invocations)) {
    if (!invocation.filesystemObservation) continue;
    if (
      invocation.status !== 'succeeded' ||
      !invocation.artifact ||
      !invocation.resultDigest ||
      !invocation.evidenceDigest
    ) {
      throw new Error(
        `Filesystem invocation ${invocation.invocationId} has incomplete Artifact evidence.`,
      );
    }
    readBoundCapabilityArtifact(reader, invocation.artifact, {
      invocationId: invocation.invocationId,
      resultDigest: invocation.resultDigest,
      evidenceDigest: invocation.evidenceDigest,
      filesystemObservation: invocation.filesystemObservation,
    });
  }
}

function assertCapabilityResult(value: unknown): asserts value is CapabilityResult {
  canonicalModelJson(value);
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
    const code: CapabilityArtifactErrorCode =
      error.code === 'artifact_corrupt' || error.code === 'artifact_missing'
        ? error.code
        : error.code === 'artifact_too_large'
          ? 'artifact_too_large'
          : error.code === 'invalid_reference'
            ? 'invalid_reference'
            : error.code === 'publish_failed'
              ? 'publish_failed'
              : 'storage_boundary_violation';
    return new CapabilityArtifactError(error.message, code);
  }
  return new CapabilityArtifactError('Capability Artifact is corrupt.', 'artifact_corrupt');
}
