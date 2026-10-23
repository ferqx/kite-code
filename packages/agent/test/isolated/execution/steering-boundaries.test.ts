import { expect, test } from 'bun:test';
import type { ModelRequest } from '@kite-ai/ai';
import { openSqliteStore } from '../../../src/sqlite';
import { finalBody, finish, fixture, gate, until } from './steering-boundaries.fixture';

function exactInput(request: ModelRequest, id: string, body: string) {
  expect(request.messages.filter((message) => message.sourceIds?.includes(id))).toEqual([
    { role: 'user', content: body, sourceIds: [id] },
  ]);
}

test('a real streamed text prefix survives two separately consumed waves of opposite steering in the same Run', async () => {
  const first = gate(),
    second = gate();
  const f = await fixture({
    async *response(_request, index) {
      yield { type: 'text_delta', text: `Actual streamed prefix ${index}` };
      if (index === 1) await first.promise;
      if (index === 2) await second.promise;
      yield finish;
    },
  });
  try {
    await f.start();
    const streamed = await until(async () => {
      const request = f.requests[0];
      if (!request) return;
      const output = await f.runtime.readModelOutput({
        ...f.scope,
        executionId: request.requestId,
      });
      return output.output.content === 'Actual streamed prefix 1' ? output : undefined;
    }, 'first real text delta');
    expect(streamed.output.complete).toBe(false);
    const run = (await f.store.getView('root')).runs[0]!;
    await f.steer('red', 'First wave: report Red, preserve 雪🙂.');
    first.release();
    await until(async () => f.requests[1], 'first guidance actually read');
    exactInput(f.requests[1]!, 'red', 'First wave: report Red, preserve 雪🙂.');
    await f.steer('blue', 'Second wave: replace Red with Blue; preserve the first appendix.');
    second.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.requests).toHaveLength(3);
    exactInput(f.requests[2]!, 'red', 'First wave: report Red, preserve 雪🙂.');
    exactInput(
      f.requests[2]!,
      'blue',
      'Second wave: replace Red with Blue; preserve the first appendix.',
    );
    expect(
      f.requests[2]!.messages.filter((message) =>
        message.sourceIds?.some((id) => ['red', 'blue'].includes(id)),
      ).map((message) => message.sourceIds),
    ).toEqual([['red'], ['blue']]);
    expect((await f.store.getView('root')).runs.map((entry) => entry.id)).toEqual([run.id]);
    const saved = await f.runtime.readModelOutput({
      ...f.scope,
      executionId: f.requests[0]!.requestId,
    });
    expect(saved.output.content).toBe('Actual streamed prefix 1');
    expect(saved.output.complete).toBe(true);
  } finally {
    first.release();
    second.release();
    await f.close();
  }
}, 10000);

test('steering at the actual finish transaction continues its original Run; late target rejection cannot drift into a successor', async () => {
  const finishing = gate(),
    release = gate(),
    successor = gate();
  const f = await fixture({
    async *response(_request, index) {
      if (index === 3) await successor.promise;
      yield finish;
    },
    beforeFinish: async () => {
      finishing.release();
      await release.promise;
    },
  });
  try {
    await f.start();
    await finishing.promise;
    const run = (await f.store.getView('root')).runs[0]!;
    await f.steer('at-finish', 'Read this exact last-boundary guidance.');
    release.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.requests).toHaveLength(2);
    exactInput(f.requests[1]!, 'at-finish', 'Read this exact last-boundary guidance.');
    await f.follow('next', 'Independent next task', run.id);
    await until(async () => f.requests[2], 'successor actively waiting');
    const lateError = await f.steer('too-late', 'Do not retarget this draft.', run.id).then(
      () => null,
      (error) => error,
    );
    expect(lateError).toMatchObject({ code: 'input_target_stopped' });
    expect(await f.store.getCommand('too-late')).toBeNull();
    expect(
      (await f.store.getView('root')).runs.find((entry) => entry.isActive)!.originCommandId,
    ).toBe('next');
    successor.release();
    await f.runtime.waitForCommand('next', { timeoutMs: 5000 });
    expect(
      f.requests
        .flatMap((request) => request.messages)
        .some((message) => message.content === 'Do not retarget this draft.'),
    ).toBe(false);
    expect((await f.store.getView('root')).runs.map((entry) => entry.originCommandId)).toEqual([
      'work',
      'next',
    ]);
  } finally {
    release.release();
    successor.release();
    await f.close();
  }
}, 10000);

