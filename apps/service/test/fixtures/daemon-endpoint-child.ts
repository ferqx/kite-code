import { selectProfile } from '@kite-ai/agent/profile';
import { reserveDaemonEndpoint, selectDaemonEndpoint } from '../../src/daemon/endpoint';

const [root, path, id] = process.argv.slice(2);
if (id === 'held-record-publication' || id === 'held-record-publication-slow') {
  const {
    closeSync,
    constants,
    fstatSync,
    fsyncSync,
    ftruncateSync,
    openSync,
    readFileSync,
    writeSync,
  } = await import('node:fs');
  const { dlopen } = require('bun:ffi') as typeof import('bun:ffi');
  const native = dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    {
      flock: { args: ['i32', 'i32'], returns: 'i32' },
    },
  );
  const fd = openSync(`${path!}.lock`, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    if (native.symbols.flock(fd, 2) !== 0) throw Error('fixture_record_lock_failed');
    const original = readFileSync(fd);
    const prefix = Buffer.from('{"reservationVersion":');
    writeSync(fd, prefix, 0, prefix.length, 0);
    ftruncateSync(fd, prefix.length);
    fsyncSync(fd);
    const stat = fstatSync(fd, { bigint: true });
    console.log(
      JSON.stringify({
        stage: 'incomplete-record-locked',
        dev: String(stat.dev),
        ino: String(stat.ino),
      }),
    );
    await Bun.stdin.stream().getReader().read();
    // The parent starts its synchronous reader while this separate process still owns EX.
    await Bun.sleep(id === 'held-record-publication-slow' ? 750 : 150);
    writeSync(fd, original, 0, original.length, 0);
    ftruncateSync(fd, original.length);
    fsyncSync(fd);
    if (native.symbols.flock(fd, 8) !== 0) throw Error('fixture_record_unlock_failed');
  } finally {
    closeSync(fd);
    native.close();
  }
  process.exit(0);
}
const p = selectProfile({ dataRoot: `${root!}/data`, profile: 'test' });
try {
  const owner = await reserveDaemonEndpoint(
    selectDaemonEndpoint({ profileAccessKey: p.profileAccessKey, explicitSocket: path! }),
    {
      profile: { dataRoot: p.dataRoot, name: p.profile, accessKey: p.profileAccessKey },
      instanceId: id!,
      buildId: 'fixed',
      workspace: root!,
    },
  );
  await owner.listen({
    httpEndpoint: 'http://127.0.0.1:12345',
    token: 'x'.repeat(64),
    webOrigin: 'http://127.0.0.1:12346',
  });
  console.log(JSON.stringify(owner.reservation));
  await Bun.stdin.stream().getReader().read();
  await owner.close();
} catch (error) {
  console.log(
    JSON.stringify({ error: (error as NodeJS.ErrnoException).code ?? (error as Error).message }),
  );
  process.exitCode = 1;
}
