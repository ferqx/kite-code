import { expect, test } from 'bun:test';
import { type ModelAdapter, ModelAttemptError, type ModelEvent } from '@kite-ai/ai';
import { approvalModelAttempts } from '../../../src/execution/authorization-retry';
import { AgentError, type Json } from '../../../src/storage/types';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 2, outputTokens: 1 },
};
const answer = (decision = 'approve_once'): ModelEvent => ({
  type: 'text_delta',
  text: JSON.stringify({ decision, reason: 'test' }),
});
async function execute(
  model: ModelAdapter,
  options: { signal?: AbortSignal; checkpoint?: () => Promise<void>; timeoutMs?: number } = {},
) {
  const attempts: Json[] = [];
  const events: ModelEvent[] = [];
  let error: unknown;
  try {
    for await (const event of approvalModelAttempts({
      model,
      request: { modelId: 'review', requestId: 'same-check', messages: [], tools: [] },
      signal: options.signal ?? new AbortController().signal,
      timeoutMs: options.timeoutMs ?? 100,
      checkpoint: options.checkpoint ?? (async () => {}),
      record: async (value) => {
        attempts.push(structuredClone(value));
      },
    }))
      events.push(event);
  } catch (value) {
    error = value;
  }
  return { events, error, attempts };
}
test('two disconnected attempts discard partial allow, third independent response succeeds', async () => {
  let calls = 0;
  const result = await execute({
    async *stream() {
      calls++;
      if (calls < 3) {
        yield { type: 'text_delta', text: '{"decision":"approve' };
        throw new ModelAttemptError('stream_incomplete', 'connection_interrupted');
      }
      yield answer();
      yield finish;
    },
  });
  expect(calls).toBe(3);
  expect(result.error).toBeUndefined();
  expect(result.events).toEqual([answer(), finish]);
  expect(result.attempts).toHaveLength(7);
});
test('transport exhaustion performs exactly three attempts and releases no failed text', async () => {
  let calls = 0;
  const result = await execute({
    async *stream() {
      calls++;
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
      throw new ModelAttemptError('connection_failed', 'connection_refused');
    },
  });
  expect(calls).toBe(3);
  expect(ModelAttemptError.isInstance(result.error)).toBe(true);
  expect(result.events).toEqual([]);
});
test('noncooperative timed out attempt is aborted, no late response is accepted', async () => {
  let calls = 0;
  const signals: AbortSignal[] = [];
  const result = await execute(
    {
      async *stream(_request, { signal }) {
        calls++;
        signals.push(signal);
        if (calls < 3) await new Promise(() => {});
        yield answer();
        yield finish;
      },
    },
    { timeoutMs: 10 },
  );
  expect(calls).toBe(3);
  expect(signals.every((value) => value.aborted)).toBe(true);
  expect(result.events).toEqual([answer(), finish]);
});
for (const decision of ['deny', 'ask_user'])
  test(`${decision} is returned once, never retried`, async () => {
    let calls = 0;
    const result = await execute({
      async *stream() {
        calls++;
        yield answer(decision);
        yield finish;
      },
    });
    expect(calls).toBe(1);
    expect(result.events).toEqual([answer(decision), finish]);
  });
for (const failure of [
  new Error('invalid credentials'),
  new AgentError('authorization_check_output_invalid'),
  new ModelAttemptError('provider_unavailable', 'service_unavailable'),
  new ModelAttemptError('provider_unavailable', 'rate_limited'),
])
  test(`does not retry ${failure.message} ${'detail' in failure ? failure.detail : ''}`, async () => {
    let calls = 0;
    const result = await execute({
      async *stream() {
        calls++;
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
        throw failure;
      },
    });
    expect(calls).toBe(1);
    expect(result.error).toBe(failure);
  });
