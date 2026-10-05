import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { runDaemonProcess } from '@kite-ai/service/daemon-main';

try {
  await runDaemonProcess({
    async configure(startup) {
      const profile = selectProfile({
        dataRoot: startup.profile.dataRoot,
        profile: startup.profile.profile,
      });
      const backend = createTemporaryCredentialBackend();
      await backend.put('credential:11111111-1111-4111-8111-111111111111', 'owned-local-secret');
      return createDefaultProcessConfiguration({
        profile,
        credentialBackend: {
          kind: 'temporary',
          put: backend.put,
          remove: backend.remove,
          async resolve(id) {
            appendFileSync(join(dirname(profile.dataRoot), 'vault-reads'), 'resolve\n');
            return backend.resolve(id);
          },
        },
      });
    },
  });
} catch {
  process.stderr.write('shared_skills_fixture_failed\n');
  process.exitCode = 1;
}
