import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  FilesystemPreimageArtifactRefV1,
  WorkspaceFilesystemPreimageObservationV1,
} from '@kite/runtime-spi';
import {
  allPrivateArtifactEvidenceRootsV1,
  canonicalModelJsonV1,
  loadOrCreateModelArtifactIntegrityKeyV1,
  PrivateArtifactStorageError,
  type PrivateArtifactWriteFaultPointV1,
  PrivateImmutableArtifactStorageV1,
} from '../model';
import { userKiteCodeDirV1 } from '../model/artifact-paths';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const SAFE_INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PARTITIONS = Object.freeze([
  { kind: 'filesystem_preimage', directory: 'preimages', extension: '.json' },
] as const);

export type FilesystemPreimageArtifactErrorCodeV1 =
  | 'invalid_preimage'
  | 'key_unavailable'
  | 'artifact_missing'
  | 'artifact_corrupt'
  | 'artifact_too_large'
  | 'storage_boundary_violation'
  | 'publish_failed';

export class FilesystemPreimageArtifactErrorV1 extends Error {
  readonly code: FilesystemPreimageArtifactErrorCodeV1;

  constructor(code: FilesystemPreimageArtifactErrorCodeV1, message: string) {
    super(message);
    this.name = 'FilesystemPreimageArtifactErrorV1';
    this.code = code;
  }
}

/** Installation-private root for filesystem mutation preimage evidence. */
export function filesystemPreimageArtifactRootV1(): string {
  return join(userKiteCodeDirV1(), 'filesystem-preimages');
}

export interface FilesystemPreimageArtifactPayloadV1 {
  readonly artifactFormatVersion: 1;
  readonly invocationId: string;
  readonly operationDigest: string;
  readonly targetIdentityDigest: string;
  readonly preimage: WorkspaceFilesystemPreimageObservationV1;
}

export interface FilesystemPreimageArtifactWriterV1 {
  write(input: {
    readonly invocationId: string;
    readonly operationDigest: string;
    readonly targetIdentityDigest: string;
    readonly preimage: WorkspaceFilesystemPreimageObservationV1;
  }): FilesystemPreimageArtifactRefV1;
}

export interface FilesystemPreimageArtifactStoreOptionsV1 {
  readonly integrityKey?: Uint8Array;
  readonly root?: string;
  readonly maxArtifactBytes?: number;
  readonly platform?: NodeJS.Platform;
  readonly secureWindowsPath?: (path: string) => void;
  readonly faultInjector?: (point: PrivateArtifactWriteFaultPointV1) => void;
}

/** Private immutable evidence required before a filesystem commit grant exists. */
export class FilesystemPreimageArtifactStoreV1 implements FilesystemPreimageArtifactWriterV1 {
  readonly #options: FilesystemPreimageArtifactStoreOptionsV1;
  #storage: PrivateImmutableArtifactStorageV1<'filesystem_preimage'> | undefined;

  constructor(options: FilesystemPreimageArtifactStoreOptionsV1 = {}) {
    this.#options = Object.freeze({ ...options });
  }

