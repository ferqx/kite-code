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
import {
  assertCoordinatorJsonValue,
  COORDINATOR_WEB_GATEWAY_ENDPOINT_SCHEMA,
  COORDINATOR_WEB_GATEWAY_IDENTITY_SCHEMA,
  type CoordinatorGatewayRegistration,
  type CoordinatorWebGatewayEndpoint,
  type CoordinatorWebGatewayIdentity,
} from '@kite-ai/kite-local-runtime/coordinator';
import type { KiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  ensurePrivateKiteHomeDirectory,
  secureWindowsStatePath,
  verifyWindowsStatePath,
} from '@kite-ai/kite-local-runtime/service';
import { z } from 'zod';

export const WEB_GATEWAY_PROCESS_DESCRIPTOR_SCHEMA_ = 'kite.web-gateway-process.v1' as const;
export const WEB_GATEWAY_PROCESS_LOCK_SCHEMA_ = 'kite.web-gateway-lock.v1' as const;
export const WEB_GATEWAY_PROCESS_LAUNCH_INTENT_SCHEMA_ =
  'kite.web-gateway-launch-intent.v1' as const;
export const WEB_GATEWAY_PROCESS_STATE_LIMITS = Object.freeze({
  descriptorBytes: 64 * 1024,
  lockIdentityBytes: 16 * 1024,
  credentialBytes: 256,
  launchIntentBytes: 16 * 1024,
  temporaryNameBytes: 128,
} as const);

export type WebGatewayProcessLockKind = 'instance' | 'lifecycle';
export type WebGatewayProcessOperation = 'ensure' | 'discover' | 'stop';

const pid = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const boundedText = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)), {
    message: 'Gateway process identity contains a control character',
  });
const processStartIdentity = boundedText.max(256);
const timestamp = z.iso.datetime({ offset: true });
const originEndpoint = COORDINATOR_WEB_GATEWAY_ENDPOINT_SCHEMA;
const controlCredential = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

const processDescriptorSchema = z
  .object({
    schema: z.literal(WEB_GATEWAY_PROCESS_DESCRIPTOR_SCHEMA_),
    identity: COORDINATOR_WEB_GATEWAY_IDENTITY_SCHEMA,
    pid,
    startedAt: timestamp,
    processStartIdentity,
    endpoint: originEndpoint,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.identity.instanceId.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['identity', 'instanceId'],
        message: 'empty instance',
      });
    }
  });

export type WebGatewayProcessDescriptor = z.infer<typeof processDescriptorSchema>;
export const WEB_GATEWAY_PROCESS_DESCRIPTOR_SCHEMA = processDescriptorSchema;

const launchIntentSchema = z
  .object({
    schema: z.literal(WEB_GATEWAY_PROCESS_LAUNCH_INTENT_SCHEMA_),
    pid,
    instanceId: boundedText,
    processStartIdentity,
    buildId: boundedText,
    credentialDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: timestamp,
  })
  .strict();

export type WebGatewayProcessLaunchIntent = z.infer<typeof launchIntentSchema>;
export const WEB_GATEWAY_PROCESS_LAUNCH_INTENT_SCHEMA = launchIntentSchema;

const processLockIdentitySchema = z
  .object({
    schema: z.literal(WEB_GATEWAY_PROCESS_LOCK_SCHEMA_),
    kind: z.enum(['instance', 'lifecycle']),
    nonce: boundedText,
    pid,
    instanceId: boundedText,
    startedAt: timestamp,
    processStartIdentity,
    buildId: boundedText,
    operation: z.enum(['ensure', 'discover', 'stop']).optional(),
    createdAt: timestamp,
  })
  .strict();

export type WebGatewayProcessLockIdentity = z.infer<typeof processLockIdentitySchema>;
export const WEB_GATEWAY_PROCESS_LOCK_IDENTITY_SCHEMA = processLockIdentitySchema;

export interface WebGatewayProcessStatePaths {
  readonly root: string;
  readonly descriptor: string;
  readonly controlCredential: string;
  readonly launchIntent: string;
  readonly instanceLock: string;
  readonly lifecycleLock: string;
}

