import { join } from 'node:path';
import { canonicalJson } from './json';
import {
  acquireExistingSharedFileLock,
  acquireFileLock,
  type FileLock,
  LockBusyError,
} from './platform/locks';
import { createOwnedWorker, ownedWorkerAssets } from './platform/process/owned-worker';
import { acquireProfileAccess, acquireSessionLock, type ProfileOptions } from './platform/profile';
import { initializeDefaultSqliteEngine } from './sqlite-engine';
import type { Store } from './storage/port';
import {
  AgentError,
  type JobRecoveryLease,
  type Json,
  type OwnerRef,
  type RunResumeLease,
} from './storage/types';
import { deserializeStorageError, isStorageTransactionUnconfirmed } from './storage/worker/error';
import { storeMethods } from './storage/worker/protocol';
import type { DbTiming } from './storage/worker/timing';

export type { DbTiming } from './storage/worker/timing';
export interface OpenSqliteStoreOptions extends ProfileOptions {
  mode?: 'readwrite' | 'readonly';
  onTiming?: (observation: DbTiming) => void;
}
export type SqliteStorePreflight = import('./storage/sqlite/connection').StorePreflight;

// Failed startup has no returned Store to own native cleanup. Retain the exact
// capability and attach its retry to the error; never recreate or re-send work.
const retainedStartupCleanups = new Set<() => Promise<void>>();
async function failedOpenCleanup(original: unknown, cleanup: () => Promise<void>): Promise<never> {
  try {
    await cleanup();
  } catch (failure) {
    const retryCleanup = async () => {
      await cleanup();
      retainedStartupCleanups.delete(retryCleanup);
    };
    retainedStartupCleanups.add(retryCleanup);
    throw Object.assign(
      new AggregateError([original, failure], 'Database open and resource cleanup failed.', {
        cause: original,
      }),
      { retryCleanup },
    );
  }
  throw original;
}

/** Exact loader assets; pure metadata, no database or filesystem access. */
export function sqliteStorageAssets() {
  const observer = ownedWorkerAssets();
  return Object.freeze({
    module: new URL(import.meta.url),
    worker: new URL(
      import.meta.url.endsWith('.ts') ? './storage/worker/main.ts' : './storage/worker/main.js',
      import.meta.url,
    ),
    baseline: new URL('./storage/migrations/0001-baseline.sql', import.meta.url),
    migrations: Object.freeze([
      new URL('./storage/migrations/0001-baseline.sql', import.meta.url),
      new URL('./storage/migrations/0002-recovery-audit.sql', import.meta.url),
      new URL('./storage/migrations/0003-session-reconciliation.sql', import.meta.url),
      new URL('./storage/migrations/0004-pending-input-order.sql', import.meta.url),
      new URL('./storage/migrations/0005-authorization-check.sql', import.meta.url),
      new URL('./storage/migrations/0006-input-file-imports.sql', import.meta.url),
    ]),
    preload: observer.preload,
    observerModules: observer.modules,
  });
}

/** Readonly startup qualification; launch must still perform its own admission checks. */
export async function preflightSqliteStore(options: ProfileOptions): Promise<SqliteStorePreflight> {
  initializeDefaultSqliteEngine();
  let access: ReturnType<typeof acquireProfileAccess> | undefined;
  let closeConfirmed = true;
  try {
    access = acquireProfileAccess(options);
    const { preflightDatabase } = await import('./storage/sqlite/connection');
    return preflightDatabase(access, sqliteStorageAssets().baseline);
  } catch (error) {
    const reported =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error
          ? error.message
          : '';
    const codes = [
      'owner_busy',
      'restore_reconciliation_required',
      'store_access_denied',
      'store_incompatible',
      'store_journal_present',
      'store_preflight_cleanup_failed',
    ];
    const code = codes.includes(reported)
      ? reported
      : !access || ['EACCES', 'EPERM', 'Symlink paths are unsupported.'].includes(reported)
        ? 'store_access_denied'
        : 'store_incompatible';
    if (code === 'store_preflight_cleanup_failed') closeConfirmed = false;
    throw new AgentError(code, 'SQLite startup preflight failed.');
  } finally {
    // Unconfirmed close conservatively retains profile use until this process exits.
    if (closeConfirmed) access?.lock.release();
  }
}

