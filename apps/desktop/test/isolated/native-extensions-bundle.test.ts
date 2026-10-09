import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
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
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';

test.skipIf(process.platform !== 'darwin')(
  'installed source-free Native public extension window completes original source, analysis, findings, result action, new identity and cold GET',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-extensions-window-')),
      home = join(root, 'home'),
      workspace = join(home, 'workspace'),
      prefix = join(root, 'installed'),
      profile = selectProfile({
        dataRoot: join(home, '.kite-code/unified-agent'),
        profile: 'default',
      });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
      out: Promise<string> | undefined,
      err: Promise<string> | undefined,
      provider: ReturnType<typeof Bun.serve> | undefined,
      requests = 0,
      completed = false;
    try {
      const releaseRoot = resolve(import.meta.dir, '../../../../scripts/release'),
        { installNativeBundle, uninstallNativeBundle } = await import(
          join(releaseRoot, 'native-install.ts')
        ),
        { buildTerminalBundle } = await import(join(releaseRoot, 'terminal-bundle.ts')),
        terminal = await buildTerminalBundle({
          destination: join(root, 'terminal-build'),
          processHostFixture: 'native-extension-reference',
        }),
        req = createRequire(resolve(import.meta.dir, '../../package.json')),
        built = await buildNativeCandidate({
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
      let storeId: string;
      try {
        storeId = (await store.getMetadata()).storeId;
        await store.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          name: 'Extension workspace',
          rootUri: pathToFileURL(workspace).href,
        });
        await store.createSession({
          expectedStoreId: storeId,
          subjectId: 'local-user',
          commandId: 'create-extension-source',
          sessionId: 's',
          workspaceId: 'w',
          title: 'Extension source',
        });
      } finally {
        await store.close();
      }
      provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === '/count') return new Response(String(requests));
          expect(path).toBe('/v1/chat/completions');
          expect(request.method).toBe('POST');
          requests++;
          const frame = (delta: unknown, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: 'original-extension-model', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          return new Response(
            `${frame({ content: 'Original extension source result' }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
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
          tools: [],
        }),
        { mode: 0o600 },
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-extensions-electron.fixture.ts'),
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
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          join(prefix, 'bin/kite-desktop'),
          home,
          provider.url.href.replace(/\/$/, ''),
          storeId,
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
      const cold = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        const view = await cold.getView('s');
        expect(view.runs.length).toBe(1);
        expect(
          view.executions.filter(
            (execution) =>
              execution.kind === 'job' && execution.definitionId.startsWith('fixture.mini-review/'),
          ).length,
        ).toBe(3);
      } finally {
        await cold.close();
      }
      for (const path of [candidate.root, candidate.terminal.root]) {
        const lease = acquireArtifactAccess({ root: path, mode: 'exclusive' });
        lease.release();
      }
      uninstallNativeBundle(prefix);
      completed = true;
    } finally {
      if (driver?.exitCode === null) {
        driver.kill('SIGTERM');
        await driver.exited;
      }
      await Promise.all([out, err]);
      await provider?.stop(true);
      // Cleanup only processes whose actual command belongs to this unique test installation.
      for (const line of String(execFileSync('/bin/ps', ['-axo', 'pid=,command=']))
        .trim()
        .split('\n')) {
        const row = line.trim().match(/^(\d+)\s+(.+)$/);
        if (row?.[2]?.includes(`${root}/installed/`))
          try {
            process.kill(Number(row[1]), 'SIGKILL');
          } catch {}
      }
      if (completed) rmSync(root, { recursive: true, force: true });
      else console.error(`native_extension_window_evidence:${root}`);
    }
  },
  120000,
);
