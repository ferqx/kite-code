import { existsSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { runServiceProcess } from '../../src/main';

await runServiceProcess({
  configure(startup) {
    const profile = selectProfile({
      dataRoot: startup.profile.dataRoot,
      profile: startup.profile.profile,
    });
    let gated = false;
    return createDefaultProcessConfiguration({
      profile,
      hostConfiguration: startup.hostConfiguration,
      allowedToolCapabilities: [
        'files.read',
        'files.write',
        'files.edit',
        'files.list',
        'files.glob',
        'files.search',
        'skills.load',
        'skills.resource',
      ],
      permissions: {
        async authorize(request) {
          if (
            request.kind === 'tool' &&
            !gated &&
            existsSync(join(profile.profilePath, 'gate-enabled'))
          ) {
            gated = true;
            writeFileSync(join(profile.profilePath, 'permission-entered'), 'entered');
            await new Promise<void>((resolve, reject) => {
              const release = join(profile.profilePath, 'permission-release');
              const watcher = watch(profile.profilePath, () => {
                if (existsSync(release)) finish();
              });
              const abort = () => {
                watcher.close();
                reject(request.signal.reason);
              };
              function finish() {
                watcher.close();
                request.signal.removeEventListener('abort', abort);
                resolve();
              }
              request.signal.addEventListener('abort', abort, { once: true });
              if (request.signal.aborted) abort();
              else if (existsSync(release)) finish();
            });
          }
          return { allowed: true, revision: 'explicit-fixture-policy' };
        },
      },
    });
  },
});
