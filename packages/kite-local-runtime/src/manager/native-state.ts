import {
  clearLocalRuntimeServiceState,
  ensureLocalRuntimeServiceStateRoot,
  type KiteHomeIdentity,
  type LocalRuntimeServiceDescriptor,
  type LocalRuntimeServiceStatePaths,
  type LocalRuntimeToken,
  publishLocalRuntimeServiceDescriptor,
  publishLocalRuntimeServiceToken,
  readLocalRuntimeServiceDescriptor,
  readLocalRuntimeServiceLockIdentity,
  readLocalRuntimeServiceToken,
} from '../service';
import type { KiteServiceManagerStatePort } from './ports';

export interface KiteServiceManagerNativeStatePort extends KiteServiceManagerStatePort {
  readonly paths: LocalRuntimeServiceStatePaths;
  publishDescriptor(value: unknown): Promise<LocalRuntimeServiceDescriptor>;
  publishToken(kind: 'access' | 'control', value: unknown): Promise<LocalRuntimeToken>;
}

function readCleanup(paths: LocalRuntimeServiceStatePaths) {
  return {
    descriptor: readLocalRuntimeServiceDescriptor(paths),
    accessToken: readLocalRuntimeServiceToken(paths, 'access'),
    controlToken: readLocalRuntimeServiceToken(paths, 'control'),
    instanceLock: readLocalRuntimeServiceLockIdentity(paths, 'instance'),
  };
}

/**
 * Bind the manager to the Native state primitive using an already validated, explicit home
 * identity. This function never reads cwd or `process.env.KITE_CODE_HOME`; ambient environment
 * values are intentionally outside the Service identity boundary.
 */
export function createKiteServiceManagerNativeStatePort(
  identity: KiteHomeIdentity,
): KiteServiceManagerNativeStatePort {
  const paths = ensureLocalRuntimeServiceStateRoot(identity);
  return Object.freeze({
    paths,
    async readDescriptor() {
      return readLocalRuntimeServiceDescriptor(paths);
    },
    async readToken(kind: 'access' | 'control') {
      return readLocalRuntimeServiceToken(paths, kind);
    },
    async readInstanceLock() {
      return readLocalRuntimeServiceLockIdentity(paths, 'instance');
    },
    async clearStale() {
      // The manager calls this only after a positive dead-PID observation. Exact identity reads
      // keep a concurrent replacement from being deleted by stale recovery.
      const cleanup = readCleanup(paths);
      clearLocalRuntimeServiceState(paths, cleanup);
    },
    async preserveFailure() {
      // Failure evidence is the state already on disk. Do not remove or rewrite it here.
    },
    async publishDescriptor(value: unknown) {
      return publishLocalRuntimeServiceDescriptor(paths, value);
    },
    async publishToken(kind: 'access' | 'control', value: unknown) {
      return publishLocalRuntimeServiceToken(paths, kind, value);
    },
  });
}
