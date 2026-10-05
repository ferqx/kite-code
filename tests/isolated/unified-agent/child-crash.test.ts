import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { OperationRef } from '@kite-ai/agent/extensions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { createFixedModel } from '@kite-ai/ai';

interface Evidence {
  storeId: string;
  generation: string;
  operation: OperationRef;
  childRunId: string;
  effectId: string;
  modelId?: string;
}
async function rejected(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
function ledger(path: string) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string });
}
for (const mode of ['effect', 'partial'] as const)
  test(`real root SIGKILL fences detached child ${mode} facts without replay and leaves unrelated Session usable`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-crash-')));
    const dataRoot = join(root, 'profile');
    const effects = join(root, 'external-ledger.jsonl');
    const ready = join(root, 'ready.json');
    const host = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, '../../fixtures/unified-agent/child-crash.ts'),
        mode,
        dataRoot,
        effects,
        ready,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = new Response(host.stdout).text();
    const stderr = new Response(host.stderr).text();
    let reader: Store | undefined;
    let store: Store | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      const deadline = Date.now() + 10000;
      while (!existsSync(ready)) {
        if (host.exitCode !== null) throw new Error(`Fixture exited: ${await stderr}`);
        if (Date.now() > deadline) throw new Error('Fixture did not reach real child dispatch.');
        await Bun.sleep(10);
      }
      const evidence = JSON.parse(readFileSync(ready, 'utf8')) as Evidence;
      expect(evidence.operation.childSessionId).toBeString();
      const beforeLedger = ledger(effects);
      expect(beforeLedger.filter((entry) => entry.kind === 'effect')).toHaveLength(1);
      expect(beforeLedger.filter((entry) => entry.kind === 'child-model')).toHaveLength(
        mode === 'effect' ? 1 : 2,
      );
      host.kill('SIGKILL');
      await host.exited;
      expect(await stderr).toBe('');
      expect(await stdout).toBe('');
      reader = await openSqliteStore({ dataRoot, profile: 'new', mode: 'readonly' });
      const rootBefore = await reader.getView('root');
      const childBefore = await reader.getView(evidence.operation.childSessionId!);
      expect(rootBefore.runs[0]?.status).toBe('completed');
      expect(childBefore.runs[0]?.status).toBe('running');
      expect((await reader.getExecution(evidence.operation.executionId!))?.status).toBe('running');
      expect((await reader.getExecution(evidence.effectId))?.status).toBe(
        mode === 'effect' ? 'dispatching' : 'succeeded',
      );
      const operationInput = {
        originStoreId: evidence.storeId,
        subjectId: 'owner',
        sessionId: 'root',
        extensionId: 'fixture',
        key: 'original-child',
      };
      expect(await reader.getOperation(operationInput)).toEqual(evidence.operation);
      const partial = childBefore.messages.find(
        (message) =>
          message.status === 'incomplete' && message.content.startsWith('child unfinished'),
      );
      if (mode === 'partial') {
        expect(evidence.modelId).toBeString();
        expect(partial?.id).toBe(`partial_${evidence.modelId}`);
        expect(partial?.sessionId).toBe(evidence.operation.childSessionId!);
        expect(partial?.content.length).toBeGreaterThan(32768);
        expect(rootBefore.messages.some((message) => message.id === partial!.id)).toBe(false);
        expect(
          childBefore.executions.find((execution) => execution.id === evidence.modelId)
            ?.originStoreId,
        ).toBe(evidence.storeId);
      }
      await Bun.sleep(50);
      expect(await reader.getView(evidence.operation.childSessionId!)).toEqual(childBefore);
      expect(ledger(effects)).toEqual(beforeLedger);
      await reader.close();
      reader = undefined;
      store = await openSqliteStore({ dataRoot, profile: 'new' });
      const recovery = {
        expectedStoreId: evidence.storeId,
        sessionId: 'root',
        subjectId: 'owner',
        commandId: 'recover',
        expectedOwnerGeneration: evidence.generation,
        decision: 'interrupt' as const,
      };
      await rejected(
        store.recoverSession({ ...recovery, expectedStoreId: 'foreign-store' }),
        'store_identity_mismatch',
      );
      await rejected(
        store.recoverSession({
          ...recovery,
          commandId: 'child-recover',
          sessionId: evidence.operation.childSessionId!,
        }),
        'group_root_required',
      );
      expect((await store.getSession('root'))?.ownerGeneration).toBe(evidence.generation);
      const report = await store.recoverSession(recovery);
      expect(report.storeId).toBe(evidence.storeId);
      expect(report.previousGeneration).toBe(evidence.generation);
      expect(BigInt(report.generation)).toBe(BigInt(evidence.generation) + 1n);
      expect(report.interruptedRunIds).toContain(evidence.childRunId);
      expect(report.unknownExecutionIds).toContain(evidence.operation.executionId!);
      expect((await store.getRun(evidence.childRunId))?.status).toBe('interrupted');
      expect((await store.getSession(evidence.operation.childSessionId!))?.ownerGeneration).toBe(
        report.generation,
      );
      expect((await store.getExecution(evidence.operation.executionId!))?.status).toBe(
        'outcome_unknown',
      );
      if (mode === 'effect') {
        expect(report.unknownExecutionIds).toContain(evidence.effectId);
        expect((await store.getExecution(evidence.effectId))?.status).toBe('outcome_unknown');
      } else {
        expect((await store.getExecution(evidence.effectId))?.status).toBe('succeeded');
        expect(report.partialMessageIds).toContain(partial!.id);
        expect(
          (await store.listMessages(evidence.operation.childSessionId!)).find(
            (message) => message.id === partial!.id,
          ),
        ).toEqual(partial!);
      }
      expect(await store.recoverSession(recovery)).toEqual(report);
      expect(await store.getOperation(operationInput)).toEqual(evidence.operation);
      const model = createFixedModel([
        [
          { type: 'text_delta', text: 'unrelated works' },
          { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
      ]);
      runtime = createRuntime({
        store,
        model,
        modelId: 'new-fixed',
        permissions: {
          async authorize() {
            return { allowed: true, revision: '1' };
          },
        },
      });
      const original = await store.getCommand('original');
      expect(
        await runtime.submitCommand({
          expectedStoreId: evidence.storeId,
          sessionId: 'root',
          subjectId: 'owner',
          commandId: 'original',
          request: { kind: 'run.start', content: 'start detached child' },
        }),
      ).toEqual(original!);
      await runtime.waitForCommand('original');
      expect(model.requests).toHaveLength(0);
      expect(ledger(effects)).toEqual(beforeLedger);
      await runtime.createSession({
        expectedStoreId: evidence.storeId,
        sessionId: 'healthy',
        workspaceId: 'w',
        commandId: 'create-healthy',
        subjectId: 'owner',
        title: 'unrelated',
      });
      await runtime.submitCommand({
        expectedStoreId: evidence.storeId,
        sessionId: 'healthy',
        subjectId: 'owner',
        commandId: 'healthy-run',
        request: { kind: 'run.start', content: 'plain harmless work' },
      });
      await runtime.waitForCommand('healthy-run');
      expect((await runtime.getView('healthy')).runs[0]?.status).toBe('completed');
      expect(model.requests).toHaveLength(1);
      expect(await store.getOperation(operationInput)).toEqual(evidence.operation);
      expect(ledger(effects)).toEqual(beforeLedger);
    } finally {
      host.kill('SIGKILL');
      await host.exited;
      await reader?.close();
      if (runtime) await runtime.close();
      else await store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
