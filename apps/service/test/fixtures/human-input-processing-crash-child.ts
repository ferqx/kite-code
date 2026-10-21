import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import {
  binding,
  permissions,
  runCrashFixture,
} from '../../../../packages/agent/test/isolated/recovery/human-input-processing-crash-fixture';
import { createDefaultProcessConfiguration } from '../../src/configuration';

const root = process.argv[2]!;
const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
const host = createDefaultProcessConfiguration({
  profile,
  userConfigurationPath: join(profile.profilePath, 'config.jsonc'),
  permissions,
});
await runCrashFixture(root, 'model', {
  ...host,
  resolveRunConfiguration: async (input) => ({
    ...(await host.resolveRunConfiguration!(input)),
    model: binding(root).model,
  }),
});
