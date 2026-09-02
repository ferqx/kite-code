import type { Database } from 'bun:sqlite';
import { assertKiteHomeStoreSchema } from './kite-home-store';

export class KiteHomeWriteError extends Error {
  readonly code: 'nested_transaction' | 'transaction_required' | 'write_failed';

  constructor(code: KiteHomeWriteError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KiteHomeWriteError';
    this.code = code;
  }
}

export interface KiteHomeWriteTransactionPort {
  readonly inTransaction: boolean;
  run<Result>(write: () => Result): Result;
}

/** One Store 9 writer transaction boundary; no migration or publication state is consulted. */
export function createKiteHomeWriteTransactionPort(
  database: Database,
  assertStoreSchema: (database: Database) => void = assertKiteHomeStoreSchema,
): KiteHomeWriteTransactionPort {
  assertStoreSchema(database);
  let running = false;
  return Object.freeze({
    get inTransaction() {
      return running;
    },
    run<Result>(write: () => Result): Result {
      if (running) {
        throw new KiteHomeWriteError(
          'nested_transaction',
          'Single Store writer does not allow a nested transaction.',
        );
      }
      running = true;
      try {
        database.run('BEGIN IMMEDIATE');
        const result = write();
        database.run('COMMIT');
        return result;
      } catch (error) {
        try {
          database.run('ROLLBACK');
        } catch {
          // SQLite may already have rolled back the failed statement.
        }
        if (error instanceof KiteHomeWriteError) throw error;
        throw new KiteHomeWriteError('write_failed', 'Single Store mutation failed.', {
          cause: error,
        });
      } finally {
        running = false;
      }
    },
  });
}
