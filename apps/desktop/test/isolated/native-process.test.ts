import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { parseNativeAssets } from '../../electron/native-assets';
import { decodeNativeRequest } from '../../electron/native-ipc';
import { buildNativeDesktop } from '../../scripts/build-native';

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
  const root = realpathSync(mkdtempSync('/private/tmp/kite-node-paired-'));
  const serviceEntry = realpathSync(resolve(import.meta.dir, '../../../service/dist/main.js'));
  const bunExecutable = realpathSync(process.execPath);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'native' });
  symlinkSync(
    resolve(import.meta.dir, '../../../../node_modules'),
    join(root, 'node_modules'),
    'dir',
  );
  const entry = join(root, 'entry.ts'),
    output = join(root, 'node-main.js');
  writeFileSync(
    entry,
    `import {launchPairedService} from '@kite-ai/service/paired';\nimport{spawnNodePairedChild}from ${JSON.stringify(resolve(import.meta.dir, '../../electron/node-process.ts'))};\nconst options=${JSON.stringify({ entrypoint: serviceEntry, executable: bunExecutable, profile, instanceId: 'native-node-test', buildId: 'native-node-test', apiMajor: 1, requiredCapabilities: ['sessions', 'history', 'commands'] })};\nconst paired=await launchPairedService({...options,spawnChild:spawnNodePairedChild});\nif(typeof Bun!=='undefined')throw Error('not_actual_node');\nconst directory=await paired.client.listSessions();\nconst pid=paired.pid;await paired.close();\nlet stopped=false;try{process.kill(pid,0)}catch{stopped=true};\nconsole.log(JSON.stringify({directory,pid,stopped,identity:paired.bootstrap.instanceId}));`,
  );
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'node',
    format: 'esm',
    outdir: root,
    naming: 'node-main.js',
    external: ['electron'],
  });
  if (!result.success) throw new AggregateError(result.logs, 'node_fixture_build');
  // Node is a test driver; the Service executable remains the explicit trusted Bun binary.
  const node = realpathSync(Bun.which('node')!);
  const driver = Bun.spawn([node, output], {
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
      serviceEntrypoint: serviceEntry,
      bunExecutable,
      serviceSha256: createHash('sha256').update(readFileSync(serviceEntry)).digest('hex'),
      bunSha256: createHash('sha256').update(readFileSync(bunExecutable)).digest('hex'),
      buildId: 'native-node-test',
      apiMajor: 1,
      requiredCapabilities: ['sessions'],
      profile: { dataRoot: join(root, 'data'), profile: 'native' },
    });
    await buildNativeDesktop(assets, join(root, 'app'));
    const renderer = readFileSync(join(root, 'app/renderer.js'), 'utf8');
    expect(renderer).not.toContain(profile.profileAccessKey);
    expect(renderer).not.toContain(serviceEntry);
    expect(renderer).not.toContain(bunExecutable);
    expect(() => decodeNativeRequest({ method: 'state', generation: 1, token: 'opaque' })).toThrow(
      'invalid_native_request',
    );
  } finally {
    driver.kill();
    await driver.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
