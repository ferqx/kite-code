import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const reasoningFirst of [true, false])
  test(`first actual content is readable while held within the partial throttle (${reasoningFirst ? 'reasoning first' : 'pure content'})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-model-content-progress-'));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const scope = {
      expectedStoreId: (await store.getMetadata()).storeId,
      sessionId: 's',
      subjectId: 'owner',
    };
    const reasoning = reasoningFirst ? 'Actual reasoning 雪🙂' : '';
    const first = 'First actual content 中文🙂';
    const second = ' second delta';
    const third = ' after throttle';
    const reasoningReady = gate(),
      contentReady = gate(),
      secondReady = gate(),
      timedReady = gate();
    const releaseContent = gate(),
      releaseSecond = gate(),
      releaseTimed = gate(),
      releaseFinish = gate();
    const partials: Parameters<Store['persistModelPartial']>[0][] = [];
    const observed = new Proxy(store, {
      get(target, key) {
        if (key === 'persistModelPartial')
          return async (input: Parameters<Store['persistModelPartial']>[0]) => {
            const result = await target.persistModelPartial(input);
            partials.push(structuredClone(input));
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const base = Date.now();
    let now = base,
      executionId = '',
      requests = 0;
    // Only this test's stream clock changes. Timers remain real; finally restores
    // Date.now before closing the Runtime, including when the red assertion fails.
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const runtime = createRuntime({
      store: observed,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned' };
        },
      },
      model: {
        async *stream(request) {
          requests++;
          executionId = request.requestId;
          if (reasoningFirst) {
            yield { type: 'reasoning_delta', text: reasoning };
            reasoningReady.release();
            await releaseContent.promise;
          }
          now = base + 10;
          yield { type: 'text_delta', text: first };
          // Resuming the generator proves the Runtime processed the previous event;
          // no subsequent event can accidentally flush this held first content.
          contentReady.release();
          await releaseSecond.promise;
          now = base + 20;
          yield { type: 'text_delta', text: second };
          secondReady.release();
          await releaseTimed.promise;
          now = base + 150;
          yield { type: 'text_delta', text: third };
          timedReady.release();
          await releaseFinish.promise;
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: scope.expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...scope,
        commandId: 'create',
        workspaceId: 'w',
        title: 'held stream',
      });
      await runtime.submitCommand({
        ...scope,
        commandId: 'work',
        request: { kind: 'run.start', content: 'Read actual streamed progress.' },
      });
      if (reasoningFirst) {
        await reasoningReady.promise;
        expect(partials).toHaveLength(1);
        expect((await runtime.readModelOutput({ ...scope, executionId })).output).toEqual({
          content: '',
          reasoning,
          toolCalls: [],
          complete: false,
        });
        releaseContent.release();
      }
      await contentReady.promise;
      expect(partials).toHaveLength(reasoningFirst ? 2 : 1);
      const actualMessage = (await runtime.listMessages('s')).find((message) =>
        message.sourceIds?.includes(executionId),
      )!;
      expect(actualMessage.content).toBe(first);
      expect(actualMessage.firstOutput).toBe(reasoningFirst ? 'reasoning' : 'content');
      expect((await store.getExecution(executionId))!.status).toBe('dispatching');
      expect((await runtime.readModelOutput({ ...scope, executionId })).output).toEqual({
        content: first,
        reasoning,
        toolCalls: [],
        complete: false,
      });
      const firstCount = partials.length;
      releaseSecond.release();
      await secondReady.promise;
      expect(partials).toHaveLength(firstCount);
      expect((await runtime.readModelOutput({ ...scope, executionId })).output.content).toBe(first);
      releaseTimed.release();
      await timedReady.promise;
      expect(partials).toHaveLength(firstCount + 1);
      expect((await runtime.readModelOutput({ ...scope, executionId })).output).toEqual({
        content: first + second + third,
        reasoning,
        toolCalls: [],
        complete: false,
      });
      expect(partials.map((partial) => partial.content)).toEqual([
        ...(reasoningFirst ? [''] : []),
        first,
        first + second + third,
      ]);
      clock.mockRestore();
      releaseFinish.release();
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect((await runtime.readModelOutput({ ...scope, executionId })).output).toEqual({
        content: first + second + third,
        reasoning,
        toolCalls: [],
        complete: true,
      });
      expect(
        (await runtime.listMessages('s')).find((message) =>
          message.sourceIds?.includes(executionId),
        ),
      ).toMatchObject({
        content: first + second + third,
        firstOutput: reasoningFirst ? 'reasoning' : 'content',
        status: 'complete',
      });
      expect(requests).toBe(1);
    } finally {
      clock.mockRestore();
      releaseContent.release();
      releaseSecond.release();
      releaseTimed.release();
      releaseFinish.release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
