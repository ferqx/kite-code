import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { KiteHomeIdentity } from '../service';
import { secureWindowsStatePath, verifyWindowsStatePath } from '../service/windows-state-security';
import {
  assertCoordinatorJsonValue,
  COORDINATOR_ENDPOINT_DESCRIPTOR_SCHEMA,
  type CoordinatorEndpointDescriptor,
  decodeCoordinatorEndpointDescriptor,
} from './codecs';
import { type CoordinatorStatePaths, ensureCoordinatorStateRoot } from './identity';

/** Files in the Coordinator state root are deliberately small and owner-only. */
export const COORDINATOR_PROCESS_STATE_LIMITS = Object.freeze({
  descriptorBytes: 64 * 1024,
  lockIdentityBytes: 16 * 1024,
  temporaryNameBytes: 128,
} as const);

export const COORDINATOR_PROCESS_DESCRIPTOR_SCHEMA_ = 'kite.local-coordinator-process.v1' as const;
export const COORDINATOR_PROCESS_LOCK_SCHEMA_ = 'kite.local-coordinator-lock.v1' as const;
export const COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA_ =
  'kite.local-coordinator-launch-intent.v1' as const;

export type CoordinatorProcessOperation = 'ensure' | 'status' | 'stop';
export type CoordinatorProcessLockKind = 'instance' | 'lifecycle';
export type CoordinatorProcessStatus = 'dead' | 'alive' | 'uncertain';

const launchIntentSchema = z
  .object({
    schema: z.literal(COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA_),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/u),
    buildId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character))),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CoordinatorProcessLaunchIntent = z.infer<typeof launchIntentSchema>;
export const COORDINATOR_PROCESS_LAUNCH_INTENT_SCHEMA = launchIntentSchema;

const pidSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime({ offset: true });
const boundedTextSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)), {
    message: 'Coordinator process identity contains a control character',
  });
const processStartIdentitySchema = boundedTextSchema.max(256);

const processDescriptorSchema = z
  .object({
    schema: z.literal(COORDINATOR_PROCESS_DESCRIPTOR_SCHEMA_),
    instanceId: boundedTextSchema,
    pid: pidSchema,
    startedAt: timestampSchema,
    processStartIdentity: processStartIdentitySchema,
    buildId: boundedTextSchema,
    protocolVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    protocolRevision: boundedTextSchema,
    clientContractRevision: boundedTextSchema,
    endpoint: COORDINATOR_ENDPOINT_DESCRIPTOR_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const identity = value.endpoint.coordinator;
    if (identity.instanceId !== value.instanceId) {
      context.addIssue({
        code: 'custom',
        path: ['instanceId'],
        message: 'instance identity mismatch',
      });
    }
    if (identity.buildId !== value.buildId) {
      context.addIssue({ code: 'custom', path: ['buildId'], message: 'build identity mismatch' });
    }
    if (identity.protocolVersion !== value.protocolVersion) {
      context.addIssue({
        code: 'custom',
        path: ['protocolVersion'],
        message: 'protocol identity mismatch',
      });
    }
    if (identity.protocolRevision !== value.protocolRevision) {
      context.addIssue({
        code: 'custom',
        path: ['protocolRevision'],
        message: 'protocol revision mismatch',
      });
    }
    if (identity.clientContractRevision !== value.clientContractRevision) {
      context.addIssue({
        code: 'custom',
        path: ['clientContractRevision'],
        message: 'client contract revision mismatch',
      });
    }
  });

export type CoordinatorProcessDescriptor = z.infer<typeof processDescriptorSchema>;
export const COORDINATOR_PROCESS_DESCRIPTOR_SCHEMA = processDescriptorSchema;

const processLockIdentitySchema = z
  .object({
    schema: z.literal(COORDINATOR_PROCESS_LOCK_SCHEMA_),
    kind: z.enum(['instance', 'lifecycle']),
    nonce: boundedTextSchema,
    pid: pidSchema,
    instanceId: boundedTextSchema,
    startedAt: timestampSchema,
    processStartIdentity: processStartIdentitySchema,
    buildId: boundedTextSchema,
    operation: z.enum(['ensure', 'status', 'stop']).optional(),
    createdAt: timestampSchema,
  })
  .strict();

export type CoordinatorProcessLockIdentity = z.infer<typeof processLockIdentitySchema>;
export const COORDINATOR_PROCESS_LOCK_IDENTITY_SCHEMA = processLockIdentitySchema;

