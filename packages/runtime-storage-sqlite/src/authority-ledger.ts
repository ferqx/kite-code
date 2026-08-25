import type { Database } from 'bun:sqlite';
import type { RuntimeRecoveryIdentityPort } from '@kite/runtime-host/storage';
import {
  assertNonEmptySessionId,
  isCanonicalRecoveryIdentity,
  recoveryIdentityMetaKey,
  SqliteRuntimeStorageOpenError,
} from './preflight';

export interface SqliteRecoveryIdentityLedger {
  readonly port: RuntimeRecoveryIdentityPort;
  readValue(sessionId: string): string | undefined;
  putValue(sessionId: string, value: string): void;
  deleteValue(sessionId: string): void;
}

export function createSqliteRecoveryIdentityLedger(
  db: Database,
  assertOpen: () => void,
  withImmediateTransaction: <T>(work: () => T) => T,
): SqliteRecoveryIdentityLedger {
  const select = db.query<{ value: string }, [string]>(
    'SELECT value FROM runtime_store_meta WHERE key = ?',
  );
  const insert = db.query('INSERT INTO runtime_store_meta (key, value) VALUES (?, ?)');
  const remove = db.query('DELETE FROM runtime_store_meta WHERE key = ?');
  const readValue = (sessionId: string): string | undefined =>
    select.get(recoveryIdentityMetaKey(sessionId))?.value;
  const putValue = (sessionId: string, value: string): void => {
    insert.run(recoveryIdentityMetaKey(sessionId), value);
  };
  const deleteValue = (sessionId: string): void => {
    remove.run(recoveryIdentityMetaKey(sessionId));
  };
  const port: RuntimeRecoveryIdentityPort = Object.freeze({
    read: (sessionId: string): string | null => {
      assertOpen();
      const value = readValue(sessionId);
      if (value === undefined) return null;
      assertCanonical(value, 'Persisted runtime recovery identity is malformed.');
      return value;
    },
    getOrCreate: (sessionId: string, allocate: () => string): string => {
      assertNonEmptySessionId(sessionId);
      if (typeof allocate !== 'function') {
        throw new SqliteRuntimeStorageOpenError(
          'Runtime recovery identity requires a Host allocator.',
        );
      }
      return withImmediateTransaction(() => {
        const existing = readValue(sessionId);
        if (existing !== undefined) {
          assertCanonical(existing, 'Persisted runtime recovery identity is malformed.');
          return existing;
        }
        const allocated = allocate();
        assertCanonical(allocated, 'Host recovery identity allocator returned an invalid key.');
        putValue(sessionId, allocated);
        return allocated;
      });
    },
    remove: (sessionId: string): void => {
      withImmediateTransaction(() => deleteValue(sessionId));
    },
  });
  return Object.freeze({ port, readValue, putValue, deleteValue });
}

function assertCanonical(value: string, message: string): void {
  if (!isCanonicalRecoveryIdentity(value)) throw new SqliteRuntimeStorageOpenError(message);
}
