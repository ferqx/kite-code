import { fstatSync } from 'node:fs';
import { acquireProfileMaintenanceAccess } from '../../../src/platform/profile';
import { acquireInheritedProfileAccess } from '../../../src/profile-access';

const [mode, dataRoot, profile] = process.argv.slice(2);
try {
  const access =
    mode === 'inherited'
      ? acquireInheritedProfileAccess({ dataRoot: dataRoot!, profile: profile!, fd: 3 })
      : acquireProfileMaintenanceAccess({ dataRoot: dataRoot!, profile: profile! });
  const key = access.profileAccessKey;
  access.lock.release();
  if (mode === 'inherited') {
    try {
      fstatSync(3);
      throw new Error('helper fd was not closed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
    }
  }
  console.log(JSON.stringify({ ok: true, key, pid: process.pid }));
} catch (error) {
  let closed = true;
  if (mode === 'inherited') {
    try {
      fstatSync(3);
      closed = false;
    } catch {}
  }
  console.log(
    JSON.stringify({
      ok: false,
      closed,
      code: (error as { code?: string }).code ?? (error as Error).message,
    }),
  );
  process.exitCode = 75;
}
