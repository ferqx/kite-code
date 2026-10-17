import type { Database, Statement } from 'bun:sqlite';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import '../../../src/storage/worker/main';

let armed = false;
let faults = 0;
let faultFinalizations = 0;
const timedDatabase = Reflect.get(SqliteOperations.prototype, 'timedDatabase') as (
  this: SqliteOperations,
  database: Database,
) => Database;
Reflect.set(
  SqliteOperations.prototype,
  'timedDatabase',
  function (this: SqliteOperations, database: Database): Database {
    return timedDatabase.call(
      this,
      new Proxy(database, {
        get(target, key) {
          const value = Reflect.get(target, key, target) as unknown;
          if (key === 'prepare' || key === 'query')
            return (...args: unknown[]) => {
              const statement = Reflect.apply(value as CallableFunction, target, args) as Statement;
              let faulted = false;
              return new Proxy(statement, {
                get(native, property) {
                  const operation = Reflect.get(native, property, native) as unknown;
                  if (property === 'finalize')
                    return () => {
                      if (armed) {
                        armed = false;
                        faulted = true;
                        faultFinalizations++;
                        faults++;
                        throw Object.assign(new Error('actual statement cleanup fixture'), {
                          code: 'fixture_finalize_failed',
                        });
                      }
                      if (faulted) faultFinalizations++;
                      return native.finalize();
                    };
                  return typeof operation === 'function' ? operation.bind(native) : operation;
                },
              });
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
  },
);
const call = SqliteOperations.prototype.call;
SqliteOperations.prototype.call = function (method: string, args: unknown[]): unknown {
  if (
    method === 'createSession' &&
    (args[0] as { commandId?: string }).commandId === 'cleanup-fault'
  ) {
    // A real statement exists even when the following real BEGIN encounters BUSY.
    this.row('SELECT 1 AS fixture_statement');
    armed = true;
  }
  return call.call(this, method, args);
};
declare const self: Worker;
const post = self.postMessage.bind(self);
self.postMessage = (response: unknown) =>
  post({
    ...(response as object),
    fixtureFaults: faults,
    fixtureFinalizations: faultFinalizations,
  });
