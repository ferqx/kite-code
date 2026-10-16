import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { initializeDefaultSqliteEngine } from '../../../src/sqlite-engine';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';

const [path, phase, marker] = process.argv.slice(2) as [string, string, string];
initializeDefaultSqliteEngine();
const native = new Database(path);
native.run('PRAGMA foreign_keys=ON');
native.run('PRAGMA synchronous=FULL');
let armed = false;
const db = new Proxy(native, {
  get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === 'run')
      return (sql: string, ...args: unknown[]) => {
        if (armed && /^COMMIT\b/.test(sql)) {
          if (phase === 'after') Reflect.apply(value, target, [sql, ...args]);
          writeFileSync(marker, 'audit-and-business-written');
          // Parent owns and SIGKILLs this process at the exact durable boundary.
          const gate = new Int32Array(new SharedArrayBuffer(4));
          for (;;) Atomics.wait(gate, 0, 0);
        }
        return Reflect.apply(value, target, [sql, ...args]);
      };
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const ops = new SqliteOperations(db, false);
armed = true;
ops.tx(() => ops.run("UPDATE execution SET output_bytes=output_bytes+1 WHERE id='history-0'"));
throw Error('crash_boundary_not_reached');
