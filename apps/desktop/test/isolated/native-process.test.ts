import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { expect, test } from '#kite-test';
import { fixtureNodeLoader } from '../../../../packages/agent/test/fixtures/node-runtime';
import { spawn as spawnFixtureProcess } from '../../../../scripts/tooling/process';
import { directoryLink, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { parseNativeAssets } from '../../electron/native-assets';
import { decodeNativeRequest } from '../../electron/native-ipc';
import { buildNativeDesktop } from '../../scripts/build-native';
import { buildNativeTestService } from '../native-node-service.fixture';

async function bounded<T>(promise: Promise<T>, timeout = 10000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('native_fixture_timeout')), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
test('actual Node paired spawn uses the one public launcher with private bootstrap; EOF reaps only its owned Service', async () => {
  const root = realpathSync(temporaryDirectory('kite-node-paired-'));
  const outdir = join(root, 'app');
  const service = await buildNativeTestService(outdir);
  const { serviceEntrypoint, runtimeExecutable } = service.assets;
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'native' });
  directoryLink(
    resolve(import.meta.dirname, '../../../../node_modules'),
    join(root, 'node_modules'),
  );
  const entry = join(root, 'node-main.mjs');
  const processModule = pathToFileURL(
    resolve(import.meta.dirname, '../../electron/node-process.ts'),
  );
  writeFileSync(
    entry,
    `import {launchPairedService} from '@kite-ai/service/paired';\nimport{spawnNodePairedChild}from ${JSON.stringify(processModule.href)};\nconst options=${JSON.stringify({ entrypoint: serviceEntrypoint, executable: runtimeExecutable, profile, instanceId: 'native-node-test', buildId: 'native-node-test', apiMajor: 1, requiredCapabilities: ['sessions', 'history', 'commands'] })};\nconst paired=await launchPairedService({...options,spawnChild:spawnNodePairedChild});\nif(!process.versions.node || process.versions.electron)throw Error('not_actual_node');\nconst directory=await paired.client.listSessions();\nconst pid=paired.pid;await paired.close();\nlet stopped=false;try{process.kill(pid,0)}catch{stopped=true};\nconsole.log(JSON.stringify({directory,pid,stopped,identity:paired.bootstrap.instanceId}));`,
  );
  const driver = spawnFixtureProcess([runtimeExecutable, '--import', fixtureNodeLoader, entry], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  try {
    const exit = await bounded(driver.exited);
    const stdout = await new Response(driver.stdout).text(),
      stderr = await new Response(driver.stderr).text();
    if (exit !== 0) console.error(stderr.slice(0, 2000));
    expect(exit).toBe(0);
    expect(stderr).toBe('');
    const fact = JSON.parse(stdout) as { directory: unknown[]; stopped: boolean; identity: string };
    expect(fact.directory).toEqual([]);
    expect(fact.stopped).toBe(true);
    expect(fact.identity).toBe('native-node-test');
    const assets = parseNativeAssets({
      ...service.assets,
      buildId: 'native-node-test',
      apiMajor: 1,
      requiredCapabilities: ['sessions'],
      profile: { dataRoot: join(root, 'data'), profile: 'native' },
    });
    await buildNativeDesktop(assets, outdir, { runtimeAddon: service.runtimeAddon });
    const renderer = readFileSync(join(root, 'app/renderer.js'), 'utf8');
    expect(renderer).not.toContain(profile.profileAccessKey);
    expect(renderer).not.toContain(serviceEntrypoint);
    expect(renderer).not.toContain(runtimeExecutable);
    expect(() => decodeNativeRequest({ method: 'state', generation: 1, token: 'opaque' })).toThrow(
      'invalid_native_request',
    );
  } finally {
    driver.kill();
    await driver.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