/** Explicit I/O entry. Root import never opens a database or launches this Worker. */
export async function openSqliteStore(options: OpenSqliteStoreOptions): Promise<Store> {
  const selectedEngine = initializeDefaultSqliteEngine();
  const engine = selectedEngine.qualification === 'selected' ? selectedEngine.selection : null;
  const access = acquireProfileAccess(options);
  let worker: Worker;
  let owned: ReturnType<typeof createOwnedWorker>;
  try {
    owned = createOwnedWorker(sqliteStorageAssets().worker.href);
    worker = owned.worker;
  } catch (error) {
    return failedOpenCleanup(error, async () => access.lock.release());
  }
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; bytes: number }
  >();
  const owners = new Map<
    string,
    { owner: OwnerRef; lock: FileLock; sqlReleased?: boolean; releasing?: Promise<boolean> }
  >();
  const recoveryLeases = new Map<
    string,
    {
      lease: JobRecoveryLease | RunResumeLease;
      lock: FileLock;
      sqlReleased?: boolean;
      releasing?: Promise<void>;
      committing?: boolean;
    }
  >();
  const retainedLocalLocks = new Map<FileLock, string>();
  const localLockHeld = (sessionId: string) => [...retainedLocalLocks.values()].includes(sessionId);
  const releaseLocalLock = (lock: FileLock, sessionId: string) => {
    try {
      lock.release();
      retainedLocalLocks.delete(lock);
    } catch (error) {
      retainedLocalLocks.set(lock, sessionId);
      throw error;
    }
  };
  const failedLocalCleanup = (lock: FileLock, sessionId: string, original: unknown): never => {
    if (failed || isStorageTransactionUnconfirmed(original)) {
      retainedLocalLocks.set(lock, sessionId);
      throw original;
    }
    try {
      releaseLocalLock(lock, sessionId);
    } catch (cleanup) {
      throw new AggregateError([original, cleanup], 'Database operation and lock cleanup failed.', {
        cause: original,
      });
    }
    throw original;
  };
  let sequence = 0;
  let queuedBytes = 0;
  let closed = false;
  let failed = false;
  let failure: Error | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  // Present only after DB acknowledgement and confirmed Worker termination. A retry
  // can finish retained native cleanup without reopening the Store or owner authority.
  let cleanupAfterClose: (() => void) | undefined;
  let activeRequests = 0;
  let drained: (() => void) | undefined;
  const waiting = { ordinary: new Map<number, number>(), critical: new Map<number, number>() };
  let criticalAdmissions = 0;
  let capacityChanged: () => void;
  let capacity = new Promise<void>((resolve) => {
    capacityChanged = resolve;
  });
  const wakeCapacity = () => {
    const wake = capacityChanged;
    capacity = new Promise<void>((resolve) => {
      capacityChanged = resolve;
    });
    wake();
  };
  const rejectAll = (error: Error) => {
    failed = true;
    failure = error;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    queuedBytes = 0;
    wakeCapacity();
  };
  worker.onmessage = (
    event: MessageEvent<{
      id: number;
      result?: unknown;
      timing?: DbTiming;
      error?: { code: string; message: string };
    }>,
  ) => {
    const item = pending.get(event.data.id);
    if (!item) return;
    pending.delete(event.data.id);
    queuedBytes -= item.bytes;
    wakeCapacity();
    if (event.data.error) item.reject(deserializeStorageError(event.data.error));
    else item.resolve(event.data.result);
    if (event.data.timing && options.onTiming) {
      try {
        options.onTiming(Object.freeze(event.data.timing));
      } catch {
        /* Observation cannot change committed business facts. */
      }
    }
  };
  worker.onerror = () =>
    rejectAll(
      new AgentError(
        'worker_unavailable',
        'Database Worker failed; unacknowledged writes require lookup.',
      ),
    );
  const validateIdentity = (args: unknown[]): void => {
    if (failed) throw failure!;
    if (closed) throw new AgentError('store_closed');
    const recovery = args[0] as { lease?: JobRecoveryLease | RunResumeLease } | undefined;
    if (recovery?.lease) {
      const held = recoveryLeases.get(recovery.lease.sessionId);
      if (
        !held ||
        held.sqlReleased ||
        held.releasing ||
        canonicalJson(held.lease as unknown as Json) !==
          canonicalJson(recovery.lease as unknown as Json)
      )
        throw new AgentError('recovery_lease_changed');
    }
    const owned = args[0] as { owner?: OwnerRef } | undefined;
    if (owned?.owner) {
      const held = owners.get(owned.owner.sessionId);
      if (
        !held ||
        held.sqlReleased ||
        held.owner.instanceId !== owned.owner.instanceId ||
        held.owner.generation !== owned.owner.generation
      )
        throw new AgentError('owner_changed');
    }
  };
  const request = async (method: string, args: unknown[]): Promise<unknown> => {
    if (
      method !== 'open' &&
      method !== 'getRecoveryReceipt' &&
      method !== 'inspectSessionReconciliation' &&
      !storeMethods.includes(method as keyof Store)
    )
      throw new AgentError('unsupported_store_operation');
    if (closing && method !== 'close') throw new AgentError('store_closed');
    validateIdentity(args);
    const id = ++sequence;
    const message = { id, method, args };
    const encoder = new TextEncoder();
    let bytes = encoder.encode(JSON.stringify(message)).byteLength;
    const critical = [
      'close',
      'cancelCommand',
      'cancelWork',
      'deleteSession',
      'removeWorkspace',
      'finishExecution',
      'markRunning',
      'finishRun',
      'releaseSessionOwner',
      'recoverSession',
      'stopActionPreparation',
    ].includes(method);
    const byteLimit = (critical ? 16 : 14) * 1024 * 1024;
    if (bytes > byteLimit)
      throw new AgentError('storage_queue_full', 'Database request exceeds queue capacity.', true);
    const tickets = critical ? waiting.critical : waiting.ordinary;
    activeRequests++;
    tickets.set(id, bytes);
    try {
      // Producers retain their arguments; only ticket identities wait here. Capacity covers
      // complete posted frames, with the original reservation for necessary control facts.
      for (;;) {
        validateIdentity(args);
        const ordinary = waiting.ordinary.entries().next().value;
        const control = waiting.critical.entries().next().value;
        const ordinaryReady =
          !!ordinary && pending.size < 224 && queuedBytes + ordinary[1] <= 14 * 1024 * 1024;
        const controlReady =
          !!control && pending.size < 256 && queuedBytes + control[1] <= 16 * 1024 * 1024;
        if (
          tickets.keys().next().value === id &&
          (critical
            ? !ordinaryReady || criticalAdmissions < 4
            : !controlReady || criticalAdmissions >= 4) &&
          pending.size < (critical ? 256 : 224) &&
          queuedBytes + bytes <= byteLimit
        )
          break;
        await capacity;
        bytes = encoder.encode(JSON.stringify(message)).byteLength;
        if (bytes > byteLimit)
          throw new AgentError(
            'storage_queue_full',
            'Database request exceeds queue capacity.',
            true,
          );
        tickets.set(id, bytes);
      }
      tickets.delete(id);
      criticalAdmissions = critical ? Math.min(4, criticalAdmissions + 1) : 0;
      queuedBytes += bytes;
      // No await between capacity reservation and posting, and no retry after posting.
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, bytes });
        try {
          worker.postMessage(message);
        } catch (error) {
          pending.delete(id);
          queuedBytes -= bytes;
          reject(error);
        }
        wakeCapacity();
      });
    } finally {
      tickets.delete(id);
      wakeCapacity();
      if (--activeRequests === 0) drained?.();
    }
  };
  let migration: FileLock | undefined;
  try {
    if (options.mode !== 'readonly') {
      const deadline = Date.now() + 2000;
      for (;;) {
        try {
          migration = acquireFileLock(
            join(access.coordinationPath, 'migration.lock'),
            'exclusive',
            options.windowsPathSecurity,
          );
          break;
        } catch (error) {
          if (!(error instanceof LockBusyError) || Date.now() >= deadline) throw error;
          await Bun.sleep(10);
        }
      }
    }
    await request('open', [
      { access: { ...access, lock: undefined }, readOnly: options.mode === 'readonly', engine },
    ]);
    migration?.release();
    migration = undefined;
  } catch (error) {
    let termination: Promise<void> | undefined;
    return failedOpenCleanup(error, async () => {
      termination ??= owned.terminate();
      await termination;
      closed = true;
      rejectAll(new AgentError('store_closed'));
      migration?.release();
      migration = undefined;
      access.lock.release();
    });
  }
  const releaseRecoveryLease = async (
    lease: RunResumeLease | JobRecoveryLease,
    method: 'releaseRunResumeLease' | 'releaseJobRecoveryLease',
  ) => {
    const held = recoveryLeases.get(lease.sessionId);
    if (!held) return;
    if (
      lease.kind !== (method === 'releaseRunResumeLease' ? 'run_resume' : 'job_reconciliation') ||
      held.committing ||
      canonicalJson(held.lease as unknown as Json) !== canonicalJson(lease as unknown as Json)
    )
      throw new AgentError('recovery_lease_changed');
    if (held.releasing) return held.releasing;
    const attempt = (async () => {
      if (!held.sqlReleased) {
        await request(method, [lease]);
        held.sqlReleased = true;
      }
      held.lock.release();
      recoveryLeases.delete(lease.sessionId);
    })();
    held.releasing = attempt;
    try {
      await attempt;
    } finally {
      if (held.releasing === attempt) held.releasing = undefined;
    }
  };
  const special = {
    async beginRunResume(input: Parameters<Store['beginRunResume']>[0]) {
      if (options.mode === 'readonly') throw new AgentError('read_only');
      const state = (await request('verifyRunResume', [input])) as Awaited<
        ReturnType<Store['verifyRunResume']>
      >;
      if (state.command)
        return { command: state.command, lease: null, state, started: false as const };
      if (
        owners.has(input.sessionId) ||
        recoveryLeases.has(input.sessionId) ||
        localLockHeld(input.sessionId)
      )
        throw new AgentError('owner_busy');
      let lock: FileLock;
      try {
        lock = acquireSessionLock(access, input.sessionId, options.windowsPathSecurity);
      } catch (error) {
        if (error instanceof LockBusyError) throw new AgentError('owner_busy');
        throw error;
      }
      let result: Awaited<ReturnType<Store['beginRunResume']>>;
      try {
        result = (await request('beginRunResume', [input])) as Awaited<
          ReturnType<Store['beginRunResume']>
        >;
      } catch (error) {
        return failedLocalCleanup(lock, input.sessionId, error);
      }
      if (result.lease) recoveryLeases.set(input.sessionId, { lease: result.lease, lock });
      else releaseLocalLock(lock, input.sessionId);
      return result;
    },
    async commitRunResume(input: Parameters<Store['commitRunResume']>[0]) {
      const held = recoveryLeases.get(input.lease.sessionId);
      if (
        held?.lease.kind !== 'run_resume' ||
        held.sqlReleased ||
        held.releasing ||
        held.committing ||
        canonicalJson(held.lease as unknown as Json) !==
          canonicalJson(input.lease as unknown as Json)
      )
        throw new AgentError('recovery_lease_changed');
      held.committing = true;
      try {
        const result = (await request('commitRunResume', [input])) as Awaited<
          ReturnType<Store['commitRunResume']>
        >;
        recoveryLeases.delete(input.lease.sessionId);
        owners.set(input.lease.sessionId, { owner: result.owner, lock: held.lock });
        return result;
      } finally {
        held.committing = false;
      }
    },
    async releaseRunResumeLease(lease: RunResumeLease) {
      return releaseRecoveryLease(lease, 'releaseRunResumeLease');
    },
    async beginJobReconciliation(input: Parameters<Store['beginJobReconciliation']>[0]) {
      if (options.mode === 'readonly') throw new AgentError('read_only');
      const prior = (await request('getJobReconciliationReceipt', [input])) as Awaited<
        ReturnType<Store['getJobReconciliationReceipt']>
      >;
      if (prior)
        return {
          command: prior,
          lease: null,
          execution: (await request('getExecution', [
            input.executionId,
          ])) as import('./storage/types').ExecutionRecord,
        };
      if (
        owners.has(input.sessionId) ||
        recoveryLeases.has(input.sessionId) ||
        localLockHeld(input.sessionId)
      )
        throw new AgentError('owner_busy');
      let lock: FileLock;
      try {
        lock = acquireSessionLock(access, input.sessionId, options.windowsPathSecurity);
      } catch (error) {
        if (error instanceof LockBusyError) throw new AgentError('owner_busy');
        throw error;
      }
      let result: Awaited<ReturnType<Store['beginJobReconciliation']>>;
      try {
        result = (await request('beginJobReconciliation', [input])) as Awaited<
          ReturnType<Store['beginJobReconciliation']>
        >;
      } catch (error) {
        return failedLocalCleanup(lock, input.sessionId, error);
      }
      if (result.lease) recoveryLeases.set(input.sessionId, { lease: result.lease, lock });
      else releaseLocalLock(lock, input.sessionId);
      return result;
    },
    async releaseJobRecoveryLease(lease: JobRecoveryLease) {
      return releaseRecoveryLease(lease, 'releaseJobRecoveryLease');
    },

    async reconcileSession(input: Parameters<Store['reconcileSession']>[0]) {
      if (options.mode === 'readonly') throw new AgentError('read_only');
      // Exact receipt lookup precedes ownership observation, so a lost response
      // remains queryable even after this root has acquired another live owner.
      const prior = await request('inspectSessionReconciliation', [input]);
      // These handles only retain exact cleanup authority after a failed local
      // release. They do not represent a live execution owner or recovery lease.
      for (const [lock, sessionId] of retainedLocalLocks)
        if (sessionId === input.sessionId) releaseLocalLock(lock, sessionId);
      if (prior) return prior as import('./storage/types').SessionReconciliation;
      const held = {
        storeId: input.expectedStoreId,
        sessionId: input.sessionId,
        outcome: 'owner_held' as const,
        commandId: null,
        report: null,
      };
      if (localLockHeld(input.sessionId) || recoveryLeases.has(input.sessionId)) return held;
      const selected = (await request('getSession', [input.sessionId])) as
        | import('./storage/types').SessionRecord
        | null;
      if (selected?.parentSessionId) throw new AgentError('group_root_required');
      // The observation cannot create a missing lock and thereby manufacture
      // proof that the original execution owner has exited.
      let probe: FileLock;
      try {
        probe = acquireExistingSharedFileLock(
          join(access.coordinationPath, `session-${input.sessionId}.lock`),
          options.windowsPathSecurity,
        );
      } catch (error) {
        if (error instanceof LockBusyError) return held;
        throw error;
      }
      releaseLocalLock(probe, input.sessionId);
      let lock: FileLock;
      try {
        lock = acquireSessionLock(access, input.sessionId, options.windowsPathSecurity);
      } catch (error) {
        if (error instanceof LockBusyError) return held;
        throw error;
      }
      let result: import('./storage/types').SessionReconciliation;
      try {
        result = (await request('reconcileSession', [
          input,
        ])) as import('./storage/types').SessionReconciliation;
      } catch (error) {
        return failedLocalCleanup(lock, input.sessionId, error);
      }
      releaseLocalLock(lock, input.sessionId);
      return result;
    },
    async recoverSession(input: Parameters<Store['recoverSession']>[0]) {
      if (options.mode === 'readonly') throw new AgentError('read_only');
      const prior = await request('getRecoveryReceipt', [input]);
      if (prior) {
        for (const [lock, sessionId] of retainedLocalLocks)
          if (sessionId === input.sessionId) releaseLocalLock(lock, sessionId);
        return prior;
      }
      if (localLockHeld(input.sessionId)) throw new AgentError('owner_busy');
      const recoverySession = (await request('getSession', [input.sessionId])) as
        | import('./storage/types').SessionRecord
        | null;
      if (recoverySession?.parentSessionId) throw new AgentError('group_root_required');
      let lock: FileLock;
      try {
        lock = acquireSessionLock(access, input.sessionId, options.windowsPathSecurity);
      } catch (error) {
        if (error instanceof LockBusyError) throw new AgentError('owner_busy');
        throw error;
      }
      let result: unknown;
      try {
        result = await request('recoverSession', [input]);
      } catch (error) {
        return failedLocalCleanup(lock, input.sessionId, error);
      }
      releaseLocalLock(lock, input.sessionId);
      return result;
    },
    async listSessionDirectory(input: Parameters<Store['listSessionDirectory']>[0]) {
      const page = (await request('listSessionDirectory', [input])) as Awaited<
        ReturnType<Store['listSessionDirectory']>
      >;
      for (const item of page.items) {
        if (!item.activity.run?.isActive) continue;
        const rootId = item.session.rootSessionId;
        item.activity.executionOwner = 'unknown';
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(rootId)) continue;
        let lock: FileLock;
        try {
          lock = acquireExistingSharedFileLock(
            join(access.coordinationPath, `session-${rootId}.lock`),
            options.windowsPathSecurity,
          );
        } catch (error) {
          if (error instanceof LockBusyError) item.activity.executionOwner = 'held';
          continue;
        }
        // Release synchronously before any further request. The shared probe cannot
        // advance a generation, settle old work, or become a recovery capability.
        releaseLocalLock(lock, rootId);
        item.activity.executionOwner = 'unheld';
      }
      return page;
    },
    async acquireSessionOwner(sessionId: string, instanceId: string): Promise<OwnerRef | null> {
      if (options.mode === 'readonly') throw new AgentError('read_only');
      const selectedSession = (await request('getSession', [sessionId])) as
        | import('./storage/types').SessionRecord
        | null;
      if (selectedSession?.parentSessionId) throw new AgentError('group_root_required');
      if (recoveryLeases.has(sessionId) || localLockHeld(sessionId))
        throw new AgentError('owner_busy');
      const prior = owners.get(sessionId);
      if (prior) {
        if (prior.sqlReleased) throw new AgentError('owner_busy');
        if (prior.owner.instanceId !== instanceId) throw new AgentError('owner_busy');
        return prior.owner;
      }
      let lock: FileLock;
      try {
        lock = acquireSessionLock(access, sessionId, options.windowsPathSecurity);
      } catch (error) {
        if (error instanceof LockBusyError) return null;
        throw error;
      }
      try {
        const owner = (await request('acquireSessionOwner', [sessionId, instanceId])) as OwnerRef;
        owners.set(sessionId, { owner, lock });
        return owner;
      } catch (error) {
        return failedLocalCleanup(lock, sessionId, error);
      }
    },
    async releaseSessionOwner(owner: OwnerRef): Promise<boolean> {
      const held = owners.get(owner.sessionId);
      if (!held) return true;
      if (held.owner.generation !== owner.generation || held.owner.instanceId !== owner.instanceId)
        throw new AgentError('owner_changed');
      if (held.releasing) return held.releasing;
      const attempt = (async () => {
        if (!held.sqlReleased) {
          const released = await request('releaseSessionOwner', [owner]);
          if (!released) return false;
          // SQL release ends execution authority even if the original OS lock's
          // eventual release fails. Keep that physical capability for exact cleanup.
          held.sqlReleased = true;
        }
        held.lock.release();
        owners.delete(owner.sessionId);
        return true;
      })();
      held.releasing = attempt;
      try {
        return await attempt;
      } finally {
        if (held.releasing === attempt) held.releasing = undefined;
      }
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        if (cleanupAfterClose) {
          cleanupAfterClose();
          return;
        }
        let acknowledged = false;
        let failedClose = false;
        let closeError: unknown;
        try {
          // The seal rejects new calls, but pre-seal producers still drain before close.
          if (activeRequests)
            await new Promise<void>((resolve) => {
              drained = resolve;
            });
          await request('close', []);
          acknowledged = true;
        } catch (error) {
          failedClose = true;
          closeError = error;
        }
        try {
          closed = true;
          rejectAll(new AgentError('store_closed'));
          await owned.terminate();
          // DB ACK and the macOS original thread/right are separate closure facts.
          // Deferred platforms retain their existing, explicitly unqualified path.
          if (acknowledged) {
            cleanupAfterClose = () => {
              for (const [sessionId, held] of owners) {
                held.lock.release();
                owners.delete(sessionId);
              }
              for (const [sessionId, held] of recoveryLeases) {
                held.lock.release();
                recoveryLeases.delete(sessionId);
              }
              for (const [lock, sessionId] of retainedLocalLocks) releaseLocalLock(lock, sessionId);
              access.lock.release();
            };
            cleanupAfterClose();
          }
        } catch (cleanup) {
          if (failedClose)
            throw new AggregateError([closeError, cleanup], 'Database and Worker cleanup failed.', {
              cause: closeError,
            });
          throw cleanup;
        }
        if (failedClose) throw closeError;
      })();
      const attempt = closePromise;
      void attempt.catch(() => {
        if (cleanupAfterClose && closePromise === attempt) closePromise = undefined;
      });
      return attempt;
    },
  };
  return new Proxy(special, {
    get(target, key) {
      if (typeof key !== 'string' || key === 'then') return undefined;
      if (key in target) return target[key as keyof typeof target];
      if (!storeMethods.includes(key as keyof Store)) return undefined;
      return (...args: unknown[]) => request(key, args);
    },
  }) as Store;
}
export { acquireProfileAccess, resolveProfile } from './platform/profile';
export { type ProfileSelection, type ProfileSelectionOptions, selectProfile } from './profile';
