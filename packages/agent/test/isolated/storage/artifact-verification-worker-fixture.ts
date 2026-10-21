import { chmodSync, closeSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { artifactPath } from '../../../src/artifacts-files';
import { ArtifactVerificationPending } from '../../../src/storage/sqlite/artifact-operations';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import { UnstartedSqliteWrite } from '../../../src/storage/sqlite/write-lock';
import '../../../src/storage/worker/main';

declare const self: Worker;
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
    self.postMessage({ fixture: 'after-successful-begin', inTransaction: this.db.inTransaction });
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
      self.postMessage({ fixture: 'verification-yielded' });
    } else if (armedWriter && error instanceof UnstartedSqliteWrite) {
      armedWriter = false;
      paused = true;
      self.postMessage({ fixture: 'verified-writer-wait' });
    }
    throw error;
  } finally {
    registering = undefined;
  }
};
const onmessage = self.onmessage!;
self.onmessage = (event: MessageEvent) => {
  if (event.data?.fixture === 'arm-verification') {
    armed = true;
    self.postMessage({ fixture: 'verification-armed' });
  } else if (event.data?.fixture === 'arm-writer-wait') {
    armedWriter = true;
    self.postMessage({ fixture: 'verification-armed' });
  } else if (event.data?.fixture === 'arm-before-callback') {
    armed = true;
    armedBegin = true;
    self.postMessage({ fixture: 'verification-armed' });
  } else if (event.data?.fixture === 'resume-verification') paused = false;
  else onmessage.call(self, event);
};
