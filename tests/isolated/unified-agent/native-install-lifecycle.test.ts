import { expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { verifyTerminalRuntimeBundle } from '@kite-ai/service/runtime-assets';
import { buildNativeCandidate } from '../../../apps/desktop/scripts/build-native';
import { packNativeBundle, unpackNativeBundle } from '../../../scripts/release/native-archive';
import {
  installNativeBundle,
  rollbackNativeBundle,
  uninstallNativeBundle,
} from '../../../scripts/release/native-install';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import { hash } from '../../fixtures/unified-agent/native-artifact-fixture';

const repositoryRoot = resolve(import.meta.dir, '../../..');
test.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'actual full Native archive/install relocates, samebaseline synthetic version upgrades/rolls back, Main/owned Service prohibit uninstall and data remains',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-install-live-'))),
      home = join(root, 'home'),
      workspace = join(home, 'workspace');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const profile = selectProfile({
        dataRoot: join(home, '.kite-code/unified-agent'),
        profile: 'default',
      }),
      prefix = join(root, 'installed');
    let providerCalls = 0,
      firstRoot = '',
      firstId = '',
      secondRoot = '',
      secondId = '',
      released = false,
      driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let preserved: { core: string; native: string; config: string } | undefined;
    const releaseOperation = <T>(operation: string, run: () => T): T => {
      const started = Date.now();
      try {
        return run();
      } finally {
        console.log(
          JSON.stringify({
            stage: 'native_install_operation',
            operation,
            durationMs: Date.now() - started,
          }),
        );
      }
    };
    const prepStarted = performance.now();
    const prep = async <T>(operation: string, run: () => T | Promise<T>): Promise<T> => {
      const started = performance.now();
      console.log(
        JSON.stringify({
          stage: 'native_install_prep',
          operation,
          phase: 'begin',
          elapsedMs: started - prepStarted,
        }),
      );
      try {
        return await run();
      } finally {
        console.log(
          JSON.stringify({
            stage: 'native_install_prep',
            operation,
            phase: 'end',
            elapsedMs: performance.now() - prepStarted,
            durationMs: performance.now() - started,
          }),
        );
      }
    };
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/count') return Response.json({ providerCalls });
        if (path === '/identity') return Response.json({ firstId, secondId });
        if (path === '/locks' || path === '/current-locks') {
          const target =
            path === '/current-locks'
              ? join(
                  prefix,
                  'releases',
                  readFileSync(join(prefix, 'active'), 'utf8').split('\n')[0]!,
                )
              : firstRoot;
          const value = { outer: false, inner: false };
          for (const [name, path] of [
            ['outer', target],
            ['inner', join(target, 'terminal')],
          ] as const) {
            try {
              const lease = acquireArtifactAccess({ root: path, mode: 'exclusive' });
              lease.release();
            } catch {
              value[name] = true;
            }
          }
          return Response.json(value);
        }
        if (path === '/upgrade')
          return Response.json(
            releaseOperation('upgrade', () =>
              installNativeBundle({ bundleRoot: secondRoot, prefix }),
            ),
          );
        if (path === '/rollback')
          return Response.json(releaseOperation('rollback', () => rollbackNativeBundle(prefix)));
        if (path === '/uninstall') {
          try {
            const bytes = {
              core: hash(readFileSync(profile.databasePath)),
              native: hash(readFileSync(join(profile.profilePath, 'desktop-private/data.sqlite'))),
              config: hash(readFileSync(join(profile.profilePath, 'config.jsonc'))),
            };
            releaseOperation('uninstall', () => uninstallNativeBundle(prefix));
            preserved = bytes;
            released = true;
            return Response.json({ removed: true });
          } catch (error) {
            return Response.json({
              blocked: true,
              error: error instanceof Error ? error.message : 'unknown',
              exists: existsSync(prefix),
            });
          }
        }
        const body = (await request.json()) as { messages: { role: string; content: string }[] };
        expect(body.messages.filter((m) => m.role === 'user').at(-1)!.content).toBe(
          'real installed Native task',
        );
        providerCalls++;
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'native-install', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame({ content: 'Native installed complete' }, null) +
            frame({}, 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    try {
      const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile }),
        storeId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'Native installed',
        rootUri: pathToFileURL(workspace).href,
      });
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'local-user',
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Native installed',
      });
      await store.close();
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'fixed',
          tools: [],
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              baseURL: `${provider.url.href}v1`,
            },
          ],
        }),
        { mode: 0o600 },
      );
      const terminal = await prep('terminal_build', () =>
          buildTerminalBundle({ destination: join(root, 'terminal-build') }),
        ),
        req = createRequire(join(repositoryRoot, 'apps/desktop/package.json')),
        electronExecutable = req('electron') as string,
        electronDist =
          process.platform === 'darwin'
            ? resolve(dirname(dirname(electronExecutable)), '../..')
            : dirname(electronExecutable);
      const built = await prep('first_candidate_build', () =>
        buildNativeCandidate({
          terminalRoot: terminal.root,
          electronDist,
          outdir: join(root, 'source'),
        }),
      );
      // Start actual archive compression before the independent second-candidate preparation.
      const archiveBuild = (async () => {
        const packed = await prep('archive_pack', () =>
          packNativeBundle({
            bundleRoot: built.root,
            archivePath: join(root, 'native.tar.gz'),
          }),
        );
        expect(packed.candidateId).toBe(built.digest);
        const unpacked = await prep('archive_unpack', () =>
          unpackNativeBundle({ ...packed, destination: join(root, 'unpacked') }),
        );
        const relocated = await prep('archive_relocate_verify', () => {
          renameSync(unpacked.root, join(root, 'relocated'));
          return verifyNativeRuntimeBundle(join(root, 'relocated'));
        });
        expect(relocated.digest).toBe(built.digest);
        expect(relocated.terminal.digest).toBe(terminal.digest);
        return { packed, relocated };
      })();
      const secondBuild = (async () => {
        const synthetic = join(root, 'terminal-samebaseline-v2');
        await prep('synthetic_terminal', () => {
          cpSync(built.terminal.root, synthetic, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
          });
          const manifestPath = join(synthetic, 'terminal-manifest.json'),
            inner = JSON.parse(readFileSync(manifestPath, 'utf8'));
          inner.productVersion = '0.1.1';
          writeFileSync(manifestPath, `${JSON.stringify(inner, null, 2)}\n`);
        });
        const v2Terminal = verifyTerminalRuntimeBundle(synthetic);
        const second = await prep('second_candidate_build', () =>
          buildNativeCandidate({
            terminalRoot: synthetic,
            electronDist,
            outdir: join(root, 'second-source'),
          }),
        );
        return { v2Terminal, second };
      })();
      // Both real closures settle, including either failure, before any source cleanup.
      const [secondResult, archiveResult] = await Promise.allSettled([secondBuild, archiveBuild]);
      if (secondResult.status === 'rejected' || archiveResult.status === 'rejected')
        throw new AggregateError(
          [secondResult, archiveResult].flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          ),
          'native_install_prep_failed',
        );
      const { second, v2Terminal } = secondResult.value,
        { packed, relocated } = archiveResult.value;
      expect(v2Terminal.manifest.files).toEqual(relocated.terminal.manifest.files);
      rmSync(built.root, { recursive: true, force: true });
      rmSync(terminal.root, { recursive: true, force: true });
      secondRoot = second.root;
      secondId = second.digest;
      expect(secondId).not.toBe(built.digest);
      const installed = await prep('first_install', () =>
        installNativeBundle({ bundleRoot: relocated.root, prefix }),
      );
      firstRoot = installed.releaseRoot;
      firstId = installed.candidateId;
      expect(firstId).toBe(built.digest);
      expect(verifyNativeRuntimeBundle(firstRoot).digest).toBe(firstId);
      const fixture = join(root, 'electron-driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          join(repositoryRoot, 'tests/fixtures/unified-agent/native-install-electron.ts'),
          'utf8',
        ),
      );
      const result = await Bun.build({
        entrypoints: [fixture],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'electron-driver.mjs',
      });
      expect(result.success).toBe(true);
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'electron-driver.mjs'),
          join(prefix, 'bin/kite-desktop'),
          home,
          provider.url.href.replace(/\/$/, ''),
          storeId,
          join(repositoryRoot, 'apps/desktop/package.json'),
        ],
        {
          cwd: home,
          env: {
            HOME: home,
            PATH: '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            ...(process.platform === 'linux'
              ? { DISPLAY: process.env.DISPLAY ?? '', XAUTHORITY: process.env.XAUTHORITY ?? '' }
              : {}),
          },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const driverStarted = Date.now();
      let timerFired = false;
      const diagnostic = (phase: string, detail: Record<string, unknown> = {}) =>
        console.log(
          JSON.stringify({
            stage: 'native_install_driver_outer',
            phase,
            elapsedMs: Date.now() - driverStarted,
            timerFired,
            ...detail,
          }),
        );
      diagnostic('spawned');
      const out = new Response(driver.stdout).text().then((text) => {
          diagnostic('stdout_eof');
          return text;
        }),
        err = new Response(driver.stderr).text().then((text) => {
          diagnostic('stderr_eof');
          return text;
        }),
        timer = setTimeout(() => {
          timerFired = true;
          diagnostic('timer_sigterm');
          driver!.kill('SIGTERM');
        }, 45000);
      try {
        const code = await driver.exited;
        diagnostic('exited', { code, signalCode: driver.signalCode });
        const stdout = await out,
          stderr = await err;
        if (code) console.error({ stdout, stderr });
        else console.log(stdout);
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      expect(released).toBe(true);
      expect(existsSync(prefix)).toBe(false);
      expect(providerCalls).toBe(1);
      expect(preserved).toBeDefined();
      expect(hash(readFileSync(profile.databasePath))).toBe(preserved!.core);
      expect(hash(readFileSync(join(profile.profilePath, 'desktop-private/data.sqlite')))).toBe(
        preserved!.native,
      );
      expect(hash(readFileSync(join(profile.profilePath, 'config.jsonc')))).toBe(preserved!.config);
      const actual = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        expect((await actual.getMetadata()).storeId).toBe(storeId);
        expect((await actual.getSession('s'))?.workspaceId).toBe('w');
        const executions = await actual.listExecutions('s');
        expect(executions).toHaveLength(1);
        const run = await actual.getRun(executions[0]!.runId!);
        expect(run?.status).toBe('completed');
      } finally {
        await actual.close();
      }
      expect(existsSync(join(profile.profilePath, 'desktop-private/data.sqlite'))).toBe(true);
      expect(verifyNativeRuntimeBundle(relocated.root).digest).toBe(firstId);
      expect(verifyNativeRuntimeBundle(second.root).digest).toBe(secondId);
      expect(hash(readFileSync(join(root, 'native.tar.gz')))).toBe(packed.sha256);
      console.log(
        JSON.stringify({
          qualification: 'native-install-full',
          root,
          firstId,
          secondId,
          terminal: relocated.terminal.digest,
          syntheticSameBaselineVersion: v2Terminal.manifest.productVersion,
          archiveSHA: packed.sha256,
          providerCalls,
          storeId,
          profilePath: profile.profilePath,
          uninstalled: true,
        }),
      );
    } finally {
      if (driver && driver.exitCode === null) {
        driver.kill('SIGKILL');
        await driver.exited;
      }
      provider.stop(true);
    }
  },
  120000,
);
