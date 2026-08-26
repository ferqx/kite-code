import { randomBytes } from 'node:crypto';
import {
  ensureLocalRuntimeServiceStateRoot,
  type KiteHomeIdentity,
  quarantineLocalRuntimeServiceLock,
  readLocalRuntimeServiceLockIdentity,
  tryAcquireLocalRuntimeServiceLock,
} from '@kite-ai/kite-local-runtime/service';
import type {
  KiteServiceManagerLifecycleLockLease,
  KiteServiceManagerLifecycleLockPort,
  KiteServiceManagerOperation,
  KiteServiceManagerProcessPort,
} from './ports';

function lockIdentity(operation: KiteServiceManagerOperation) {
  return {
    schema: 'kite.local-service-lock.v1' as const,
    nonce: randomBytes(24).toString('base64url'),
    pid: typeof process.pid === 'number' && process.pid > 0 ? process.pid : 1,
    operation,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Native filesystem adapter for the manager lifecycle lock. PID inspection remains injected so
 * tests can model dead/alive/uncertain owners without touching a real process. Only a positively
 * dead lock owner is quarantined; this adapter never kills a PID.
 */
export function createKiteServiceManagerNativeLifecycleLockPort(input: {
  readonly identity: KiteHomeIdentity;
  readonly process: KiteServiceManagerProcessPort;
}): KiteServiceManagerLifecycleLockPort {
  const paths = ensureLocalRuntimeServiceStateRoot(input.identity);
  return Object.freeze({
    async acquire(operation: KiteServiceManagerOperation) {
      const identity = lockIdentity(operation);
      const lock = tryAcquireLocalRuntimeServiceLock(paths, 'lifecycle', identity);
      if (!lock) return undefined;
      const release = async (): Promise<void> => {
        lock.release();
      };
      const lease: KiteServiceManagerLifecycleLockLease = {
        release,
        [Symbol.asyncDispose]: release,
      };
      return Object.freeze(lease);
    },
    async inspect() {
      try {
        const identity = readLocalRuntimeServiceLockIdentity(paths, 'lifecycle');
        if (!identity) return { status: 'absent' as const };
        const status = await input.process.inspect(identity.pid);
        return { status, pid: identity.pid };
      } catch {
        return { status: 'uncertain' as const };
      }
    },
    async quarantineStale() {
      const identity = readLocalRuntimeServiceLockIdentity(paths, 'lifecycle');
      if (!identity) return;
      // Re-check the owner at the point of mutation. The manager's earlier inspect is advisory;
      // this second check plus the exact identity prevents a release/reacquire race from
      // quarantining a replacement owner.
      if ((await input.process.inspect(identity.pid)) !== 'dead') return;
      const quarantined = quarantineLocalRuntimeServiceLock(paths, 'lifecycle', identity);
      quarantined?.remove();
    },
  });
}
