import { acquireInheritedProfileAccess } from '@kite-ai/agent/profile-access';

try {
  if (process.argv.length !== 3) throw Error('profile_access_unavailable');
  const options = JSON.parse(process.argv[2]!);
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).sort().join(',') !== 'dataRoot,profile' ||
    typeof options.dataRoot !== 'string' ||
    typeof options.profile !== 'string'
  )
    throw Error('profile_access_unavailable');
  const access = acquireInheritedProfileAccess({ ...options, fd: 3 });
  access.lock.release();
  console.log('profile-access-acquired');
} catch (error) {
  const code = (error as { code?: string }).code ?? (error as Error).message;
  console.log(
    code === 'owner_busy' || code === 'restore_reconciliation_required'
      ? code
      : 'profile_access_unavailable',
  );
  process.exitCode = 1;
}
