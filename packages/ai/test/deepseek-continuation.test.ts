import { expect, test } from 'bun:test';
import type { ModelEvent, ModelMessage, ModelRequest, ModelToolCall } from '@kite-ai/ai';
import { boundModelHistory, createFixedModel } from '@kite-ai/ai';
import {
  createCompatibleModelBinding,
  createSdkModelAdapter,
  type ReasoningEffort,
} from '@kite-ai/ai/sdk';

const model = 'deepseek-v4-flash';
const origin = 'https://api.deepseek.com';
const route = 'owned-route';
const firstReason = ' synthetic 🦎\nprivate tool reasoning ';
const nextReason = ' different private text 响应 🧪 ';
const call = { id: 'fetch-a', name: 'web_fetch', arguments: '{"url":"https://example.test/page"}' };
const secondCall = { ...call, id: 'fetch-b' };
const question = { role: 'user' as const, content: 'Read this fixture' };
const tools: ModelRequest['tools'] = [
  {
    id: 'web_fetch',
    definitionVersion: '1',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
];
type WireRow = {
  role: string;
  content: unknown;
  reasoning_content?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};
type Wire = { model: string; messages: WireRow[]; reasoning_effort?: string; thinking?: unknown };

function streamReply(
  reason?: string | null,
  calls: readonly ModelToolCall[] = [],
  content = 'answer',
) {
  const frame = (delta: object, finish: string | null = null) =>
    'data: ' +
    JSON.stringify({
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    '\n\n';
  let response = frame({ role: 'assistant' });
  if (typeof reason === 'string') {
    response +=
      frame({ reasoning_content: reason.slice(0, 3) }) +
      frame({ reasoning_content: reason.slice(3) });
  } else if (reason === null) response += frame({ reasoning_content: null });
  response += frame({ content });
  if (calls.length)
    response += frame({
      tool_calls: calls.map((c, index) => ({
        index,
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    });
  return `${response + frame({}, calls.length ? 'tool_calls' : 'stop')}data: [DONE]\n\n`;
}
const defaults = { name: 'deepseek', baseURL: origin, modelId: model, apiKey: 'owned-fixture-key' };
type Binding = Partial<Omit<Parameters<typeof createCompatibleModelBinding>[0], 'fetch'>> & {
  accountId?: string;
};
function fixture(replies: string[], overrides: Binding = {}, id = route, effort?: ReasoningEffort) {
  const bodies: Wire[] = [];
  const binding = createCompatibleModelBinding({
    ...defaults,
    ...overrides,
    fetch: Object.assign(
      async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Wire;
        bodies.push(body);
        const reply = replies[bodies.length - 1];
        if (reply === undefined) throw Error('unexpected_fixture_dispatch');
        return new Response(reply, { headers: { 'content-type': 'text/event-stream' } });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const adapter = createSdkModelAdapter({
    models: new Map([[id, binding]]),
    ...(effort ? { presets: new Map([[id, { reasoningEffort: effort }]]) } : {}),
  });
  return {
    bodies,
    adapter,
    async send(requestId: string, messages: ModelRequest['messages'], available = tools) {
      const events: ModelEvent[] = [];
      for await (const event of adapter.stream(
        { modelId: id, requestId, messages, tools: available },
        { signal: new AbortController().signal },
      ))
        events.push(event);
      return events;
    },
  };
}
function stored(requestId: string, events: ModelEvent[]): ModelMessage {
  const finish = events.find((e) => e.type === 'finish');
  expect(finish).toBeDefined();
  const calls = events.filter((e) => e.type === 'tool_call').map(({ type: _kind, ...c }) => c);
  return JSON.parse(
    JSON.stringify({
      role: 'assistant',
      sourceIds: [requestId],
      content: events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.text)
        .join(''),
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(finish?.continuation === undefined ? {} : { continuation: finish.continuation }),
    }),
  ) as ModelMessage;
}
const results = (calls: readonly ModelToolCall[]) =>
  calls.map((c) => ({ role: 'tool' as const, toolCallId: c.id, content: `stored result ${c.id}` }));
test('official DeepSeek Chat restores exact private reasoning only on its own assistant turns through a cold SDK', async () => {
  const warm = fixture([streamReply(firstReason, [call, secondCall], 'using tool')]);
  const first = await warm.send('exec-tool', [question]);
  const toolTurn = stored('exec-tool', first);
  const history = [question, toolTurn, ...results([call, secondCall])];
  const cold = fixture([streamReply(nextReason), streamReply()]);
  expect(cold.bodies).toHaveLength(0);
  const second = await cold.send('exec-answer', history);
  const firstWire = cold.bodies[0]!;
  const restored = firstWire.messages.find((m) => m.role === 'assistant')!;
  expect(restored.reasoning_content === firstReason).toBe(true);
  expect(restored.tool_calls?.map((c) => c.id)).toEqual([call.id, secondCall.id]);
  expect(firstWire.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual([
    call.id,
    secondCall.id,
  ]);
  const answerTurn = stored('exec-answer', second);
  await cold.send('exec-next', [...history, answerTurn, { role: 'user', content: 'Next turn' }]);
  const assistants = cold.bodies[1]!.messages.filter((m) => m.role === 'assistant');
  expect(assistants.map((m) => m.content)).toEqual(['using tool', 'answer']);
  expect(assistants[0]?.reasoning_content === firstReason).toBe(true);
  expect(assistants[1]?.reasoning_content === nextReason).toBe(true);
  expect(warm.bodies).toHaveLength(1);
  expect(cold.bodies).toHaveLength(2);
  for (const [events, privateValue] of [
    [first, firstReason],
    [second, nextReason],
  ] as const) {
    expect(events.some((e) => e.type === 'reasoning_delta')).toBe(false);
    expect(JSON.stringify(events).includes(privateValue.trim().split(' ')[0]!)).toBe(false);
  }
  for (const body of [...warm.bodies, ...cold.bodies]) {
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('thinking');
    expect(
      body.messages
        .filter((m) => m.role !== 'assistant')
        .some((m) => m.reasoning_content !== undefined),
    ).toBe(false);
  }
});

test('non-tool source turns are retained privately; tools-free destinations omit reasoning and preserve the selected effort', async () => {
  for (const modelId of ['deepseek-flash', 'deepseek-v4-pro']) {
    const options = { modelId, baseURL: `${origin}/v1` };
    const first = fixture([streamReply(nextReason)], options, route, 'medium');
    const source = stored('original', await first.send('original', [question], []));
    const cold = fixture([streamReply(), streamReply()], options, route, 'medium');
    const history = [question, source, { role: 'user' as const, content: 'continue' }];
    await cold.send('without-tools', history, []);
    await cold.send('with-tools', history, tools);
    expect(cold.bodies[0]?.messages[1]).not.toHaveProperty('reasoning_content');
    expect(cold.bodies[1]?.messages[1]?.reasoning_content === nextReason).toBe(true);
    for (const body of [...first.bodies, ...cold.bodies]) {
      expect(body.reasoning_effort).toBe('medium');
      expect(body).not.toHaveProperty('thinking');
    }
  }
});
test('absent, empty, null and compatible reasoning aliases never supply a DeepSeek continuation', async () => {
  for (const reply of [
    streamReply(),
    streamReply(''),
    streamReply(null),
    streamReply(firstReason).replaceAll('"reasoning_content":', '"reasoning":'),
  ]) {
    const f = fixture([reply, streamReply()]);
    const source = stored('original', await f.send('original', [question]));
    expect(source.continuation).toBeUndefined();
    await f.send('continuation', [question, source, { role: 'user', content: 'continue' }]);
    expect(f.bodies[1]?.messages[1]).not.toHaveProperty('reasoning_content');
  }
});
async function captureToolTurn() {
  const f = fixture([streamReply(firstReason, [call, secondCall], 'same text')]);
  const source = stored('original', await f.send('original', [question]));
  expect(source.continuation !== undefined).toBe(true);
  return source;
}
test('private assistant material is bound to actual credential, connection, route and registered model', async () => {
  const source = await captureToolTurn();
  const history = [question, source, ...results([call, secondCall])];
  for (const [overrides, alias] of [
    [{ apiKey: 'another-fixture-key' }, route],
    [{ name: 'generic-compatible' }, route],
    [{ baseURL: 'https://gateway.example/v1' }, route],
    [{ modelId: 'deepseek-v4-pro' }, route],
    [{ modelId: `${model}-unverified` }, route],
    [{ headers: { 'x-custom-routing': 'other' } }, route],
    [{}, 'other-route'],
  ] as const) {
    const other = fixture([streamReply()], overrides, alias);
    await other.send('another', history);
    expect(other.bodies).toHaveLength(1);
    expect(other.bodies[0]!.messages.every((m) => m.reasoning_content === undefined)).toBe(true);
  }
});
test('reconstruction requires the original assistant, exact ordered calls, and its unambiguous tool results', async () => {
  const source = await captureToolTurn();
  const complete = results([call, secondCall]);
  const calls = source.toolCalls!;
  const following = { role: 'user' as const, content: 'continue' };
  const altered: ModelRequest['messages'][] = [
    [{ ...source, sourceIds: [] }, ...complete],
    [{ ...source, sourceIds: ['another-model-execution'] }, ...complete],
    [{ ...source, sourceIds: ['original', 'original'] }, ...complete],
    [{ ...source, content: 'changed' }, ...complete],
    [{ ...source, toolCalls: [{ ...call, name: 'other_tool' }, secondCall] }, ...complete],
    [{ ...source, toolCalls: [{ ...call, arguments: '{"other":true}' }, secondCall] }, ...complete],
    [{ ...source, toolCalls: [secondCall, call] }, ...complete],
    [{ ...source, toolCalls: [call] }, complete[0]!],
    [{ ...source, toolCalls: [call, call] }, complete[0]!, complete[0]!],
    [source, complete[0]!, following],
    [source, complete[0]!, complete[0]!, complete[1]!],
    [source, following, ...complete],
    [
      source,
      ...complete,
      { ...source, sourceIds: [...source.sourceIds!], toolCalls: [...calls] },
      ...complete,
    ],
  ];
  for (const rows of altered) {
    const cold = fixture([streamReply()]);
    try {
      await cold.send('altered', [question, ...rows, following]);
    } catch {
      // A generic invalid_tool_history error before the transport is also fail-closed.
      expect(cold.bodies).toHaveLength(0);
      continue;
    }
    expect(cold.bodies).toHaveLength(1);
    expect(cold.bodies[0]!.messages.every((m) => m.reasoning_content === undefined)).toBe(true);
  }
});

test('separately configured accounts holding the same key cannot exchange continuations', async () => {
  const accountId = '1'.repeat(64);
  const first = fixture([streamReply(firstReason, [call])], { accountId });
  const source = stored('owned-execution', await first.send('owned-execution', [question]));
  const history = [question, source, ...results([call])];
  for (const [id, same] of [
    [accountId, true],
    ['2'.repeat(64), false],
    [undefined, false],
  ] as const) {
    const cold = fixture([streamReply()], { accountId: id });
    expect(cold.bodies).toHaveLength(0);
    await cold.send('follow-up', history);
    const assistant = cold.bodies[0]!.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.reasoning_content === firstReason).toBe(same);
    if (!same) expect(assistant).not.toHaveProperty('reasoning_content');
  }
});

test('equal visible answers from different executions cannot exchange sealed continuations', async () => {
  const f = fixture([streamReply(firstReason), streamReply(nextReason)]);
  const a = stored('answer-a', await f.send('answer-a', [question]));
  const b = stored('answer-b', await f.send('answer-b', [question]));
  expect(a.content).toBe(b.content);
  expect(a.continuation !== undefined && b.continuation !== undefined).toBe(true);
  const cold = fixture([streamReply()]);
  await cold.send('next', [
    question,
    { ...a, continuation: b.continuation },
    question,
    { ...b, continuation: a.continuation },
    question,
  ]);
  expect(cold.bodies[0]!.messages.every((row) => row.reasoning_content === undefined)).toBe(true);
});
test('a look-alike endpoint, family or model does not create official DeepSeek state', async () => {
  for (const overrides of [
    { baseURL: 'https://gateway.example/v1' },
    { name: 'openai-compatible' },
    { modelId: 'deepseek-flash-preview' },
    { baseURL: `${origin}/arbitrary-path` },
    { apiKey: undefined },
  ]) {
    const f = fixture([streamReply(firstReason)], overrides);
    const events = await f.send('ignored', [question]);
    expect(stored('ignored', events).continuation).toBeUndefined();
  }
});

test('modified or incomplete ciphertext cannot supply assistant reasoning on the next request', async () => {
  const source = await captureToolTurn();
  const envelope = source.continuation;
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    typeof envelope.sealed !== 'string'
  )
    throw Error('expected_sealed_history');
  const damaged = (envelope.sealed[0] === 'A' ? 'B' : 'A') + envelope.sealed.slice(1);
  for (const continuation of [
    { ...envelope, sealed: damaged },
    { ...envelope, sealed: envelope.sealed.slice(0, 4) },
    { ...envelope, iv: 'invalid' },
  ]) {
    const cold = fixture([streamReply()]);
    await cold.send('restored', [
      question,
      { ...source, continuation },
      ...results([call, secondCall]),
    ]);
    expect(cold.bodies).toHaveLength(1);
    expect(cold.bodies[0]!.messages[1]).not.toHaveProperty('reasoning_content');
  }
});

test('oversized private material ends the one attempt without publishing a tool or partial continuation', async () => {
  for (const text of ['x'.repeat(4 * 1024 * 1024 + 1), '🦎'.repeat(1024 * 1024)]) {
    const f = fixture([streamReply(text, [call])]);
    const kinds: string[] = [];
    let failure: unknown;
    try {
      for await (const e of f.adapter.stream(
        { modelId: route, requestId: 'over-limit', messages: [question], tools },
        { signal: new AbortController().signal },
      ))
        kinds.push(e.type);
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error && failure.message === 'model_continuation_limit').toBe(true);
    expect(kinds.some((kind) => ['tool_call', 'finish', 'reasoning_delta'].includes(kind))).toBe(
      false,
    );
    expect(f.bodies).toHaveLength(1);
  }
});

test('dispatch removes sealed material for unknown or mismatched adapters and tools-free work', async () => {
  const sink = createFixedModel([]);
  const assistant: ModelMessage = {
    role: 'assistant',
    content: 'visible',
    continuation: {
      format: 'deepseek-chat-reasoning-v1',
      binding: 'synthetic binding',
      route,
    },
  };
  const request = { requestId: 'next', modelId: route, tools, messages: [assistant] };
  for (const [target, current] of [
    [sink, request],
    [{ ...sink, privateHistoryBinding: async () => 'other binding' }, request],
    [
      { ...sink, privateHistoryBinding: async () => 'synthetic binding' },
      { ...request, modelId: 'other' },
    ],
    [
      { ...sink, privateHistoryBinding: async () => 'synthetic binding' },
      { ...request, tools: [] },
    ],
  ] as const) {
    expect((await boundModelHistory(current, target)).messages[0]).toEqual({
      role: 'assistant',
      content: 'visible',
    });
  }
  expect(sink.requests).toHaveLength(0);
});
