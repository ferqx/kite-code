import { dirname } from 'node:path';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import type { PairedServiceSpawner } from '@kite-ai/service/paired';
import { userConfigurationPath } from '../../src/user-configuration-path';

export { userConfigurationPath };

/** Owned test home; no fixture reads or writes the developer's real user configuration. */
export function ownedUserConfiguration(home: string) {
  const path = userConfigurationPath(home);
  privateDirectory(dirname(path));
  const homeEnvironment = {
    HOME: home,
    ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
  };
  const spawnChild: PairedServiceSpawner = (command, { env }) =>
    Bun.spawn([...command], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...env, ...homeEnvironment },
    });
  return { path, homeEnvironment, spawnChild };
}
