import type { Database } from 'bun:sqlite';
import type { RuntimeRecoveryIdentityPort } from '@kite-ai/runtime-host/storage';
import { assertKiteHomeStoreSchema } from './kite-home-store';
import type { KiteHomeWorkspaceSessionStore } from './kite-home-workspaces';
import type { KiteHomeWriteTransactionPort } from './kite-home-write';
import {
  isCanonicalRecoveryIdentity,
  recoveryIdentityMetaKey,
  SqliteRuntimeStorageOpenError,
} from './preflight';

export interface KiteHomeRecoveryIdentityLedger {
  readonly port: RuntimeRecoveryIdentityPort;
  readValue(sessionId: string): string | undefined;
  /** Same-connection primitive. The caller must already own the Store writer transaction. */
  putInTransaction(sessionId: string, value: string): void;
  /** Same-connection primitive. The caller must already own the Store writer transaction. */
  removeInTransaction(sessionId: string): void;
}

/** Workspace-namespaced Store 9 recovery identity ledger over kite_meta. */
export function createKiteHomeRecoveryIdentityLedger<State>(input: {
  readonly database: Database;
  readonly writer: KiteHomeWriteTransactionPort;
  readonly assertStoreSchema?: (database: Database) => void;
  readonly workspaceId: string;
  readonly sessions: KiteHomeWorkspaceSessionStore<State>;
  readonly isClosed: () => boolean;
}): KiteHomeRecoveryIdentityLedger {
  (input.assertStoreSchema ?? assertKiteHomeStoreSchema)(input.database);
  const select = input.database.query<{ value: string }, [string]>(
    'SELECT value FROM kite_meta WHERE key = ?',
  );
  const insert = input.database.query('INSERT INTO kite_meta(key, value) VALUES (?, ?)');
  const remove = input.database.query('DELETE FROM kite_meta WHERE key = ?');
  const key = (sessionId: string): string =>
    `workspace_authority/${input.workspaceId}/${recoveryIdentityMetaKey(sessionId)}`;
  const assertSession = (sessionId: string): void => {
    if (!input.sessions.binding(sessionId)) {
      throw new SqliteRuntimeStorageOpenError(
        'Runtime recovery identity Session is not admitted to this Workspace.',
      );
    }
  };
  const readValue = (sessionId: string): string | undefined => {
    assertSession(sessionId);
    return select.get(key(sessionId))?.value;
  };
  const assertCanonical = (value: string, message: string): string => {
    if (!isCanonicalRecoveryIdentity(value)) throw new SqliteRuntimeStorageOpenError(message);
    return value;
  };
  const removeInTransaction = (sessionId: string): void => {
    if (!input.writer.inTransaction) {
      throw new SqliteRuntimeStorageOpenError(
        'Runtime recovery identity removal requires the single Store writer transaction.',
      );
    }
    assertSession(sessionId);
    remove.run(key(sessionId));
  };
  const putInTransaction = (sessionId: string, value: string): void => {
    if (!input.writer.inTransaction) {
      throw new SqliteRuntimeStorageOpenError(
        'Runtime recovery identity write requires the single Store writer transaction.',
      );
    }
    assertSession(sessionId);
    const canonical = assertCanonical(value, 'Runtime recovery identity is malformed.');
    const existing = select.get(key(sessionId))?.value;
    if (existing !== undefined) {
      if (existing !== canonical) {
        throw new SqliteRuntimeStorageOpenError('Runtime recovery identity conflicts.');
      }
      return;
    }
    insert.run(key(sessionId), canonical);
  };

  const port: RuntimeRecoveryIdentityPort = Object.freeze({
    read(sessionId: string): string | null {
      if (input.isClosed()) throw new SqliteRuntimeStorageOpenError('Kite Home Store is closed.');
      assertSession(sessionId);
      const value = readValue(sessionId);
      return value === undefined
        ? null
        : assertCanonical(value, 'Persisted runtime recovery identity is malformed.');
    },
    getOrCreate(sessionId: string, allocate: () => string): string {
      if (input.isClosed()) throw new SqliteRuntimeStorageOpenError('Kite Home Store is closed.');
      assertSession(sessionId);
      if (typeof allocate !== 'function') {
        throw new SqliteRuntimeStorageOpenError(
          'Runtime recovery identity requires a Host allocator.',
        );
      }
      const existing = readValue(sessionId);
      if (existing !== undefined) {
        return assertCanonical(existing, 'Persisted runtime recovery identity is malformed.');
      }
      return input.writer.run(() => {
        assertSession(sessionId);
        const current = readValue(sessionId);
        if (current !== undefined) {
          return assertCanonical(current, 'Persisted runtime recovery identity is malformed.');
        }
        const allocated = assertCanonical(
          allocate(),
          'Host recovery identity allocator returned an invalid key.',
        );
        putInTransaction(sessionId, allocated);
        return allocated;
      });
    },
    remove(sessionId: string): void {
      if (input.isClosed()) throw new SqliteRuntimeStorageOpenError('Kite Home Store is closed.');
      input.writer.run(() => removeInTransaction(sessionId));
    },
  });

  return Object.freeze({ port, readValue, putInTransaction, removeInTransaction });
}
