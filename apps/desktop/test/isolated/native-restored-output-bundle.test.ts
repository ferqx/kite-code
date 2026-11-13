import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import type { ProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { expect, test } from '#kite-test';
import { build as buildFixture } from '../../../../scripts/tooling/build';
import { type FixtureServer, serve as serveFixture } from '../../../../scripts/tooling/http';
import {
  type Subprocess as FixtureProcess,
  which as findFixtureExecutable,
  spawn as spawnFixtureProcess,
} from '../../../../scripts/tooling/process';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { userConfigurationPath } from '../../../service/test/fixtures/user-configuration-fixture';
import { buildNativeCandidate } from '../../scripts/build-native';

test.skipIf(process.platform !== 'darwin')(
  'installed default PC reads the original large sealed Fork after explicit installed backup/restore and cold reopen, without new work',
  async () => {
    const root = realpathSync(temporaryDirectory('kite-native-restored-output-')),
      home = join(root, 'home'),
      workspace = join(home, 'workspace'),
      prefix = join(root, 'installed'),
      content = `${'original 雪🙂\r\n'.repeat(6000)}RESTORED ORIGINAL COMPLETE TAIL`,
      profile = selectProfile({
        dataRoot: join(home, '.kite-code/unified-agent'),
        profile: 'default',
      });
    privateDirectory(workspace);
    expect(Buffer.byteLength(content)).toBeGreaterThan(65536);
    let driver: FixtureProcess<'ignore', 'pipe', 'pipe'> | undefined,
      out: Promise<string> | undefined,
      err: Promise<string> | undefined,
      provider: FixtureServer | undefined,
      requests = 0,
      restores = 0,
      currentStoreId = '';
    try {
      const releaseRoot = resolve(import.meta.dirname, '../../../../scripts/release'),
        installModule = join(releaseRoot, 'native-install.ts'),
        terminalModule = join(releaseRoot, 'terminal-bundle.ts'),
        { installNativeBundle, uninstallNativeBundle } = await import(installModule),
        { buildTerminalBundle } = await import(terminalModule);
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') }),
        req = createRequire(resolve(import.meta.dirname, '../../package.json')),
        built = await buildNativeCandidate({
          testDiagnostics: true,
          terminalRoot: terminal.root,
          electronDist: resolve(dirname(dirname(req('electron') as string)), '../..'),
          outdir: join(root, 'source'),
        });
      renameSync(built.root, join(root, 'relocated'));
      rmSync(terminal.root, { recursive: true, force: true });
      const installation = installNativeBundle({ bundleRoot: join(root, 'relocated'), prefix }),
        candidate = verifyNativeRuntimeBundle(installation.releaseRoot);
      expect(candidate.digest).toBe(built.digest);
      expect(existsSync(built.root)).toBe(false);
      expect(existsSync(terminal.root)).toBe(false);
      initializeSqliteEngine({
        root: join(candidate.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: candidate.terminal.manifest.sqlite.manifestSha256,
      });
      const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      let originalStoreId: string;
      try {
        originalStoreId = (await store.getMetadata()).storeId;
        await store.createWorkspace({
          expectedStoreId: originalStoreId,
          id: 'w',
          name: 'Original output workspace',
          rootUri: pathToFileURL(workspace).href,
        });
        for (const [id, title] of [
          ['s', 'Source original'],
          ['other', 'Other original'],
        ])
          await store.createSession({
            expectedStoreId: originalStoreId,
            subjectId: 'local-user',
            commandId: `create-${id}`,
            sessionId: id!,
            workspaceId: 'w',
            title: title!,
          });
      } finally {
        await store.close();
      }
      const unlocked = () => {
        for (const path of [candidate.root, candidate.terminal.root]) {
          const lease = acquireArtifactAccess({ root: path, mode: 'exclusive' });
          lease.release();
        }
      };
      const maintenance = async (args: string[]) => {
        const child = spawnFixtureProcess([join(prefix, 'bin/kite'), 'maintenance', ...args], {
            cwd: home,
            env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          }),
          output = new Response(child.stdout).text(),
          error = new Response(child.stderr).text(),
          timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        try {
          const exit = await child.exited,
            stderr = await error,
            stdout = await output;
          expect(exit, stderr).toBe(0);
          expect(stderr).toBe('');
          const result = JSON.parse(stdout);
          expect(result.kind).toBe('offline_maintenance');
          expect(result.coverage.profileComplete).toBe(false);
          return result;
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) {
            child.kill('SIGKILL');
            await child.exited;
          }
          await Promise.all([output, error]);
        }
      };
      provider = await serveFixture({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === '/count') return new Response(String(requests));
          if (path === '/content') return new Response(content);
          if (path === '/unlocked') {
            unlocked();
            return Response.json({ unlocked: true });
          }
          if (path === '/restore' && request.method === 'POST') {
            expect(restores++).toBe(0);
            unlocked();
            const common = ['--data-root', profile.dataRoot, '--profile', profile.profile],
              backup: ProfileBackup = (
                await maintenance(['backup', ...common, '--destination', join(root, 'backups')])
              ).backup,
              restored = await maintenance([
                'restore',
                backup.directory,
                ...common,
                '--expected-store',
                originalStoreId,
                '--confirm-data-loss',
              ]);
            expect(restored.status).toBe('restored');
            expect(restored.storeId).not.toBe(originalStoreId);
            currentStoreId = restored.storeId;
            return Response.json({ storeId: currentStoreId, originalStoreId });
          }
          expect(path).toBe('/v1/chat/completions');
          await request.json();
          requests++;
          const frame = (delta: unknown, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: 'original-model', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          return new Response(`${frame({ content }, null)}${frame({}, 'stop')}data: [DONE]\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      });
      writeFileSync(
        userConfigurationPath(home),
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
          tools: [],
        }),
        { mode: 0o600 },
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dirname, '../native-restored-output-electron.fixture.ts'),
          'utf8',
        )
          .replace(
            "'../../../tests/fixtures/loopback-model-environment'",
            JSON.stringify(
              resolve(
                import.meta.dirname,
                '../../../../tests/fixtures/loopback-model-environment.ts',
              ),
            ),
          )
          .replace(
            "'./native-root-page.fixture'",
            JSON.stringify(resolve(import.meta.dirname, '../native-root-page.fixture.ts')),
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
      const result = await buildFixture({
        entrypoints: [fixture],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'driver.js',
      });
      expect(result.success).toBe(true);
      driver = spawnFixtureProcess(
        [
          realpathSync(findFixtureExecutable('node')!),
          join(root, 'driver.js'),
          join(prefix, 'bin/kite-desktop'),
          home,
          provider.url.href.replace(/\/$/, ''),
          originalStoreId,
        ],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      out = new Response(driver.stdout).text();
      err = new Response(driver.stderr).text();
      const timer = setTimeout(() => driver!.kill('SIGTERM'), 45000),
        force = setTimeout(() => driver!.kill('SIGKILL'), 50000);
      try {
        const code = await driver.exited,
          stdout = await out,
          stderr = await err;
        console.log(stdout);
        if (code || stderr) console.error(stderr);
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
        clearTimeout(force);
      }
      expect(requests).toBe(1);
      expect(restores).toBe(1);
      const cold = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        expect((await cold.getMetadata()).storeId).toBe(currentStoreId);
        expect((await cold.getSession('s'))!.title).toBe('Source original');
      } finally {
        await cold.close();
      }
      unlocked();
      uninstallNativeBundle(prefix);
    } finally {
      if (driver?.exitCode === null) {
        driver.kill('SIGTERM');
        await driver.exited;
      }
      await Promise.all([out, err]);
      await provider?.stop(true);
      // Only descendants whose executable belongs to this unique test installation.
      for (const line of String(execFileSync('/bin/ps', ['-axo', 'pid=,command=']))
        .trim()
        .split('\n')) {
        const row = line.trim().match(/^(\d+)\s+(.+)$/);
        if (row?.[2]?.includes(`${root}/installed/`)) {
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