export interface CoordinatorProcessStateCleanup {
  readonly descriptor?: CoordinatorProcessDescriptor;
  readonly endpoint?: CoordinatorEndpointDescriptor;
  readonly instanceLock?: CoordinatorProcessLockIdentity;
  readonly lifecycleLock?: CoordinatorProcessLockIdentity;
}

export interface CoordinatorProcessLockLease {
  readonly kind: CoordinatorProcessLockKind;
  readonly identity: CoordinatorProcessLockIdentity;
  release(): Promise<void>;
}

export type CoordinatorProcessStateValue =
  | CoordinatorProcessDescriptor
  | CoordinatorEndpointDescriptor
  | CoordinatorProcessLockIdentity
  | CoordinatorProcessLaunchIntent;

/**
 * Native state seam used by the Coordinator lifecycle manager. The manager owns decisions while
 * this port owns no process authority; all methods are intentionally narrow and exact.
 */
export interface CoordinatorProcessStatePort {
  readonly paths?: CoordinatorStatePaths;
  readDescriptor(): Promise<unknown | undefined>;
  readEndpoint(): Promise<unknown | undefined>;
  readLaunchIntent(): Promise<unknown | undefined>;
  readInstanceLock(): Promise<unknown | undefined>;
  readLifecycleLock(): Promise<unknown | undefined>;
  publishDescriptor(value: unknown): Promise<CoordinatorProcessDescriptor>;
  publishEndpoint(value: unknown): Promise<CoordinatorEndpointDescriptor>;
  publishLaunchIntent(value: unknown): Promise<CoordinatorProcessLaunchIntent>;
  clearLaunchIntent(expected: CoordinatorProcessLaunchIntent): Promise<void>;
  acquireLock(
    kind: CoordinatorProcessLockKind,
    identity: CoordinatorProcessLockIdentity,
  ): Promise<CoordinatorProcessLockLease | undefined>;
  clearStale(expected: CoordinatorProcessStateCleanup): Promise<void>;
  preserveFailure(): Promise<void>;
}

export class CoordinatorProcessStateError extends Error {
  readonly code: 'invalid_path' | 'missing' | 'busy' | 'corrupt' | 'permission' | 'io';

  constructor(
    code: 'invalid_path' | 'missing' | 'busy' | 'corrupt' | 'permission' | 'io',
    message: string,
  ) {
    super(message);
    this.name = 'CoordinatorProcessStateError';
    this.code = code;
  }
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const OWNER_MASK = 0o077;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const LOCK_IDENTITY_FILE = 'identity.json';

interface CoordinatorFileStat {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid?: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function readStat(path: string): CoordinatorFileStat {
  return lstatSync(path) as unknown as CoordinatorFileStat;
}

function fail(
  code: ConstructorParameters<typeof CoordinatorProcessStateError>[0],
  message: string,
): never {
  throw new CoordinatorProcessStateError(code, message);
}

function isNativeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function assertOwnerOnly(path: string, stat: CoordinatorFileStat, label: string): void {
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    fail('corrupt', `${label} is not a private regular state entry.`);
  }
  if (process.platform !== 'win32' && (stat.mode & OWNER_MASK) !== 0) {
    fail('permission', `${label} is not owner-only.`);
  }
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stat.uid !== undefined &&
    stat.uid !== process.getuid()
  ) {
    fail('permission', `${label} is not owned by the current user.`);
  }
  if (process.platform === 'win32') {
    try {
      verifyWindowsStatePath(path, stat.isDirectory() ? 'directory' : 'file');
    } catch {
      fail('permission', `${label} does not have a verified owner-only Windows ACL.`);
    }
  }
  void path;
}

function secureCreatedWindowsEntry(path: string, kind: 'directory' | 'file'): void {
  if (process.platform !== 'win32') return;
  try {
    secureWindowsStatePath(path, kind, { allowOwnerInitialization: true });
  } catch {
    fail('permission', 'Coordinator state entry could not be secured for the Windows owner.');
  }
}

