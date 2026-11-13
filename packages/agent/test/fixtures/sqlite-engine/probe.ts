import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { nativeRuntime } from '../../../src/runtime-native';
import {
  getLoadedSqliteEngine,
  initializeDefaultSqliteEngine,
  initializeSqliteEngine,
} from '../../../src/sqlite-engine';

const [root, manifestSha256, mode] = process.argv.slice(2);
assert(root && manifestSha256 && mode);
if (mode === 'late') {
  const native = nativeRuntime();
  assert.equal(native.sqliteSelect(join(root, 'libsqlite3.dylib'), true), true);
  native.sqliteClose(native.sqliteOpen(':memory:', 6));
  assert.throws(
    () => initializeSqliteEngine({ root, manifestSha256 }),
    /sqlite_engine_load_failed/,
  );
  assert.equal(getLoadedSqliteEngine(), null);
  console.log('late_rejected');
} else if (mode === 'selected') {
  const selected = initializeSqliteEngine({ root, manifestSha256 });
  assert.equal(selected.version, '3.51.3');
  assert.equal(initializeSqliteEngine({ root, manifestSha256 }), selected);
  const worker = new Worker(new URL('./worker.js', import.meta.url));
  const timer = setTimeout(() => {
    worker.terminate();
    throw Error('sqlite_engine_worker_deadline');
  }, 5000);
  worker.postMessage({ root, manifestSha256 });
  await new Promise<void>((resolve, reject) => {
    worker.once('message', (message) => {
      try {
        assert.deepEqual(message, selected);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    worker.once('error', reject);
  }).finally(() => {
    clearTimeout(timer);
    return worker.terminate();
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
