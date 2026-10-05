import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { buildNativeDesktop } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
function gate() {
  let release!: () => void, enter!: () => void;
  return {
    promise: new Promise<void>((r) => {
      release = r;
    }),
    entered: new Promise<void>((r) => {
      enter = r;
    }),
    release: () => release(),
    enter: () => enter(),
  };
}
async function bounded<T>(promise: Promise<T>, milliseconds = 15000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('native_fixture_timeout')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
test.skipIf(process.platform !== 'darwin')(
  'actual Electron Fork reads linked >17MiB output in original scope; rename CAS and unknown delete remain exact and view-only',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-sessions-')),
      barrier = gate();
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' }),
      workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Native fixture',
      rootUri: new URL(`file://${workspace}`).href,
    });
    for (const id of ['s', 'other'])
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: `create-${id}`,
        sessionId: id,
        workspaceId: 'w',
        title: id === 's' ? 'Native A' : 'Native B',
      });
    await store.close();
    let requests = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/release') {
          barrier.release();
          return new Response('ok');
        }
        if (path === '/count') return new Response(String(requests));
        if (path === '/entered') {
          await barrier.entered;
          return new Response('ok');
        }
        await request.json();
        requests++;
        barrier.enter();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: ' +
                    JSON.stringify({
                      id: 'native',
                      object: 'chat.completion.chunk',
                      choices: [
                        {
                          index: 0,
                          delta: { role: 'assistant', content: 'NATIVE STREAM START' },
                          finish_reason: null,
                        },
                      ],
                    }) +
                    '\n\n',
                ),
              );
              await barrier.promise;
              controller.enqueue(
                new TextEncoder().encode(
                  'data: ' +
                    JSON.stringify({
                      id: 'native',
                      object: 'chat.completion.chunk',
                      choices: [
                        {
                          index: 0,
                          delta: {
                            content: `${(`${'x'.repeat(65536)}\n\n`).repeat(288)}\n\nMODEL OUTPUT COMPLETE TAIL`,
                          },
                          finish_reason: 'stop',
                        },
                      ],
                      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                    }) +
                    '\n\ndata: [DONE]\n\n',
                ),
              );
              controller.close();
            } catch {
              /* A canceled client owns its socket; no success is fabricated. */
            }
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'local',
        models: [
          {
            id: 'local',
            provider: 'compatible',
            model: 'local',
            baseURL: `http://127.0.0.1:${provider.port}/v1`,
          },
        ],
      }),
    );
    const serviceEntrypoint = join(root, 'service.js'),
      bunExecutable = realpathSync(process.execPath),
      outdir = join(root, 'app');
    const serviceBuild = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../../../service/src/main.ts')],
      target: 'bun',
      format: 'esm',
      packages: 'external',
      outdir: root,
      naming: 'service.js',
    });
    if (!serviceBuild.success)
      throw new AggregateError(serviceBuild.logs, 'private_service_build_failed');
    await buildNativeDesktop(
      {
        serviceEntrypoint,
        bunExecutable,
        serviceSha256: createHash('sha256').update(readFileSync(serviceEntrypoint)).digest('hex'),
        bunSha256: createHash('sha256').update(readFileSync(bunExecutable)).digest('hex'),
        buildId: 'native-electron-fixture',
        apiMajor: 1,
        requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
        profile: { dataRoot: profile.dataRoot, profile: profile.profile },
      },
      outdir,
    );
    const fixture = join(root, 'driver.ts'),
      driverPath = join(root, 'driver.js');
    writeFileSync(
      fixture,
      readFileSync(
        resolve(import.meta.dir, '../native-sessions-electron.fixture.ts'),
        'utf8',
      ).replace(
        "import { _electron } from 'playwright';",
        `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
      ),
    );
    const built = await Bun.build({
      entrypoints: [fixture],
      target: 'node',
      format: 'esm',
      outdir: root,
      naming: 'driver.js',
      packages: 'external',
    });
    if (!built.success) throw new AggregateError(built.logs, 'driver_build_failed');
    symlinkSync(
      resolve(import.meta.dir, '../../../../node_modules'),
      join(root, 'node_modules'),
      'dir',
    );
    const driver = Bun.spawn(
      [
        realpathSync(Bun.which('node')!),
        driverPath,
        outdir,
        root,
        profile.dataRoot,
        storeId,
        `127.0.0.1:${provider.port}`,
        require('electron') as string,
        `http://127.0.0.1:${provider.port}`,
        bunExecutable,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      },
    );
    const stderrPromise = new Response(driver.stderr).text(),
      stdoutPromise = new Response(driver.stdout).text();
    try {
      const exit = await bounded(driver.exited, 45000);
      const stderr = await stderrPromise;
      if (exit !== 0) console.error(stderr.slice(0, 5000));
      expect(exit).toBe(0);
      const output = await stdoutPromise;
      console.info(output.trim());
      expect(output).toContain('Native Session Node assertions:');
      expect(requests).toBe(1);
    } finally {
      barrier.release();
      driver.kill('SIGKILL');
      await driver.exited;
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
