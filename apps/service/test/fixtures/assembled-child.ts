import { existsSync, writeFileSync } from 'node:fs';
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
            const release = join(profile.profilePath, 'permission-release');
            while (!existsSync(release)) {
              request.signal.throwIfAborted();
              let timer: ReturnType<typeof setTimeout> | undefined;
              let abort: (() => void) | undefined;
              try {
                await new Promise<void>((resolve, reject) => {
                  abort = () => reject(request.signal.reason);
                  request.signal.addEventListener('abort', abort, { once: true });
                  if (request.signal.aborted) abort();
                  else timer = setTimeout(resolve, 5);
                });
              } finally {
                if (timer) clearTimeout(timer);
                if (abort) request.signal.removeEventListener('abort', abort);
              }
            }
            request.signal.throwIfAborted();
            console.error('assembly_permission_gate:release-consumed');
          }
          return { allowed: true, revision: 'explicit-fixture-policy' };
        },
      },
    });
  },
});
