import {
  type KiteLocalRuntimeProcessIdentityProbe,
  readLocalProcessStartIdentity,
} from '../service';

/** Exact PID + OS start-token probe shared by the single-Service lifecycle manager. */
export function createKiteSingleServiceNativeProcessIdentityProbe(
  platform: NodeJS.Platform = process.platform,
): KiteLocalRuntimeProcessIdentityProbe {
  return Object.freeze({
    async inspect(pid: number, expectedStartIdentity: string) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || !expectedStartIdentity) return 'uncertain';
      const actual = await readLocalProcessStartIdentity(pid, platform);
      if (actual !== undefined) return actual === expectedStartIdentity ? 'alive' : 'dead';
      try {
        process.kill(pid, 0);
        return 'uncertain';
      } catch (error) {
        return errorCodeIs(error, 'ESRCH') ? 'dead' : 'uncertain';
      }
    },
  });
}

function errorCodeIs(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
