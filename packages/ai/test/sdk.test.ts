import { expect, test } from 'bun:test';
import type { ModelEvent, ModelRequest } from '@kite-ai/ai';
import {
  createCompatibleModelBinding,
  createSdkModelAdapter,
  reasoningEfforts,
  type SdkModelPreset,
} from '@kite-ai/ai/sdk';

const request: ModelRequest = {
  requestId: 'request',
  modelId: 'bound',
  messages: [
    { role: 'system', content: 'Project instructions', sourceIds: ['project:source'] },
    { role: 'user', content: 'Initial request' },
    {
      role: 'assistant',
      content: 'Earlier call',
      toolCalls: [{ id: 'old-call', name: 'fixture.count', arguments: '{"value":"old"}' }],
    },
    { role: 'tool', content: 'Saved tool result', toolCallId: 'old-call' },
    { role: 'user', content: 'Next step' },
  ],
  tools: [
    {
      id: 'fixture.count',
      definitionVersion: '7',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  ],
};
function chunk(delta: unknown, finish: string | null = null, usage?: unknown) {
  return `data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
}
function endpoint(
  response: (incoming: Request) => Response | Promise<Response>,
  preset?: SdkModelPreset,
) {
  const bodies: unknown[] = [];
  let calls = 0;
  let transportSignal: AbortSignal | null | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(incoming) {
      calls++;
      bodies.push(await incoming.clone().json());
      return response(incoming);
    },
  });
  const model = createCompatibleModelBinding({
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    modelId: 'fake',
    apiKey: 'fixture-secret',
    fetch: Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        transportSignal = init?.signal;
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const adapter = createSdkModelAdapter({
    models: new Map([['bound', model]]),
    ...(preset ? { presets: new Map([['bound', preset]]) } : {}),
  });
  return {
    adapter,
    bodies,
    get calls() {
      return calls;
    },
    get transportSignal() {
      return transportSignal;
    },
    close: () => server.stop(true),
  };
}
const sse = (text: string) =>
  new Response(text, { headers: { 'content-type': 'text/event-stream' } });
async function collect(
  adapter: ReturnType<typeof createSdkModelAdapter>,
  signal = new AbortController().signal,
) {
  const events: ModelEvent[] = [];
  try {
    for await (const event of adapter.stream(request, { signal })) events.push(event);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

test('one actual network attempt maps message history, complete tools, reasoning, text and known usage', async () => {
  const data = endpoint((incoming) => {
    expect(incoming.headers.get('authorization')).toBe('Bearer fixture-secret');
    return sse(
      chunk({ role: 'assistant', reasoning_content: 'Reason' }) +
        chunk({ content: 'Visible' }) +
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'new-call',
              type: 'function',
              function: { name: 'fixture.count', arguments: '{"value":' },
            },
          ],
        }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"new"}' } }] }) +
        chunk({}, 'tool_calls', {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 3 },
        }) +
        'data: [DONE]\n\n',
    );
  });
  try {
    const result = await collect(data.adapter);
    expect(result.error).toBeNull();
    expect(data.calls).toBe(1);
    expect(result.events).toContainEqual({ type: 'reasoning_delta', text: 'Reason' });
    expect(result.events).toContainEqual({ type: 'text_delta', text: 'Visible' });
    expect(result.events).toContainEqual({
      type: 'tool_call',
      id: 'new-call',
      name: 'fixture.count',
      arguments: '{"value":"new"}',
    });
    expect(result.events.at(-1)).toMatchObject({
      type: 'finish',
      reason: 'tool_calls',
      usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 2, reasoningTokens: 3 },
    });
    expect(result.events.filter((event) => event.type === 'finish')).toHaveLength(1);
    expect(data.bodies[0]).toMatchObject({
      model: 'fake',
      stream: true,
      messages: [
        { role: 'system', content: 'Project instructions' },
        { role: 'user', content: 'Initial request' },
        {
          role: 'assistant',
          content: 'Earlier call',
          tool_calls: [
            {
              id: 'old-call',
              type: 'function',
              function: { name: 'fixture.count', arguments: '{"value":"old"}' },
            },
          ],
        },
        { role: 'tool', content: 'Saved tool result', tool_call_id: 'old-call' },
        { role: 'user', content: 'Next step' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'fixture.count', parameters: request.tools[0]!.inputSchema },
        },
      ],
    });
    expect(JSON.stringify(result.events)).not.toContain('fixture-secret');
    expect(JSON.stringify(data.bodies)).not.toContain('fixture-secret');
  } finally {
    await data.close();
  }
});

test('missing Provider token usage remains null rather than zero', async () => {
  const data = endpoint(() =>
    sse(`${chunk({ content: 'Done' })}${chunk({}, 'stop')}data: [DONE]\n\n`),
  );
  try {
    const result = await collect(data.adapter);
    expect(result.error).toBeNull();
    expect(result.events.at(-1)).toEqual({
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(data.calls).toBe(1);
  } finally {
    await data.close();
  }
});

test('partial usage does not turn absent input/cache/reasoning measurements into zero', async () => {
  const data = endpoint(() =>
    sse(`${chunk({}, 'stop', { completion_tokens: 7 })}data: [DONE]\n\n`),
  );
  try {
    const result = await collect(data.adapter);
    expect(result.error).toBeNull();
    expect(result.events.at(-1)).toEqual({
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: null, outputTokens: 7 },
    });
    expect(data.calls).toBe(1);
  } finally {
    await data.close();
  }
});

test.each([
  'partial-call',
  'no-finish',
  'filtered',
  'unknown',
  'http-error',
  'stream-error',
] as const)('single attempt fails closed without synthesized successful finish: %s', async (mode) => {
  const data = endpoint(() => {
    if (mode === 'http-error')
      return new Response(
        JSON.stringify({ error: { message: 'fixture-secret must stay private' } }),
        { status: 500 },
      );
    if (mode === 'stream-error') return sse('data: {"error":{"message":"fixture-secret"}}\n\n');
    if (mode === 'partial-call')
      return sse(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'partial',
              type: 'function',
              function: { name: 'fixture.count', arguments: '{"value":' },
            },
          ],
        }),
      );
    return sse(
      chunk({ content: 'partial' }) +
        (mode === 'no-finish'
          ? ''
          : chunk({}, mode === 'filtered' ? 'content_filter' : 'unexpected')),
    );
  });
  try {
    const result = await collect(data.adapter);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.events.filter((event) => event.type === 'finish')).toHaveLength(0);
    expect(result.events.filter((event) => event.type === 'tool_call')).toHaveLength(0);
    expect(String(result.error)).not.toContain('fixture-secret');
    expect(data.calls).toBe(1);
  } finally {
    await data.close();
  }
});

test('AbortSignal terminates the actual in-flight HTTP stream without retry or successful finish', async () => {
  let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const data = endpoint(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            responseController = controller;
            controller.enqueue(new TextEncoder().encode(chunk({ content: 'partial' })));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const controller = new AbortController();
  try {
    const events: ModelEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of data.adapter.stream(request, { signal: controller.signal })) {
        events.push(event);
        if (event.type === 'text_delta') controller.abort(new Error('fixture cancellation'));
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ message: 'fixture cancellation' });
    expect(events.filter((event) => event.type === 'finish')).toHaveLength(0);
    expect(data.calls).toBe(1);
    expect(data.transportSignal?.aborted).toBe(true);
  } finally {
    try {
      responseController?.close();
    } catch {}
    await data.close();
  }
});

test('an unbound model or pre-aborted request does not open a Provider attempt', async () => {
  const adapter = createSdkModelAdapter({ models: new Map() });
  expect((await collect(adapter)).error).toMatchObject({ message: 'model_not_bound' });
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  expect((await collect(adapter, controller.signal)).error).toMatchObject({
    message: 'already cancelled',
  });
});

test('frozen per-model preset supplies actual non-secret Provider options and rejects unsupported or invalid numeric values', async () => {
  const preset = { temperature: 0.25, topP: 0.7, maxOutputTokens: 13 };
  const data = endpoint(
    () => sse(`${chunk({ content: 'ok' })}${chunk({}, 'stop')}data: [DONE]\n\n`),
    preset,
  );
  try {
    preset.temperature = 1;
    const result = await collect(data.adapter);
    expect(result.error).toBeNull();
    expect(data.calls).toBe(1);
    expect(data.bodies[0]).toMatchObject({ temperature: 0.25, top_p: 0.7, max_tokens: 13 });
  } finally {
    data.close();
  }
  for (const invalid of [
    { temperature: -1 },
    { topP: 1.1 },
    { maxOutputTokens: 1.5 },
    { maxOutputTokens: 0 },
    { apiKey: 'fixture-secret' },
  ])
    expect(() =>
      createSdkModelAdapter({
        models: new Map(),
        presets: new Map([['bound', invalid as SdkModelPreset]]),
      }),
    ).toThrow('invalid_model_options');
});

test('compatible effort is frozen and transmitted once; unsupported bindings fail before Provider I/O', async () => {
  for (const effort of reasoningEfforts) {
    const preset: SdkModelPreset = { reasoningEffort: effort };
    const data = endpoint(
      () => sse(`${chunk({ content: 'ok' })}${chunk({}, 'stop')}data: [DONE]\n\n`),
      preset,
    );
    try {
      (preset as { reasoningEffort: string }).reasoningEffort = 'changed-after-binding';
      expect(data.adapter.describeRequest!(request).settings.reasoningEffort).toBe(effort);
      expect(data.calls).toBe(0);
      const result = await collect(data.adapter);
      expect(result.error).toBeNull();
      expect(data.calls).toBe(1);
      expect(data.bodies[0]).toMatchObject({ reasoning_effort: effort });
      expect(data.bodies[0]).not.toHaveProperty('reasoningEffort');
    } finally {
      data.close();
    }
  }
  expect(() =>
    createSdkModelAdapter({
      models: new Map([['bound', 'opaque/model']]),
      presets: new Map([['bound', { reasoningEffort: 'high' }]]),
    }),
  ).toThrow('model_reasoning_effort_unsupported');
  expect(() =>
    createSdkModelAdapter({
      models: new Map(),
      presets: new Map([
        ['bound', { reasoningEffort: 'unrecognized' } as unknown as SdkModelPreset],
      ]),
    }),
  ).toThrow('invalid_model_options');
});