export interface WebGatewayProcessStateCleanup {
  readonly descriptor?: WebGatewayProcessDescriptor;
  readonly instanceLock?: WebGatewayProcessLockIdentity;
  readonly lifecycleLock?: WebGatewayProcessLockIdentity;
  readonly controlCredential?: string;
  readonly launchIntent?: WebGatewayProcessLaunchIntent;
}

export interface WebGatewayProcessLockLease {
  readonly kind: WebGatewayProcessLockKind;
  readonly identity: WebGatewayProcessLockIdentity;
  release(): Promise<void>;
}

export interface WebGatewayProcessStatePort {
  readonly paths?: WebGatewayProcessStatePaths;
  readDescriptor(): Promise<unknown | undefined>;
  readControlCredential(): Promise<string | undefined>;
  readLaunchIntent(): Promise<unknown | undefined>;
  readInstanceLock(): Promise<unknown | undefined>;
  readLifecycleLock(): Promise<unknown | undefined>;
  publishDescriptor(value: unknown): Promise<WebGatewayProcessDescriptor>;
  publishControlCredential(value: string): Promise<string>;
  publishLaunchIntent(value: unknown): Promise<WebGatewayProcessLaunchIntent>;
  acquireLock(
    kind: WebGatewayProcessLockKind,
    identity: WebGatewayProcessLockIdentity,
  ): Promise<WebGatewayProcessLockLease | undefined>;
  clearStale(expected: WebGatewayProcessStateCleanup): Promise<void>;
  preserveFailure(): Promise<void>;
}

export class WebGatewayProcessStateError extends Error {
  readonly code: 'invalid_path' | 'missing' | 'busy' | 'corrupt' | 'permission' | 'io';

  constructor(
    code: 'invalid_path' | 'missing' | 'busy' | 'corrupt' | 'permission' | 'io',
    message: string,
  ) {
    super(message);
    this.name = 'WebGatewayProcessStateError';
    this.code = code;
  }
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const OWNER_MASK = 0o077;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const LOCK_IDENTITY_FILE = 'identity.json';
const STATE_SEGMENTS = Object.freeze(['web-gateway', 'v1'] as const);

interface StateStat {
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

export function decodeWebGatewayProcessDescriptor(value: unknown): WebGatewayProcessDescriptor {
  assertCoordinatorJsonValue(value);
  return processDescriptorSchema.parse(value);
}

export function encodeWebGatewayProcessDescriptor(
  value: WebGatewayProcessDescriptor,
): WebGatewayProcessDescriptor {
  return decodeWebGatewayProcessDescriptor(value);
}

export function safeDecodeWebGatewayProcessDescriptor(
  value: unknown,
):
  | { readonly success: true; readonly data: WebGatewayProcessDescriptor }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeWebGatewayProcessDescriptor(value) };
  } catch (error) {
    return { success: false, error };
  }
}

export function decodeWebGatewayProcessLockIdentity(value: unknown): WebGatewayProcessLockIdentity {
  assertCoordinatorJsonValue(value);
  return processLockIdentitySchema.parse(value);
}

export function encodeWebGatewayProcessLockIdentity(
  value: WebGatewayProcessLockIdentity,
): WebGatewayProcessLockIdentity {
  return decodeWebGatewayProcessLockIdentity(value);
}

/** Ensure the process state root under an already validated canonical Kite home. */
export function ensureWebGatewayProcessStateRoot(
  identity: KiteHomeIdentity,
): WebGatewayProcessStatePaths {
  return resolveWebGatewayProcessStatePaths(
    ensurePrivateKiteHomeDirectory(identity, STATE_SEGMENTS),
  );
}

/** Pure path derivation for tests or callers that already validated the state root. */
export function resolveWebGatewayProcessStatePaths(root: string): WebGatewayProcessStatePaths {
  return Object.freeze({
    root,
    descriptor: join(root, 'process.json'),
    controlCredential: join(root, 'control.token'),
    launchIntent: join(root, 'launch-intent.json'),
    instanceLock: join(root, 'instance.lock'),
    lifecycleLock: join(root, 'lifecycle.lock'),
  });
}

