import { join } from 'node:path';
import { canonicalJson } from './json';
import { acquireFileLock, type FileLock, LockBusyError } from './platform/locks';
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
  return Object.freeze({
    module: new URL(import.meta.url),
    worker: new URL(
      import.meta.url.endsWith('.ts') ? './storage/worker/main.ts' : './storage/worker/main.js',
      import.meta.url,
    ),
    baseline: new URL('./storage/migrations/0001-baseline.sql', import.meta.url),
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
  try {
    worker = new Worker(sqliteStorageAssets().worker.href);
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
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const rejectAll = (error: Error) => {
    failed = true;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    queuedBytes = 0;
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
  const request = (method: string, args: unknown[]): Promise<unknown> => {
    if (
      method !== 'open' &&
      method !== 'getRecoveryReceipt' &&
      !storeMethods.includes(method as keyof Store)
    )
      return Promise.reject(new AgentError('unsupported_store_operation'));
    if (closed || failed || (closing && method !== 'close'))
      return Promise.reject(new AgentError('store_closed'));
    const recovery = args[0] as { lease?: JobRecoveryLease | RunResumeLease } | undefined;
    if (recovery?.lease) {
      const held = recoveryLeases.get(recovery.lease.sessionId);
      if (
        !held ||
        canonicalJson(held.lease as unknown as Json) !==
          canonicalJson(recovery.lease as unknown as Json)
      )
        return Promise.reject(new AgentError('recovery_lease_changed'));
    }
    const owned = args[0] as { owner?: OwnerRef } | undefined;
    if (owned?.owner) {
      const held = owners.get(owned.owner.sessionId);
      if (
        !held ||
        held.owner.instanceId !== owned.owner.instanceId ||
        held.owner.generation !== owned.owner.generation
      )
        return Promise.reject(new AgentError('owner_changed'));
    }
    const bytes = new TextEncoder().encode(JSON.stringify(args)).byteLength;
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
    if (
      pending.size >= (critical ? 256 : 224) ||
      queuedBytes + bytes > (critical ? 16 * 1024 * 1024 : 14 * 1024 * 1024)
    )
      return Promise.reject(
        new AgentError('storage_queue_full', 'Database queue capacity reached.', true),
      );
    const id = ++sequence;
    queuedBytes += bytes;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, bytes });
      worker.postMessage({ id, method, args });
    });
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
    worker.terminate();
    access.lock.release();
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
        try {
          await request('close', []);
        } finally {
          closed = true;
          worker.terminate();
          rejectAll(new AgentError('store_closed'));
          for (const held of owners.values()) held.lock.release();
          owners.clear();
          for (const held of recoveryLeases.values()) held.lock.release();
          recoveryLeases.clear();
          access.lock.release();
        }
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
