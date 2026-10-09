import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'real embedded Native candidate relocates without checkout/assets fallback, asks independently, protects both roots through Main kill and owned child terminal',
  async () => {
    const began = performance.now();
    const observe = (phase: string, code?: number | null) =>
      console.log(
        JSON.stringify({
          stage: 'native_bundle_parent',
          phase,
          elapsedMs: Math.round(performance.now() - began),
          ...(code === undefined ? {} : { code }),
        }),
      );
    observe('begin');
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-bundle-')),
      home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(
      join(root, 'clipboard-guard.jxa'),
      readFileSync(resolve(import.meta.dir, '../native-clipboard-guard.fixture.jxa')),
    );
    const profile = selectProfile({
        dataRoot: join(home, '.kite-code/unified-agent'),
        profile: 'default',
      }),
      workspace = join(home, 'workspace');
    mkdirSync(workspace);
    let provider: ReturnType<typeof Bun.serve> | undefined,
      driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let requests = 0;
    try {
      const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile }),
        storeId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'Native bundled',
        rootUri: new URL(`file://${workspace}`).href,
      });
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: 'create-s',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Native bundled',
      });
      await store.close();
      const releaseModule = resolve(
        import.meta.dir,
        '../../../../scripts/release/terminal-bundle.ts',
      );
      const { buildTerminalBundle } = await import(releaseModule);
      observe('terminal_build_begin');
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
      observe('terminal_build_end');
      const electronDist = dirname(dirname(require('electron') as string));
      // Actual npm Electron dist, not a fixture-labelled system executable.
      const actualDist = resolve(electronDist, '../..');
      const source = join(root, 'source-candidate');
      console.log('native_bundle_stage: build');
      observe('native_build_begin');
      const built = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist: actualDist,
        outdir: source,
      });
      observe('native_build_end');
      const moved = join(root, 'relocated');
      renameSync(source, moved);
      rmSync(terminal.root, { recursive: true, force: true });
      observe('relocated_verify_begin');
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
      observe('relocated_verify_end');
      expect(readFileSync(join(moved, '.use-terminal.lock')).length).toBe(0);
      provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === '/count') return new Response(String(requests));
          if (path === '/locks') {
            const state: { outer: boolean; inner: boolean } = { outer: false, inner: false };
            for (const [name, path] of [
              ['outer', moved],
              ['inner', join(moved, 'terminal')],
            ] as const) {
              try {
                const lease = acquireArtifactAccess({ root: path, mode: 'exclusive' });
                lease.release();
              } catch {
                state[name] = true;
              }
            }
            return Response.json(state);
          }
          await request.json();
          requests++;
          const call = requests === 1;
          const read = requests === 2;
          const sample = [
            [100, 40],
            [200, 160],
            [100, 0],
          ][requests - 1]!;
          const frame = (delta: unknown, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: `native-${requests}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: sample[0], completion_tokens: 4, total_tokens: sample[0]! + 4, prompt_tokens_details: { cached_tokens: sample[1] } } } : {}) })}\n\n`;
          return new Response(
            frame(
              call
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'bundled-write',
                        type: 'function',
                        function: {
                          name: 'files.write',
                          arguments: JSON.stringify({
                            path: 'bundled.txt',
                            base: null,
                            content: 'actual bundled bytes\r\n',
                          }),
                        },
                      },
                    ],
                  }
                : read
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'bundled-failed-read',
                          type: 'function',
                          function: {
                            name: 'files.read',
                            arguments: JSON.stringify({ path: 'missing-tool-target.txt' }),
                          },
                        },
                      ],
                    }
                  : {
                      content:
                        'bundled complete\n\n[查看文件](bundled.txt) [查看缺失文件](missing.txt)',
                    },
              null,
            ) +
              frame({}, call || read ? 'tool_calls' : 'stop') +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'fixed',
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              baseURL: `${provider.url.href}v1`,
            },
          ],
          tools: [
            { id: 'files.write', definitionVersion: '2' },
            { id: 'files.read', definitionVersion: '3' },
          ],
        }),
      );
      mkdirSync(join(home, 'old-user-data'), { mode: 0o700 });
      writeFileSync(join(home, 'old-user-data/old-database'), 'must remain independent');
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-bundle-electron.fixture.ts'),
          'utf8',
        ).replace(
          "import { _electron } from 'playwright';",
          `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
        ),
      );
      observe('primary_driver_build_begin');
      const result = await Bun.build({
        entrypoints: [fixture],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'driver.js',
      });
      observe('primary_driver_build_end');
      expect(result.success).toBe(true);
      console.log('native_bundle_stage: relocated launch');
      observe('primary_spawn_begin');
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          moved,
          home,
          provider.url.href.replace(/\/$/, ''),
          storeId,
        ],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        },
      );
      observe('primary_spawn_end');
      void driver.exited
        .then((code) => observe('primary_exited', code))
        .catch(() => observe('primary_exit_error'));
      const out = new Response(driver.stdout).text().then((value) => {
          observe('primary_stdout_eof');
          return value;
        }),
        err = new Response(driver.stderr).text().then((value) => {
          observe('primary_stderr_eof');
          return value;
        }),
        timer = setTimeout(() => {
          observe('primary_timer_fired');
          driver!.kill('SIGKILL');
        }, 45000);
      try {
        const code = await driver.exited,
          stdout = await out,
          stderr = await err;
        if (code) console.error({ stdout, stderr });
        else console.log(stdout);
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      expect(requests).toBe(3);
      const quitFixture = join(root, 'quit-driver.ts');
      writeFileSync(
        quitFixture,
        readFileSync(
          resolve(import.meta.dir, '../native-quit-electron.fixture.ts'),
          'utf8',
        ).replace(
          "import { _electron } from 'playwright';",
          `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
        ),
      );
      observe('quit_driver_build_begin');
      const quitBuild = await Bun.build({
        entrypoints: [quitFixture],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'quit-driver.js',
      });
      observe('quit_driver_build_end');
      expect(quitBuild.success).toBe(true);
      observe('quit_spawn_begin');
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'quit-driver.js'),
          moved,
          home,
          provider.url.href.replace(/\/$/, ''),
        ],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        },
      );
      observe('quit_spawn_end');
      void driver.exited
        .then((code) => observe('quit_exited', code))
        .catch(() => observe('quit_exit_error'));
      const quitOut = new Response(driver.stdout).text().then((value) => {
          observe('quit_stdout_eof');
          return value;
        }),
        quitErr = new Response(driver.stderr).text().then((value) => {
          observe('quit_stderr_eof');
          return value;
        }),
        quitTimer = setTimeout(() => {
          observe('quit_timer_fired');
          driver!.kill('SIGKILL');
        }, 45000);
      try {
        const code = await driver.exited,
          stdout = await quitOut,
          stderr = await quitErr;
        if (code) console.error({ stdout, stderr });
        else console.log(stdout);
        expect(code).toBe(0);
      } finally {
        clearTimeout(quitTimer);
      }
      expect(requests).toBe(3);
      expect(readFileSync(join(home, 'old-user-data/old-database'), 'utf8')).toBe(
        'must remain independent',
      );
      const diagnosticHome = join(root, 'diagnostic-home'),
        diagnosticProfile = selectProfile({
          dataRoot: join(diagnosticHome, '.kite-code/unified-agent'),
          profile: 'default',
        });
      mkdirSync(diagnosticProfile.profilePath, { recursive: true, mode: 0o700 });
      writeFileSync(
        diagnosticProfile.databasePath,
        'private-corrupt-database credential session-content',
        { mode: 0o600 },
      );
      writeFileSync(
        join(diagnosticHome, 'existing.json'),
        'existing file must not be overwritten',
        { mode: 0o600 },
      );
      const diagnosticFixture = join(root, 'diagnostic-driver.ts');
      writeFileSync(
        diagnosticFixture,
        readFileSync(
          resolve(import.meta.dir, '../native-startup-diagnostic-electron.fixture.ts'),
          'utf8',
        ).replace(
          "import { _electron } from 'playwright';",
          `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
        ),
      );
      observe('diagnostic_driver_build_begin');
      const diagnosticBuild = await Bun.build({
        entrypoints: [diagnosticFixture],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'diagnostic-driver.js',
      });
      observe('diagnostic_driver_build_end');
      expect(diagnosticBuild.success).toBe(true);
      observe('diagnostic_spawn_begin');
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'diagnostic-driver.js'),
          moved,
          diagnosticHome,
          provider.url.href.replace(/\/$/, ''),
          diagnosticProfile.databasePath,
        ],
        {
          cwd: diagnosticHome,
          env: { HOME: diagnosticHome, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        },
      );
      observe('diagnostic_spawn_end');
      void driver.exited
        .then((code) => observe('diagnostic_exited', code))
        .catch(() => observe('diagnostic_exit_error'));
      // Read the original stdout once. Forward only bounded, fixed diagnostic phases
      // while leaving every original byte for the existing complete-output check.
      const decoder = new TextDecoder();
      const phases = new Set([
        'begin',
        'launch_begin',
        'launch_end',
        'window',
        'save_begin',
        'save_end',
        'retry_begin',
        'retry_clicked',
        'ready',
        'normal_close_begin',
        'normal_close_end',
        'finally_begin',
        'finally_end',
      ]);
      let pending = '',
        discarded = false,
        traceUnavailable = false;
      const forward = (text: string) => {
        const parts = text.split('\n');
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index]!;
          if (pending.length + part.length > 4096) {
            pending = '';
            discarded = true;
          } else if (!discarded) pending += part;
          if (index === parts.length - 1) break;
          if (!discarded && pending.startsWith('{"stage":"native_diagnostic_driver",')) {
            try {
              const value = JSON.parse(pending);
              if (
                Object.keys(value).length === 3 &&
                value.stage === 'native_diagnostic_driver' &&
                phases.has(value.phase) &&
                Number.isSafeInteger(value.elapsedMs) &&
                value.elapsedMs >= 0
              )
                console.log(JSON.stringify(value));
            } catch {}
          }
          pending = '';
          discarded = false;
        }
      };
      const diagnosticOutput = driver.stdout.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            try {
              forward(decoder.decode(chunk, { stream: true }));
            } catch {
              try {
                if (!traceUnavailable) observe('diagnostic_trace_unavailable');
              } catch {}
              traceUnavailable = true;
            }
          },
        }),
      );
      const diagnosticOut = new Response(diagnosticOutput).text().then((value) => {
          observe('diagnostic_stdout_eof');
          return value;
        }),
        diagnosticErr = new Response(driver.stderr).text().then((value) => {
          observe('diagnostic_stderr_eof');
          return value;
        }),
        diagnosticTimer = setTimeout(() => {
          observe('diagnostic_timer_fired');
          driver!.kill('SIGKILL');
        }, 20000);
      try {
        const code = await driver.exited,
          stdout = await diagnosticOut,
          stderr = await diagnosticErr;
        if (code) console.error({ stdout, stderr });
        else console.log(stdout);
        expect(code).toBe(0);
      } finally {
        clearTimeout(diagnosticTimer);
      }
      expect(requests).toBe(3);
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
    } finally {
      observe('finally_begin');
      if (driver && driver.exitCode === null) {
        driver.kill('SIGKILL');
        await driver.exited;
        observe('finally_driver_exited');
      }
      provider?.stop(true);
      observe('finally_provider_stopped');
      // A driver SIGKILL cannot run its finally. Only processes whose actual command
      // names contain this fixture's exact disposable candidate are eligible here.
      const rows = String(execFileSync('/bin/ps', ['-axo', 'pid=,command=']))
        .trim()
        .split('\n');
      for (const line of rows) {
        const row = line.trim().match(/^(\d+)\s+(.+)$/);
        if (row?.[2]?.includes(`${join(root, 'relocated')}/`)) {
          try {
            process.kill(Number(row[1]), 'SIGKILL');
          } catch {}
        }
      }
      observe('finally_remove_begin');
      rmSync(root, { recursive: true, force: true });
      observe('finally_end');
    }
  },
  120000,
);
