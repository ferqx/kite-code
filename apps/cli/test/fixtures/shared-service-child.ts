import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { startService } from '@kite-ai/service';
import { selectDaemonEndpoint } from '@kite-ai/service/daemon';

const root = process.argv[2]!;
const drift = process.argv[3] === 'drift';
const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
const store = await openSqliteStore(profile);
const runtime = createRuntime({
  store,
  permissions: {
    async authorize() {
      return { allowed: true, revision: 'fixed' };
    },
  },
  modelId: 'fixed',
  model: {
    async *stream() {
      appendFileSync(join(root, 'models'), 'call\n');
      yield {
        type: 'finish' as const,
        reason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  },
});
const identity = {
  dataRoot: profile.dataRoot,
  name: profile.profile,
  accessKey: profile.profileAccessKey,
};
const service = await startService({
  runtime,
  profile: identity,
  instanceId: 'original-instance',
  buildId: 'running-build-not-client-build',
});
const { reserveDaemonEndpoint } = await import(
  new URL('../../../service/src/daemon/endpoint.ts', import.meta.url).href
);
const endpoint = selectDaemonEndpoint({
  profileAccessKey: profile.profileAccessKey,
  explicitSocket: join(root, 'd.sock'),
});
const owner = await reserveDaemonEndpoint(endpoint, {
  profile: identity,
  instanceId: drift ? 'wrong-instance' : service.bootstrap.instanceId,
  buildId: service.bootstrap.buildId,
  workspace: join(root, 'workspace'),
});
await owner.listen({
  httpEndpoint: service.endpoint,
  token: service.bootstrap.token,
  webOrigin: service.endpoint,
});
console.log('READY');
await new Promise<void>((resolve) => process.stdin.once('end', resolve).resume());
await service.close();
await owner.close();
