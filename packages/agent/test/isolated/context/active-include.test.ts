import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
for (const mode of ['apply', 'cancel', 'approval'] as const)
  test(`active result include ${mode} waits for exact dispatched Model boundary without replaying original Tool`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-active-include-')));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const ready = gate(),
      release = gate();
    const requests: ModelRequest[] = [];
    let effects = 0;
    const model: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield { type: 'tool_call', id: 'old-call', name: 'old', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        if (requests.length === 3) {
          ready.release();
          if (mode !== 'approval') await release.promise;
          else {
            yield { type: 'tool_call', id: 'unattempted-call', name: 'old', arguments: '{}' };
            yield { ...finish, reason: 'tool_calls' };
            return;
          }
        }
        yield { type: 'text_delta', text: 'actual response' };
        yield finish;
      },
    };
    const runtime = createRuntime({
      store: new Proxy(store, {
        get(target, key) {
          if (key === 'applyInput')
            return async (input: Parameters<typeof store.applyInput>[0]) => {
              if (input.kind === 'result_include') await release.promise;
              return target.applyInput(input);
            };
          return Reflect.get(target, key);
        },
      }),
      model,
      modelId: 'fixed',
      permissions: {
        async authorize(request) {
          if (mode === 'approval' && requests.length >= 3 && request.kind === 'tool')
            return {
              allowed: false,
              revision: '1',
              approval: { request: { title: 'exact old Tool permission' } },
            };
          return { allowed: true, revision: '1' };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'old',
              version: '1',
              description: 'immutable harmless prior result',
              inputSchema: { type: 'object' },
              async execute() {
                effects++;
                return { outcome: 'succeeded', content: 'EXACT OLD RESULT' };
              },
            },
          ],
        },
      ],
    });
    const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'private',
        rootUri: `file://${root}`,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'include',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'old-work',
        request: { kind: 'run.start', content: 'produce prior result' },
      });
      await runtime.waitForCommand('old-work', { timeoutMs: 5000 });
      const old = (await store.getView('s')).executions.find((e) => e.kind === 'tool')!;
      const selection = await runtime.selectContext({
        ...base,
        commandId: 'rewind',
        expectedContextSelectionId: (await store.getSession('s'))!.contextSelectionId,
        boundary: null,
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'active-work',
        request: { kind: 'run.start', content: 'new exact foreground' },
      });
      await ready.promise;
      let cardId: string | undefined;
      if (mode === 'approval') {
        for (let attempt = 0; attempt < 200; attempt++) {
          const page = await store.listInteractions({
            expectedStoreId,
            sessionId: 's',
            state: 'pending',
          });
          if (page.interactions.length) {
            cardId = page.interactions[0]!.id;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(cardId).toBeDefined();
      }
      const run = (await store.getView('s')).runs.find((run) => run.isActive)!;
      const input = {
        ...base,
        commandId: 'include',
        expectedContextSelectionId: selection.selection.id,
        targetRunId: run.id,
        executionId: old.id,
        resultRevision: old.resultRevision,
      };
      await rejected(
        runtime.includeResult({ ...input, expectedStoreId: 'foreign' }),
        'store_identity_mismatch',
      );
      await rejected(
        runtime.includeResult({ ...input, subjectId: 'intruder' }),
        'permission_denied',
      );
      await rejected(
        runtime.includeResult({ ...input, targetRunId: 'wrong' }),
        'input_target_changed',
      );
      await rejected(
        runtime.includeResult({ ...input, expectedContextSelectionId: 'old' }),
        'context_selection_changed',
      );
      const included = await runtime.includeResult(input);
      expect(included.command.status).toBe('accepted');
      expect(included.command.receipt).toMatchObject({ outcome: 'result_queued', runId: run.id });
      expect(
        (await store.getSelectedContext({ expectedStoreId, sessionId: 's' })).resultSources,
      ).toHaveLength(0);
      expect((await store.getExecution(old.id))!.resultAcceptance).toBeNull();
      const cursor = (await store.getMetadata()).lastChangeCursor;
      expect(await runtime.includeResult(input)).toEqual(included);
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(requests).toHaveLength(3);
      expect(effects).toBe(1);
      if (mode === 'cancel')
        await runtime.cancelCommand({
          ...base,
          commandId: 'cancel-include',
          targetCommandId: 'include',
        });
      release.release();
      await runtime.waitForCommand('active-work', { timeoutMs: 5000 });
      const selected = await store.getSelectedContext({ expectedStoreId, sessionId: 's' });
      expect((await store.getRun(run.id))!.status).toBe('completed');
      expect(effects).toBe(1);
      expect((await store.getExecution(old.id))!.result).toEqual(old.result);
      if (mode !== 'cancel') {
        expect(requests).toHaveLength(4);
        expect(selected.resultSources.map((source) => source.id)).toEqual([included.source.id]);
        const message = requests[3]!.messages.filter((message) =>
          message.sourceIds?.includes(included.source.id),
        );
        expect(message).toHaveLength(1);
        expect(message[0]!.role).toBe('user');
        expect(message[0]!.content).toContain('EXACT OLD RESULT');
        expect(
          requests[2]!.messages.some((message) => message.sourceIds?.includes(included.source.id)),
        ).toBe(false);
        expect((await store.getCommand('include'))!.status).toBe('applied');
        if (mode === 'approval') {
          expect(
            (await store.getInteraction({
              expectedStoreId,
              sessionId: 's',
              interactionId: cardId!,
            }))!.state,
          ).toBe('cancelled');
          const cancelled = (await store.getView('s')).executions.find(
            (execution) => execution.callId === 'unattempted-call',
          )!;
          expect(cancelled.status).toBe('cancelled');
          expect(cancelled.result).toMatchObject({
            outcome: 'cancelled',
            details: { adapterAttempted: false, code: 'superseded_by_user_input' },
          });
        }
      } else {
        expect(requests).toHaveLength(3);
        expect(selected.resultSources).toHaveLength(0);
        expect((await store.getCommand('include'))!.status).toBe('rejected');
      }
    } finally {
      release.release();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
