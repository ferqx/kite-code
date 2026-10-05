import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { historyBinding } from './history-followup-fixture';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('history_followup_deadline');
    await Bun.sleep(5);
  }
}
for (const mode of ['inline', 'sealed'] as const)
  test(`actual SIGKILL ${mode} Model output interrupt preserves original call history for same Session SDK followup`, async () => {
    const directory = mkdtempSync('/private/tmp/kite-history-followup-');
    const bodies: {
      messages: {
        role: string;
        tool_call_id?: string;
        content: string;
        tool_calls?: { id: string; function: { arguments: string } }[];
      }[];
    }[] = [];
    const original = mode === 'sealed' ? '原始大正文'.repeat(16000) : 'original';
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as (typeof bodies)[number];
        bodies.push(body);
        const finished = body.messages.at(-1)?.role === 'tool';
        const delta = finished
          ? { content: 'SAME_SESSION_DONE' }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: bodies.length === 1 ? 'original-call' : 'followup-call',
                  type: 'function',
                  function: {
                    name: 'fixture.effect',
                    arguments: JSON.stringify({
                      value: bodies.length === 1 ? original : 'followup',
                    }),
                  },
                },
              ],
            };
        const chunk = (delta: unknown, reason: string | null) =>
          `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
        return new Response(
          chunk(delta, null) + chunk({}, finished ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const baseURL = `${server.url.href}v1`;
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('./history-followup-crash-child.ts', import.meta.url).pathname,
        directory,
        baseURL,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      await until(() => existsSync(join(directory, 'ready.json')));
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'));
      child.kill('SIGKILL');
      await child.exited;
      const profile = { dataRoot: join(directory, 'data'), profile: 'owned' };
      store = await openSqliteStore(profile);
      const input = {
        ...ready,
        commandId: 'interrupt',
        sessionId: 's',
        subjectId: 'owner',
        decision: 'interrupt' as const,
      };
      delete input.executionId;
      const histories = await store.readRecoveryToolHistory(input);
      expect(histories).toHaveLength(1);
      expect(histories[0]!.modelOutput !== null).toBe(mode === 'sealed');
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({ profile, store }),
        ...historyBinding(directory, baseURL),
      });
      let fullReads = 0;
      const read = runtime.readModelOutput.bind(runtime);
      runtime.readModelOutput = async (...args) => {
        fullReads++;
        return read(...args);
      };
      if (mode === 'sealed') {
        const hash = histories[0]!.modelOutput!.head.hash;
        const path = artifactPath(join(profile.dataRoot, profile.profile), hash);
        const bytes = readFileSync(path);
        const cursor = (await store.getMetadata()).lastChangeCursor;
        try {
          chmodSync(path, 0o600);
          const broken = Buffer.from(bytes);
          broken[0] = broken[0]! ^ 1;
          writeFileSync(path, broken);
          chmodSync(path, 0o400);
          let error: unknown;
          try {
            await runtime.recoverSession(input);
          } catch (caught) {
            error = caught;
          }
          expect(error).toBeDefined();
          expect(await store.getCommand('interrupt')).toBeNull();
          expect((await store.getExecution(ready.executionId))?.status).toBe('planned');
          expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
          expect((await store.listMessages('s')).some((message) => message.role === 'tool')).toBe(
            false,
          );
        } finally {
          chmodSync(path, 0o600);
          writeFileSync(path, bytes);
          chmodSync(path, 0o400);
        }
      }
      // Caller-supplied proof is discarded. Only Runtime's full original reader produces it.
      const report = await runtime.recoverSession({
        ...input,
        toolHistoryProofs: [{ executionId: 'foreign', bindingDigest: 'fake' }],
      });
      expect(report.cancelledExecutionIds).toEqual([ready.executionId]);
      expect(report.unknownExecutionIds).toEqual([]);
      const cursor = (await store.getMetadata()).lastChangeCursor;
      const reads = fullReads;
      expect(await runtime.recoverSession(input)).toEqual(report);
      expect(fullReads).toBe(reads);
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(bodies).toHaveLength(1);
      await runtime.submitCommand({
        expectedStoreId: ready.expectedStoreId,
        commandId: 'next',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'New explicit input' },
      });
      await until(
        async () =>
          (await runtime!.getCommand('next'))?.status === 'applied' &&
          (await runtime!.getView('s')).runs.some(
            (run) => run.originCommandId === 'next' && run.status === 'completed',
          ),
      );
      expect(bodies).toHaveLength(3);
      const oldCall = bodies[1]!.messages.find((message) => message.role === 'assistant')!;
      expect(JSON.parse(oldCall.tool_calls![0]!.function.arguments)).toEqual({ value: original });
      expect(bodies[1]!.messages.find((message) => message.role === 'tool')).toMatchObject({
        tool_call_id: 'original-call',
      });
      expect(bodies[1]!.messages.find((message) => message.role === 'tool')!.content).toContain(
        'recovery_cancelled_unstarted',
      );
      expect(readFileSync(join(directory, 'effects'), 'utf8')).toBe('followup\n');
      expect((await store.getExecution(ready.executionId))?.status).toBe('cancelled');
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      if (runtime) await runtime.close();
      else await store?.close();
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);
