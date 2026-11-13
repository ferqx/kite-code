import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { expect, test } from '#kite-test';
import { build as buildFixture } from '../../../../scripts/tooling/build';
import {
  type Subprocess as FixtureProcess,
  which as findFixtureExecutable,
  spawn as spawnFixtureProcess,
} from '../../../../scripts/tooling/process';
import { directoryLink } from '../../../../tests/fixtures/test-filesystem';
import { buildNativeDesktop } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'actual Electron replaces 20-card pending pages, closes stale reads, answers original later card once and reconciles lost POST',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-interaction-pages-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
    let driver: FixtureProcess<'ignore', 'pipe', 'pipe'> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const store = await openSqliteStore(profile);
      const storeId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(root).href,
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
      directoryLink(
        resolve(import.meta.dirname, '../../../../node_modules'),
        join(root, 'node_modules'),
      );
      const source = join(root, 'service.ts');
      writeFileSync(
        source,
        readFileSync(
          resolve(import.meta.dirname, '../interaction-pages-child.fixture.ts'),
          'utf8',
        ).replace("'LEDGER_PATH'", JSON.stringify(join(root, 'ledger'))),
      );
      const service = await buildFixture({
        entrypoints: [source],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'service.js',
      });
      if (!service.success)
        throw new AggregateError(service.logs, 'interaction_pages_service_build_failed');
      const serviceEntrypoint = join(root, 'service.js'),
        bunExecutable = realpathSync(process.execPath),
        outdir = join(root, 'app');
      const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
      await buildNativeDesktop(
        {
          serviceEntrypoint,
          runtimeExecutable: bunExecutable,
          serviceSha256: hash(serviceEntrypoint),
          runtimeSha256: hash(bunExecutable),
          buildId: 'interaction-pages-fixture',
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'history', 'commands', 'interactions'],
          profile,
        },
        outdir,
        { testDiagnostics: true },
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dirname, '../interaction-pages-electron.fixture.ts'),
          'utf8',
        )
          .replace(
            "'./native-model-selection.fixture'",
            JSON.stringify(resolve(import.meta.dirname, '../native-model-selection.fixture.ts')),
          )
          .replace(
            "import { _electron } from 'playwright';",
            `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dirname, '../../package.json'))})('playwright');`,
          ),
      );
      const built = await buildFixture({
        entrypoints: [fixture],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'driver.js',
      });
      if (!built.success)
        throw new AggregateError(built.logs, 'interaction_pages_driver_build_failed');
      driver = spawnFixtureProcess(
        [
          realpathSync(findFixtureExecutable('node')!),
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
          timer = setTimeout(() => reject(Error('interaction_pages_electron_timeout')), 45000);
        }),
      ]);
      if (exit !== 0) console.error((await stderr).slice(0, 7000));
      expect(exit).toBe(0);
      const result = await stdout;
      console.info(result.trim());
      expect(result).toContain('Native interaction pages assertions:');
      expect(readFileSync(join(root, 'ledger'), 'utf8').trim().split('\n')).toHaveLength(40);
      expect(result).toContain('Native interaction pages ordinary exit:');
    } finally {
      clearTimeout(timer);
      driver?.kill('SIGKILL');
      await driver?.exited;
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
