import { expect, test } from 'bun:test';
import { realpathSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { buildNativeDesktop } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
for (const kind of ['run', 'interrupt', 'report'])
  test.skipIf(process.platform !== 'darwin')(
    `actual Electron cold ${kind} recovery preserves one original mutation across lost reply and restart`,
    async () => {
      const module = await import(
        resolve(
          import.meta.dir,
          kind === 'report'
            ? '../../../cli/test/fixtures/recovery-report-profile.ts'
            : '../../../cli/test/fixtures/recovery-profile.ts',
        )
      );
      const f = await (kind === 'report'
        ? module.recoveryReportProfile()
        : module.recoveryProfile());
      let driver: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const outdir = join(f.root, 'native');
        await buildNativeDesktop(
          {
            serviceEntrypoint: f.artifact.entrypoint,
            serviceSha256: f.artifact.entrypointSha256,
            bunExecutable: f.artifact.executable,
            bunSha256: f.artifact.executableSha256,
            buildId: 'native-recovery',
            apiMajor: 1,
            requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
            profile: { dataRoot: f.profile.dataRoot, profile: f.profile.profile },
          },
          outdir,
        );
        const built = await Bun.build({
          entrypoints: [resolve(import.meta.dir, '../native-recovery-electron.fixture.ts')],
          target: 'node',
          format: 'esm',
          packages: 'external',
          outdir: f.root,
          naming: 'driver.js',
        });
        if (!built.success) throw new AggregateError(built.logs, 'native_driver_build');
        symlinkSync(
          resolve(import.meta.dir, '../../../../node_modules'),
          join(f.root, 'node_modules'),
          'dir',
        );
        const processDriver = Bun.spawn(
          [
            realpathSync(Bun.which('node')!),
            join(f.root, 'driver.js'),
            outdir,
            f.root,
            require('electron') as string,
            kind === 'report' ? f.reportId : f.run.id,
            kind === 'report' ? 'none' : f.card.id,
            kind === 'report' ? '0' : f.card.revision,
            kind,
            f.ledger,
            f.workspace,
            resolve(import.meta.dir, '../../package.json'),
          ],
          { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
        );
        driver = processDriver;
        const error = new Response(processDriver.stderr).text(),
          output = new Response(processDriver.stdout).text();
        const timer = setTimeout(() => driver?.kill('SIGKILL'), 45000);
        try {
          const code = await driver.exited,
            stderr = await error,
            stdout = await output;
          if (code !== 0)
            console.error(
              stderr,
              stdout,
              JSON.stringify(f.rows('SELECT * FROM command')),
              JSON.stringify(f.rows('SELECT * FROM interaction')),
              JSON.stringify(f.rows('SELECT * FROM execution')),
              JSON.stringify(f.rows('SELECT * FROM run')),
            );
          expect(code).toBe(0);
          expect(stdout).toContain('native-recovery-real-qualified');
          if (kind === 'report') {
            const original = f.rows(
              'SELECT id,origin_command_id,status FROM run WHERE origin_command_id=' +
                "'" +
                f.reportId +
                "'",
            );
            expect(original).toHaveLength(1);
            expect(original[0]).toMatchObject({
              origin_command_id: f.reportId,
              status: 'completed',
            });
          }
          if (kind !== 'report') expect(f.calls()).toBe(kind === 'run' ? 2 : 1);
          else expect(f.calls()).toEqual({ parentCalls: 3, childCalls: 1, reviewCalls: 2 });
        } finally {
          clearTimeout(timer);
        }
      } finally {
        driver?.kill('SIGKILL');
        if (driver) await driver.exited;
        f.close();
      }
    },
    60000,
  );
