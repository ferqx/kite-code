import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildNativeDesktop } from '../scripts/build-native';

// This fixture only reopens a previously completed owned Profile. It submits no business intent.
const original = JSON.parse(
  readFileSync(
    process.argv[2] ??
      resolve(import.meta.dir, '../../../.cache/trajectory-online-native-A4mAG9/fixture.json'),
    'utf8',
  ),
) as { directory: string; profile: { dataRoot: string; profile: string }; storeId: string };
const directory = realpathSync(
  mkdtempSync(resolve(import.meta.dir, '../../../.cache/trajectory-export-native-')),
);
for (const name of ['home', 'app', 'service', 'driver'])
  mkdirSync(join(directory, name), { mode: 0o700 });
const observation = { modelCalls: 0, permissionCalls: 0 };
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/unexpected-model') observation.modelCalls++;
    if (path === '/unexpected-permission') observation.permissionCalls++;
    return Response.json(observation);
  },
});
const control = server.url.href.replace(/\/$/, '');
try {
  const service = await Bun.build({
    entrypoints: [resolve(import.meta.dir, 'trajectory-export-native-service.fixture.ts')],
    outdir: join(directory, 'service'),
    naming: 'main.js',
    target: 'bun',
    packages: 'bundle',
    external: ['@kite-ai/agent', '@kite-ai/ai'],
    define: { TRAJECTORY_ONLINE_FIXTURE_CONTROL: JSON.stringify(control) },
  });
  if (!service.success) throw new AggregateError(service.logs, 'fixture_service_build_failed');
  const runtime = realpathSync(process.execPath),
    entry = join(directory, 'service/main.js'),
    hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  await buildNativeDesktop(
    {
      kind: 'development',
      serviceEntrypoint: entry,
      serviceSha256: hash(entry),
      bunExecutable: runtime,
      bunSha256: hash(runtime),
      buildId: 'trajectory-export-native-isolated',
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'history', 'commands', 'trajectory'],
      profile: original.profile,
    },
    join(directory, 'app'),
    { testDiagnostics: false },
  );
  const driver = await Bun.build({
    entrypoints: [resolve(import.meta.dir, 'trajectory-export-native-driver.fixture.ts')],
    outdir: join(directory, 'driver'),
    naming: 'driver.mjs',
    target: 'node',
    packages: 'external',
  });
  if (!driver.success) throw new AggregateError(driver.logs, 'fixture_driver_build_failed');
  const fixture = {
    directory,
    outdir: join(directory, 'app'),
    profile: original.profile,
    storeId: original.storeId,
    sourceDirectory: original.directory,
    control,
  };
  writeFileSync(join(directory, 'fixture.json'), JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify({ phase: 'built', ...fixture }));
  const node = Bun.which('node');
  if (!node) throw Error('node_driver_required');
  const child = Bun.spawn(
    [
      node,
      join(directory, 'driver/driver.mjs'),
      join(directory, 'fixture.json'),
      resolve(import.meta.dir, '../package.json'),
    ],
    { cwd: directory, stdout: 'inherit', stderr: 'inherit' },
  );
  process.exitCode = await child.exited;
} finally {
  server.stop(true);
  writeFileSync(join(directory, 'control-final.json'), JSON.stringify(observation, null, 2));
}
