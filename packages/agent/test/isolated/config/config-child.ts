import {
  createCredentialVault,
  createTemporaryCredentialBackend,
  updateConfigurationFile,
} from '@kite-ai/agent/config';
import { acquireFileLock } from '../../../src/platform/locks';

const mode = process.argv[2]!;
const path = process.argv[3]!;
if (mode === 'credential') {
  try {
    await createCredentialVault({ backend: createTemporaryCredentialBackend() }).resolve(path);
    process.stdout.write(JSON.stringify({ status: 'unexpected' }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ code: (error as { code: string }).code }));
  }
} else if (mode === 'hold') {
  const lock = acquireFileLock(`${path}.lock`, 'exclusive');
  try {
    process.stdout.write('locked\n');
    await Bun.stdin.text();
  } finally {
    lock.release();
  }
} else {
  await Bun.stdin.text();
  try {
    const document = updateConfigurationFile({
      path,
      ifMatch: process.argv[4]!,
      operations: [{ kind: 'set', path: [process.argv[5]!], value: process.argv[5]! }],
    });
    process.stdout.write(JSON.stringify({ status: 'ok', etag: document.etag }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ status: 'failed', code: (error as { code: string }).code }),
    );
  }
}
