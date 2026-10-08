import { expect, test } from 'bun:test';
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
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
const cases = ['approved', 'rejected', 'manual', 'unavailable', 'stopped'] as const;

test.skipIf(process.platform !== 'darwin')(
  'original current-Session controls drive actual Auto decisions, fallback and precise stop, with source-free cold history and no replay',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-auto-approval-'));
    const home = join(root, 'home'),
      moved = join(root, 'relocated'),
      workspace = join(home, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
    const bodies: {
      tools?: { function: { name: string } }[];
      messages: { role: string; content?: unknown }[];
    }[] = [];
    const reviews: {
      purpose: string;
      target: {
        sessionId: string;
        executionId: string;
        runId: string;
        originStoreId: string;
        definitionId: string;
        definitionVersion: string;
        input: { path: string };
      };
      originCommandRequest: { content: string };
    }[] = [];
    const held = new Map<string, () => void>();
    let provider: ReturnType<typeof Bun.serve> | undefined,
      driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
      const releaseModule = resolve(
        import.meta.dir,
        '../../../../scripts/release/terminal-bundle.ts',
      );
      const { buildTerminalBundle } = await import(releaseModule);
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
      const built = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist: resolve(dirname(dirname(require('electron') as string)), '../..'),
        outdir: join(root, 'source'),
      });
      renameSync(join(root, 'source'), moved);
      rmSync(terminal.root, { recursive: true, force: true });
      const bundle = verifyNativeRuntimeBundle(moved);
      expect(bundle.digest).toBe(built.digest);
      leases.push(
        acquireArtifactAccess({ root: moved, mode: 'shared' }),
        acquireArtifactAccess({ root: bundle.terminal.root, mode: 'shared' }),
      );
      initializeSqliteEngine({
        root: join(bundle.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: bundle.terminal.manifest.sqlite.manifestSha256,
      });
      const seed = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      let storeId: string;
      try {
        storeId = (await seed.getMetadata()).storeId;
        await seed.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          name: 'Auto controls',
          rootUri: new URL(`file://${workspace}`).href,
        });
        for (const id of cases)
          await seed.createSession({
            expectedStoreId: storeId,
            subjectId: 'local-user',
            commandId: `create-${id}`,
            sessionId: id,
            workspaceId: 'w',
            title: `Auto ${id}`,
          });
      } finally {
        await seed.close();
      }
      provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/count') return new Response(String(bodies.length));
          if (url.pathname === '/release') {
            const id = url.searchParams.get('case')!;
            const release = held.get(id);
            if (!release) return new Response('original review not held', { status: 409 });
            held.delete(id);
            release();
            return new Response('released');
          }
          const body = (await request.json()) as (typeof bodies)[number];
          bodies.push(body);
          const frame = (delta: unknown, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: `auto-${bodies.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          const review = body.messages.flatMap((message) => {
            if (message.role !== 'user' || typeof message.content !== 'string') return [];
            try {
              const value = JSON.parse(message.content);
              return value?.purpose === 'authorization_review' ? [value] : [];
            } catch {
              return [];
            }
          });
          let delta: unknown,
            finish = 'stop';
          if (review.length) {
            expect(review).toHaveLength(1);
            expect(body.tools ?? []).toEqual([]);
            const original = review[0] as (typeof reviews)[number];
            const id = original.target.sessionId;
            expect(cases.includes(id as (typeof cases)[number])).toBe(true);
            expect(original.target.originStoreId).toBe(storeId!);
            expect(original.target.definitionId).toBe('files.write');
            expect(original.target.definitionVersion).toBe('2');
            expect(original.target.input.path).toBe(`auto-${id}.txt`);
            expect(original.originCommandRequest.content).toBe(
              `NATIVE_AUTO_${id.toUpperCase()} original task`,
            );
            reviews.push(original);
            await new Promise<void>((release) => held.set(id, release));
            delta = {
              content:
                id === 'unavailable'
                  ? 'invalid authorization answer'
                  : JSON.stringify({
                      decision:
                        id === 'rejected'
                          ? 'reject'
                          : id === 'manual'
                            ? 'ask_user'
                            : 'approve_once',
                      reason: `Original ${id} review 雪🙂`,
                    }),
            };
          } else {
            const serialized = JSON.stringify(body.messages);
            const id = cases.find((id) => serialized.includes(`NATIVE_AUTO_${id.toUpperCase()}`));
            expect(id).toBeDefined();
            expect(body.tools?.map((tool) => tool.function.name).sort()).toEqual([
              'ask_user',
              'files.write',
            ]);
            if (!body.messages.some((message) => message.role === 'tool')) {
              finish = 'tool_calls';
              delta = {
                tool_calls: [
                  {
                    index: 0,
                    id: `write-${id}`,
                    type: 'function',
                    function: {
                      name: 'files.write',
                      arguments: JSON.stringify({
                        path: `auto-${id}.txt`,
                        base: null,
                        content: `Actual ${id} effect\r\n雪🙂`,
                      }),
                    },
                  },
                ],
              };
            } else delta = { content: `Original ${id} final` };
          }
          return new Response(frame(delta, null) + frame({}, finish) + 'data: [DONE]\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
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
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-auto-approval-electron.fixture.ts'),
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
          moved,
          home,
          provider.url.href.replace(/\/$/, ''),
          storeId!,
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
        err = new Response(driver.stderr).text();
      const timer = setTimeout(() => driver!.kill('SIGKILL'), 45000);
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
      expect(reviews.map((review) => review.target.sessionId)).toEqual([...cases]);
      expect(bodies).toHaveLength(13);
      const report = JSON.parse(readFileSync(join(home, 'auto-report.json'), 'utf8')) as {
        records: { id: string; executionId: string; runId: string; authorization: unknown }[];
        stopCommandId: string;
        answerPosts: number;
        coldReads: number;
      };
      expect(report.answerPosts).toBe(2);
      expect(report.coldReads).toBe(5);
      const cold = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        expect((await cold.getMetadata()).storeId).toBe(storeId!);
        for (const record of report.records) {
          const execution = await cold.getExecution(record.executionId),
            run = await cold.getRun(record.runId);
          expect(execution?.sessionId).toBe(record.id);
          expect(execution?.runId).toBe(record.runId);
          expect(run?.isActive).toBe(false);
          expect(run?.status).toBe(
            record.id === 'stopped' || record.id === 'rejected' ? 'cancelled' : 'completed',
          );
          expect(execution?.status).toBe(
            record.id === 'stopped'
              ? 'cancelled'
              : record.id === 'rejected'
                ? 'failed'
                : 'succeeded',
          );
          expect(
            reviews.find((review) => review.target.sessionId === record.id)?.target.executionId,
          ).toBe(record.executionId);
        }
        expect((await cold.getCommand(report.stopCommandId))?.kind).toBe('command.cancel');
      } finally {
        await cold.close();
      }
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
    } finally {
      for (const release of held.values()) release();
      if (driver && driver.exitCode === null) {
        driver.kill('SIGTERM');
        await driver.exited;
      }
      provider?.stop(true);
      for (const lease of leases.reverse()) lease.release();
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
