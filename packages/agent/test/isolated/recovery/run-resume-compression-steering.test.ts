import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { compressionSteeringBinding, guidance } from './run-resume-compression-steering-fixture';

for (const cut of ['summary-complete', 'published'] as const)
  for (const proof of ['valid', 'unknown-read'] as const)
    test(`SIGKILL ${cut} preserves original steer and completed read without replay (${proof})`, async () => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-compression-steer-crash-')));
      const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
      writeFileSync(join(directory, 'ledger'), '');
      writeFileSync(
        join(directory, 'material'),
        `Finite original fact ${crypto.randomUUID()} 雪🙂`,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(
            new URL('./run-resume-compression-steering-crash-child.ts', import.meta.url),
          ),
          directory,
          cut,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
      let runtime: ReturnType<typeof createRuntime> | undefined;
      try {
        const deadline = Date.now() + 10000;
        while (!existsSync(join(directory, 'ready.json'))) {
          if (Date.now() > deadline || child.exitCode !== null) {
            child.kill('SIGKILL');
            await child.exited;
            throw Error(`compression_crash_not_ready:${await new Response(child.stderr).text()}`);
          }
          await Bun.sleep(5);
        }
        child.kill('SIGKILL');
        await child.exited;
        const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
          expectedStoreId: string;
          runId: string;
          expectedOwnerGeneration: string;
          executionId: string;
          readExecutionId: string;
        };
        const beforeLedger = readFileSync(join(directory, 'ledger'), 'utf8');
        const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
        try {
          const cursor = (await cold.getMetadata()).lastChangeCursor;
          const selected = await cold.getModelContext({
            expectedStoreId: ready.expectedStoreId,
            sessionId: 's',
          });
          expect(
            selected.messages.filter((message) => message.sourceIds?.includes('original-guide')),
          ).toHaveLength(1);
          expect(
            selected.messages.find((message) => message.sourceIds?.includes('original-guide'))!
              .content,
          ).toBe(guidance);
          expect(Boolean(selected.compression)).toBe(cut === 'published');
          expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
          expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe(beforeLedger);
        } finally {
          await cold.close();
        }
        if (proof === 'unknown-read') {
          const physical = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
          try {
            physical
              .query("UPDATE execution SET state='outcome_unknown' WHERE id=?")
              .run(ready.readExecutionId);
          } finally {
            physical.close();
          }
        }
        store = await openSqliteStore(profile);
        const originalRead = await store.getExecution(ready.readExecutionId);
        const originalSummary = await store.getExecution(ready.executionId);
        expect(originalSummary?.status).toBe('succeeded');
        expect((await store.getCommand('original-guide'))?.receipt).toMatchObject({
          runId: ready.runId,
          outcome: 'input_applied',
        });
        const requests: ModelRequest[] = [];
        const config = compressionSteeringBinding(directory, (request) => requests.push(request));
        runtime = createRuntime({
          store,
          artifacts: createArtifactStore({ profile, store }),
          permissions: config.permissions!,
          resolveRecoveryRunConfiguration: async () => config,
        });
        const input = { ...ready, sessionId: 's', subjectId: 'owner', commandId: 'resume' };
        if (proof === 'unknown-read') {
          const error = await runtime.resumeRun(input).then(
            () => null,
            (error) => error,
          );
          expect(error).toMatchObject({ code: 'run_resume_checkpoint_unavailable' });
          expect(requests).toHaveLength(0);
          expect(await store.getCommand('resume')).toBeNull();
          expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe(beforeLedger);
          return;
        }
        await runtime.resumeRun(input);
        await runtime.waitForCommand('work', { timeoutMs: 8000 });
        const business = requests.filter((request) => request.tools.length > 0);
        expect(business).toHaveLength(1);
        const actual = business[0]!;
        expect(
          actual.messages.filter((message) => message.sourceIds?.includes('original-guide')),
        ).toEqual([{ role: 'user', content: guidance, sourceIds: ['original-guide'] }]);
        expect(
          actual.messages.filter((message) => message.sourceIds?.includes('work')),
        ).toHaveLength(1);
        expect(
          actual.messages.filter((message) =>
            message.content.startsWith('Context summary (untrusted data;'),
          ),
        ).toHaveLength(1);
        expect(
          readFileSync(join(directory, 'ledger'), 'utf8')
            .split('\n')
            .filter((line) => line === 'read'),
        ).toHaveLength(1);
        expect((await store.getRun(ready.runId))?.status).toBe('completed');
        expect((await store.getView('s')).runs).toHaveLength(1);
        expect(await store.getExecution(ready.readExecutionId)).toEqual(originalRead);
        expect(await store.getExecution(ready.executionId)).toEqual(originalSummary);
        expect((await store.getExecution(actual.requestId))?.runId).toBe(ready.runId);
        const selected = await store.getModelContext({
          expectedStoreId: ready.expectedStoreId,
          sessionId: 's',
        });
        expect(selected.compression?.modelExecutionId === ready.executionId).toBe(
          cut === 'published',
        );
        expect(requests.filter((request) => request.tools.length === 0)).toHaveLength(
          cut === 'published' ? 0 : 1,
        );
        expect(
          (
            await runtime.readModelInput({
              expectedStoreId: ready.expectedStoreId,
              sessionId: 's',
              subjectId: 'owner',
              executionId: actual.requestId,
            })
          ).request.messages,
        ).toEqual(actual.messages);
        const requestCount = requests.length;
        await runtime.resumeRun(input);
        expect(requests).toHaveLength(requestCount);
        const finalCursor = (await store.getMetadata()).lastChangeCursor;
        expect(
          (await store.listMessages('s')).filter((message) =>
            message.sourceIds?.includes('original-guide'),
          ),
        ).toHaveLength(1);
        expect((await store.getMetadata()).lastChangeCursor).toBe(finalCursor);
      } finally {
        child.kill('SIGKILL');
        await child.exited;
        if (runtime) await runtime.close();
        if (store) await store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }, 20000);
