import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { defineExtension } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { runServiceProcess } from '../../src/main';

await runServiceProcess({
  async configure(startup) {
    const backend = createTemporaryCredentialBackend();
    // Private explicit test host only; this is not a production default credential.
    await backend.put('credential:11111111-1111-4111-8111-111111111111', 'local-fixture-secret');
    const selected = selectProfile({
      dataRoot: startup.profile.dataRoot,
      profile: startup.profile.profile,
    });
    return {
      ...createDefaultProcessConfiguration({
        profile: selected,
        hostConfiguration: startup.hostConfiguration,
        credentialBackend: backend,
        knownToolIds: ['a'],
      }),
      extensions: [
        defineExtension({
          id: 'fixture.config-tool',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'a',
              version: '1',
              description: 'Tool with model id spelling',
              inputSchema: {},
              async execute() {
                appendFileSync(join(selected.profilePath, 'tool-ledger'), 'dispatched\n');
                return { outcome: 'succeeded', content: 'effect' };
              },
            },
          ],
        }),
      ],
    };
  },
});
