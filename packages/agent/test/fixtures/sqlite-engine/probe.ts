import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import {
  getLoadedSqliteEngine,
  initializeDefaultSqliteEngine,
  initializeSqliteEngine,
} from '../../../src/sqlite-engine';

const [root, manifestSha256, mode] = process.argv.slice(2);
assert(root && manifestSha256 && mode);
if (mode === 'late') {
  const db = new Database(':memory:');
  db.close(true);
  assert.throws(
    () => initializeSqliteEngine({ root, manifestSha256 }),
    /sqlite_engine_initialization_failed/,
  );
  assert.equal(getLoadedSqliteEngine(), null);
  console.log('late_rejected');
} else if (mode === 'selected') {
  const selected = initializeSqliteEngine({ root, manifestSha256 });
  assert.equal(selected.version, '3.51.3');
  assert.equal(initializeSqliteEngine({ root, manifestSha256 }), selected);
  const worker = new Worker(new URL('./worker.js', import.meta.url).href);
  const timer = setTimeout(() => {
    worker.terminate();
    throw Error('sqlite_engine_worker_deadline');
  }, 5000);
  worker.postMessage({ root, manifestSha256 });
  await new Promise<void>((resolve, reject) => {
    worker.onmessage = (event) => {
      try {
        assert.deepEqual(event.data, selected);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    worker.onerror = (event) => reject(Error(event.message));
  }).finally(() => {
    clearTimeout(timer);
    worker.terminate();
  });
  console.log(JSON.stringify(selected));
} else if (mode === 'identity') {
  assert.throws(
    () => initializeSqliteEngine({ root, manifestSha256 }),
    /sqlite_engine_identity_mismatch/,
  );
  assert.throws(
    () => initializeSqliteEngine({ root, manifestSha256 }),
    /sqlite_engine_initialization_failed/,
  );
  assert.equal(getLoadedSqliteEngine(), null);
  assert.throws(() => initializeDefaultSqliteEngine(), /sqlite_engine_initialization_failed/);
  console.log('identity_rejected_no_fallback');
} else throw Error('invalid_probe_mode');
