import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { buildNativeDesktop } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'actual Electron private SQLite retains profile lock after Service crash until UI close or Node death; maintenance and journals cannot create an empty UI store',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-profile-access-'));
    const { acquireProfileAccess } = await import(
      resolve(import.meta.dir, '../../../../packages/agent/src/platform/profile.ts')
    );
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' }),
      other = selectProfile({ dataRoot: profile.dataRoot, profile: 'other' }),
      blocked = selectProfile({ dataRoot: profile.dataRoot, profile: 'blocked' });
    for (const selected of [profile, other, blocked]) {
      const store = await openSqliteStore(selected);
      const storeId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: new URL(`file://${workspace}`).href,
        name: 'fixture',
      });
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Native A',
      });
      await store.close();
    }
    let hold: ReturnType<typeof acquireProfileAccess> | undefined,
      backups = 0,
      provider = 0;
    const control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/hold') {
          hold = acquireProfileAccess(blocked, 'exclusive');
          return new Response('held');
        }
        if (path === '/release') {
          hold?.lock.release();
          hold = undefined;
          return new Response('released');
        }
        if (path === '/journal') {
          writeFileSync(join(blocked.coordinationPath, 'restore-journal.json'), '{}', {
            mode: 0o600,
          });
          return new Response('ok');
        }
        if (path === '/clear-journal') {
          unlinkSync(join(blocked.coordinationPath, 'restore-journal.json'));
          return new Response('ok');
        }
        if (path === '/blocked-ui')
          return Response.json({
            present: existsSync(join(blocked.profilePath, 'desktop-private/data.sqlite')),
          });
        if (path === '/count') return new Response(String(provider));
        if (path === '/maintenance' || path === '/other-maintenance') {
          try {
            await createProfileBackup({
              profile: path === '/maintenance' ? profile : other,
              destinationRoot: join(root, `backup-${backups++}`),
            });
            return new Response('available');
          } catch (error) {
            return new Response((error as { code?: string }).code ?? (error as Error).message);
          }
        }
        provider++;
        return new Response('unexpected Provider', { status: 500 });
      },
    });
    const bunExecutable = realpathSync(process.execPath),
      serviceEntrypoint = join(root, 'service.js');
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
    const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const assets = {
      serviceEntrypoint,
      bunExecutable,
      serviceSha256: sha(serviceEntrypoint),
      bunSha256: sha(bunExecutable),
      buildId: 'native-profile-lock-fixture',
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
    };
    const outdir = join(root, 'app'),
      blockedApp = join(root, 'blocked-app');
    await buildNativeDesktop(
      { ...assets, profile: { dataRoot: profile.dataRoot, profile: profile.profile } },
      outdir,
    );
    await buildNativeDesktop(
      { ...assets, profile: { dataRoot: blocked.dataRoot, profile: blocked.profile } },
      blockedApp,
    );
    const source = readFileSync(
      resolve(import.meta.dir, '../native-profile-access-electron.fixture.ts'),
      'utf8',
    ).replace(
      "import { _electron } from 'playwright';",
      `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
    );
    writeFileSync(join(root, 'driver.ts'), source);
    symlinkSync(
      resolve(import.meta.dir, '../../../../node_modules'),
      join(root, 'node_modules'),
      'dir',
    );
    const built = await Bun.build({
      entrypoints: [join(root, 'driver.ts')],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'driver.js',
    });
    if (!built.success) throw new AggregateError(built.logs, 'driver_build_failed');
    const child = Bun.spawn(
      [
        realpathSync(Bun.which('node')!),
        join(root, 'driver.js'),
        outdir,
        blockedApp,
        root,
        require('electron') as string,
        `http://127.0.0.1:${control.port}`,
        bunExecutable,
      ],
      { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
    );
    const out = new Response(child.stdout).text(),
      err = new Response(child.stderr).text();
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    try {
      const code = await child.exited;
      const stderr = await err;
      if (code !== 0) console.error(stderr);
      expect(code).toBe(0);
      const output = await out;
      console.info(output.trim());
      expect(output).toContain('Native Profile Access Node assertions:');
      expect(provider).toBe(0);
    } finally {
      clearTimeout(timer);
      hold?.lock.release();
      child.kill('SIGKILL');
      await child.exited;
      const owned = String(execFileSync('/bin/ps', ['-axo', 'pid=,command=']))
        .split('\n')
        .filter(
          (line) =>
            line.includes(`--user-data-dir=${root}`) ||
            line.trim().endsWith(` ${serviceEntrypoint}`),
        )
        .map((line) => Number(line.trim().split(/\s+/)[0]));
      for (const pid of owned) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      control.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
