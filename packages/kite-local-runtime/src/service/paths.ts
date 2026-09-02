import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export type KiteHomeIdentitySource = 'os_user_home' | 'explicit_argument';

export interface KiteHomeIdentity {
  readonly root: string;
  readonly source: KiteHomeIdentitySource;
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

export const KITE_LOCAL_RUNTIME_ENDPOINT_VERSION = 'v1' as const;

export type KiteLocalRuntimeEndpoint =
  | {
      readonly kind: 'unix';
      readonly homeDigest: string;
      readonly root: string;
      readonly socket: string;
      readonly lifecycleReservation: string;
    }
  | {
      readonly kind: 'named_pipe';
      readonly homeDigest: string;
      readonly pipeName: string;
    };

/** Stable, path-free identity used only for ephemeral per-home runtime discovery. */
export function kiteHomeRuntimeDigest(identity: KiteHomeIdentity): string {
  return createHash('sha256').update(identity.root, 'utf8').digest('hex').slice(0, 32);
}

/** Explicit App Server daemon endpoint derived without reading or creating state. */
export function resolveKiteAppServerDaemonEndpoint(input: {
  readonly home: KiteHomeIdentity;
  readonly platform?: NodeJS.Platform;
  readonly runtimeParent?: string;
}): KiteLocalRuntimeEndpoint {
  const platform = input.platform ?? process.platform;
  const homeDigest = kiteHomeRuntimeDigest(input.home);
  if (platform === 'win32') {
    return Object.freeze({
      kind: 'named_pipe',
      homeDigest,
      pipeName: `\\\\.\\pipe\\kite-app-server-${KITE_LOCAL_RUNTIME_ENDPOINT_VERSION}-${homeDigest}`,
    });
  }
  const runtimeParent = assertAbsoluteCleanPath(input.runtimeParent ?? '', 'OS runtime parent');
  const root = join(runtimeParent, 'kite-code', KITE_LOCAL_RUNTIME_ENDPOINT_VERSION, homeDigest);
  return Object.freeze({
    kind: 'unix',
    homeDigest,
    root,
    socket: join(root, 'app-server.sock'),
    lifecycleReservation: join(root, 'app-server.lock'),
  });
}
