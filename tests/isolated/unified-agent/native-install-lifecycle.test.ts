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
test.skipIf(process.platform !== 'darwin')(
  'actual full Native archive/install relocates, samebaseline synthetic version upgrades/rolls back, Main/owned Service prohibit uninstall and data remains',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-install-live-')),
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
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') }),
        req = createRequire(join(repositoryRoot, 'apps/desktop/package.json')),
        electronDist = resolve(dirname(dirname(req('electron') as string)), '../..');
      const built = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist,
        outdir: join(root, 'source'),
      });
      const packed = await packNativeBundle({
        bundleRoot: built.root,
        archivePath: join(root, 'native.tar.gz'),
      });
      expect(packed.candidateId).toBe(built.digest);
      const unpacked = unpackNativeBundle({ ...packed, destination: join(root, 'unpacked') });
      renameSync(unpacked.root, join(root, 'relocated'));
      const relocated = verifyNativeRuntimeBundle(join(root, 'relocated'));
      expect(relocated.digest).toBe(built.digest);
      expect(relocated.terminal.digest).toBe(terminal.digest);
      rmSync(built.root, { recursive: true, force: true });
      rmSync(terminal.root, { recursive: true, force: true });
      const synthetic = join(root, 'terminal-samebaseline-v2');
      cpSync(relocated.terminal.root, synthetic, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      const manifestPath = join(synthetic, 'terminal-manifest.json'),
        inner = JSON.parse(readFileSync(manifestPath, 'utf8'));
      inner.productVersion = '0.1.1';
      writeFileSync(manifestPath, JSON.stringify(inner, null, 2) + '\n');
      const v2Terminal = verifyTerminalRuntimeBundle(synthetic);
      expect(v2Terminal.manifest.files).toEqual(relocated.terminal.manifest.files);
      const second = await buildNativeCandidate({
        terminalRoot: synthetic,
        electronDist,
        outdir: join(root, 'second-source'),
      });
      secondRoot = second.root;
      secondId = second.digest;
      expect(secondId).not.toBe(built.digest);
      const installed = installNativeBundle({ bundleRoot: relocated.root, prefix });
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
        naming: 'electron-driver.js',
      });
      expect(result.success).toBe(true);
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'electron-driver.js'),
          join(prefix, 'bin/kite-desktop'),
          home,
          provider.url.href.replace(/\/$/, ''),
          storeId,
          join(repositoryRoot, 'apps/desktop/package.json'),
        ],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
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
