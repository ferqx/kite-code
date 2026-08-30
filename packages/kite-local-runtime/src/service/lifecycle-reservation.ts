import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import {
  decodeKiteLocalRuntimeLifecycleReservation,
  type KiteLocalRuntimeLifecycleReservation,
} from './native-protocol';
import type { KiteLocalRuntimeEndpoint } from './paths';

const MAX_RESERVATION_BYTES = 4_096;

export interface KiteLocalRuntimeProcessIdentityProbe {
  inspect(pid: number, processStartIdentity: string): Promise<'alive' | 'dead' | 'uncertain'>;
}

export type KiteLocalRuntimeDeadEndpointCleanupResult =
  | { readonly outcome: 'absent' | 'cleared' }
  | { readonly outcome: 'blocked'; readonly diagnostic: 'alive' | 'identity_uncertain' | 'drift' };

/** Read the minimal Unix lifecycle owner record without following links or mutating state. */
export function readKiteLocalRuntimeLifecycleReservation(
  endpoint: KiteLocalRuntimeEndpoint,
): KiteLocalRuntimeLifecycleReservation | undefined {
  if (endpoint.kind !== 'unix') return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      endpoint.lifecycleReservation,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_RESERVATION_BYTES) {
      throw new Error('Local Service lifecycle reservation is invalid.');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Local Service lifecycle reservation owner is invalid.');
    }
    return decodeKiteLocalRuntimeLifecycleReservation(
      JSON.parse(readFileSync(descriptor, 'utf8')) as unknown,
    );
  } catch (error) {
    if (errorCodeIs(error, 'ENOENT')) return undefined;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Clear a stale Unix endpoint only after this function obtains exact PID/start-identity dead
 * proof and re-reads the same lifecycle/socket identity. Alive, uncertain or drift stays intact.
 */
export async function clearDeadKiteLocalRuntimeEndpoint(input: {
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly expected: KiteLocalRuntimeLifecycleReservation;
  readonly process: KiteLocalRuntimeProcessIdentityProbe;
}): Promise<KiteLocalRuntimeDeadEndpointCleanupResult> {
  if (input.endpoint.kind !== 'unix') {
    return { outcome: 'blocked', diagnostic: 'identity_uncertain' };
  }
  const status = await input.process.inspect(
    input.expected.pid,
    input.expected.processStartIdentity,
  );
  if (status === 'alive') return { outcome: 'blocked', diagnostic: 'alive' };
  if (status !== 'dead') return { outcome: 'blocked', diagnostic: 'identity_uncertain' };
  const current = readKiteLocalRuntimeLifecycleReservation(input.endpoint);
  if (!current) return { outcome: 'absent' };
  if (!sameReservation(current, input.expected)) {
    return { outcome: 'blocked', diagnostic: 'drift' };
  }
  if (current.socketDevice !== undefined && current.socketInode !== undefined) {
    let socket: ReturnType<typeof lstatSync> | undefined;
    try {
      socket = lstatSync(input.endpoint.socket);
    } catch (error) {
      if (!errorCodeIs(error, 'ENOENT')) throw error;
      socket = undefined;
    }
    if (socket) {
      if (
        socket.isSymbolicLink() ||
        !socket.isSocket() ||
        socket.dev !== current.socketDevice ||
        socket.ino !== current.socketInode
      ) {
        return { outcome: 'blocked', diagnostic: 'drift' };
      }
      unlinkSync(input.endpoint.socket);
    }
  } else if (entryExists(input.endpoint.socket)) {
    return { outcome: 'blocked', diagnostic: 'drift' };
  }
  const afterSocket = readKiteLocalRuntimeLifecycleReservation(input.endpoint);
  if (!afterSocket || !sameReservation(afterSocket, current)) {
    return { outcome: 'blocked', diagnostic: 'drift' };
  }
  unlinkSync(input.endpoint.lifecycleReservation);
  try {
    rmdirSync(input.endpoint.root);
  } catch (error) {
    if (!errorCodeIs(error, 'ENOENT') && !errorCodeIs(error, 'ENOTEMPTY')) throw error;
  }
  return { outcome: 'cleared' };
}

function sameReservation(
  left: KiteLocalRuntimeLifecycleReservation,
  right: KiteLocalRuntimeLifecycleReservation,
): boolean {
  return (
    left.schema === right.schema &&
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    left.instanceId === right.instanceId &&
    left.buildId === right.buildId &&
    left.startedAt === right.startedAt &&
    left.socketDevice === right.socketDevice &&
    left.socketInode === right.socketInode
  );
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCodeIs(error, 'ENOENT')) return false;
    throw error;
  }
}

function errorCodeIs(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
