import { isAbsolute, join, resolve } from 'node:path';
import type { LocalRuntimeServiceDescriptor } from './codecs';

export const LOCAL_RUNTIME_SERVICE_STATE_DIRECTORY = Object.freeze([
  'runtime-service',
  'v1',
] as const);

export type KiteHomeIdentitySource = 'os_user_home' | 'explicit_argument';

export interface KiteHomeIdentity {
  readonly root: string;
  readonly source: KiteHomeIdentitySource;
}

export interface LocalRuntimeServiceStatePaths {
  readonly root: string;
  readonly descriptor: string;
  readonly accessToken: string;
  readonly controlToken: string;
  readonly instanceLock: string;
  readonly lifecycleLock: string;
}

function assertAbsoluteCleanPath(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !isAbsolute(value) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new TypeError(`${label} must be a non-empty absolute path without control characters`);
  }
  return resolve(value);
}

/**
 * Create the identity used to derive Service state. This is intentionally lexical: callers that
 * accept a custom home must perform their no-follow/realpath and owner/ACL checks before passing
 * the validated result here.
 */
export function createKiteHomeIdentity(
  root: string,
  source: KiteHomeIdentitySource = 'explicit_argument',
): KiteHomeIdentity {
  return Object.freeze({ root: assertAbsoluteCleanPath(root, 'Kite home'), source });
}

export function localRuntimeServiceStateRoot(identity: KiteHomeIdentity): string {
  return join(identity.root, ...LOCAL_RUNTIME_SERVICE_STATE_DIRECTORY);
}

/**
 * Return the fixed V1 state layout. No file is read, created, followed, or removed by this
 * helper; service lifecycle code owns those operations and their no-follow/ACL checks.
 */
export function resolveLocalRuntimeServiceStatePaths(
  identity: KiteHomeIdentity,
): LocalRuntimeServiceStatePaths {
  const root = localRuntimeServiceStateRoot(identity);
  return Object.freeze({
    root,
    descriptor: join(root, 'instance.json'),
    accessToken: join(root, 'access.token'),
    controlToken: join(root, 'control.token'),
    instanceLock: join(root, 'instance.lock'),
    lifecycleLock: join(root, 'lifecycle.lock'),
  });
}

export interface LocalRuntimeServiceStatePort {
  readonly paths: LocalRuntimeServiceStatePaths;
  readDescriptor(): Promise<LocalRuntimeServiceDescriptor | undefined>;
  readToken(kind: 'access' | 'control'): Promise<string | undefined>;
}
