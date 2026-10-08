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
import type { ProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';

test.skipIf(process.platform !== 'darwin')(
  'installed default PC preserves the original answered questionnaire in source and sealed Fork after installed backup/restore and cold reopen',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-restored-questionnaire-')),
      home = join(root, 'home'),
      workspace = join(home, 'workspace'),
      prefix = join(root, 'installed'),
      content = '问答后的原任务已完成',
      answers = { q1: '原 PC 界面', q2: '  原 PC 界面🙂é\n保留 空格  ' },
      questions = [
        {
          question: '第一题：保留哪个实现？',
          options: [
            { label: answers.q1, description: '迁入原客户端实现', recommended: true },
            { label: '其他实现', description: '另一种选择' },
          ],
        },
        {
          question: '第二题：迁移说明？',
          options: [
            { label: '选项一', description: '第一项' },
            { label: '选项二', description: '第二项' },
          ],
        },
      ],
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
      restores = 0,
      currentStoreId = '';
    try {
      const releaseRoot = resolve(import.meta.dir, '../../../../scripts/release'),
        installModule = join(releaseRoot, 'native-install.ts'),
        terminalModule = join(releaseRoot, 'terminal-bundle.ts'),
        { installNativeBundle, uninstallNativeBundle } = await import(installModule),
        { buildTerminalBundle } = await import(terminalModule);
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') }),
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
      let originalStoreId: string;
      try {
        originalStoreId = (await store.getMetadata()).storeId;
        await store.createWorkspace({
          expectedStoreId: originalStoreId,
          id: 'w',
          name: 'Original questionnaire workspace',
          rootUri: pathToFileURL(workspace).href,
        });
        for (const [id, title] of [
          ['s', 'Source questions'],
          ['other', 'Other questions'],
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
        const child = Bun.spawn([join(prefix, 'bin/kite'), 'maintenance', ...args], {
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
          expect(await child.exited).toBe(0);
          expect(await error).toBe('');
          const result = JSON.parse(await output);
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
      provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === '/count') return new Response(String(requests));
          if (path === '/facts') return Response.json({ content, questions, answers });
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
          const body = (await request.json()) as {
            tools?: { function: { name: string } }[];
            messages: { role: string; content?: string }[];
          };
          requests++;
          if (requests === 1)
            expect(body.tools?.some((tool) => tool.function.name === 'ask_user')).toBe(true);
          if (requests === 2)
            expect(
              JSON.parse(body.messages.find((message) => message.role === 'tool')!.content!)
                .answers,
            ).toEqual(answers);
          const call = requests === 1;
          const frame = (delta: unknown, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: 'original-model', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          return new Response(
            `${frame(call ? { tool_calls: [{ index: 0, id: 'original-ask-call', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ questions }) } }] } : { content }, null)}${frame({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
            {
              headers: { 'content-type': 'text/event-stream' },
            },
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
          resolve(import.meta.dir, '../native-restored-questionnaire-electron.fixture.ts'),
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
      expect(requests).toBe(2);
      expect(restores).toBe(1);
      const cold = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        expect((await cold.getMetadata()).storeId).toBe(currentStoreId);
        expect((await cold.getSession('s'))!.title).toBe('Source questions');
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