export function createWebGatewayProcessStatePort(
  identity: KiteHomeIdentity,
): WebGatewayProcessStatePort & { readonly paths: WebGatewayProcessStatePaths } {
  const paths = ensureWebGatewayProcessStateRoot(identity);
  return Object.freeze({
    paths,
    async readDescriptor() {
      return readDescriptor(paths);
    },
    async readControlCredential() {
      return readControlCredential(paths);
    },
    async readLaunchIntent() {
      return readLaunchIntent(paths);
    },
    async readInstanceLock() {
      return readLock(paths, 'instance');
    },
    async readLifecycleLock() {
      return readLock(paths, 'lifecycle');
    },
    async publishDescriptor(value: unknown) {
      const descriptor = decodeWebGatewayProcessDescriptor(value);
      publishFile(
        paths,
        paths.descriptor,
        encodeJson(descriptor, 'Gateway descriptor'),
        'Gateway descriptor',
      );
      return descriptor;
    },
    async publishControlCredential(value: string) {
      const credential = controlCredential.parse(value);
      publishFile(
        paths,
        paths.controlCredential,
        Buffer.from(credential, 'utf8'),
        'Gateway control credential',
      );
      return credential;
    },
    async publishLaunchIntent(value: unknown) {
      const intent = launchIntentSchema.parse(value);
      publishFile(
        paths,
        paths.launchIntent,
        encodeJson(intent, 'Gateway launch intent'),
        'Gateway launch intent',
      );
      return intent;
    },
    async acquireLock(kind: WebGatewayProcessLockKind, value: WebGatewayProcessLockIdentity) {
      const identityValue = decodeWebGatewayProcessLockIdentity(value);
      if (identityValue.kind !== kind) fail('corrupt', `${kind} lock identity kind mismatches.`);
      return tryAcquireLock(paths, kind, identityValue);
    },
    async clearStale(expected: WebGatewayProcessStateCleanup) {
      if (expected.descriptor)
        removeFile(paths, paths.descriptor, expected.descriptor, 'Gateway descriptor');
      if (expected.instanceLock) removeLock(paths, 'instance', expected.instanceLock);
      if (expected.lifecycleLock) removeLock(paths, 'lifecycle', expected.lifecycleLock);
      if (expected.controlCredential) {
        removeCredential(paths, expected.controlCredential, 'Gateway control credential');
      }
      if (expected.launchIntent) {
        removeFile(paths, paths.launchIntent, expected.launchIntent, 'Gateway launch intent');
      }
    },
    async preserveFailure() {
      // Existing state is recovery evidence. Never rewrite it after an uncertain operation.
    },
  });
}

