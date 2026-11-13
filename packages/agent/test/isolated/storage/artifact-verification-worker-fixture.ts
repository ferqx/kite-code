import { getEventListeners } from 'node:events';
import { chmodSync, closeSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { artifactPath } from '../../../src/artifacts-files';
import { ArtifactVerificationPending } from '../../../src/storage/sqlite/artifact-operations';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import { UnstartedSqliteWrite } from '../../../src/storage/sqlite/write-lock';

const port = parentPort!;
const register = port.on;
let onMessage: ((data: unknown) => void) | undefined;
port.on = function (type, listener) {
  if (type === 'message') onMessage = (data) => Reflect.apply(listener, this, [data]);
  return Reflect.apply(register, this, [type, listener]);
};
await import('../../../src/storage/worker/main');
port.on = register;

let armed = false;
let armedWriter = false;
let paused = false;
let armedBegin = false;
let registering: { hash: string } | undefined;
const tx = SqliteOperations.prototype.tx;
SqliteOperations.prototype.tx = function <T>(work: () => T): T {
  if (!armedBegin || !registering) return tx.call(this, work) as T;
  const path = artifactPath(dirname(this.db.filename), registering.hash);
  return tx.call(this, () => {
    armedBegin = false;
    if (!this.db.inTransaction) throw new Error('fixture_not_after_real_BEGIN');
    chmodSync(path, 0o600);
    const fd = openSync(path, 'r+');
    try {
      writeSync(fd, Buffer.from('b'), 0, 1, 0);
    } finally {
      closeSync(fd);
      chmodSync(path, 0o400);
    }
    port.postMessage({ fixture: 'after-successful-begin', inTransaction: this.db.inTransaction });
    return work();
  }) as T;
};
const call = SqliteOperations.prototype.call;
SqliteOperations.prototype.call = function (method: string, args: unknown[]): unknown {
  if (method === 'registerArtifact' && paused) throw new ArtifactVerificationPending();
  registering = method === 'registerArtifact' ? (args[0] as { hash: string }) : undefined;
  try {
    return call.call(this, method, args);
  } catch (error) {
    if (armed && error instanceof ArtifactVerificationPending) {
      armed = false;
      paused = true;
      // Only this fixture pauses the already started, actual byte verifier. SQL
      // and Store messages still use the original Worker and original queue.
      port.postMessage({ fixture: 'verification-yielded' });
    } else if (armedWriter && error instanceof UnstartedSqliteWrite) {
      armedWriter = false;
      paused = true;
      port.postMessage({ fixture: 'verified-writer-wait' });
    }
    throw error;
  } finally {
    registering = undefined;
  }
};
if (!onMessage || getEventListeners(port, 'message').length !== 1)
  throw Error('fixture_worker_listener_missing');
const originalMessage = onMessage;
port.removeAllListeners('message');
port.on('message', (data) => {
  if (data?.fixture === 'arm-verification') {
    armed = true;
    port.postMessage({ fixture: 'verification-armed' });
  } else if (data?.fixture === 'arm-writer-wait') {
    armedWriter = true;
    port.postMessage({ fixture: 'verification-armed' });
  } else if (data?.fixture === 'arm-before-callback') {
    armed = true;
    armedBegin = true;
    port.postMessage({ fixture: 'verification-armed' });
  } else if (data?.fixture === 'resume-verification') paused = false;
  else originalMessage(data);
});
