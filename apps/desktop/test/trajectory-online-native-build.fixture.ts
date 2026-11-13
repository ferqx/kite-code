import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { build as buildFixture } from '../../../scripts/tooling/build';
import { serve as serveFixture } from '../../../scripts/tooling/http';
import {
  which as findFixtureExecutable,
  spawn as spawnFixtureProcess,
} from '../../../scripts/tooling/process';
import { buildNativeDesktop } from '../scripts/build-native';

// Explicit fixture artifact. It never modifies ordinary Main/renderer/service sources.
const directory = realpathSync(
  mkdtempSync(resolve(import.meta.dirname, '../../../.cache/trajectory-online-native-')),
);
for (const leaf of ['home', 'workspace', 'app', 'driver', 'service'])
  mkdirSync(join(directory, leaf), { mode: 0o700 });
const profile = { dataRoot: join(directory, 'data'), profile: 'isolated' };
const store = await openSqliteStore(profile),
  storeId = (await store.getMetadata()).storeId;
await store.createWorkspace({
  expectedStoreId: storeId,
  id: 'w',
  rootUri: `file://${join(directory, 'workspace')}`,
  name: '轨迹隔离空间',
});
for (const [sessionId, title] of [
  ['s', 'Trajectory A'],
  ['other', 'Trajectory B'],
])
  await store.createSession({
    expectedStoreId: storeId,
    commandId: `create-${sessionId}`,
    sessionId: sessionId!,
    title: title!,
    workspaceId: 'w',
    subjectId: 'local-user',
  });
await store.close();
const observation = { calls: 0, prefixSaved: false, released: false, events: [] as unknown[] };
const gates = new Set<() => void>();
const server = await serveFixture({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/status') return Response.json(observation);
    if (path === '/browser-page')
      return new Response(
        '<!doctype html><title>Owned Browser Fixture</title><h1>Owned Browser Fixture</h1><input aria-label="Owned browser input">',
        { headers: { 'content-type': 'text/html' } },
      );
    if (path === '/model-start') {
      const value = await request.json();
      observation.calls++;
      observation.events.push({ at: Date.now(), kind: 'model-start', value });
      return new Response('ok');
    }
    if (path === '/prefix-saved') {
      observation.prefixSaved = true;
      observation.events.push({ at: Date.now(), kind: 'prefix-saved' });
      return new Response('ok');
    }
    if (path === '/release') {
      observation.released = true;
      for (const release of gates) release();
      gates.clear();
      return new Response('ok');
    }
    if (path === '/model-gate') {
      if (!observation.released) await new Promise<void>((resolve) => gates.add(resolve));
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },
});
const control = server.url.href.replace(/\/$/, '');
const service = join(directory, 'service/main.js');
const result = await buildFixture({
  entrypoints: [resolve(import.meta.dirname, 'trajectory-online-native-service.fixture.ts')],
  outdir: join(directory, 'service'),
  naming: 'main.js',
  target: 'node',
  packages: 'bundle',
  external: ['@kite-ai/agent', '@kite-ai/ai'],
  define: { TRAJECTORY_ONLINE_FIXTURE_CONTROL: JSON.stringify(control) },
});
if (!result.success) throw new AggregateError(result.logs, 'fixture_service_build_failed');
const runtime = realpathSync(process.execPath),
  hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
await buildNativeDesktop(
  {
    kind: 'development',
    serviceEntrypoint: service,
    serviceSha256: hash(service),
    runtimeExecutable: runtime,
    runtimeSha256: hash(runtime),
    buildId: 'trajectory-online-native-isolated',
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'history', 'commands', 'trajectory'],
    profile,
  },
  join(directory, 'app'),
  { testDiagnostics: false },
);
const driver = await buildFixture({
  entrypoints: [resolve(import.meta.dirname, 'trajectory-online-native-driver.fixture.ts')],
  target: 'node',
  packages: 'external',
  outdir: join(directory, 'driver'),
  naming: 'driver.mjs',
});
if (!driver.success) throw new AggregateError(driver.logs, 'fixture_driver_build_failed');
const fixture = { directory, profile, storeId, control, outdir: join(directory, 'app') };
writeFileSync(join(directory, 'fixture.json'), JSON.stringify(fixture, null, 2));
console.log(JSON.stringify({ phase: 'built', ...fixture }));
const node = findFixtureExecutable('node');
if (!node) throw Error('node_driver_required');
const packagePath = resolve(import.meta.dirname, '../package.json');
const child = spawnFixtureProcess(
  [node, join(directory, 'driver/driver.mjs'), join(directory, 'fixture.json'), packagePath],
  { stdout: 'inherit', stderr: 'inherit', cwd: directory },
);
try {
  process.exitCode = await child.exited;
} finally {
  for (const release of gates) release();
  server.stop(true);
  writeFileSync(join(directory, 'control-final.json'), JSON.stringify(observation, null, 2));
}
