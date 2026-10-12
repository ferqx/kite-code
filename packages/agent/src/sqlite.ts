import { join } from 'node:path';
import { canonicalJson } from './json';
import { acquireFileLock, type FileLock, LockBusyError } from './platform/locks';
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
import { storeMethods } from './storage/worker/protocol';
import type { DbTiming } from './storage/worker/timing';

export type { DbTiming } from './storage/worker/timing';
export interface OpenSqliteStoreOptions extends ProfileOptions {
  mode?: 'readwrite' | 'readonly';
  onTiming?: (observation: DbTiming) => void;
}
export type SqliteStorePreflight = import('./storage/sqlite/connection').StorePreflight;

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
    access.lock.release();
    throw error;
  }
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; bytes: number }
  >();
  const owners = new Map<string, { owner: OwnerRef; lock: FileLock }>();
  const recoveryLeases = new Map<
    string,
    { lease: JobRecoveryLease | RunResumeLease; lock: FileLock }
  >();
  let sequence = 0;
  let queuedBytes = 0;
  let closed = false;
  let failed = false;
  let failure: Error | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
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
    if (event.data.error)
      item.reject(new AgentError(event.data.error.code, event.data.error.message));
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
  } catch (error) {
    try {
      await owned.terminate();
      access.lock.release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Database open and Worker cleanup failed.', {
        cause: error,
      });
    }
    throw error;
  } finally {
    migration?.release();
  }
  const special = {
    async beginRunResume(input: Parameters<Store['beginRunResume']>[0]) {
      if (options.mode === 'readonly') throw new AgentError('read_only');
      const state = (await request('verifyRunResume', [input])) as Awaited<
        ReturnType<Store['verifyRunResume']>
      >;
      if (state.command)
        return { command: state.command, lease: null, state, started: false as const };
      if (owners.has(input.sessionId) || recoveryLeases.has(input.sessionId))
        throw new AgentError('owner_busy');
      let lock: FileLock;
      try {
        lock = acquireSessionLock(access, input.sessionId, options.windowsPathSecurity);
      } catch (error) {
        if (error instanceof LockBusyError) throw new AgentError('owner_busy');
        throw error;
      }
      try {
        const result = (await request('beginRunResume', [input])) as Awaited<
          ReturnType<Store['beginRunResume']>
        >;
        if (result.lease) recoveryLeases.set(input.sessionId, { lease: result.lease, lock });
        else lock.release();
        return result;
      } catch (error) {
        lock.release();
        throw error;
      }
    },
    async commitRunResume(input: Parameters<Store['commitRunResume']>[0]) {
      const held = recoveryLeases.get(input.lease.sessionId);
      if (
        held?.lease.kind !== 'run_resume' ||
        canonicalJson(held.lease as unknown as Json) !==
          canonicalJson(input.lease as unknown as Json)
      )
        throw new AgentError('recovery_lease_changed');
      const result = (await request('commitRunResume', [input])) as Awaited<
        ReturnType<Store['commitRunResume']>
      >;
      recoveryLeases.delete(input.lease.sessionId);
      owners.set(input.lease.sessionId, { owner: result.owner, lock: held.lock });
      return result;
    },
    async releaseRunResumeLease(lease: RunResumeLease) {
      const held = recoveryLeases.get(lease.sessionId);
      if (!held) return;
      if (
        held.lease.kind !== 'run_resume' ||
        canonicalJson(held.lease as unknown as Json) !== canonicalJson(lease as unknown as Json)
      )
        throw new AgentError('recovery_lease_changed');
      await request('releaseRunResumeLease', [lease]);
      recoveryLeases.delete(lease.sessionId);
      held.lock.release();
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
      if (owners.has(input.sessionId) || recoveryLeases.has(input.sessionId))
        throw new AgentError('owner_busy');
      let lock: FileLock;
      try {
        lock = acquireSessionLock(access, input.sessionId, options.windowsPathSecurity);
      } catch (error) {
        if (error instanceof LockBusyError) throw new AgentError('owner_busy');
        throw error;
      }
      try {
        const result = (await request('beginJobReconciliation', [input])) as Awaited<
          ReturnType<Store['beginJobReconciliation']>
        >;
        if (result.lease) recoveryLeases.set(input.sessionId, { lease: result.lease, lock });
        else lock.release();
        return result;
      } catch (error) {
        lock.release();
        throw error;
      }
    },
    async releaseJobRecoveryLease(lease: JobRecoveryLease) {
      const held = recoveryLeases.get(lease.sessionId);
      if (!held) return;
      if (canonicalJson(held.lease as unknown as Json) !== canonicalJson(lease as unknown as Json))
        throw new AgentError('recovery_lease_changed');
      await request('releaseJobRecoveryLease', [lease]);
      recoveryLeases.delete(lease.sessionId);
      held.lock.release();
    },

    async recoverSession(input: Parameters<Store['recoverSession']>[0]) {
      if (options.mode === 'readonly') throw new AgentError('read_only');
      const prior = await request('getRecoveryReceipt', [input]);
      if (prior) return prior;
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
      try {
        return await request('recoverSession', [input]);
      } finally {
        lock.release();
      }
    },
    async acquireSessionOwner(sessionId: string, instanceId: string): Promise<OwnerRef | null> {
      if (options.mode === 'readonly') throw new AgentError('read_only');
      const selectedSession = (await request('getSession', [sessionId])) as
        | import('./storage/types').SessionRecord
        | null;
      if (selectedSession?.parentSessionId) throw new AgentError('group_root_required');
      if (recoveryLeases.has(sessionId)) throw new AgentError('owner_busy');
      const prior = owners.get(sessionId);
      if (prior) {
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
        lock.release();
        throw error;
      }
    },
    async releaseSessionOwner(owner: OwnerRef): Promise<boolean> {
      const held = owners.get(owner.sessionId);
      if (!held) return true;
      if (held.owner.generation !== owner.generation || held.owner.instanceId !== owner.instanceId)
        throw new AgentError('owner_changed');
      const released = await request('releaseSessionOwner', [owner]);
      if (released) {
        owners.delete(owner.sessionId);
        held.lock.release();
      }
      return Boolean(released);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
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
            for (const held of owners.values()) held.lock.release();
            owners.clear();
            for (const held of recoveryLeases.values()) held.lock.release();
            recoveryLeases.clear();
            access.lock.release();
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
      return closePromise;
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
