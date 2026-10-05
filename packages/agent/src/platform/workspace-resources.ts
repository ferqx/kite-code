import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { WorkspaceSerialLocks } from '../execution/resource-port';
import type { ProfileSelection } from '../profile';
import { AgentError } from '../storage/types';
import { acquireFileLock, type FileLock, LockBusyError } from './locks';
import { acquireProfileAccess, type ProfileOptions } from './profile';
import { defaultWindowsPathSecurity } from './windows-path-security';

export interface WorkspaceSerialCoordinator extends WorkspaceSerialLocks {
  close(): Promise<void>;
}
interface Waiter {
  identity: string;
  bytes: number;
  signal: AbortSignal;
  abort(): void;
  resolve(release: () => void): void;
  reject(error: unknown): void;
}
/** Explicit OS coordination. Scope is one profile and the persisted Workspace identity. */
export function createWorkspaceSerialLocks(
  profile: ProfileSelection | ProfileOptions,
): WorkspaceSerialCoordinator {
  const access = acquireProfileAccess(profile);
  const security =
    ('windowsPathSecurity' in profile ? profile.windowsPathSecurity : undefined) ??
    defaultWindowsPathSecurity();
  const active = new Map<string, FileLock>();
  const waiters: Waiter[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let finishClose: (() => void) | undefined;
  const drain = () => {
    if (!closing || active.size || closed) return;
    closed = true;
    access.lock.release();
    finishClose?.();
  };
  const remove = (waiter: Waiter) => {
    const index = waiters.indexOf(waiter);
    if (index !== -1) {
      waiters.splice(index, 1);
      bytes -= waiter.bytes;
    }
    waiter.signal.removeEventListener('abort', waiter.abort);
  };
  const pump = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closing) {
      drain();
      return;
    }
    const considered = new Set<string>();
    for (const waiter of [...waiters]) {
      if (active.size >= 128) break;
      if (active.has(waiter.identity) || considered.has(waiter.identity)) continue;
      considered.add(waiter.identity);
      try {
        waiter.signal.throwIfAborted();
        const lock = acquireFileLock(
          join(access.coordinationPath, `workspace-${waiter.identity}.lock`),
          'exclusive',
          security,
        );
        active.set(waiter.identity, lock);
        remove(waiter);
        let released = false;
        waiter.resolve(() => {
          if (released) return;
          released = true;
          lock.release();
          active.delete(waiter.identity);
          pump();
          drain();
        });
      } catch (error) {
        if (error instanceof LockBusyError) continue;
        remove(waiter);
        waiter.reject(error);
      }
    }
    if (waiters.length) timer = setTimeout(pump, 25);
  };
  return {
    acquire(input, signal) {
      if (closing) return Promise.reject(new AgentError('resource_coordinator_closed'));
      if (
        typeof input.workspaceId !== 'string' ||
        !input.workspaceId ||
        input.workspaceId.length > 128 ||
        typeof input.key !== 'string' ||
        !input.key ||
        input.key.length > 512 ||
        Array.from(input.workspaceId + input.key).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        return Promise.reject(new AgentError('invalid_workspace_resource'));
      const identity = createHash('sha256')
        .update(input.workspaceId)
        .update('\0')
        .update(input.key)
        .digest('hex');
      const size = new TextEncoder().encode(input.workspaceId + input.key).byteLength;
      if (waiters.length + active.size >= 256 || bytes + size > 1024 * 1024)
        return Promise.reject(new AgentError('resource_queue_full'));
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const waiter: Waiter = {
          identity,
          bytes: size,
          signal,
          resolve,
          reject,
          abort() {
            remove(waiter);
            reject(signal.reason);
            pump();
          },
        };
        waiters.push(waiter);
        bytes += size;
        signal.addEventListener('abort', waiter.abort, { once: true });
        pump();
      });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      closePromise = new Promise((resolve) => {
        finishClose = resolve;
      });
      for (const waiter of [...waiters]) {
        remove(waiter);
        waiter.reject(new AgentError('resource_coordinator_closed'));
      }
      drain();
      return closePromise;
    },
  };
}
