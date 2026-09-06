import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createKiteHomeWriteTransactionPort,
  initializeKiteHomeStoreSchema,
  KiteHomeWriteError,
} from '../src';

describe('Kite Home single writer transaction', () => {
  test('commits an ordinary mutation without migration metadata', () => {
    using database = storeDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);

    expect(
      writer.run(() => {
        database.query("INSERT INTO kite_meta(key, value) VALUES ('runtime/test', 'one')").run();
        return 'applied';
      }),
    ).toBe('applied');
    expect(
      database
        .query<{ value: string }, []>("SELECT value FROM kite_meta WHERE key = 'runtime/test'")
        .get()?.value,
    ).toBe('one');
  });

  test('rolls back a failed mutation', () => {
    using database = storeDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    expect(() =>
      writer.run(() => {
        database
          .query("INSERT INTO kite_meta(key, value) VALUES ('runtime/test', 'partial')")
          .run();
        throw new Error('injected fault');
      }),
    ).toThrow(KiteHomeWriteError);
    expect(
      database
        .query<{ value: string }, []>("SELECT value FROM kite_meta WHERE key = 'runtime/test'")
        .get(),
    ).toBeNull();
  });

  test('rejects nested writer transactions', () => {
    using database = storeDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    expect(capture(() => writer.run(() => writer.run(() => undefined)))).toMatchObject({
      code: 'nested_transaction',
    });
  });
});

function storeDatabase(): Database {
  const database = new Database(':memory:', { strict: true });
  initializeKiteHomeStoreSchema(database);
  return database;
}

function capture(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}
