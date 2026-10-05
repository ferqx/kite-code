import { selectProfile } from '@kite-ai/agent/profile';
import { reserveDaemonEndpoint, selectDaemonEndpoint } from '../../src/daemon/endpoint';

const [root, path, id] = process.argv.slice(2);
const p = selectProfile({ dataRoot: `${root!}/data`, profile: 'test' });
try {
  const owner = await reserveDaemonEndpoint(
    selectDaemonEndpoint({ profileAccessKey: p.profileAccessKey, explicitSocket: path! }),
    {
      profile: { dataRoot: p.dataRoot, name: p.profile, accessKey: p.profileAccessKey },
      instanceId: id!,
      buildId: 'fixed',
      workspace: root!,
    },
  );
  await owner.listen({
    httpEndpoint: 'http://127.0.0.1:12345',
    token: 'x'.repeat(64),
    webOrigin: 'http://127.0.0.1:12346',
  });
  console.log(JSON.stringify(owner.reservation));
  await Bun.stdin.stream().getReader().read();
  await owner.close();
} catch (error) {
  console.log(
    JSON.stringify({ error: (error as NodeJS.ErrnoException).code ?? (error as Error).message }),
  );
  process.exitCode = 1;
}