function assertDirectory(path: string, label: string): CoordinatorFileStat {
  let stat: CoordinatorFileStat;
  try {
    stat = readStat(path);
  } catch (error) {
    if (isNativeError(error, 'ENOENT')) fail('missing', `${label} is missing.`);
    fail('io', `${label} could not be inspected.`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('corrupt', `${label} is not a private directory.`);
  }
  assertOwnerOnly(path, stat, label);
  return stat;
}

function assertStateRoot(paths: CoordinatorStatePaths): string {
  const root = assertDirectory(paths.root, 'Coordinator state root');
  if (
    paths.processDescriptor !== join(paths.root, 'process.json') ||
    paths.endpointDescriptor !== join(paths.root, 'endpoint.json') ||
    paths.launchIntent !== join(paths.root, 'launch-intent.json') ||
    paths.instanceLock !== join(paths.root, 'instance.lock') ||
    paths.lifecycleLock !== join(paths.root, 'lifecycle.lock')
  ) {
    fail('invalid_path', 'Coordinator paths do not match the fixed V1 layout.');
  }
  void root;
  return paths.root;
}

function parseJson<T>(bytes: Buffer, parser: (value: unknown) => T, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    fail('corrupt', `${label} is not valid JSON.`);
  }
  try {
    return parser(value);
  } catch {
    fail('corrupt', `${label} failed strict validation.`);
  }
}

function readRegularFile(path: string, maxBytes: number, label: string): Buffer | undefined {
  let stat: CoordinatorFileStat;
  try {
    stat = readStat(path);
  } catch (error) {
    if (isNativeError(error, 'ENOENT')) return undefined;
    fail('io', `${label} could not be inspected.`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail('corrupt', `${label} is not a private regular file.`);
  }
  assertOwnerOnly(path, stat, label);
  if (stat.size > maxBytes) fail('corrupt', `${label} is oversized.`);
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > maxBytes) fail('corrupt', `${label} is oversized.`);
    return bytes;
  } catch {
    fail('io', `${label} could not be read.`);
  }
}

function encodeJson(value: CoordinatorProcessStateValue, label: string): Buffer {
  try {
    assertCoordinatorJsonValue(value);
    return Buffer.from(JSON.stringify(value), 'utf8');
  } catch {
    fail('corrupt', `${label} failed strict validation.`);
  }
}

function readDescriptor(paths: CoordinatorStatePaths): CoordinatorProcessDescriptor | undefined {
  const bytes = readRegularFile(
    paths.processDescriptor,
    COORDINATOR_PROCESS_STATE_LIMITS.descriptorBytes,
    'Coordinator process descriptor',
  );
  return bytes === undefined
    ? undefined
    : parseJson(bytes, decodeCoordinatorProcessDescriptor, 'Coordinator process descriptor');
}

function readEndpoint(paths: CoordinatorStatePaths): CoordinatorEndpointDescriptor | undefined {
  const bytes = readRegularFile(
    paths.endpointDescriptor,
    COORDINATOR_PROCESS_STATE_LIMITS.descriptorBytes,
    'Coordinator endpoint descriptor',
  );
  return bytes === undefined
    ? undefined
    : parseJson(bytes, decodeCoordinatorEndpointDescriptor, 'Coordinator endpoint descriptor');
}

function lockPath(paths: CoordinatorStatePaths, kind: CoordinatorProcessLockKind): string {
  return kind === 'instance' ? paths.instanceLock : paths.lifecycleLock;
}

function lockIdentityPath(paths: CoordinatorStatePaths, kind: CoordinatorProcessLockKind): string {
  return join(lockPath(paths, kind), LOCK_IDENTITY_FILE);
}

function readLock(
  paths: CoordinatorStatePaths,
  kind: CoordinatorProcessLockKind,
): CoordinatorProcessLockIdentity | undefined {
  const path = lockPath(paths, kind);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isNativeError(error, 'ENOENT')) return undefined;
    fail('io', `${kind} lock could not be inspected.`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('corrupt', `${kind} lock is not a private directory.`);
  }
  assertOwnerOnly(path, stat, `${kind} lock`);
  let entries: string[];
  try {
    entries = readdirSync(path) as string[];
  } catch {
    fail('io', `${kind} lock could not be read.`);
  }
  if (entries.length !== 1 || entries[0] !== LOCK_IDENTITY_FILE) {
    fail('corrupt', `${kind} lock has unexpected contents.`);
  }
  const bytes = readRegularFile(
    lockIdentityPath(paths, kind),
    COORDINATOR_PROCESS_STATE_LIMITS.lockIdentityBytes,
    `${kind} lock identity`,
  );
  if (bytes === undefined) fail('missing', `${kind} lock identity is missing.`);
  return parseJson(bytes, decodeCoordinatorProcessLockIdentity, `${kind} lock identity`);
}