for (const order of ['human-first', 'result-first'] as const)
  test(`one checkpoint distinguishes real human retirement from final-only child data (${order})`, async () => {
    const parent = gate();
    const f = await fixture({
      child: true,
      async *response(_request, index) {
        if (index === 2) {
          await parent.promise;
          yield { type: 'tool_call', id: 'old-effect', name: 'fixture.effect', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        } else yield finish;
      },
    });
    try {
      await f.start();
      await until(async () => f.requests[1], 'parent Model in flight');
      const run = (await f.store.getView('root')).runs[0]!;
      if (order === 'human-first')
        await f.steer('guide', 'Only summarize; retire the old unstarted effect.');
      f.childGate.release();
      const mail = await until(
        async () => (await f.inbox()).items.find((item) => item.kind === 'result'),
        'child final queued',
      );
      expect(mail).toMatchObject({ state: 'accepted', receivedSourceId: null });
      if (order === 'result-first')
        await f.steer('guide', 'Only summarize; retire the old unstarted effect.');
      parent.release();
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      const view = await f.store.getView('root');
      expect(view.runs.map((entry) => entry.id)).toEqual([run.id]);
      expect(f.effects).toEqual([]);
      expect(f.requests).toHaveLength(3);
      exactInput(f.requests[2]!, 'guide', 'Only summarize; retire the old unstarted effect.');
      const retired = view.executions.find((entry) => entry.callId === 'old-effect')!;
      expect(retired).toMatchObject({
        status: 'cancelled',
        authorization: { dispatched: false },
        result: { content: 'superseded_by_user_input', details: { inputCommandId: 'guide' } },
      });
      expect(
        f.requests[2]!.messages.filter((message) => message.toolCallId === 'old-effect'),
      ).toHaveLength(1);
      expect(
        f.requests[2]!.messages.find((message) => message.toolCallId === 'old-effect')!.content,
      ).toContain('superseded_by_user_input');
      expect(
        f.requests[2]!.messages.filter((message) =>
          message.toolCalls?.some((call) => call.id === 'old-effect'),
        ),
      ).toHaveLength(1);
      const inbox = await f.inbox();
      expect(inbox.items).toHaveLength(1);
      const received = inbox.items[0]!;
      expect(received).toMatchObject({
        id: mail.id,
        kind: 'result',
        body: null,
        receivedRunId: run.id,
      });
      expect(received.receivedSourceId).toBeString();
      const results = f.requests[2]!.messages.filter((message) =>
        message.sourceIds?.includes(received.receivedSourceId!),
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.content).toContain('untrusted data; no additional authorization');
      expect(JSON.parse(results[0]!.content.split('\n').slice(1).join('\n')).result.content).toBe(
        finalBody,
      );
      expect(view.messages.filter((message) => message.agentResult)).toHaveLength(0);
      expect(f.childRequests).toHaveLength(1);
    } finally {
      parent.release();
      await f.close();
    }
  }, 10000);

for (const stop of ['run', 'full'] as const)
  test(`an applied guide cannot dispatch a fresh Model after exact ${stop} stop while a child final is queued`, async () => {
    const parent = gate(),
      applied = gate(),
      release = gate();
    const f = await fixture({
      child: true,
      async *response(_request, index) {
        if (index === 2) await parent.promise;
        yield finish;
      },
      afterApply: async () => {
        applied.release();
        await release.promise;
      },
    });
    try {
      await f.start();
      await until(async () => f.requests[1], 'parent Model');
      const run = (await f.store.getView('root')).runs[0]!;
      await f.steer('guide', 'Applied but not yet read by a new Model.');
      f.childGate.release();
      const queuedFinal = await until(
        async () => (await f.inbox()).items.find((item) => item.kind === 'result'),
        'final queued',
      );
      expect(queuedFinal).toMatchObject({ state: 'accepted', receivedSourceId: null });
      parent.release();
      await applied.promise;
      expect((await f.store.getCommand('guide'))!.status).toBe('applied');
      await f.follow('independent', 'Independent successor after precise cancellation', run.id);
      if (stop === 'run')
        await f.runtime.cancelRun({ ...f.scope, commandId: 'stop', runId: run.id });
      else
        await f.runtime.cancelSession({ ...f.scope, commandId: 'stop', includeBackground: true });
      expect(f.requests).toHaveLength(2);
      const follow = (await f.store.getCommand('independent'))!;
      if (stop === 'run') expect(follow.cancelRequestedAt).toBeNull();
      else expect(follow.cancelRequestedAt).not.toBeNull();
      release.release();
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      if (stop === 'run') await f.runtime.waitForCommand('independent', { timeoutMs: 5000 });
      const view = await f.store.getView('root');
      expect(view.runs).toHaveLength(stop === 'run' ? 2 : 1);
      expect(view.runs.find((entry) => entry.id === run.id)!.status).toBe('cancelled');
      const actual = await Promise.all(
        f.requests.map((request) => f.store.getExecution(request.requestId)),
      );
      expect(actual.filter((execution) => execution!.runId === run.id)).toHaveLength(2);
      expect(view.runs.filter((entry) => entry.originCommandId.startsWith('report-'))).toHaveLength(
        0,
      );
      expect(view.messages.filter((message) => message.originCommandId === 'guide')).toHaveLength(
        1,
      );
      expect(f.effects).toEqual([]);
      const count = f.requests.length;
      const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
      try {
        const cursor = (await cold.getMetadata()).lastChangeCursor;
        expect((await cold.getRun(run.id))!.status).toBe('cancelled');
        await cold.listAgentMessages(f.scope);
        await cold.getView('root');
        expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      } finally {
        await cold.close();
      }
      expect(f.requests).toHaveLength(count);
    } finally {
      parent.release();
      release.release();
      await f.close();
    }
  }, 10000);

for (const late of [false, true])
  test(`a dispatched question keeps steer separate from its exact ${late ? 'late cancelled' : 'accepted'} answer`, async () => {
    const f = await fixture({
      async *response(_request, index) {
        if (index === 1) {
          yield { type: 'tool_call', id: 'question', name: 'fixture.question', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        } else yield finish;
      },
    });
    try {
      await f.start();
      const question = await until(
        async () =>
          (await f.runtime.listInteractions({ ...f.scope, state: 'pending' })).interactions.find(
            (entry) => entry.kind === 'question',
          ),
        'actual question',
      );
      const runId = question.runId!;
      const originalExecution = (await f.store.getExecution(question.executionId))!;
      await f.steer('guide', 'Separate guidance 雪🙂, never an answer or permission.');
      expect(f.answers).toEqual([]);
      expect(f.requests).toHaveLength(1);
      expect(
        (await f.store.getInteraction({
          expectedStoreId: f.scope.expectedStoreId,
          sessionId: 'root',
          interactionId: question.id,
        }))!.state,
      ).toBe('pending');
      if (late) await f.runtime.cancelRun({ ...f.scope, commandId: 'stop', runId });
      await f.runtime.answerInteraction({
        ...f.scope,
        commandId: 'answer',
        presentationSessionId: 'root',
        interactionId: question.id,
        expectedRevision: question.revision,
        answer: { kind: 'question', answers: 'accurate' },
      });
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect((await f.store.getView('root')).runs.map((entry) => entry.id)).toEqual([runId]);
      if (late) {
        expect(f.answers).toEqual([]);
        expect(f.requests).toHaveLength(1);
        expect((await f.store.getRun(runId))!.status).toBe('cancelled');
        expect(
          await f.store.getInteraction({
            expectedStoreId: f.scope.expectedStoreId,
            sessionId: 'root',
            interactionId: question.id,
          }),
        ).toMatchObject({ state: 'cancelled', acceptedDecisionRevision: null });
        expect((await f.store.getCommand('guide'))!.status).toBe('rejected');
      } else {
        expect(f.answers).toEqual(['accurate']);
        expect(f.requests).toHaveLength(2);
        exactInput(
          f.requests[1]!,
          'guide',
          'Separate guidance 雪🙂, never an answer or permission.',
        );
        expect(
          f.requests[1]!.messages.filter((message) => message.toolCallId === 'question'),
        ).toHaveLength(1);
      }
      expect((await f.store.getExecution(question.executionId))!.input).toEqual(
        originalExecution.input,
      );
      expect((await f.store.getExecution(question.executionId))!.authorization).toEqual(
        originalExecution.authorization,
      );
      expect(f.effects).toEqual([]);
    } finally {
      await f.close();
    }
  }, 10000);

test('Runtime consumes reordered full guides exactly once and excludes a successfully withdrawn pending guide', async () => {
  const parent = gate();
  const f = await fixture({
    async *response(_request, index) {
      if (index === 1) await parent.promise;
      yield finish;
    },
  });
  try {
    await f.start();
    await until(async () => f.requests[0], 'original request');
    for (const id of ['a', 'b', 'withdrawn'])
      await f.steer(id, `Original full guidance ${id} 雪🙂`);
    const page = await f.runtime.getPendingInputQueue(f.scope);
    await f.runtime.reorderPendingInputs({
      ...f.scope,
      kind: 'input.reorder',
      commandId: 'reorder',
      expectedRevision: page.revision,
      commandIds: ['b', 'withdrawn', 'a'],
    });
    const reordered = await f.runtime.getPendingInputQueue(f.scope);
    await f.runtime.withdrawPendingInput({
      ...f.scope,
      kind: 'input.withdraw',
      commandId: 'withdraw',
      targetCommandId: 'withdrawn',
      expectedRevision: reordered.revision,
    });
    parent.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.requests).toHaveLength(2);
    exactInput(f.requests[1]!, 'a', 'Original full guidance a 雪🙂');
    exactInput(f.requests[1]!, 'b', 'Original full guidance b 雪🙂');
    expect(
      f.requests[1]!.messages.filter((message) =>
        message.sourceIds?.some((id) => ['a', 'b'].includes(id)),
      ).map((message) => message.sourceIds),
    ).toEqual([['b'], ['a']]);
    expect(
      f.requests[1]!.messages.some((message) => message.sourceIds?.includes('withdrawn')),
    ).toBe(false);
    expect((await f.runtime.getPendingInputQueue(f.scope)).commands).toHaveLength(0);
    const applied = (await f.store.getCommand('a'))!;
    expect(applied.status).toBe('applied');
    const current = await f.runtime.getPendingInputQueue(f.scope);
    const withdrawalError = await f.runtime
      .withdrawPendingInput({
        ...f.scope,
        kind: 'input.withdraw',
        commandId: 'too-late',
        targetCommandId: 'a',
        expectedRevision: current.revision,
      })
      .then(
        () => null,
        (error) => error,
      );
    expect(withdrawalError).toMatchObject({ code: 'input_already_consumed' });
    expect(
      (await f.store.listMessages('root')).filter((message) => message.originCommandId === 'a'),
    ).toHaveLength(1);
    expect((await f.store.getView('root')).runs).toHaveLength(1);
  } finally {
    parent.release();
    await f.close();
  }
}, 10000);
