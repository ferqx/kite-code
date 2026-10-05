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
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-bundle-')),
      home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
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
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
      const electronDist = dirname(dirname(require('electron') as string));
      // Actual npm Electron dist, not a fixture-labelled system executable.
      const actualDist = resolve(electronDist, '../..');
      const source = join(root, 'source-candidate');
      console.log('native_bundle_stage: build');
      const built = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist: actualDist,
        outdir: source,
      });
      const moved = join(root, 'relocated');
      renameSync(source, moved);
      rmSync(terminal.root, { recursive: true, force: true });
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
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
          const frame = (delta: unknown, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: `native-${requests}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
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
                : { content: 'bundled complete' },
              null,
            ) +
              frame({}, call ? 'tool_calls' : 'stop') +
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
          tools: [{ id: 'files.write', definitionVersion: '2' }],
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
      const result = await Bun.build({
        entrypoints: [fixture],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'driver.js',
      });
      expect(result.success).toBe(true);
      console.log('native_bundle_stage: relocated launch');
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
      const out = new Response(driver.stdout).text(),
        err = new Response(driver.stderr).text(),
        timer = setTimeout(() => driver!.kill('SIGKILL'), 45000);
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
      expect(requests).toBe(2);
      expect(readFileSync(join(home, 'old-user-data/old-database'), 'utf8')).toBe(
        'must remain independent',
      );
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
    } finally {
      if (driver && driver.exitCode === null) {
        driver.kill('SIGKILL');
        await driver.exited;
      }
      provider?.stop(true);
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
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
