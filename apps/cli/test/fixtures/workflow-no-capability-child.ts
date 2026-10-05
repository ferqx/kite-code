import { selectProfile } from '@kite-ai/agent/profile';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { runServiceProcess } from '@kite-ai/service/main';

await runServiceProcess({
  configure(startup) {
    return {
      ...createDefaultProcessConfiguration({
        profile: selectProfile(startup.profile),
        hostConfiguration: startup.hostConfiguration,
        credentialBackend: {
          kind: 'temporary',
          async put() {},
          async remove() {},
          async resolve() {
            return null;
          },
        },
      }),
      supportsExtensionInputs: false,
    };
  },
});
