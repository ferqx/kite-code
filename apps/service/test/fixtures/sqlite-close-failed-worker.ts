import type { Database } from 'bun:sqlite';
import { SqliteOperations } from '../../../../packages/agent/src/storage/sqlite/operations';
import '../../../../packages/agent/src/storage/worker/main';

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
          if (key === 'close')
            return (strict: boolean) => {
              if (strict === true)
                throw Object.assign(Error('original strict close failed before native close'), {
                  code: 'fixture_strict_close_failed',
                });
              return target.close(strict);
            };
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
  },
);