test('cancel during attempt stops immediately without retries or output', async () => {
  let calls = 0;
  const controller = new AbortController();
  const cancelled = new AgentError('cancelled');
  const result = await execute(
    {
      async *stream() {
        calls++;
        controller.abort(cancelled);
        yield answer();
      },
    },
    { signal: controller.signal },
  );
  expect(calls).toBe(1);
  expect(result.error).toBe(cancelled);
  expect(result.events).toEqual([]);
});
test('freshness revision failure prevents the next provider call', async () => {
  let calls = 0;
  let checks = 0;
  const result = await execute(
    {
      async *stream() {
        calls++;
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
        throw new ModelAttemptError('connection_failed', 'connection_interrupted');
      },
    },
    {
      checkpoint: async () => {
        if (++checks > 1) throw new AgentError('context_refresh_required');
      },
    },
  );
  expect(calls).toBe(1);
  expect((result.error as AgentError).code).toBe('context_refresh_required');
});
test('a finished decision followed by transport failure is not retried', async () => {
  let calls = 0;
  const result = await execute({
    async *stream() {
      calls++;
      yield answer('deny');
      yield finish;
      throw new ModelAttemptError('stream_incomplete');
    },
  });
  expect(calls).toBe(1);
  expect(result.error).toBeDefined();
  expect(result.events).toEqual([]);
});

test('observed usage is retained when cancellation interrupts a buffered attempt', async () => {
  const controller = new AbortController();
  const result = await execute(
    {
      async *stream() {
        yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3 } };
        controller.abort(new AgentError('cancelled'));
        yield answer();
      },
    },
    { signal: controller.signal },
  );
  expect(result.events).toEqual([]);
  expect(result.attempts.at(-1)).toMatchObject({
    status: 'cancelled',
    usage: { inputTokens: 11, outputTokens: 3 },
  });
});

test('failed output and arbitrary provider messages are absent from attempt audit', async () => {
  const result = await execute({
    async *stream() {
      yield { type: 'text_delta', text: 'PRIVATE_USER_TEXT' };
      throw new Error('PRIVATE_PROVIDER_URL_AND_CREDENTIAL');
    },
  });
  expect(result.events).toEqual([]);
  expect(JSON.stringify(result.attempts)).not.toContain('PRIVATE');
  expect(result.attempts.at(-1)).toMatchObject({ status: 'failed', code: 'model_failed' });
});

for (const failure of [
  new ModelAttemptError('stream_incomplete'),
  new ModelAttemptError('connection_failed'),
])
  test(`ambiguous SDK failure is final: ${failure.reason}`, async () => {
    let calls = 0;
    const result = await execute({
      async *stream() {
        calls++;
        yield answer();
        throw failure;
      },
    });
    expect(calls).toBe(1);
    expect(result.error).toBe(failure);
    expect(result.events).toEqual([]);
  });

test('a cleanly ended stream without finish is never inferred to be a disconnect', async () => {
  let calls = 0;
  const result = await execute({
    async *stream() {
      calls++;
      yield answer();
    },
  });
  expect(calls).toBe(1);
  expect(result.error).toMatchObject({ code: 'model_response_incomplete' });
  expect(result.events).toEqual([]);
});

test('a length-limited response is final and retains the reported failure usage', async () => {
  let calls = 0;
  const result = await execute({
    async *stream() {
      calls++;
      yield answer();
      yield { type: 'finish', reason: 'length', usage: { inputTokens: 7, outputTokens: 100 } };
    },
  });
  expect(calls).toBe(1);
  expect(result.events).toEqual([]);
  expect(result.error).toMatchObject({ code: 'authorization_check_output_limit' });
  expect(result.attempts.at(-1)).toMatchObject({
    usage: { inputTokens: 7, outputTokens: 100 },
    status: 'failed',
  });
});

test('synchronous provider delay cannot evade a per-attempt deadline before the timer runs', async () => {
  let calls = 0;
  const result = await execute(
    {
      async *stream() {
        calls++;
        if (calls < 3) {
          const until = Date.now() + 20;
          while (Date.now() < until) {
            /* deliberately block timer callbacks */
          }
        }
        yield answer();
        yield finish;
      },
    },
    { timeoutMs: 10 },
  );
  expect(calls).toBe(3);
  expect(result.events).toEqual([answer(), finish]);
  expect(
    result.attempts.filter((entry) => (entry as { detail?: string }).detail === 'request_timeout'),
  ).toHaveLength(2);
});