function temporaryPath(root: string, target: string): string {
  const name = `.${target}-${randomBytes(16).toString('hex')}.tmp`;
  if (Buffer.byteLength(name, 'utf8') > COORDINATOR_PROCESS_STATE_LIMITS.temporaryNameBytes) {
    fail('invalid_path', 'Coordinator state temporary name is oversized.');
  }
  return join(root, name);
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    fsyncSync(descriptor);
  } catch {
    fail('io', 'Coordinator state directory could not be flushed.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function publishFile(
  paths: CoordinatorStatePaths,
  target: string,
  bytes: Buffer,
  label: string,
): void {
  const root = assertStateRoot(paths);
  if (dirname(target) !== root) fail('invalid_path', `${label} path is invalid.`);
  const existing = (() => {
    try {
      return readStat(target);
    } catch (error) {
      if (isNativeError(error, 'ENOENT')) return undefined;
      fail('io', `${label} could not be inspected.`);
    }
  })();
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
      fail('corrupt', `${label} is not a private regular file.`);
    }
    assertOwnerOnly(target, existing, label);
  }
  const temporary = temporaryPath(root, target.split(/[\\/]/u).at(-1) ?? 'state');
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      FILE_MODE,
    );
    writeFileSync(descriptor, bytes);
    if (process.platform !== 'win32') fchmodSync(descriptor, FILE_MODE);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    secureCreatedWindowsEntry(temporary, 'file');
    renameSync(temporary, target);
    published = true;
    syncDirectory(root);
    const after = readStat(target);
    if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1) {
      fail('corrupt', `${label} changed during publication.`);
    }
    assertOwnerOnly(target, after, label);
  } catch (error) {
    if (error instanceof CoordinatorProcessStateError) throw error;
    fail('io', `${label} could not be published.`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!published) {
      try {
        unlinkSync(temporary);
      } catch {
        // Best-effort cleanup never removes a path that was not created by this attempt.
      }
    }
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function removeFile(
  paths: CoordinatorStatePaths,
  target: string,
  expected: unknown,
  label: string,
): void {
  const root = assertStateRoot(paths);
  const before = (() => {
    try {
      return readStat(target);
    } catch (error) {
      if (isNativeError(error, 'ENOENT')) return undefined;
      fail('io', `${label} could not be inspected.`);
    }
  })();
  if (!before) return;
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    fail('corrupt', `${label} is not a private regular file.`);
  }
  assertOwnerOnly(target, before, label);
  const bytes = readRegularFile(target, COORDINATOR_PROCESS_STATE_LIMITS.descriptorBytes, label);
  let actual: unknown;
  try {
    actual = bytes === undefined ? undefined : (JSON.parse(bytes.toString('utf8')) as unknown);
  } catch {
    fail('corrupt', `${label} is not valid JSON.`);
  }
  if (actual === undefined || !sameJson(actual, expected)) {
    fail('corrupt', `${label} does not match the cleanup identity.`);
  }
  const current = (() => {
    try {
      return readStat(target);
    } catch (error) {
      if (isNativeError(error, 'ENOENT')) return undefined;
      fail('io', `${label} could not be inspected.`);
    }
  })();
  if (!current) return;
  if (current.dev !== before.dev || current.ino !== before.ino) {
    fail('corrupt', `${label} changed during cleanup.`);
  }
  unlinkSync(target);
  syncDirectory(root);
}

function removeLock(
  paths: CoordinatorStatePaths,
  kind: CoordinatorProcessLockKind,
  expected: CoordinatorProcessLockIdentity,
): void {
  const root = assertStateRoot(paths);
  const path = lockPath(paths, kind);
  let before: CoordinatorFileStat;
  try {
    before = readStat(path);
  } catch (error) {
    if (isNativeError(error, 'ENOENT')) return;
    fail('io', `${kind} lock could not be inspected.`);
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    fail('corrupt', `${kind} lock is not a private directory.`);
  }
  assertOwnerOnly(path, before, `${kind} lock`);
  const actual = readLock(paths, kind);
  if (!actual || !sameJson(actual, expected)) fail('corrupt', `${kind} lock identity mismatches.`);
  let current: CoordinatorFileStat;
  try {
    current = readStat(path);
  } catch (error) {
    if (isNativeError(error, 'ENOENT')) return;
    fail('io', `${kind} lock could not be inspected.`);
  }
  if (current.dev !== before.dev || current.ino !== before.ino) {
    fail('corrupt', `${kind} lock changed during cleanup.`);
  }
  unlinkSync(lockIdentityPath(paths, kind));
  rmdirSync(path);
  syncDirectory(root);
}

