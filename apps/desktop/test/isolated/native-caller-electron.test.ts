import { expect, test } from 'bun:test';
import { realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { buildNativeDesktop } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
for (const kind of [
  'run.start',
  'input.steer',
  'input.follow_up',
  'command.cancel',
  'execution.cancel',
] as const)
  test.skipIf(process.platform !== 'darwin')(
    `actual Electron ${kind} original complete caller survives physical POST/first GET loss and main/owned Service SIGKILL`,
    async () => {
      const module = await import(
          resolve(
            import.meta.dir,
            kind === 'execution.cancel'
              ? '../native-caller-jobs-profile.ts'
              : '../../../cli/test/fixtures/recovery-profile.ts',
          )
        ),
        f = await (kind === 'execution.cancel'
          ? module.nativeCallerJobsProfile()
          : module.recoveryProfile());
      let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
      try {
        const warm = await f.launch();
        let contextSelectionId: string;
        try {
          if (kind === 'run.start')
            await warm.client.recoverSession('s', {
              kind: 'session.recover',
              expectedStoreId: f.storeId,
              commandId: 'before-native-start',
              decision: 'interrupt',
            });
          const view = await warm.client.getView('s');
          if (typeof view.session.contextSelectionId !== 'string')
            throw Error('context_fixture_unavailable');
          contextSelectionId = view.session.contextSelectionId;
        } finally {
          await warm.close();
        }
        const common = { expectedStoreId: f.storeId, commandId: 'native-window-original' },
          content = '真实 Native 中文🙂é\r\n完整原正文';
        const input =
          kind === 'execution.cancel'
            ? { ...common, kind, executionId: 'choose-original-first' }
            : kind === 'command.cancel'
              ? { ...common, kind, targetCommandId: 'work' }
              : kind === 'input.steer'
                ? { ...common, kind, content, targetRunId: f.run.id, contextSelectionId }
                : kind === 'input.follow_up'
                  ? {
                      ...common,
                      kind,
                      content,
                      afterRunId: f.run.id,
                      contextSelectionId,
                      extensionInputs: [
                        {
                          extensionId: 'builtin.planning',
                          definitionVersion: '1',
                          input: { mode: 'plan' },
                        },
                      ],
                    }
                  : {
                      ...common,
                      kind,
                      content,
                      extensionInputs: [
                        {
                          extensionId: 'builtin.skill-workflow',
                          definitionVersion: '1',
                          input: {
                            activations: [
                              {
                                skillId: 'skill:unconfigured',
                                input: { full: '中'.repeat(400000), text: content },
                              },
                            ],
                          },
                        },
                      ],
                    };
        const outdir = join(f.root, 'native');
        await buildNativeDesktop(
          {
            serviceEntrypoint: f.artifact.entrypoint,
            serviceSha256: f.artifact.entrypointSha256,
            bunExecutable: f.artifact.executable,
            bunSha256: f.artifact.executableSha256,
            buildId: 'native-caller',
            apiMajor: 1,
            requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
            profile: { dataRoot: f.profile.dataRoot, profile: 'owned' },
          },
          outdir,
        );
        const built = await Bun.build({
          entrypoints: [resolve(import.meta.dir, '../native-caller-electron.fixture.ts')],
          target: 'node',
          format: 'esm',
          packages: 'external',
          outdir: f.root,
          naming: 'caller-window-driver.js',
        });
        expect(built.success).toBe(true);
        symlinkSync(
          resolve(import.meta.dir, '../../../../node_modules'),
          join(f.root, 'node_modules'),
          'dir',
        );
        const requestPath = join(f.root, 'caller-request.json');
        writeFileSync(requestPath, JSON.stringify(input), { mode: 0o600 });
        driver = Bun.spawn(
          [
            realpathSync(Bun.which('node')!),
            join(f.root, 'caller-window-driver.js'),
            outdir,
            f.root,
            require('electron') as string,
            requestPath,
            f.profile.databasePath,
            f.workspace,
            resolve(import.meta.dir, '../../package.json'),
          ],
          {
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
            env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          },
        );
        const out = new Response(driver.stdout).text(),
          err = new Response(driver.stderr).text(),
          timer = setTimeout(() => driver?.kill('SIGKILL'), 45000);
        try {
          const code = await driver.exited,
            error = await err;
          if (code) console.error(error);
          expect(code).toBe(0);
          expect(await out).toContain('native-caller-window-qualified');
          expect(
            f.rows("SELECT count(*) AS n FROM command WHERE id='native-window-original'"),
          ).toEqual([{ n: 1 }]);
        } finally {
          clearTimeout(timer);
        }
      } finally {
        if (driver?.exitCode === null) {
          driver.kill('SIGKILL');
          await driver.exited;
        }
        f.close();
      }
    },
    60000,
  );
