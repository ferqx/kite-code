import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import type { PairedServiceSpawner } from '@kite-ai/service/paired';
import { pairedNodeChild } from '../../src/node-process';
import { userConfigurationPath } from '../../src/user-configuration-path';
import { spawnFixtureNodeService } from './node-service-process';

export { userConfigurationPath };

/** Owned test home; no fixture reads or writes the developer's real user configuration. */
export function ownedUserConfiguration(home: string) {
  const path = userConfigurationPath(home);
  privateDirectory(dirname(path));
  const homeEnvironment = {
    HOME: home,
    ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
  };
  const spawnChild: PairedServiceSpawner = ([executable, ...args], { env }) => {
    const environment = { ...env, ...homeEnvironment };
    if (args.at(-1)?.endsWith('.ts'))
      return pairedNodeChild(spawnFixtureNodeService(args, environment));
    return pairedNodeChild(
      spawn(executable!, args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  };
  return { path, homeEnvironment, spawnChild };
}
