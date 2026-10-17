import type { Database } from 'bun:sqlite';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import { AgentError } from '../../../src/storage/types';
import '../../../src/storage/worker/main';

let armed = false;
let poisonRelease = false;
let poisonWhenRunFinishes = false;
let attempts = 0;
let rollbacks = 0;
let closes = 0;
let transactionBeforeClose = false;
const timed = Reflect.get(SqliteOperations.prototype, 'timedDatabase') as (
  this: SqliteOperations,
  database: Database,
) => Database;
Reflect.set(
  SqliteOperations.prototype,
  'timedDatabase',
  function (this: SqliteOperations, database: Database) {
    return timed.call(
      this,
      new Proxy(database, {
        get(target, key) {
          if (key === 'run')
            return (sql: string, ...args: unknown[]) => {
              if (poisonRelease && sql === 'UPDATE session SET owner_instance=NULL WHERE id=?') {
                poisonRelease = false;
                armed = true;
                Reflect.apply(target.run, target, [sql, ...args]);
                throw new AgentError('fixture_business_failed', 'original owner release failure');
              }
              if (armed && sql === 'ROLLBACK') {
                armed = false;
                rollbacks++;
                throw new AgentError(
                  'fixture_rollback_failed',
                  'actual rollback failed before native execution',
                );
              }
              return Reflect.apply(target.run, target, [sql, ...args]);
            };
          if (key === 'close')
            return (...args: unknown[]) => {
              transactionBeforeClose = target.inTransaction;
              Reflect.apply(target.close, target, args);
              closes++;
            };
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
  },
);
const call = SqliteOperations.prototype.call;
SqliteOperations.prototype.call = function (method: string, args: unknown[]) {
  if (method === 'getWorkspace' && args[0] === 'arm-owner-release-poison') {
    poisonWhenRunFinishes = true;
    return null;
  }
  if (method === 'finishRun' && poisonWhenRunFinishes) {
    const result = call.call(this, method, args);
    poisonWhenRunFinishes = false;
    poisonRelease = true;
    return result;
  }
  if (method === 'getWorkspace' && args[0] === 'fault-write') {
    attempts++;
    armed = true;
    return this.tx(() => {
      this.run("INSERT INTO workspace(id,root_uri,name) VALUES('dirty','file:///dirty','dirty')");
      throw new AgentError('fixture_business_failed', 'original business failure');
    });
  }
  if (
    (method === 'getView' && args[0] === 'fault-read') ||
    (method === 'readExecutionGroupSafety' &&
      (args[0] as { sessionId: string }).sessionId === 'fault-read-helper')
  ) {
    attempts++;
    armed = true;
  }
  if (method === 'getWorkspace' && args[0] === 'unfinished-success') {
    attempts++;
    this.db.run('BEGIN IMMEDIATE');
    this.run("INSERT INTO workspace(id,root_uri,name) VALUES('dirty','file:///dirty','dirty')");
    return { id: 'dirty', rootUri: 'file:///dirty', name: 'dirty' };
  }
  return call.call(this, method, args);
};
declare const self: Worker;
const post = self.postMessage.bind(self);
self.postMessage = (response: unknown) =>
  post({
    ...(response as object),
    fixture: { attempts, rollbacks, closes, transactionBeforeClose },
  });