export function createWebGatewayProcessLockIdentity(input: {
  readonly kind: WebGatewayProcessLockKind;
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly processStartIdentity: string;
  readonly buildId: string;
  readonly operation?: WebGatewayProcessOperation;
  readonly createdAt?: string;
}): WebGatewayProcessLockIdentity {
  return decodeWebGatewayProcessLockIdentity({
    schema: WEB_GATEWAY_PROCESS_LOCK_SCHEMA_,
    kind: input.kind,
    nonce: randomBytes(24).toString('base64url'),
    pid: input.pid,
    instanceId: input.instanceId,
    startedAt: input.startedAt,
    processStartIdentity: input.processStartIdentity,
    buildId: input.buildId,
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

function readStat(path: string): StateStat {
  return lstatSync(path) as unknown as StateStat;
}

function fail(
  code: ConstructorParameters<typeof WebGatewayProcessStateError>[0],
  message: string,
): never {
  throw new WebGatewayProcessStateError(code, message);
}

function nativeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function assertOwnerOnly(path: string, stat: StateStat, label: string): void {
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    fail('corrupt', `${label} is not a private state entry.`);
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
      fail('permission', `${label} does not have a verified owner-only ACL.`);
    }
  }
}

function secureCreatedWindowsEntry(path: string, kind: 'directory' | 'file'): void {
  if (process.platform !== 'win32') return;
  try {
    secureWindowsStatePath(path, kind, { allowOwnerInitialization: true });
  } catch {
    fail('permission', 'Gateway state entry could not be secured.');
  }
}

function assertRoot(paths: WebGatewayProcessStatePaths): void {
  const root = readStat(paths.root);
  if (root.isSymbolicLink() || !root.isDirectory())
    fail('corrupt', 'Gateway state root is invalid.');
  assertOwnerOnly(paths.root, root, 'Gateway state root');
  if (
    paths.descriptor !== join(paths.root, 'process.json') ||
    paths.controlCredential !== join(paths.root, 'control.token') ||
    paths.launchIntent !== join(paths.root, 'launch-intent.json') ||
    paths.instanceLock !== join(paths.root, 'instance.lock') ||
    paths.lifecycleLock !== join(paths.root, 'lifecycle.lock')
  ) {
    fail('invalid_path', 'Gateway state paths do not match the fixed layout.');
  }
}

function readRegularFile(path: string, maxBytes: number, label: string): Buffer | undefined {
  let stat: StateStat;
  try {
    stat = readStat(path);
  } catch (error) {
    if (nativeError(error, 'ENOENT')) return undefined;
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

function readDescriptor(
  paths: WebGatewayProcessStatePaths,
): WebGatewayProcessDescriptor | undefined {
  assertRoot(paths);
  const bytes = readRegularFile(
    paths.descriptor,
    WEB_GATEWAY_PROCESS_STATE_LIMITS.descriptorBytes,
    'Gateway descriptor',
  );
  return bytes === undefined
    ? undefined
    : parseJson(bytes, decodeWebGatewayProcessDescriptor, 'Gateway descriptor');
}

function readControlCredential(paths: WebGatewayProcessStatePaths): string | undefined {
  assertRoot(paths);
  const bytes = readRegularFile(
    paths.controlCredential,
    WEB_GATEWAY_PROCESS_STATE_LIMITS.credentialBytes,
    'Gateway control credential',
  );
  if (bytes === undefined) return undefined;
  try {
    return controlCredential.parse(bytes.toString('utf8'));
  } catch {
    fail('corrupt', 'Gateway control credential is invalid.');
  }
}

function readLaunchIntent(
  paths: WebGatewayProcessStatePaths,
): WebGatewayProcessLaunchIntent | undefined {
  assertRoot(paths);
  const bytes = readRegularFile(
    paths.launchIntent,
    WEB_GATEWAY_PROCESS_STATE_LIMITS.launchIntentBytes,
    'Gateway launch intent',
  );
  return bytes === undefined
    ? undefined
    : parseJson(bytes, (value) => launchIntentSchema.parse(value), 'Gateway launch intent');
}

function lockPath(paths: WebGatewayProcessStatePaths, kind: WebGatewayProcessLockKind): string {
  return kind === 'instance' ? paths.instanceLock : paths.lifecycleLock;
}

function lockIdentityPath(
  paths: WebGatewayProcessStatePaths,
  kind: WebGatewayProcessLockKind,
): string {
  return join(lockPath(paths, kind), LOCK_IDENTITY_FILE);
}

function readLock(
  paths: WebGatewayProcessStatePaths,
  kind: WebGatewayProcessLockKind,
): WebGatewayProcessLockIdentity | undefined {
  assertRoot(paths);
  const path = lockPath(paths, kind);
  let stat: StateStat;
  try {
    stat = readStat(path);
  } catch (error) {
    if (nativeError(error, 'ENOENT')) return undefined;
    fail('io', `${kind} lock could not be inspected.`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('corrupt', `${kind} lock is invalid.`);
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
    WEB_GATEWAY_PROCESS_STATE_LIMITS.lockIdentityBytes,
    `${kind} lock identity`,
  );
  if (bytes === undefined) fail('missing', `${kind} lock identity is missing.`);
  const identity = parseJson(bytes, decodeWebGatewayProcessLockIdentity, `${kind} lock identity`);
  if (identity.kind !== kind) fail('corrupt', `${kind} lock identity kind mismatches.`);
  return identity;
}

function encodeJson(value: unknown, label: string): Buffer {
  try {
    assertCoordinatorJsonValue(value);
    return Buffer.from(JSON.stringify(value), 'utf8');
  } catch {
    fail('corrupt', `${label} failed strict validation.`);
  }
}

function temporaryPath(root: string, target: string): string {
  const name = `.${target.split(/[\\/]/u).at(-1) ?? 'state'}-${randomBytes(16).toString('hex')}.tmp`;
  if (Buffer.byteLength(name, 'utf8') > WEB_GATEWAY_PROCESS_STATE_LIMITS.temporaryNameBytes) {
    fail('invalid_path', 'Gateway temporary state name is oversized.');
  }
  return join(root, name);
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    fsyncSync(fd);
  } catch {
    fail('io', 'Gateway state directory could not be flushed.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function publishFile(
  paths: WebGatewayProcessStatePaths,
  target: string,
  bytes: Buffer,
  label: string,
): void {
  assertRoot(paths);
  if (dirname(target) !== paths.root) fail('invalid_path', `${label} path is invalid.`);
  let existing: StateStat | undefined;
  try {
    existing = readStat(target);
  } catch (error) {
    if (!nativeError(error, 'ENOENT')) fail('io', `${label} could not be inspected.`);
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
      fail('corrupt', `${label} is not a private regular file.`);
    }
    assertOwnerOnly(target, existing, label);
  }
  const temporary = temporaryPath(paths.root, target);
  let fd: number | undefined;
  let published = false;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      FILE_MODE,
    );
    writeFileSync(fd, bytes);
    if (process.platform !== 'win32') fchmodSync(fd, FILE_MODE);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedWindowsEntry(temporary, 'file');
    renameSync(temporary, target);
    published = true;
    syncDirectory(paths.root);
    const after = readStat(target);
    if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1)
      fail('corrupt', `${label} changed during publication.`);
    assertOwnerOnly(target, after, label);
  } catch (error) {
    if (error instanceof WebGatewayProcessStateError) throw error;
    fail('io', `${label} could not be published.`);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!published) {
      try {
        unlinkSync(temporary);
      } catch {
        // Only this attempt's temporary path is ever removed.
      }
    }
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function removeFile(
  paths: WebGatewayProcessStatePaths,
  target: string,
  expected: unknown,
  label: string,
): void {
  assertRoot(paths);
  let before: StateStat | undefined;
  try {
    before = readStat(target);
  } catch (error) {
    if (nativeError(error, 'ENOENT')) return;
    fail('io', `${label} could not be inspected.`);
  }
  if (!before) return;
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1)
    fail('corrupt', `${label} is invalid.`);
  assertOwnerOnly(target, before, label);
  const bytes = readRegularFile(target, WEB_GATEWAY_PROCESS_STATE_LIMITS.descriptorBytes, label);
  if (bytes === undefined) return;
  let actual: unknown;
  try {
    actual = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    fail('corrupt', `${label} is not valid JSON.`);
  }
  if (!sameJson(actual, expected)) fail('corrupt', `${label} does not match cleanup identity.`);
  const current = readStat(target);
  if (current.dev !== before.dev || current.ino !== before.ino)
    fail('corrupt', `${label} changed during cleanup.`);
  unlinkSync(target);
  syncDirectory(paths.root);
}

function removeCredential(
  paths: WebGatewayProcessStatePaths,
  expected: string,
  label: string,
): void {
  assertRoot(paths);
  let before: StateStat | undefined;
  try {
    before = readStat(paths.controlCredential);
  } catch (error) {
    if (nativeError(error, 'ENOENT')) return;
    fail('io', `${label} could not be inspected.`);
  }
  if (!before) return;
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    fail('corrupt', `${label} is invalid.`);
  }
  assertOwnerOnly(paths.controlCredential, before, label);
  const bytes = readRegularFile(
    paths.controlCredential,
    WEB_GATEWAY_PROCESS_STATE_LIMITS.credentialBytes,
    label,
  );
  if (bytes === undefined || bytes.toString('utf8') !== expected) {
    fail('corrupt', `${label} does not match cleanup identity.`);
  }
  const current = readStat(paths.controlCredential);
  if (current.dev !== before.dev || current.ino !== before.ino) {
    fail('corrupt', `${label} changed during cleanup.`);
  }
  unlinkSync(paths.controlCredential);
  syncDirectory(paths.root);
}