  write(input: {
    readonly invocationId: string;
    readonly operationDigest: string;
    readonly targetIdentityDigest: string;
    readonly preimage: WorkspaceFilesystemPreimageObservationV1;
  }): FilesystemPreimageArtifactRefV1 {
    const payload = validatedPayload({ artifactFormatVersion: 1, ...input });
    try {
      return this.#resolveStorage().write(
        'filesystem_preimage',
        Buffer.from(canonicalModelJsonV1(payload), 'utf8'),
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  read(ref: FilesystemPreimageArtifactRefV1): FilesystemPreimageArtifactPayloadV1 {
    try {
      const bytes = this.#resolveStorage().read(ref);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed) || canonicalModelJsonV1(parsed) !== text) {
        throw new FilesystemPreimageArtifactErrorV1(
          'artifact_corrupt',
          'Filesystem preimage Artifact is not canonical JSON.',
        );
      }
      return validatedPayload(parsed);
    } catch (error) {
      if (error instanceof FilesystemPreimageArtifactErrorV1) throw error;
      throw mapStorageError(error);
    }
  }

  #resolveStorage(): PrivateImmutableArtifactStorageV1<'filesystem_preimage'> {
    if (this.#storage) return this.#storage;
    let integrityKey: Uint8Array;
    try {
      integrityKey =
        this.#options.integrityKey ??
        loadOrCreateModelArtifactIntegrityKeyV1({
          additionalArtifactRoots: allPrivateArtifactEvidenceRootsV1(),
        });
    } catch {
      throw new FilesystemPreimageArtifactErrorV1(
        'key_unavailable',
        'Filesystem preimage Artifact integrity key is unavailable.',
      );
    }
    try {
      this.#storage = new PrivateImmutableArtifactStorageV1({
        root: this.#options.root ?? filesystemPreimageArtifactRootV1(),
        namespace: 'filesystem-preimages',
        integrityKey,
        partitions: PARTITIONS,
        maxArtifactBytes: this.#options.maxArtifactBytes ?? DEFAULT_MAX_BYTES,
        ...(this.#options.platform ? { platform: this.#options.platform } : {}),
        ...(this.#options.secureWindowsPath
          ? { secureWindowsPath: this.#options.secureWindowsPath }
          : {}),
        ...(this.#options.faultInjector ? { faultInjector: this.#options.faultInjector } : {}),
      });
      return this.#storage;
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}

function validatedPayload(input: unknown): FilesystemPreimageArtifactPayloadV1 {
  if (!isPlainObject(input)) invalid();
  const source = input as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const expected = [
    'artifactFormatVersion',
    'invocationId',
    'operationDigest',
    'preimage',
    'targetIdentityDigest',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    invalid();
  }
  const artifactFormatVersion = source.artifactFormatVersion ?? 1;
  if (artifactFormatVersion !== 1) invalid();
  if (typeof source.invocationId !== 'string' || !SAFE_INVOCATION_ID.test(source.invocationId)) {
    invalid();
  }
  if (
    typeof source.operationDigest !== 'string' ||
    !SHA256_DIGEST.test(source.operationDigest) ||
    typeof source.targetIdentityDigest !== 'string' ||
    !SHA256_DIGEST.test(source.targetIdentityDigest)
  ) {
    invalid();
  }
  const preimage = validatePreimage(source.preimage);
  return Object.freeze({
    artifactFormatVersion: 1,
    invocationId: source.invocationId,
    operationDigest: source.operationDigest,
    targetIdentityDigest: source.targetIdentityDigest,
    preimage,
  });
}

function validatePreimage(value: unknown): WorkspaceFilesystemPreimageObservationV1 {
  if (!isPlainObject(value)) invalid();
  const keys = Object.keys(value).sort();
  const expected = ['byteLength', 'content', 'contentDigest', 'existed'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    invalid();
  }
  if (typeof value.existed !== 'boolean') invalid();
  if (!Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0) invalid();
  if (value.existed) {
    if (typeof value.content !== 'string' || typeof value.contentDigest !== 'string') invalid();
    if (!SHA256_DIGEST.test(value.contentDigest as string)) invalid();
    const bytes = Buffer.from(value.content as string, 'utf8');
    if (bytes.byteLength !== value.byteLength) invalid();
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== value.contentDigest) invalid();
  } else if (value.content !== null || value.contentDigest !== null || value.byteLength !== 0) {
    invalid();
  }
  return Object.freeze({
    existed: value.existed,
    content: value.content as string | null,
    contentDigest: value.contentDigest as string | null,
    byteLength: value.byteLength as number,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function invalid(): never {
  throw new FilesystemPreimageArtifactErrorV1(
    'invalid_preimage',
    'Filesystem preimage Artifact payload is invalid.',
  );
}

function mapStorageError(error: unknown): FilesystemPreimageArtifactErrorV1 {
  if (error instanceof FilesystemPreimageArtifactErrorV1) return error;
  if (error instanceof PrivateArtifactStorageError) {
    const code: FilesystemPreimageArtifactErrorCodeV1 =
      error.code === 'key_unavailable'
        ? 'key_unavailable'
        : error.code === 'artifact_missing'
          ? 'artifact_missing'
          : error.code === 'artifact_corrupt' || error.code === 'invalid_reference'
            ? 'artifact_corrupt'
            : error.code === 'artifact_too_large'
              ? 'artifact_too_large'
              : error.code === 'publish_failed'
                ? 'publish_failed'
                : 'storage_boundary_violation';
    return new FilesystemPreimageArtifactErrorV1(code, error.message);
  }
  return new FilesystemPreimageArtifactErrorV1(
    'storage_boundary_violation',
    'Filesystem preimage Artifact storage is unavailable.',
  );
}