function createLockIdentity(
  kind: CoordinatorProcessLockKind,
  input: Omit<CoordinatorProcessLockIdentity, 'schema' | 'kind' | 'nonce'> & {
    readonly operation?: CoordinatorProcessOperation;
  },
): CoordinatorProcessLockIdentity {
  return decodeCoordinatorProcessLockIdentity({
    schema: COORDINATOR_PROCESS_LOCK_SCHEMA_,
    kind,
    nonce: randomBytes(24).toString('base64url'),
    ...input,
  });
}

function tryAcquireLock(
  paths: CoordinatorStatePaths,
  kind: CoordinatorProcessLockKind,
  identity: CoordinatorProcessLockIdentity,
): CoordinatorProcessLockLease | undefined {
  const root = assertStateRoot(paths);
  const path = lockPath(paths, kind);
  try {
    mkdirSync(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (isNativeError(error, 'EEXIST')) {
      const existing = readStat(path);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        fail('corrupt', `${kind} lock is not a private directory.`);
      }
      assertOwnerOnly(path, existing, `${kind} lock`);
      return undefined;
    }
    fail('io', `${kind} lock could not be acquired.`);
  }
  let released = false;
  try {
    secureCreatedWindowsEntry(path, 'directory');
    const lockStat = readStat(path);
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
      fail('corrupt', `${kind} lock changed during acquisition.`);
    }
    assertOwnerOnly(path, lockStat, `${kind} lock`);
    const bytes = encodeJson(identity, `${kind} lock identity`);
    const fd = openSync(
      lockIdentityPath(paths, kind),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      FILE_MODE,
    );
    try {
      writeFileSync(fd, bytes);
      if (process.platform !== 'win32') fchmodSync(fd, FILE_MODE);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    secureCreatedWindowsEntry(lockIdentityPath(paths, kind), 'file');
    syncDirectory(path);
    syncDirectory(root);
    return Object.freeze({
      kind,
      identity,
      async release(): Promise<void> {
        if (released) return;
        const current = readStat(path);
        if (current.isSymbolicLink() || !current.isDirectory()) {
          fail('corrupt', `${kind} lock is no longer owned by this handle.`);
        }
        if (current.dev !== lockStat.dev || current.ino !== lockStat.ino) {
          fail('corrupt', `${kind} lock is no longer owned by this handle.`);
        }
        const actual = readLock(paths, kind);
        if (!actual || actual.nonce !== identity.nonce) {
          fail('corrupt', `${kind} lock is no longer owned by this handle.`);
        }
        unlinkSync(lockIdentityPath(paths, kind));
        rmdirSync(path);
        syncDirectory(root);
        released = true;
      },
    });
  } catch (error) {
    try {
      const entries = readdirSync(path);
      if (entries.length === 0) rmdirSync(path);
    } catch {
      // Preserve evidence if ownership changed while acquisition failed.
    }
    if (error instanceof CoordinatorProcessStateError) throw error;
    fail('io', `${kind} lock identity could not be published.`);
  }
}

export function decodeCoordinatorProcessDescriptor(value: unknown): CoordinatorProcessDescriptor {
  assertCoordinatorJsonValue(value);
  return processDescriptorSchema.parse(value);
}

export function encodeCoordinatorProcessDescriptor(
  value: CoordinatorProcessDescriptor,
): CoordinatorProcessDescriptor {
  return decodeCoordinatorProcessDescriptor(value);
}

export function safeDecodeCoordinatorProcessDescriptor(
  value: unknown,
):
  | { readonly success: true; readonly data: CoordinatorProcessDescriptor }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeCoordinatorProcessDescriptor(value) };
  } catch (error) {
    return { success: false, error };
  }
}

export function decodeCoordinatorProcessLockIdentity(
  value: unknown,
): CoordinatorProcessLockIdentity {
  assertCoordinatorJsonValue(value);
  return processLockIdentitySchema.parse(value);
}

export function encodeCoordinatorProcessLockIdentity(
  value: CoordinatorProcessLockIdentity,
): CoordinatorProcessLockIdentity {
  return decodeCoordinatorProcessLockIdentity(value);
}

