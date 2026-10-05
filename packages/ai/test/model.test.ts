import { expect, test } from 'bun:test';
import { createFixedModel, type ModelEvent, type ModelRequest } from '../src';

const request: ModelRequest = {
  modelId: 'fixed',
  requestId: 'request-1',
  messages: [{ role: 'user', content: 'hello', sourceIds: ['input-1'] }],
  tools: [],
};
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 2 },
};

test('records exact request sources and preserves explicit stream order', async () => {
  const model = createFixedModel([
    [{ type: 'reasoning_delta', text: 'thinking' }, { type: 'text_delta', text: 'hello' }, finish],
  ]);
  const actual = await Array.fromAsync(
    model.stream(request, { signal: new AbortController().signal }),
  );
  expect(actual).toEqual([
    { type: 'reasoning_delta', text: 'thinking' },
    { type: 'text_delta', text: 'hello' },
    finish,
  ]);
  expect(model.requests).toEqual([request]);
  const copy = model.requests[0]!;
  Object.assign(copy.messages[0]!, { content: 'changed' });
  expect(model.requests[0]!.messages[0]!.content).toBe('hello');
});

test('does not manufacture finish for truncated or failed streams', async () => {
  const call: ModelEvent = { type: 'tool_call', id: 'call-1', name: 'count', arguments: '{' };
  const model = createFixedModel([[call], [call, new Error('provider failed')]]);
  expect(
    await Array.fromAsync(model.stream(request, { signal: new AbortController().signal })),
  ).toEqual([call]);
  await expect(
    Array.fromAsync(model.stream(request, { signal: new AbortController().signal })),
  ).rejects.toThrow('provider failed');
});

test('cancelled stream stops before yielding further events', async () => {
  const abort = new AbortController();
  const model = createFixedModel([[{ type: 'text_delta', text: 'first' }, finish]]);
  const iterator = model.stream(request, { signal: abort.signal })[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ type: 'text_delta', text: 'first' });
  abort.abort();
  await expect(iterator.next()).rejects.toThrow();
});
