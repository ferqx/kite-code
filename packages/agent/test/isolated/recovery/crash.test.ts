import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createArtifactStore } from '../../../src/artifacts';
import { canonicalJson } from '../../../src/json';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json, OwnerRef } from '../../../src/storage/types';

async function rejected(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string } | undefined)?.code).toBe(code);
}
for (const mode of ['tool', 'model'])
  test(`SIGKILL ${mode} retains durable facts without automatic execution`, async () => {
    const dataRoot = mkdtempSync('/private/tmp/kite-recovery-crash-');
    chmodSync(dataRoot, 0o700);
    const ledger = join(dataRoot, 'external-ledger');
    const child = Bun.spawn(
      [process.execPath, new URL('./crash-child.ts', import.meta.url).pathname],
      {
        env: {
          ...process.env,
          TEST_DATA_ROOT: dataRoot,
          TEST_LEDGER: ledger,
          TEST_CRASH_MODE: mode,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    let readonly: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let writer: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const reader = child.stdout.getReader();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('fixture readiness timeout')), 10000);
        }),
      ]);
      clearTimeout(timeout);
      expect(chunk.done).toBe(false);
      const ready = JSON.parse(new TextDecoder().decode(chunk.value)) as {
        phase: string;
        owner: OwnerRef;
        storeId: string;
        runId: string;
      };
      expect(ready.phase).toBe(
        mode === 'tool' ? 'effect_before_result_commit' : 'partial_committed',
      );
      child.kill('SIGSTOP');
      writer = await openSqliteStore({ dataRoot, profile: 'test' });
      // A live or frozen OS owner is not taken over based on a stale heartbeat.
      expect(await writer.acquireSessionOwner('crashed', 'contender')).toBeNull();
      const recovery = {
        expectedStoreId: ready.storeId,
        commandId: 'recover',
        sessionId: 'crashed',
        subjectId: 'user',
        expectedOwnerGeneration: ready.owner.generation,
        decision: 'interrupt' as const,
      };
      await rejected(writer.recoverSession(recovery), 'owner_busy');
      child.kill('SIGKILL');
      await child.exited;
      readonly = await openSqliteStore({ dataRoot, profile: 'test', mode: 'readonly' });
      expect((await readonly.getMetadata()).storeId).toBe(ready.storeId);
      const view = await readonly.getView('crashed');
      expect(view.runs[0]?.isActive).toBe(true);
      expect(view.executions).toHaveLength(1);
      expect(view.executions[0]?.status).toBe('dispatching');
      expect(view.executions[0]?.result).toBeNull();
      if (mode === 'tool') expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
      else {
        const partials = view.messages.filter((message) => message.role === 'assistant');
        expect(partials).toHaveLength(1);
        expect(partials[0]?.status).toBe('incomplete');
        const original = 'fixed incomplete '.repeat(4096);
        expect(partials[0]?.content).toBe(original.slice(0, 4096));
        expect(partials[0]?.sourceIds).toEqual(['model']);
        const outputStore = await openSqliteStore({ dataRoot, profile: 'test', mode: 'readonly' });
        const artifacts = createArtifactStore({
          profile: { dataRoot, profile: 'test' },
          store: outputStore,
        });
        const reader = createRuntime({
          store: outputStore,
          artifacts,
          model: {
            stream() {
              throw new Error('cold_read_must_not_initialize_model');
            },
          },
          permissions: {
            async authorize() {
              throw new Error('cold_read_must_not_authorize_effect');
            },
          },
        });
        const output = await reader.readModelOutput({
          expectedStoreId: ready.storeId,
          sessionId: 'crashed',
          subjectId: 'user',
          executionId: 'model',
        });
        expect(output.executionId).toBe('model');
        expect(output.storeId).toBe(ready.storeId);
        expect(output.output.content).toBe(original);
        expect(output.output.complete).toBe(false);
        const bytes = Buffer.from(canonicalJson(output.output as unknown as Json));
        expect(output.bodyHash).toBe(
          Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex'),
        );
        await reader.close();
      }
      await rejected(writer.acquireSessionOwner('crashed', 'new-owner'), 'recovery_required');
      await rejected(
        writer.finishExecution({
          expectedStoreId: ready.storeId,
          owner: ready.owner,
          executionId: view.executions[0]!.id,
          status: 'succeeded',
          result: {},
        }),
        'owner_changed',
      );
      await rejected(
        writer.recoverSession({ ...recovery, expectedOwnerGeneration: '0' }),
        'owner_changed',
      );
      const report = await writer.recoverSession(recovery);
      expect(report.previousGeneration).toBe(ready.owner.generation);
      expect(report.generation).toBe(String(BigInt(ready.owner.generation) + 1n));
      expect(report.interruptedRunIds).toEqual([ready.runId]);
      expect(report.unknownExecutionIds).toEqual(mode === 'tool' ? [view.executions[0]!.id] : []);
      expect(report.settledExecutionIds).toEqual(mode === 'model' ? ['model'] : []);
      expect(report.partialMessageIds).toEqual(mode === 'model' ? ['partial_model'] : []);
      expect(await writer.recoverSession(recovery)).toEqual(report);
      await rejected(
        writer.recoverSession({ ...recovery, subjectId: 'different' }),
        'command_conflict',
      );
      const recovered = await readonly.getView('crashed');
      expect(recovered.runs[0]?.status).toBe('interrupted');
      expect(recovered.runs[0]?.isActive).toBe(false);
      const recoveredRun = await writer.getRun(ready.runId);
      expect(recoveredRun?.finishedAt).not.toBeNull();
      expect(Number.isFinite(recoveredRun?.finishedAt)).toBe(true);
      expect(recovered.executions[0]?.decisionSource).toEqual(view.executions[0]?.decisionSource);
      expect(recovered.executions[0]?.input).toEqual(view.executions[0]?.input);
      if (mode === 'tool')
        await rejected(
          writer.acquireSessionOwner('crashed', 'after-recovery'),
          'recovery_required',
        );
      else {
        const live = await writer.acquireSessionOwner('crashed', 'after-recovery');
        expect(live).not.toBeNull();
        expect(await writer.recoverSession(recovery)).toEqual(report);
        await rejected(
          writer.finishExecution({
            expectedStoreId: ready.storeId,
            owner: ready.owner,
            executionId: 'model',
            status: 'succeeded',
            result: {},
          }),
          'owner_changed',
        );
        expect(
          (await readonly.listMessages('crashed')).find((message) => message.id === 'partial_model')
            ?.status,
        ).toBe('incomplete');
      }
      const unrelatedOwner = await writer.acquireSessionOwner('unrelated', 'unrelated-owner');
      expect(unrelatedOwner).not.toBeNull();
      await writer.acceptCommand({
        expectedStoreId: ready.storeId,
        commandId: 'unrelated-work',
        sessionId: 'unrelated',
        subjectId: 'user',
        request: { kind: 'run.start', content: 'independent' },
      });
      const unrelatedRun = await writer.startRun({
        expectedStoreId: ready.storeId,
        owner: unrelatedOwner!,
        commandId: 'unrelated-work',
        configuration: {},
      });
      await writer.finishRun({
        expectedStoreId: ready.storeId,
        owner: unrelatedOwner!,
        runId: unrelatedRun.id,
        status: 'completed',
        requirements: [],
      });
      expect(await writer.releaseSessionOwner(unrelatedOwner!)).toBe(true);
      expect((await readonly.getView('crashed')).executions[0]?.status).toBe(
        mode === 'tool' ? 'outcome_unknown' : 'failed',
      );
      if (mode === 'tool') expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
    } finally {
      clearTimeout(timeout);
      child.kill('SIGKILL');
      await child.exited;
      await readonly?.close();
      await writer?.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 15000);