export function safeDecodeCoordinatorProcessLockIdentity(
  value: unknown,
):
  | { readonly success: true; readonly data: CoordinatorProcessLockIdentity }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeCoordinatorProcessLockIdentity(value) };
  } catch (error) {
    return { success: false, error };
  }
}

export function createCoordinatorProcessStatePort(
  identity: KiteHomeIdentity,
): CoordinatorProcessStatePort & { readonly paths: CoordinatorStatePaths } {
  const paths = ensureCoordinatorStateRoot(identity);
  return Object.freeze({
    paths,
    async readDescriptor() {
      return readDescriptor(paths);
    },
    async readEndpoint() {
      return readEndpoint(paths);
    },
    async readLaunchIntent() {
      const bytes = readRegularFile(
        paths.launchIntent,
        COORDINATOR_PROCESS_STATE_LIMITS.lockIdentityBytes,
        'Coordinator launch intent',
      );
      return bytes
        ? parseJson(bytes, (value) => launchIntentSchema.parse(value), 'Coordinator launch intent')
        : undefined;
    },
    async readInstanceLock() {
      return readLock(paths, 'instance');
    },
    async readLifecycleLock() {
      return readLock(paths, 'lifecycle');
    },
    async publishDescriptor(value: unknown) {
      const descriptor = decodeCoordinatorProcessDescriptor(value);
      publishFile(
        paths,
        paths.processDescriptor,
        encodeJson(descriptor, 'Coordinator process descriptor'),
        'Coordinator process descriptor',
      );
      return descriptor;
    },
    async publishEndpoint(value: unknown) {
      const endpoint = decodeCoordinatorEndpointDescriptor(value);
      publishFile(
        paths,
        paths.endpointDescriptor,
        encodeJson(endpoint, 'Coordinator endpoint descriptor'),
        'Coordinator endpoint descriptor',
      );
      return endpoint;
    },
    async publishLaunchIntent(value: unknown) {
      const intent = launchIntentSchema.parse(value);
      publishFile(
        paths,
        paths.launchIntent,
        encodeJson(intent, 'Coordinator launch intent'),
        'Coordinator launch intent',
      );
      return intent;
    },
    async clearLaunchIntent(expected: CoordinatorProcessLaunchIntent) {
      removeFile(
        paths,
        paths.launchIntent,
        launchIntentSchema.parse(expected),
        'Coordinator launch intent',
      );
    },
    async acquireLock(
      kind: CoordinatorProcessLockKind,
      identityValue: CoordinatorProcessLockIdentity,
    ) {
      const identity = decodeCoordinatorProcessLockIdentity(identityValue);
      if (identity.kind !== kind) fail('corrupt', `${kind} lock identity kind mismatches.`);
      return tryAcquireLock(paths, kind, identity);
    },
    async clearStale(expected: CoordinatorProcessStateCleanup) {
      if (expected.descriptor) {
        removeFile(
          paths,
          paths.processDescriptor,
          expected.descriptor,
          'Coordinator process descriptor',
        );
      }
      if (expected.endpoint) {
        removeFile(
          paths,
          paths.endpointDescriptor,
          expected.endpoint,
          'Coordinator endpoint descriptor',
        );
      }
      if (expected.instanceLock) removeLock(paths, 'instance', expected.instanceLock);
      if (expected.lifecycleLock) removeLock(paths, 'lifecycle', expected.lifecycleLock);
    },
    async preserveFailure() {
      // The state itself is the recovery evidence. Never rewrite it on failure.
    },
  });
}

/** Build a process lock identity with a fresh nonce for native manager callers. */
export function createCoordinatorProcessLockIdentity(input: {
  readonly kind: CoordinatorProcessLockKind;
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly processStartIdentity: string;
  readonly buildId: string;
  readonly operation?: CoordinatorProcessOperation;
  readonly createdAt?: string;
}): CoordinatorProcessLockIdentity {
  return createLockIdentity(input.kind, {
    pid: input.pid,
    instanceId: input.instanceId,
    startedAt: input.startedAt,
    processStartIdentity: input.processStartIdentity,
    buildId: input.buildId,
    ...(input.operation ? { operation: input.operation } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

/** Helper kept public for tests and native process hosts that need strict endpoint decoding. */
export function decodeCoordinatorProcessEndpoint(value: unknown): CoordinatorEndpointDescriptor {
  return decodeCoordinatorEndpointDescriptor(value);
}

export type { CoordinatorStatePaths };
