import { realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { expect, test } from '#kite-test';
import { build as buildFixture } from '../../../../scripts/tooling/build';
import {
  type Subprocess as FixtureProcess,
  which as findFixtureExecutable,
  spawn as spawnFixtureProcess,
} from '../../../../scripts/tooling/process';
import { directoryLink } from '../../../../tests/fixtures/test-filesystem';
import { buildNativeDesktop } from '../../scripts/build-native';
import { cleanupNativeCaller } from '../native-caller-cleanup.fixture';
import { openNativeShellObservation } from '../native-shell-observation.fixture';

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
      const content = '真实 Native 中文🙂é\r\n完整原正文';
      const module = await import(
          resolve(
            import.meta.dirname,
            kind === 'execution.cancel'
              ? '../native-caller-jobs-profile.ts'
              : '../../../cli/test/fixtures/recovery-profile.ts',
          )
        ),
        f = await (kind === 'execution.cancel'
          ? module.nativeCallerJobsProfile()
          : module.recoveryProfile(
              kind === 'input.follow_up' ? { holdModelCommandId: 'native-window-original' } : {},
            ));
      let driver: FixtureProcess<'ignore', 'pipe', 'pipe'> | undefined,
        observation: ReturnType<typeof openNativeShellObservation> | undefined,
        completed = false;
      try {
        observation = openNativeShellObservation();
        let contextSelectionId: string;
        if (kind === 'input.steer') {
          // A read-only warm Service followed by graceful close would cancel the
          // seeded orphan before Native can explicitly recover its original Run.
          const original = f.rows("SELECT context_selection_id AS id FROM session WHERE id='s'");
          if (typeof original[0]?.id !== 'string') throw Error('context_fixture_unavailable');
          contextSelectionId = original[0].id;
        } else {
          const warm = await f.launch();
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
        }
        const common = { expectedStoreId: f.storeId, commandId: 'native-window-original' };
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
            runtimeExecutable: f.artifact.executable,
            runtimeSha256: f.artifact.executableSha256,
            buildId: 'native-caller',
            apiMajor: 1,
            requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
            profile: { dataRoot: f.profile.dataRoot, profile: 'owned' },
          },
          outdir,
          { testDiagnostics: true },
        );
        const built = await buildFixture({
          entrypoints: [resolve(import.meta.dirname, '../native-caller-electron.fixture.ts')],
          target: 'node',
          format: 'esm',
          packages: 'external',
          outdir: f.root,
          naming: 'caller-window-driver.js',
        });
        expect(built.success).toBe(true);
        directoryLink(
          resolve(import.meta.dirname, '../../../../node_modules'),
          join(f.root, 'node_modules'),
        );
        const requestPath = join(f.root, 'caller-request.json');
        writeFileSync(requestPath, JSON.stringify(input), { mode: 0o600 });
        driver = spawnFixtureProcess(
          [
            realpathSync(findFixtureExecutable('node')!),
            join(f.root, 'caller-window-driver.js'),
            outdir,
            f.root,
            require('electron') as string,
            requestPath,
            f.profile.databasePath,
            f.workspace,
            resolve(import.meta.dirname, '../../package.json'),
          ],
          {
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
              ...(f.userConfiguration?.homeEnvironment ?? { HOME: f.root }),
              PATH: '/usr/bin:/bin',
              LANG: 'C.UTF-8',
            },
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
          if (kind === 'input.follow_up') expect(f.heldModelRequests()).toBe(1);
          expect(
            f.rows("SELECT count(*) AS n FROM command WHERE id='native-window-original'"),
          ).toEqual([{ n: 1 }]);
          completed = true;
        } finally {
          clearTimeout(timer);
        }
      } finally {
        let cleanupConfirmed = false;
        try {
          if (driver?.exitCode === null) {
            driver.kill('SIGKILL');
            await driver.exited;
          }
          if (driver && observation)
            await cleanupNativeCaller({
              root: f.root,
              kind,
              electronExecutable: require('electron') as string,
              serviceExecutable: f.artifact.executable,
              serviceEntrypoint: f.artifact.entrypoint,
              observation,
            });
          cleanupConfirmed = true;
        } finally {
          observation?.close();
          const retainRoot = !completed || !cleanupConfirmed;
          f.close({ retainRoot });
          if (retainRoot) console.error('native_caller_failed_root_retained', f.root);
        }
      }
    },
    60000,
  );
