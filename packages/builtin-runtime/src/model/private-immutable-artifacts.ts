import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { secureWindowsOwnerOnlyPath } from './secure-storage';

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const OPAQUE_ARTIFACT_ID = /^pa_[0-9a-f]{64}$/;
const INTEGRITY_IDENTIFIER = /^sha256:[0-9a-f]{64}$/;
const SAFE_STORAGE_SEGMENT = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_ARTIFACT_KIND = /^[a-z][a-z0-9_-]{0,63}$/;
const DEFAULT_SCAN_ENTRY_LIMIT = 10_000;
const ARTIFACT_ID_DOMAIN = 'kite.private-immutable-artifact.id.v1\0';
const ARTIFACT_INTEGRITY_DOMAIN = 'kite.private-immutable-artifact.integrity.v1\0';

export type PrivateArtifactStorageErrorCode =
  | 'invalid_reference'
  | 'artifact_missing'
  | 'artifact_corrupt'
  | 'artifact_too_large'
  | 'storage_boundary_violation'
  | 'reachability_incomplete'
  | 'scan_limit_exceeded'
  | 'publish_failed';

export class PrivateArtifactStorageError extends Error {
  public readonly code: PrivateArtifactStorageErrorCode;

  constructor(code: PrivateArtifactStorageErrorCode, message: string) {
    super(message);
    this.name = 'PrivateArtifactStorageError';
    this.code = code;
  }
}

export interface PrivateImmutableArtifactRef<Kind extends string = string> {
  artifactId: string;
  kind: Kind;
  integrityIdentifier: string;
  byteLength: number;
}

export interface PrivateArtifactPartition<Kind extends string> {
  kind: Kind;
  directory: string;
  extension: `.${string}`;
}

export type PrivateArtifactWriteFaultPoint =
  | 'after_temporary_file_fsync'
  | 'after_atomic_publish_before_directory_fsync';

export interface PrivateImmutableArtifactStorageOptions<Kind extends string> {
  root?: string;
  namespace: string;
  partitions: readonly PrivateArtifactPartition<Kind>[];
  maxArtifactBytes: number;
  /** App-owned durable backend; exactly one of `root` or `backend` must be supplied. */
  backend?: PrivateImmutableArtifactStorageBackend<Kind>;
  platform?: NodeJS.Platform;
  secureWindowsPath?: (path: string) => void;
  faultInjector?: (point: PrivateArtifactWriteFaultPoint) => void;
}

export interface PrivateImmutableArtifactStorageBackend<Kind extends string> {
  write(ref: PrivateImmutableArtifactRef<Kind>, payload: Uint8Array): void;
  read(ref: PrivateImmutableArtifactRef<Kind>): Uint8Array;
  collectGarbage(
    options: PrivateArtifactGarbageCollectionOptions<Kind>,
  ): PrivateArtifactGarbageCollectionResult;
}

export interface PrivateArtifactReachabilitySnapshot<Kind extends string> {
  /** Must cover every retained session and fork before any deletion is allowed. */
  complete: boolean;
  reachable: readonly PrivateImmutableArtifactRef<Kind>[];
}

export interface PrivateArtifactGarbageCollectionOptions<Kind extends string> {
  reachability: PrivateArtifactReachabilitySnapshot<Kind>;
  minimumRetentionMs: number;
  nowMs?: number;
  maxEntries?: number;
}

