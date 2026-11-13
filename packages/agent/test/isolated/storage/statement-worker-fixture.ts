import { parentPort } from 'node:worker_threads';
import { nativeRuntime } from '../../../src/runtime-native';
import type { Database, Statement } from '../../../src/runtime-sqlite';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import '../../../src/storage/worker/main';

const port = parentPort!;
const statements = new Set<Statement>();
const timedDatabase = Reflect.get(SqliteOperations.prototype, 'timedDatabase') as (
  this: SqliteOperations,
  database: Database,
) => Database;

// Observe actual native statements created by Operations, excluding the
// connection's bounded initialization queries. The production Worker stays intact.
Reflect.set(
  SqliteOperations.prototype,
  'timedDatabase',
  function (this: SqliteOperations, database: Database): Database {
    return timedDatabase.call(
      this,
      new Proxy(database, {
        get(target, key) {
          const value = Reflect.get(target, key, target) as unknown;
          if (key === 'query' || key === 'prepare')
            return (...args: unknown[]) => {
              const statement = Reflect.apply(value as CallableFunction, target, args) as Statement;
              statements.add(statement);
              return statement;
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
  },
);

const post = port.postMessage.bind(port);
port.postMessage = (response: unknown) => {
  const observed = statements.size;
  const live = [...statements].filter((statement) => {
    try {
      // Only a native finalized handle may refuse a reset with this exact code.
      nativeRuntime().sqliteReset(Reflect.get(statement, 'statement'));
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'native_sqlite_statement_finalized')
        throw error;
      return false;
    }
  }).length;
  statements.clear();
  post({
    ...(response as object),
    ...(live
      ? {
          error: {
            code: 'statement_alive_before_worker_ack',
            message: `${live} native statements still alive before ACK`,
          },
        }
      : {}),
    statementScope: { observed, finalized: live === 0 },
  });
};
