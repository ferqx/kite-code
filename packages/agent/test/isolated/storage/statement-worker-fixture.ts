import type { Database, Statement } from 'bun:sqlite';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import '../../../src/storage/worker/main';

declare const self: Worker;
type NativeStatement = Statement & { readonly isFinalized: boolean };
const statements = new Set<NativeStatement>();
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
              const statement = Reflect.apply(
                value as CallableFunction,
                target,
                args,
              ) as NativeStatement;
              statements.add(statement);
              return statement;
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
  },
);

const post = self.postMessage.bind(self);
self.postMessage = (response: unknown) => {
  const observed = statements.size;
  const live = [...statements].filter((statement) => !statement.isFinalized).length;
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