export interface PrivateArtifactGarbageCollectionResult {
  scannedEntries: number;
  retainedArtifacts: number;
  deletedArtifacts: number;
  deletedTemporaryFiles: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface DirectoryBinding extends FileIdentity {
  path: string;
  canonicalPath: string;
}

interface BoundPartition<Kind extends string> {
  descriptor: PrivateArtifactPartition<Kind>;
  directories: readonly DirectoryBinding[];
  directory: DirectoryBinding;
}

interface ScannedFile {
  path: string;
  identity: FileIdentity;
  parent: BoundPartition<string>;
  type: 'artifact' | 'temporary';
  artifactId?: string;
  mtimeMs: number;
}

function storageError(code: PrivateArtifactStorageErrorCode, message: string): never {
  throw new PrivateArtifactStorageError(code, message);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeEqual(left: string, right: string): boolean {
  return left === right;
}

/** Stable content reference shared by filesystem and App-injected durable backends. */
export function derivePrivateImmutableArtifactReference<Kind extends string>(
  namespace: string,
  kind: Kind,
  payload: Uint8Array,
): PrivateImmutableArtifactRef<Kind> {
  if (!SAFE_STORAGE_SEGMENT.test(namespace) || !SAFE_ARTIFACT_KIND.test(kind)) {
    storageError('invalid_reference', 'Private Artifact identity domain is invalid.');
  }
  const bytes = Buffer.from(payload);
  if (bytes.byteLength < 1) {
    storageError('invalid_reference', 'Private Artifact payload is empty.');
  }
  const contentDigest = createHash('sha256').update(bytes).digest('hex');
  const identityMaterial = `${namespace}\0${kind}\0${contentDigest}`;
  const artifactId = `pa_${createHash('sha256')
    .update(ARTIFACT_ID_DOMAIN)
    .update(identityMaterial)
    .digest('hex')}`;
  const integrityIdentifier = `sha256:${createHash('sha256')
    .update(ARTIFACT_INTEGRITY_DOMAIN)
    .update(identityMaterial)
    .update('\0')
    .update(artifactId)
    .update('\0')
    .update(String(bytes.byteLength))
    .digest('hex')}`;
  return {
    artifactId,
    kind,
    integrityIdentifier,
    byteLength: bytes.byteLength,
  };
}

/**
 * Shared storage primitive for private, immutable, content-addressed artifacts.
 *
 * The content-addressed identifier and digest detect corruption and mixups.
 * No installation secret is required to create or recover local artifacts.
 */
export class PrivateImmutableArtifactStorage<Kind extends string> {
  private readonly root: string;
  private readonly namespace: string;
  private readonly maxArtifactBytes: number;
  private readonly platform: NodeJS.Platform;
  private readonly secureWindowsPath: (path: string) => void;
  private readonly faultInjector?: (point: PrivateArtifactWriteFaultPoint) => void;
  private readonly partitions: ReadonlyMap<Kind, PrivateArtifactPartition<Kind>>;
  private readonly backend?: PrivateImmutableArtifactStorageBackend<Kind>;

  constructor(options: PrivateImmutableArtifactStorageOptions<Kind>) {
    if (!SAFE_STORAGE_SEGMENT.test(options.namespace)) {
      storageError('storage_boundary_violation', 'Private Artifact namespace is invalid.');
    }
    if (!Number.isSafeInteger(options.maxArtifactBytes) || options.maxArtifactBytes < 1) {
      storageError('storage_boundary_violation', 'Private Artifact byte limit is invalid.');
    }

    if ((options.root === undefined) === (options.backend === undefined)) {
      storageError(
        'storage_boundary_violation',
        'Private Artifact storage requires exactly one durable owner.',
      );
    }
    const root = options.root === undefined ? '' : resolve(options.root);
    if (
      options.root !== undefined &&
      (root === resolve(dirname(root)) || basename(root) !== options.namespace)
    ) {
      storageError('storage_boundary_violation', 'Private Artifact root is too broad.');
    }
    const partitions = new Map<Kind, PrivateArtifactPartition<Kind>>();
    const directories = new Set<string>();
    for (const descriptor of options.partitions) {
      if (
        !SAFE_ARTIFACT_KIND.test(descriptor.kind) ||
        !SAFE_STORAGE_SEGMENT.test(descriptor.directory) ||
        !/^\.[a-z0-9]+$/.test(descriptor.extension) ||
        partitions.has(descriptor.kind) ||
        directories.has(descriptor.directory)
      ) {
        storageError('storage_boundary_violation', 'Private Artifact partition is invalid.');
      }
      partitions.set(descriptor.kind, Object.freeze({ ...descriptor }));
      directories.add(descriptor.directory);
    }
    if (partitions.size === 0) {
      storageError('storage_boundary_violation', 'Private Artifact partitions are unavailable.');
    }

    this.root = root;
    this.namespace = options.namespace;
    this.maxArtifactBytes = options.maxArtifactBytes;
    this.platform = options.platform ?? process.platform;
    this.secureWindowsPath = options.secureWindowsPath ?? secureWindowsOwnerOnlyPath;
    this.faultInjector = options.faultInjector;
    this.partitions = partitions;
    this.backend = options.backend;
  }

  write<SpecificKind extends Kind>(
    kind: SpecificKind,
    payload: Uint8Array,
  ): PrivateImmutableArtifactRef<SpecificKind> {
    const bytes = Buffer.from(payload);
    const ref = this.deriveReference(kind, bytes);
    if (this.backend) {
      try {
        this.backend.write(ref, bytes);
        if (!Buffer.from(this.read(ref)).equals(bytes)) {
          storageError('artifact_corrupt', 'Private Artifact backend readback differs.');
        }
        return ref;
      } catch (error) {
        if (error instanceof PrivateArtifactStorageError) throw error;
        storageError('publish_failed', 'Private Artifact backend write failed.');
      }
    }
    const partition = this.bindPartition(kind, true);
    const target = this.artifactPath(partition, ref.artifactId);

    const existing = this.tryReadExisting(ref, target, partition);
    if (existing) return ref;

    const temporary = join(
      partition.directory.path,
      `.${ref.artifactId}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    let temporaryIdentity: FileIdentity | undefined;
    let published = false;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | this.noFollowFlag(),
        0o600,
      );
      const opened = fstatSync(descriptor);
      this.assertPrivateRegularFile(opened, 'Private Artifact temporary file is unsafe.');
      temporaryIdentity = { dev: opened.dev, ino: opened.ino };
      this.assertDirectoryBindings(partition.directories);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      this.secureFile(temporary);
      const written = fstatSync(descriptor);
      if (!sameIdentity(opened, written) || written.size !== bytes.byteLength) {
        storageError('publish_failed', 'Private Artifact temporary file changed while writing.');
      }
      this.assertDirectoryBindings(partition.directories);
      this.faultInjector?.('after_temporary_file_fsync');
      closeSync(descriptor);
      descriptor = undefined;

      try {
        // Hard-link publication is atomic and, unlike POSIX rename(), never
        // replaces a same-content winner. Remove the temporary name
        // immediately so the published inode returns to the required nlink=1.
        linkSync(temporary, target);
        unlinkSync(temporary);
        published = true;
        temporaryIdentity = undefined;
      } catch (error) {
        if (
          (isFileSystemError(error, 'EEXIST') || isFileSystemError(error, 'EPERM')) &&
          this.waitForConcurrentPublisher(ref, target, partition)
        ) {
          return ref;
        }
        storageError('publish_failed', 'Private Artifact could not be published atomically.');
      }
      this.assertDirectoryBindings(partition.directories);
      this.faultInjector?.('after_atomic_publish_before_directory_fsync');
      this.read(ref);
      this.fsyncDirectories(partition.directories);
      return ref;
    } catch (error) {
      if (error instanceof PrivateArtifactStorageError) throw error;
      storageError('publish_failed', 'Private Artifact write failed.');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (!published && temporaryIdentity) {
        this.unlinkIfIdentity(temporary, temporaryIdentity, partition.directories);
      }
    }
    return storageError('publish_failed', 'Private Artifact write did not complete.');
  }

  read(ref: PrivateImmutableArtifactRef<Kind>): Uint8Array {
    this.assertReference(ref);
    const bytes = this.backend
      ? Buffer.from(this.backend.read(ref))
      : (() => {
          const partition = this.bindPartition(ref.kind, false);
          const target = this.artifactPath(partition, ref.artifactId);
          return this.readPayload(target, partition, 'artifact_missing');
        })();
    if (bytes.byteLength !== ref.byteLength) {
      storageError(
        'artifact_corrupt',
        'Private Artifact byte length does not match its reference.',
      );
    }
    const derived = this.deriveReference(ref.kind, bytes);
    if (
      !safeEqual(derived.artifactId, ref.artifactId) ||
      !safeEqual(derived.integrityIdentifier, ref.integrityIdentifier)
    ) {
      storageError('artifact_corrupt', 'Private Artifact integrity verification failed.');
    }
    return bytes;
  }

  collectGarbage(
    options: PrivateArtifactGarbageCollectionOptions<Kind>,
  ): PrivateArtifactGarbageCollectionResult {
    if (!options.reachability.complete) {
      storageError(
        'reachability_incomplete',
        'Private Artifact reachability must cover every retained session and fork.',
      );
    }
    if (!Number.isFinite(options.minimumRetentionMs) || options.minimumRetentionMs < 0) {
      storageError('storage_boundary_violation', 'Private Artifact retention is invalid.');
    }
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(nowMs)) {
      storageError('storage_boundary_violation', 'Private Artifact collection time is invalid.');
    }
    const maxEntries = options.maxEntries ?? DEFAULT_SCAN_ENTRY_LIMIT;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      storageError('storage_boundary_violation', 'Private Artifact scan limit is invalid.');
    }

    const reachableIds = new Set<string>();
    for (const ref of options.reachability.reachable) {
      this.read(ref);
      reachableIds.add(`${ref.kind}\0${ref.artifactId}`);
    }

    if (this.backend) return this.backend.collectGarbage(options);

    if (!this.rootExists()) {
      if (reachableIds.size > 0) {
        storageError('artifact_missing', 'A reachable Private Artifact is missing.');
      }
      return {
        scannedEntries: 0,
        retainedArtifacts: 0,
        deletedArtifacts: 0,
        deletedTemporaryFiles: 0,
      };
    }

    const scanned: ScannedFile[] = [];
    let scannedEntries = 0;
    let retainedArtifacts = 0;
    for (const descriptor of this.partitions.values()) {
      if (!this.partitionExists(descriptor)) continue;
      const partition = this.bindPartition(descriptor.kind, false);
      const directory = opendirSync(partition.directory.path);
      try {
        let entry = directory.readSync();
        while (entry) {
          scannedEntries += 1;
          if (scannedEntries > maxEntries) {
            storageError('scan_limit_exceeded', 'Private Artifact scan budget was exceeded.');
          }
          const target = join(partition.directory.path, entry.name);
          const stats = this.lstatPrivateFile(target);
          const artifactId = this.artifactIdFromFileName(entry.name, descriptor.extension);
          const temporary = this.isTemporaryFileName(entry.name);
          if (!artifactId && !temporary) {
            storageError(
              'artifact_corrupt',
              'Private Artifact directory contains an unknown entry.',
            );
          }
          if (artifactId) {
            const bytes = this.readPayload(target, partition, 'artifact_corrupt');
            const derived = this.deriveReference(descriptor.kind, bytes);
            if (!safeEqual(derived.artifactId, artifactId)) {
              storageError('artifact_corrupt', 'Private Artifact content address is invalid.');
            }
            if (reachableIds.has(`${descriptor.kind}\0${artifactId}`)) {
              retainedArtifacts += 1;
            }
          }
          scanned.push({
            path: target,
            identity: { dev: stats.dev, ino: stats.ino },
            parent: partition as BoundPartition<string>,
            type: artifactId ? 'artifact' : 'temporary',
            ...(artifactId ? { artifactId } : {}),
            mtimeMs: stats.mtimeMs,
          });
          entry = directory.readSync();
        }
      } finally {
        directory.closeSync();
      }
    }

    const cutoff = nowMs - options.minimumRetentionMs;
    const deletions = scanned
      .filter((entry) => {
        if (entry.mtimeMs > cutoff) return false;
        if (entry.type === 'temporary') return true;
        const kind = entry.parent.descriptor.kind;
        return !reachableIds.has(`${kind}\0${entry.artifactId}`);
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));

    let deletedArtifacts = 0;
    let deletedTemporaryFiles = 0;
    for (const candidate of deletions) {
      this.assertDirectoryBindings(candidate.parent.directories);
      const current = this.lstatPrivateFile(candidate.path);
      if (!sameIdentity(candidate.identity, current)) {
        storageError('storage_boundary_violation', 'Private Artifact changed during collection.');
      }
      unlinkSync(candidate.path);
      this.fsyncDirectories(candidate.parent.directories);
      if (candidate.type === 'artifact') deletedArtifacts += 1;
      else deletedTemporaryFiles += 1;
    }

    retainedArtifacts += scanned.filter(
      (entry) =>
        entry.type === 'artifact' &&
        entry.mtimeMs > cutoff &&
        !reachableIds.has(`${entry.parent.descriptor.kind}\0${entry.artifactId}`),
    ).length;
    return {
      scannedEntries,
      retainedArtifacts,
      deletedArtifacts,
      deletedTemporaryFiles,
    };
  }

  private deriveReference<SpecificKind extends Kind>(
    kind: SpecificKind,
    bytes: Buffer,
  ): PrivateImmutableArtifactRef<SpecificKind> {
    this.partition(kind);
    if (bytes.byteLength > this.maxArtifactBytes) {
      storageError('artifact_too_large', 'Private Artifact exceeds its byte limit.');
    }
    return derivePrivateImmutableArtifactReference(this.namespace, kind, bytes);
  }

  private assertReference(ref: PrivateImmutableArtifactRef<Kind>): void {
    const reference = ref as unknown;
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
      storageError('invalid_reference', 'Private Artifact reference is invalid.');
    }
    const prototype = Object.getPrototypeOf(reference);
    const keys = Reflect.ownKeys(reference);
    const expectedKeys = ['artifactId', 'kind', 'integrityIdentifier', 'byteLength'];
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key)) ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(reference, key);
        return !descriptor || !('value' in descriptor) || !descriptor.enumerable;
      })
    ) {
      storageError('invalid_reference', 'Private Artifact reference is invalid.');
    }
    if (
      !OPAQUE_ARTIFACT_ID.test(ref.artifactId) ||
      !INTEGRITY_IDENTIFIER.test(ref.integrityIdentifier) ||
      !Number.isSafeInteger(ref.byteLength) ||
      ref.byteLength < 0 ||
      ref.byteLength > this.maxArtifactBytes
    ) {
      storageError('invalid_reference', 'Private Artifact reference is invalid.');
    }
    this.partition(ref.kind);
  }

  private partition(kind: Kind): PrivateArtifactPartition<Kind> {
    const partition = this.partitions.get(kind);
    if (!partition) storageError('invalid_reference', 'Private Artifact kind is invalid.');
    return partition;
  }

  private artifactPath(partition: BoundPartition<Kind>, artifactId: string): string {
    const target = resolve(
      join(partition.directory.path, `${artifactId}${partition.descriptor.extension}`),
    );
    const fromPartition = relative(partition.directory.path, target);
    if (fromPartition.startsWith('..') || isAbsolute(fromPartition)) {
      storageError('storage_boundary_violation', 'Private Artifact path escaped its partition.');
    }
    return target;
  }

  private tryReadExisting(
    ref: PrivateImmutableArtifactRef<Kind>,
    target: string,
    partition: BoundPartition<Kind>,
  ): boolean {
    try {
      lstatSync(target);
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) return false;
      storageError('storage_boundary_violation', 'Private Artifact target could not be inspected.');
    }
    const bytes = this.readPayload(target, partition, 'artifact_corrupt');
    if (bytes.byteLength !== ref.byteLength) {
      storageError('artifact_corrupt', 'Existing Private Artifact has different content.');
    }
    const derived = this.deriveReference(ref.kind, bytes);
    if (
      !safeEqual(derived.artifactId, ref.artifactId) ||
      !safeEqual(derived.integrityIdentifier, ref.integrityIdentifier)
    ) {
      storageError('artifact_corrupt', 'Existing Private Artifact has different content.');
    }
    return true;
  }

  private waitForConcurrentPublisher(
    ref: PrivateImmutableArtifactRef<Kind>,
    target: string,
    partition: BoundPartition<Kind>,
  ): boolean {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return this.tryReadExisting(ref, target, partition);
      } catch (error) {
        // A hard-link winner has a tiny nlink=2 window before it removes its
        // private temporary name. Retry only that boundary classification;
        // persistent identity/permission/corruption failures still surface.
        if (
          !(error instanceof PrivateArtifactStorageError) ||
          error.code !== 'storage_boundary_violation' ||
          attempt === 19
        ) {
          throw error;
        }
        Bun.sleepSync(2);
      }
    }
    return false;
  }

  private bindPartition(kind: Kind, create: boolean): BoundPartition<Kind> {
    const descriptor = this.partition(kind);
    const anchor = dirname(this.root);
    const partitionPath = join(this.root, descriptor.directory);
    const directories = [anchor, this.root, partitionPath];
    const bindings: DirectoryBinding[] = [];
    for (const directory of directories) {
      const parent = bindings.at(-1);
      bindings.push(this.bindDirectory(directory, parent, create));
    }
    this.assertDirectoryBindings(bindings);
    return { descriptor, directories: bindings, directory: bindings.at(-1)! };
  }

  private bindDirectory(
    path: string,
    parent: DirectoryBinding | undefined,
    create: boolean,
  ): DirectoryBinding {
    let created = false;
    if (create) {
      try {
        mkdirSync(path, { recursive: false, mode: 0o700 });
        created = true;
      } catch (error) {
        if (!isFileSystemError(error, 'EEXIST')) {
          storageError('storage_boundary_violation', 'Private Artifact directory is unavailable.');
        }
      }
    }
    let stats: Stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) {
        storageError('artifact_missing', 'Private Artifact directory is missing.');
      }
      storageError('storage_boundary_violation', 'Private Artifact directory is unsafe.');
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      storageError('storage_boundary_violation', 'Private Artifact directory is unsafe.');
    }
    this.assertOwnedByCurrentUser(stats);
    if (this.platform === 'win32') this.secureWindowsPath(path);
    else if (created) chmodSync(path, 0o700);
    else if ((stats.mode & 0o777) !== 0o700) {
      storageError('storage_boundary_violation', 'Private Artifact directory is not owner-only.');
    }
    const after = lstatSync(path);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(stats, after)) {
      storageError('storage_boundary_violation', 'Private Artifact directory identity changed.');
    }
    this.assertOwnedByCurrentUser(after);
    const canonicalPath = realpathSync(path);
    if (parent) {
      const canonicalParent = dirname(canonicalPath);
      if (canonicalParent !== parent.canonicalPath) {
        storageError('storage_boundary_violation', 'Private Artifact directory escaped its root.');
      }
    }
    return { path, canonicalPath, dev: after.dev, ino: after.ino };
  }

  private assertDirectoryBindings(bindings: readonly DirectoryBinding[]): void {
    for (const binding of bindings) {
      const current = lstatSync(binding.path);
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        !sameIdentity(binding, current) ||
        realpathSync(binding.path) !== binding.canonicalPath
      ) {
        storageError('storage_boundary_violation', 'Private Artifact directory identity changed.');
      }
      this.assertOwnedByCurrentUser(current);
      if (this.platform !== 'win32' && (current.mode & 0o777) !== 0o700) {
        storageError(
          'storage_boundary_violation',
          'Private Artifact directory permissions changed.',
        );
      }
    }
  }

  private readPayload(
    target: string,
    partition: BoundPartition<Kind>,
    missingCode: 'artifact_missing' | 'artifact_corrupt',
  ): Buffer {
    let before: Stats;
    try {
      before = this.lstatPrivateFile(target);
    } catch (error) {
      if (error instanceof PrivateArtifactStorageError) throw error;
      if (isFileSystemError(error, 'ENOENT')) {
        storageError(missingCode, 'Private Artifact is missing.');
      }
      storageError('storage_boundary_violation', 'Private Artifact target is unsafe.');
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(target, constants.O_RDONLY | this.noFollowFlag());
      const opened = fstatSync(descriptor);
      this.assertPrivateRegularFile(opened, 'Private Artifact target is unsafe.');
      if (!sameIdentity(before, opened)) {
        storageError('storage_boundary_violation', 'Private Artifact changed while opening.');
      }
      this.assertDirectoryBindings(partition.directories);
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (!sameIdentity(opened, after) || after.size !== bytes.byteLength) {
        storageError('storage_boundary_violation', 'Private Artifact changed while reading.');
      }
      const current = this.lstatPrivateFile(target);
      if (!sameIdentity(after, current)) {
        storageError('storage_boundary_violation', 'Private Artifact path changed while reading.');
      }
      this.assertDirectoryBindings(partition.directories);
      return bytes;
    } catch (error) {
      if (error instanceof PrivateArtifactStorageError) throw error;
      if (isFileSystemError(error, 'ENOENT')) {
        storageError(missingCode, 'Private Artifact is missing.');
      }
      storageError('storage_boundary_violation', 'Private Artifact could not be opened safely.');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    return storageError('storage_boundary_violation', 'Private Artifact read did not complete.');
  }

  private lstatPrivateFile(path: string): Stats {
    const stats = lstatSync(path);
    this.assertPrivateRegularFile(stats, 'Private Artifact target is unsafe.');
    if (this.platform !== 'win32') return stats;
    this.secureWindowsPath(path);
    const secured = lstatSync(path);
    if (!sameIdentity(stats, secured)) {
      storageError('storage_boundary_violation', 'Private Artifact target identity changed.');
    }
    this.assertPrivateRegularFile(secured, 'Private Artifact target is unsafe.');
    return secured;
  }

  private assertPrivateRegularFile(stats: Stats, message: string): void {
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      storageError('storage_boundary_violation', message);
    }
    this.assertOwnedByCurrentUser(stats);
    if (this.platform !== 'win32' && (stats.mode & 0o777) !== 0o600) {
      storageError('storage_boundary_violation', message);
    }
    if (stats.size > this.maxArtifactBytes) {
      storageError('artifact_too_large', 'Private Artifact exceeds its byte limit.');
    }
  }

  private secureFile(path: string): void {
    if (this.platform === 'win32') this.secureWindowsPath(path);
    else chmodSync(path, 0o600);
  }

  private assertOwnedByCurrentUser(stats: Stats): void {
    if (
      this.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      stats.uid !== process.getuid()
    ) {
      storageError('storage_boundary_violation', 'Private Artifact storage has another owner.');
    }
  }

  private noFollowFlag(): number {
    return this.platform === 'win32' ? 0 : O_NOFOLLOW;
  }

  private fsyncDirectories(bindings: readonly DirectoryBinding[]): void {
    if (this.platform === 'win32') return;
    for (const binding of [...bindings].reverse()) {
      let descriptor: number | undefined;
      try {
        descriptor = openSync(binding.path, constants.O_RDONLY | O_NOFOLLOW);
        if (!fstatSync(descriptor).isDirectory()) {
          storageError('storage_boundary_violation', 'Private Artifact directory is unsafe.');
        }
        fsyncSync(descriptor);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
  }

  private unlinkIfIdentity(
    path: string,
    identity: FileIdentity,
    directories: readonly DirectoryBinding[],
  ): void {
    try {
      this.assertDirectoryBindings(directories);
      const current = lstatSync(path);
      if (
        !current.isSymbolicLink() &&
        current.isFile() &&
        current.nlink === 1 &&
        sameIdentity(identity, current)
      ) {
        unlinkSync(path);
      }
    } catch {
      // A changed temp or directory is intentionally left untouched.
    }
  }

  private artifactIdFromFileName(fileName: string, extension: string): string | undefined {
    if (!fileName.endsWith(extension)) return undefined;
    const artifactId = fileName.slice(0, -extension.length);
    return OPAQUE_ARTIFACT_ID.test(artifactId) ? artifactId : undefined;
  }

  private isTemporaryFileName(fileName: string): boolean {
    const name = basename(fileName);
    return /^\.pa_[0-9a-f]{64}\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name);
  }

  private rootExists(): boolean {
    try {
      const stats = lstatSync(this.root);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        storageError('storage_boundary_violation', 'Private Artifact root is unsafe.');
      }
      return true;
    } catch (error) {
      if (error instanceof PrivateArtifactStorageError) throw error;
      if (isFileSystemError(error, 'ENOENT')) return false;
      storageError('storage_boundary_violation', 'Private Artifact root is unsafe.');
    }
  }

  private partitionExists(descriptor: PrivateArtifactPartition<Kind>): boolean {
    const path = join(this.root, descriptor.directory);
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        storageError('storage_boundary_violation', 'Private Artifact partition is unsafe.');
      }
      return true;
    } catch (error) {
      if (error instanceof PrivateArtifactStorageError) throw error;
      if (isFileSystemError(error, 'ENOENT')) return false;
      storageError('storage_boundary_violation', 'Private Artifact partition is unsafe.');
    }
  }
}