function removeLock(
  paths: WebGatewayProcessStatePaths,
  kind: WebGatewayProcessLockKind,
  expected: WebGatewayProcessLockIdentity,
): void {
  assertRoot(paths);
  const path = lockPath(paths, kind);
  const before = readStat(path);
  if (before.isSymbolicLink() || !before.isDirectory()) fail('corrupt', `${kind} lock is invalid.`);
  assertOwnerOnly(path, before, `${kind} lock`);
  const actual = readLock(paths, kind);
  if (!actual || !sameJson(actual, expected)) fail('corrupt', `${kind} lock identity mismatches.`);
  const current = readStat(path);
  if (current.dev !== before.dev || current.ino !== before.ino)
    fail('corrupt', `${kind} lock changed during cleanup.`);
  unlinkSync(lockIdentityPath(paths, kind));
  rmdirSync(path);
  syncDirectory(paths.root);
}

function tryAcquireLock(
  paths: WebGatewayProcessStatePaths,
  kind: WebGatewayProcessLockKind,
  identity: WebGatewayProcessLockIdentity,
): WebGatewayProcessLockLease | undefined {
  assertRoot(paths);
  const path = lockPath(paths, kind);
  try {
    mkdirSync(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (nativeError(error, 'EEXIST')) {
      const existing = readStat(path);
      if (existing.isSymbolicLink() || !existing.isDirectory())
        fail('corrupt', `${kind} lock is invalid.`);
      assertOwnerOnly(path, existing, `${kind} lock`);
      return undefined;
    }
    fail('io', `${kind} lock could not be acquired.`);
  }
  let released = false;
  try {
    secureCreatedWindowsEntry(path, 'directory');
    const lockStat = readStat(path);
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory())
      fail('corrupt', `${kind} lock changed during acquisition.`);
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
    syncDirectory(paths.root);
    return Object.freeze({
      kind,
      identity,
      async release() {
        if (released) return;
        const current = readStat(path);
        if (
          current.isSymbolicLink() ||
          !current.isDirectory() ||
          current.dev !== lockStat.dev ||
          current.ino !== lockStat.ino
        ) {
          fail('corrupt', `${kind} lock is no longer owned by this handle.`);
        }
        const actual = readLock(paths, kind);
        if (!actual || actual.nonce !== identity.nonce)
          fail('corrupt', `${kind} lock is no longer owned by this handle.`);
        unlinkSync(lockIdentityPath(paths, kind));
        rmdirSync(path);
        syncDirectory(paths.root);
        released = true;
      },
    });
  } catch (error) {
    try {
      if (readdirSync(path).length === 0) rmdirSync(path);
    } catch {
      // Preserve state if another owner changed the path.
    }
    if (error instanceof WebGatewayProcessStateError) throw error;
    fail('io', `${kind} lock identity could not be published.`);
  }
}

/** Convert a process descriptor into the path-free Coordinator registry entry. */
export function gatewayRegistrationFromDescriptor(
  descriptor: WebGatewayProcessDescriptor,
  lastSeenAt = descriptor.startedAt,
): CoordinatorGatewayRegistration {
  return Object.freeze({
    identity: descriptor.identity,
    endpoint: descriptor.endpoint,
    state: 'ready' as const,
    startedAt: descriptor.startedAt,
    lastSeenAt,
  });
}

export type { CoordinatorWebGatewayEndpoint, CoordinatorWebGatewayIdentity };
