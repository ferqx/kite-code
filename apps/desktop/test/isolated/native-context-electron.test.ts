import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
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
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('native_context_timeout')), 45000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
test.skipIf(process.platform !== 'darwin')(
  'actual Native Context idle Rewind suppresses the original Job; exact active Include queues then reaches next Model checkpoint once with no Job replay',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-context-')),
      profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' }),
      workspace = join(root, 'workspace'),
      ledger = join(root, 'ledger');
    mkdirSync(workspace);
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile }),
      storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Native fixture',
      rootUri: `file://${workspace}`,
    });
    await store.createSession({
      expectedStoreId: storeId,
      subjectId: 'local-user',
      commandId: 'create-s',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Native A',
    });
    await store.close();
    const requests: unknown[] = [];
    let release!: () => void, entered!: () => void, releaseJob!: () => void;
    const jobGate = new Promise<void>((r) => {
      releaseJob = r;
    });
    const thirdGate = new Promise<void>((r) => {
        release = r;
      }),
      thirdEntered = new Promise<void>((r) => {
        entered = r;
      });
    const control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/job-gate') {
          await jobGate;
          return new Response('released');
        }
        if (path === '/release-job') {
          releaseJob();
          return new Response('ok');
        }
        if (path === '/record') {
          requests.push(await request.json());
          return new Response('ok');
        }
        if (path === '/third-gate') {
          entered();
          await thirdGate;
          return new Response('released');
        }
        if (path === '/third-entered') {
          await thirdEntered;
          return new Response('entered');
        }
        if (path === '/release-third') {
          release();
          return new Response('ok');
        }
        if (path === '/requests') return Response.json(requests);
        if (path === '/effects')
          return new Response(
            String(existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').length : 0),
          );
        if (path === '/count') return new Response(String(requests.length));
        return new Response('missing', { status: 404 });
      },
    });
    const serviceSource = join(root, 'service.ts');
    writeFileSync(
      serviceSource,
      readFileSync(resolve(import.meta.dir, '../native-context-service.fixture.ts'), 'utf8')
        .replace("'CONTROL_URL'", JSON.stringify(`http://127.0.0.1:${control.port}`))
        .replace("'LEDGER_PATH'", JSON.stringify(ledger)),
    );
    symlinkSync(
      resolve(import.meta.dir, '../../../../node_modules'),
      join(root, 'node_modules'),
      'dir',
    );
    const service = await Bun.build({
      entrypoints: [serviceSource],
      target: 'bun',
      format: 'esm',
      packages: 'external',
      outdir: root,
      naming: 'service.js',
    });
    if (!service.success)
      throw new AggregateError(service.logs, 'private_context_service_build_failed');
    const serviceEntrypoint = join(root, 'service.js'),
      bunExecutable = realpathSync(process.execPath),
      outdir = join(root, 'app');
    await buildNativeDesktop(
      {
        serviceEntrypoint,
        bunExecutable,
        serviceSha256: createHash('sha256').update(readFileSync(serviceEntrypoint)).digest('hex'),
        bunSha256: createHash('sha256').update(readFileSync(bunExecutable)).digest('hex'),
        buildId: 'native-context-fixture',
        apiMajor: 1,
        requiredCapabilities: ['sessions', 'history', 'commands', 'context'],
        profile: { dataRoot: profile.dataRoot, profile: profile.profile },
      },
      outdir,
    );
    const fixture = join(root, 'driver.ts');
    writeFileSync(
      fixture,
      readFileSync(resolve(import.meta.dir, '../native-context-electron.fixture.ts'), 'utf8')
        .replace(
          "import { _electron } from 'playwright';",
          `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
        )
        .replace(
          "import {_electron} from 'playwright';",
          `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
        ),
    );
    const build = await Bun.build({
      entrypoints: [fixture],
      target: 'node',
      format: 'esm',
      packages: 'external',
      outdir: root,
      naming: 'driver.js',
    });
    if (!build.success) throw new AggregateError(build.logs, 'driver_build_failed');
    const driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          outdir,
          root,
          storeId,
          require('electron') as string,
          `http://127.0.0.1:${control.port}`,
          bunExecutable,
        ],
        { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
      ),
      stderr = new Response(driver.stderr).text(),
      stdout = new Response(driver.stdout).text();
    try {
      const exit = await bounded(driver.exited),
        diagnostics = await stderr;
      if (exit !== 0) console.error(diagnostics.slice(0, 6500));
      expect(exit).toBe(0);
      const output = await stdout;
      console.info(output.trim());
      expect(output).toContain('Native Context Node assertions:');
      expect(requests).toHaveLength(4);
      expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
    } finally {
      releaseJob();
      release();
      driver.kill('SIGKILL');
      await driver.exited;
      control.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
