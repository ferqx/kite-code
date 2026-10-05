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
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { buildNativeDesktop } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'actual two Electron Main lifetimes retain complete original answer and reconcile only its command GET',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-answer-journal-'));
    const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const store = await openSqliteStore(profile);
      const storeId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'owned',
        rootUri: `file://${root}`,
      });
      for (const id of ['s', 'other'])
        await store.createSession({
          expectedStoreId: storeId,
          subjectId: 'local-user',
          commandId: `create-${id}`,
          sessionId: id,
          workspaceId: 'w',
          title: id,
        });
      await store.close();
      symlinkSync(
        resolve(import.meta.dir, '../../../../node_modules'),
        join(root, 'node_modules'),
        'dir',
      );
      const source = join(root, 'service.ts');
      writeFileSync(
        source,
        readFileSync(
          resolve(import.meta.dir, '../answer-journal-child.fixture.ts'),
          'utf8',
        ).replace("'LEDGER_PATH'", JSON.stringify(join(root, 'ledger'))),
      );
      const service = await Bun.build({
        entrypoints: [source],
        target: 'bun',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'service.js',
      });
      if (!service.success)
        throw new AggregateError(service.logs, 'answer_journal_service_build_failed');
      const serviceEntrypoint = join(root, 'service.js'),
        bunExecutable = realpathSync(process.execPath),
        outdir = join(root, 'app');
      const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
      await buildNativeDesktop(
        {
          serviceEntrypoint,
          bunExecutable,
          serviceSha256: hash(serviceEntrypoint),
          bunSha256: hash(bunExecutable),
          buildId: 'answer-journal-fixture',
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'history', 'commands', 'interactions'],
          profile,
        },
        outdir,
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../answer-journal-electron.fixture.ts'),
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
        packages: 'external',
        outdir: root,
        naming: 'driver.js',
      });
      if (!built.success)
        throw new AggregateError(built.logs, 'answer_journal_driver_build_failed');
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          outdir,
          root,
          storeId,
          require('electron') as string,
        ],
        { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
      );
      const stdout = new Response(driver.stdout).text(),
        stderr = (async () => {
          const chunks: string[] = [];
          for await (const chunk of driver!.stderr) {
            const text = Buffer.from(chunk).toString('utf8');
            chunks.push(text);
            console.error(text.trim());
          }
          return chunks.join('');
        })();
      const exit = await Promise.race([
        driver.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('answer_journal_electron_timeout')), 45000);
        }),
      ]);
      if (exit !== 0) console.error((await stderr).slice(0, 7000));
      expect(exit).toBe(0);
      const result = await stdout;
      console.info(result.trim());
      expect(result).toContain('Native cold answer assertions:');
      expect(readFileSync(join(root, 'ledger'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      clearTimeout(timer);
      driver?.kill('SIGKILL');
      await driver?.exited;
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
