import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { decodeLocalRuntimeToken, type LocalRuntimeToken } from './codecs';
import { createKiteHomeIdentity, type KiteHomeIdentity } from './paths';
import {
  secureWindowsStatePath,
  verifyWindowsStatePath,
  windowsStateSecurityDiagnostic,
} from './windows-state-security';

export type KiteLocalStateErrorCode = 'invalid_path' | 'corrupt' | 'permission' | 'io';

/** Safe local-state error: messages never include a path or filesystem payload. */
export class KiteLocalStateError extends Error {
  readonly code: KiteLocalStateErrorCode;

  constructor(code: KiteLocalStateErrorCode, message: string) {
    super(message);
    this.name = 'KiteLocalStateError';
    this.code = code;
  }
}

/** Generate one process-scoped bearer token for internal loopback carriers. */
export function createLocalRuntimeServiceToken(): LocalRuntimeToken {
  return decodeLocalRuntimeToken(randomBytes(32).toString('base64url'));
}

type PortableDirectoryStat = {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid?: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

const POSIX_OWNER_MASK = 0o077;
const POSIX_DIRECTORY_MODE = 0o700;

function fail(code: KiteLocalStateErrorCode, message: string): never {
  throw new KiteLocalStateError(code, message);
}

function filesystemCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function safeAbsolutePath(path: string): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !isAbsolute(path) ||
    [...path].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    })
  ) {
    fail('invalid_path', 'Local state path is not a safe absolute path.');
  }
  return resolve(path);
}

function lstatDirectory(path: string): PortableDirectoryStat | undefined {
  try {
    return lstatSync(path) as unknown as PortableDirectoryStat;
  } catch (error) {
    if (filesystemCode(error, 'ENOENT')) return undefined;
    fail('io', 'Local state directory could not be inspected.');
  }
}

function verifyOwnerOnly(path: string, stat: PortableDirectoryStat, label: string): void {
  if (process.platform === 'win32') {
    try {
      verifyWindowsStatePath(path, 'directory');
      return;
    } catch (error) {
      const diagnostic = windowsStateSecurityDiagnostic(error);
      fail(
        'permission',
        diagnostic
          ? `${label} owner ACL is invalid (${diagnostic}).`
          : `${label} owner ACL is invalid.`,
      );
    }
  }
  if ((stat.mode & POSIX_OWNER_MASK) !== 0) fail('permission', `${label} is not owner-only.`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('permission', `${label} has a different owner.`);
  }
}

function ensureDirectory(path: string, label: string, ownerOnly: boolean): void {
  let stat = lstatDirectory(path);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    fail('corrupt', `${label} is not a real directory.`);
  }
  if (!stat) {
    try {
      mkdirSync(path, { mode: POSIX_DIRECTORY_MODE });
    } catch (error) {
      if (!filesystemCode(error, 'EEXIST')) fail('io', `${label} could not be created.`);
    }
    stat = lstatDirectory(path);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('corrupt', `${label} changed during creation.`);
    }
  }
  if (!ownerOnly) return;
  try {
    if (process.platform === 'win32') {
      secureWindowsStatePath(path, 'directory', { allowOwnerInitialization: true });
    } else {
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        fail('permission', `${label} has a different owner.`);
      }
      chmodSync(path, POSIX_DIRECTORY_MODE);
    }
  } catch (error) {
    if (error instanceof KiteLocalStateError) throw error;
    fail('permission', `${label} could not be secured.`);
  }
  const secured = lstatDirectory(path);
  if (!secured || secured.dev !== stat.dev || secured.ino !== stat.ino) {
    fail('corrupt', `${label} changed while being secured.`);
  }
  verifyOwnerOnly(path, secured, label);
}

function segmentsUnderRoot(target: string): {
  readonly anchor: string;
  readonly segments: string[];
} {
  const absolute = safeAbsolutePath(target);
  const anchor = parse(absolute).root;
  const tail = relative(anchor, absolute);
  return { anchor, segments: tail === '' ? [] : tail.split(sep).filter(Boolean) };
}

/** Create or verify the explicit Kite profile home without following aliases. */
export function ensureKiteProfileHome(identity: KiteHomeIdentity): KiteHomeIdentity {
  const parsed = segmentsUnderRoot(identity.root);
  if (parsed.segments.length === 0)
    fail('invalid_path', 'Kite home must not be a filesystem root.');
  let current = parsed.anchor;
  for (let index = 0; index < parsed.segments.length; index += 1) {
    current = join(current, parsed.segments[index]!);
    ensureDirectory(current, 'Kite home', index === parsed.segments.length - 1);
  }
  try {
    return createKiteHomeIdentity(realpathSync.native(identity.root), identity.source);
  } catch {
    fail('io', 'Kite home could not be resolved after validation.');
  }
}

/** Create one fixed owner-only state subtree beneath a validated Kite profile home. */
export function ensurePrivateKiteHomeDirectory(
  identity: KiteHomeIdentity,
  segments: readonly string[],
): string {
  if (
    segments.length === 0 ||
    segments.length > 8 ||
    segments.some((segment) => !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(segment))
  ) {
    fail('invalid_path', 'Private Kite home directory segments are invalid.');
  }
  let current = ensureKiteProfileHome(identity).root;
  for (const segment of segments) {
    current = join(current, segment);
    ensureDirectory(current, 'Private Kite home state directory', true);
  }
  return current;
}
