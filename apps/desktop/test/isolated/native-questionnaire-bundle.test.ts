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
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'relocated actual Native candidate completes the default questionnaire and cancels another questionnaire while each original Run continues',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-questionnaire-bundle-'));
    const home = join(root, 'home'),
      moved = join(root, 'relocated');
    mkdirSync(home, { mode: 0o700 });
    const workspace = join(home, 'workspace');
    mkdirSync(workspace);
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    const bodies: {
      tools?: { function: { name: string } }[];
      messages: { role: string; content?: unknown }[];
    }[] = [];
    const questionsReady = new Map<number, () => void>();
    let provider: ReturnType<typeof Bun.serve> | undefined;
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    const fixtureLeases: ReturnType<typeof acquireArtifactAccess>[] = [];
    try {
      const releaseModule = resolve(
        import.meta.dir,
        '../../../../scripts/release/terminal-bundle.ts',
      );
      const { buildTerminalBundle } = await import(releaseModule);
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
      const electronDist = resolve(dirname(dirname(require('electron') as string)), '../..');
      const source = join(root, 'source-candidate');
      const built = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist,
        outdir: source,
      });
      renameSync(source, moved);
      rmSync(terminal.root, { recursive: true, force: true });
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
      // SQLite selection is process-wide: use the candidate's pinned engine before
      // the fixture's first database/Worker, and retain that original asset for cold reads.
      const original = verifyNativeRuntimeBundle(moved);
      fixtureLeases.push(acquireArtifactAccess({ root: moved, mode: 'shared' }));
      fixtureLeases.push(acquireArtifactAccess({ root: original.terminal.root, mode: 'shared' }));
      initializeSqliteEngine({
        root: join(original.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: original.terminal.manifest.sqlite.manifestSha256,
      });
      const seed = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      let storeId: string;
      try {
        storeId = (await seed.getMetadata()).storeId;
        await seed.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          name: 'Questionnaire',
          rootUri: new URL(`file://${workspace}`).href,
        });
        for (const id of ['a', 'b'])
          await seed.createSession({
            expectedStoreId: storeId,
            subjectId: 'local-user',
            commandId: `create-${id}`,
            sessionId: id,
            workspaceId: 'w',
            title: `Question ${id.toUpperCase()}`,
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
          if (url.pathname === '/continue') {
            const id = Number(url.searchParams.get('request'));
            const release = questionsReady.get(id);
            if (!release) return new Response('original model request not held', { status: 409 });
            questionsReady.delete(id);
            release();
            return new Response('released original model request');
          }
          const body = (await request.json()) as (typeof bodies)[number];
          bodies.push(body);
          const call = bodies.length % 2 === 1;
          if (call)
            await new Promise<void>((release) => questionsReady.set(bodies.length, release));
          const frame = (delta: unknown, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: `questions-${bodies.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          return new Response(
            frame(
              call
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: `ask-${bodies.length}`,
                        type: 'function',
                        function: {
                          name: 'ask_user',
                          arguments: JSON.stringify({
                            questions: [
                              {
                                question: 'First original question?',
                                options: [
                                  {
                                    label: 'Alpha',
                                    description: 'Full original description\nUnicode 尾部',
                                    recommended: true,
                                  },
                                  { label: 'Other', description: 'Other first option' },
                                ],
                              },
                              {
                                question: 'Second original question?',
                                options: [
                                  {
                                    label: 'q1-o1',
                                    description:
                                      'This label is literal text, not another question ID',
                                    recommended: true,
                                  },
                                  { label: 'Other', description: 'Other second option' },
                                ],
                              },
                              {
                                question: 'Third original question?',
                                options: [
                                  { label: 'One', description: 'First third option' },
                                  { label: 'Two', description: 'Second third option' },
                                ],
                              },
                            ],
                          }),
                        },
                      },
                    ],
                  }
                : { content: 'Original task continued after questionnaire' },
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
          tools: [],
        }),
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-questionnaire-electron.fixture.ts'),
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
        err = new Response(driver.stderr).text();
      const timer = setTimeout(() => driver!.kill('SIGKILL'), 45000);
      try {
        const code = await driver.exited,
          stdout = await out,
          stderr = await err;
        if (code)
          console.error({
            stdout,
            stderr,
            providerRequests: bodies.length,
            providerRoles: bodies.map((body) => body.messages.map((message) => message.role)),
          });
        else console.log(stdout);
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      expect(bodies).toHaveLength(4);
      for (const body of bodies)
        expect(body.tools?.some((tool) => tool.function.name === 'ask_user')).toBe(true);
      const text = '  q3-o1🙂é\n保持 空格  ';
      const semantic = [...bodies[1]!.messages]
        .reverse()
        .find((message) => message.role === 'tool')!;
      expect(JSON.parse(semantic.content as string)).toEqual({
        answer: `First original question?: Alpha\nSecond original question?: q1-o1\nThird original question?: ${text}`,
        answers: { q1: 'Alpha', q2: 'q1-o1', q3: text },
      });
      expect(
        JSON.parse(
          [...bodies[3]!.messages].reverse().find((message) => message.role === 'tool')!
            .content as string,
        ),
      ).toEqual({ cancelled: true });
      const report = JSON.parse(readFileSync(join(home, 'questionnaire-report.json'), 'utf8')) as {
        cards: { id: string; runId: string; executionId: string; commandId: string }[];
        posts: number;
        childPid: number;
      };
      expect(report.posts).toBe(2);
      expect(() => process.kill(report.childPid, 0)).toThrow();
      // Cold reads happen only after the actual owned Service child is dead.
      const verified = verifyNativeRuntimeBundle(moved);
      const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
      let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
      try {
        leases.push(acquireArtifactAccess({ root: moved, mode: 'shared' }));
        leases.push(acquireArtifactAccess({ root: verified.terminal.root, mode: 'shared' }));
        const engine = initializeSqliteEngine({
          root: join(verified.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
          manifestSha256: verified.terminal.manifest.sqlite.manifestSha256,
        });
        expect(engine.version).toBe(verified.terminal.manifest.sqlite.version);
        expect(engine.sourceId).toBe(verified.terminal.manifest.sqlite.sourceId);
        cold = await openSqliteStore({
          dataRoot: profile.dataRoot,
          profile: profile.profile,
          mode: 'readonly',
        });
        const cursor = (await cold.getMetadata()).lastChangeCursor;
        expect((await cold.getMetadata()).storeId).toBe(storeId);
        const interactions = (
          await cold.listInteractions({ expectedStoreId: storeId, sessionId: 'a' })
        ).interactions;
        expect(interactions).toHaveLength(2);
        for (const [index, original] of report.cards.entries()) {
          const card = interactions.find((value) => value.id === original.id)!;
          expect(card).toMatchObject({
            runId: original.runId,
            executionId: original.executionId,
            state: 'answered',
            acceptedDecisionRevision: '2',
          });
          expect(card.answer).toEqual({
            kind: 'question',
            answers: index === 0 ? { q1: 'q1-o1', q2: 'q2-o1', q3: { text } } : null,
          });
          expect((await cold.getCommand(original.commandId))?.receipt).toMatchObject({
            outcome: 'answer_saved',
            interactionId: original.id,
            cancelled: false,
          });
          expect((await cold.getRun(original.runId))?.status).toBe('completed');
          expect((await cold.getExecution(original.executionId))?.result).toMatchObject({
            outcome: 'succeeded',
            details: index === 0 ? JSON.parse(semantic.content as string) : { cancelled: true },
          });
          expect(
            (await cold.listExecutions('a')).filter(
              (value) => value.kind === 'model' && value.runId === original.runId,
            ),
          ).toHaveLength(2);
        }
        expect(
          (await cold.listInteractions({ expectedStoreId: storeId, sessionId: 'b' })).interactions,
        ).toHaveLength(0);
        expect(bodies).toHaveLength(4);
        expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      } finally {
        await cold?.close();
        for (const lease of leases.reverse()) lease.release();
      }
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
    } finally {
      if (driver && driver.exitCode === null) {
        driver.kill('SIGKILL');
        await driver.exited;
      }
      for (const release of questionsReady.values()) release();
      provider?.stop(true);
      // Only actual command paths inside this exact disposable candidate are eligible.
      for (const line of String(execFileSync('/bin/ps', ['-axo', 'pid=,command=']))
        .trim()
        .split('\n')) {
        const row = line.trim().match(/^(\d+)\s+(.+)$/);
        if (row?.[2]?.includes(`${moved}/`))
          try {
            process.kill(Number(row[1]), 'SIGKILL');
          } catch {}
      }
      for (const lease of fixtureLeases.reverse()) lease.release();
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
