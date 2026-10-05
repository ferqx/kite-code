import { selectProfile } from '@kite-ai/agent/profile';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { runServiceProcess } from '../../src/main';

await runServiceProcess({
  configure(startup) {
    const host = createDefaultProcessConfiguration({
      profile: selectProfile({
        dataRoot: startup.profile.dataRoot,
        profile: startup.profile.profile,
      }),
      credentialBackend: {
        kind: 'temporary',
        async put() {},
        async resolve() {
          return null;
        },
        async remove() {},
      },
    });
    const management = host.configurationManagement!;
    return {
      ...host,
      configurationManagement(runtime) {
        if (runtime) {
          const begin = runtime.tryBeginShutdown.bind(runtime);
          runtime.tryBeginShutdown = (mode) =>
            begin(mode, {
              beforeResourceClose: async () => {
                throw Error('fixture_unconfirmed_host_resource');
              },
            });
        }
        return management(runtime);
      },
    };
  },
});
