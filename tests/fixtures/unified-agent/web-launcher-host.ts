import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { runDevelopmentWeb } from '../../../scripts/development/unified-web';

const root = process.argv[2];
if (!root) throw new Error('missing_fixture_root');
await runDevelopmentWeb({
  selection: {
    profile: selectProfile({ dataRoot: join(root, 'data'), profile: 'development' }),
    entrypoint: join(import.meta.dir, 'web-launcher-service.ts'),
    buildId: 'fixed-launcher-fixture',
    instanceId: crypto.randomUUID(),
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'history'],
    // Trusted test binding enters only the private startup channel.
    hostConfiguration: { ledger: join(root, 'effect'), release: join(root, 'release') },
  },
});
