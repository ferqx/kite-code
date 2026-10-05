import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { runServiceProcess } from '@kite-ai/service/main';

await runServiceProcess({
  configure(startup) {
    const base = dirname(startup.profile.dataRoot);
    return createDefaultProcessConfiguration({
      profile: selectProfile(startup.profile),
      hostConfiguration: startup.hostConfiguration,
      credentialBackend: {
        kind: 'temporary',
        async put() {
          appendFileSync(join(base, 'credential-io'), 'put\n');
          throw Error('credential_io_forbidden');
        },
        async resolve() {
          appendFileSync(join(base, 'credential-io'), 'resolve\n');
          throw Error('credential_io_forbidden');
        },
        async remove() {
          appendFileSync(join(base, 'credential-io'), 'remove\n');
          throw Error('credential_io_forbidden');
        },
      },
    });
  },
});
