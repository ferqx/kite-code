import { join } from 'node:path';
import type {
  CapabilityArtifactRef,
  CapabilityResult,
  PrivateCapabilityArtifactRefV1,
  WorkspaceFilesystemObservationRecordV1,
} from '@kite/runtime-contract';
import { digestCapabilityBindingValueV1 as digestCapability } from './capability-binding';
import {
  allPrivateArtifactEvidenceRootsV1,
  canonicalModelJsonV1,
  loadOrCreateModelArtifactIntegrityKeyV1,
  modelArtifactRoot,
  PrivateArtifactStorageError,
  type PrivateArtifactWriteFaultPointV1,
  PrivateImmutableArtifactStorageV1,
} from './model';
import { userKiteCodeDirV1 } from './model/artifact-paths';

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

/** Installation-private root for canonical capability result evidence. */
export function capabilityArtifactRootV1(): string {
  return join(userKiteCodeDirV1(), 'capability-artifacts');
}

export interface CapabilityArtifactStoreOptionsV1 {
  integrityKey?: Uint8Array;
  root?: string;
  maxArtifactBytes?: number;
  platform?: NodeJS.Platform;
  secureWindowsPath?: (path: string) => void;
  faultInjector?: (point: PrivateArtifactWriteFaultPointV1) => void;
}

export interface CapabilityArtifactEnvelopeV1 {
  readonly artifactFormatVersion: 2;
  readonly invocationId: string;
  readonly result: CapabilityResult;
}

export type CapabilityArtifactWriterV1 = Pick<CapabilityArtifactStore, 'write'>;
export type CapabilityArtifactReaderV1 = Pick<CapabilityArtifactStore, 'read' | 'readEnvelope'>;
export type CapabilityArtifactAccessV1 = CapabilityArtifactWriterV1 & CapabilityArtifactReaderV1;

export interface CapabilityArtifactBindingV1 {
  readonly invocationId: string;
  readonly resultDigest: string;
  readonly evidenceDigest: string;
  readonly filesystemObservation?: import('@kite/runtime-contract').WorkspaceFilesystemObservationRecordV1;
}

export interface CapabilityArtifactEvidenceInvocationV1 {
  readonly invocationId: string;
  readonly status: 'recorded' | 'running' | 'succeeded' | 'failed' | 'unknown';
  readonly artifact?: CapabilityArtifactRef;
  readonly resultDigest?: string;
  readonly evidenceDigest?: string;
  readonly filesystemObservation?: WorkspaceFilesystemObservationRecordV1;
}

/** Minimal State26 projection consumed by the Builtin Artifact owner. */
export interface CapabilityArtifactEvidenceStateV1 {
  readonly capabilities: {
    readonly invocations: Readonly<Record<string, CapabilityArtifactEvidenceInvocationV1>>;
  };
}

export function capabilityResultDigestV1(result: Readonly<CapabilityResult>): string {
  return digestCapability(result);
}

export function capabilityResultEvidenceDigestV1(result: Readonly<CapabilityResult>): string {
  return digestCapability({
    content: result.content,
    structuredContent: result.structuredContent ?? null,
  });
}

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
    return this.readEnvelope(ref).result;
  }

  readEnvelope(ref: CapabilityArtifactRef): CapabilityArtifactEnvelopeV1 {
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

  private resolveStorage(): PrivateImmutableArtifactStorageV1<'capability_result'> {
    if (this.storage) return this.storage;
    let integrityKey: Uint8Array;
    try {
      integrityKey =
        this.options.integrityKey ??
        loadOrCreateModelArtifactIntegrityKeyV1({
          artifactRoot: modelArtifactRoot(),
          additionalArtifactRoots: allPrivateArtifactEvidenceRootsV1(),
        });
    } catch {
      throw new CapabilityArtifactError(
        'Capability Artifact integrity key is unavailable.',
        'key_unavailable',
      );
    }
    try {
      this.storage = new PrivateImmutableArtifactStorageV1({
        root: this.options.root ?? capabilityArtifactRootV1(),
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

/** Read immutable capability evidence only when it is exactly bound to its Runtime receipt. */
export function readBoundCapabilityArtifactV1(
  reader: CapabilityArtifactReaderV1,
  ref: CapabilityArtifactRef,
  binding: CapabilityArtifactBindingV1,
): CapabilityResult {
  const envelope = reader.readEnvelope(ref);
  const result = envelope.result;
  if (
    envelope.invocationId !== binding.invocationId ||
    capabilityResultDigestV1(result) !== binding.resultDigest ||
    capabilityResultEvidenceDigestV1(result) !== binding.evidenceDigest
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
export function assertRestoredCapabilityArtifactEvidenceV1(
  state: CapabilityArtifactEvidenceStateV1,
  reader: CapabilityArtifactReaderV1,
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
    readBoundCapabilityArtifactV1(reader, invocation.artifact, {
      invocationId: invocation.invocationId,
      resultDigest: invocation.resultDigest,
      evidenceDigest: invocation.evidenceDigest,
      filesystemObservation: invocation.filesystemObservation,
    });
  }
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
