import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

async function ready(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let value = '';
  try {
    while (!value.includes('\n')) {
      const next = await reader.read();
      if (next.done) throw Error('legacy_fixture_early_exit');
      value += new TextDecoder().decode(next.value);
    }
    return JSON.parse(value.split('\n')[0]!) as {
      expectedStoreId: string;
      rawId: string;
      processingId: string;
      runId: string | null;
      generation: string;
    };
  } finally {
    reader.releaseLock();
  }
}
for (const boundary of ['queued', 'planned'] as const)
  test(`SIGKILL legacy ${boundary} input remains readable and cannot dispatch or recover an interpreter`, async () => {
    const root = temporaryDirectory('kite-retired-input-crash-');
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./human-input-processing-crash-fixture.ts', import.meta.url)),
        root,
        boundary,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      const facts = await ready(child.stdout);
      child.kill('SIGKILL');
      expect(await child.exited).toBe(137);
      expect(await new Response(child.stderr).text()).toBe('');
      const profile = { dataRoot: join(root, 'data'), profile: 'test' };
      const observer = await openSqliteStore({ ...profile, mode: 'readonly' });
      const original = await observer.getCommand(facts.rawId);
      const cursor = (await observer.getMetadata()).lastChangeCursor;
      expect(await observer.getCommand(facts.processingId)).toMatchObject({
        request: { content: 'Old ambiguous input' },
      });
      await observer.getView('s');
      expect((await observer.getMetadata()).lastChangeCursor).toBe(cursor);
      await observer.close();
      store = await openSqliteStore(profile);
      let calls = 0,
        recoveries = 0;
      runtime = createRuntime({
        store,
        modelId: 'ordinary',
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'current' };
          },
        },
        model: {
          async *stream() {
            calls++;
            yield { type: 'text_delta', text: 'Actual ordinary answer' };
            yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
          },
        },
        resolveRecoveryRunConfiguration: async () => {
          recoveries++;
          throw Error('retired_configuration_must_not_load');
        },
      });
      await runtime.getView('s');
      expect(calls).toBe(0);
      expect(recoveries).toBe(0);
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      const scope = { expectedStoreId: facts.expectedStoreId, sessionId: 's', subjectId: 'owner' };
      if (facts.runId) {
        const resume = {
          ...scope,
          commandId: 'resume',
          runId: facts.runId,
          expectedOwnerGeneration: facts.generation,
        };
        const foreign = await runtime
          .resumeRun({ ...resume, subjectId: 'foreign', commandId: 'foreign' })
          .catch((error) => error);
        expect(String(foreign)).toContain('permission_denied');
        expect(String(await runtime.resumeRun(resume).catch((error) => error))).toContain(
          'input_processing_removed',
        );
        expect(String(await runtime.resumeRun(resume).catch((error) => error))).toContain(
          'input_processing_removed',
        );
        expect((await store.getExecution('legacy-model'))?.status).toBe('planned');
        expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      } else {
        await runtime.submitCommand({
          ...scope,
          commandId: 'ordinary',
          request: { kind: 'run.start', content: 'New ordinary input' },
        });
        await runtime.waitForCommand('ordinary', { timeoutMs: 5000 });
        expect((await store.getCommand(facts.processingId))?.receipt).toMatchObject({
          reason: 'input_processing_removed',
        });
        expect(calls).toBe(1);
        expect((await store.getView('s')).runs.map((run) => run.originCommandId)).toEqual([
          'ordinary',
        ]);
      }
      expect(recoveries).toBe(0);
      expect(await store.getCommand(facts.rawId)).toEqual(original);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await runtime?.close();
      await store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
