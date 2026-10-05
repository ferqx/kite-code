import { dlopen } from 'bun:ffi';
import { closeSync, constants, openSync } from 'node:fs';
import {
  createCredentialVault,
  createTemporaryCredentialBackend,
  updateConfigurationFile,
} from '@kite-ai/agent/config';

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
  const fd = openSync(
    `${path}.lock`,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  const library = dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    { flock: { args: ['i32', 'i32'], returns: 'i32' } },
  );
  if (library.symbols.flock(fd, 2 | 4) !== 0) throw new Error('fixture_lock_busy');
  process.stdout.write('locked\n');
  await Bun.stdin.text();
  closeSync(fd);
  library.close();
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
