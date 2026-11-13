import {
  ModelAccessError,
  ModelAttemptError,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import {
  createCompatibleModelBinding,
  createSdkModelAdapter,
  reasoningEfforts,
  type SdkModelPreset,
} from '@kite-ai/ai/sdk';
import { expect, test } from '#kite-test';
import { serve as serveFixture } from '../../../scripts/tooling/http';

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
async function endpoint(
  response: (incoming: Request) => Response | Promise<Response>,
  preset?: SdkModelPreset,
) {
  const bodies: unknown[] = [];
  let calls = 0;
  let transportSignal: AbortSignal | null | undefined;
  const server = await serveFixture({
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
  input = request,
) {
  const events: ModelEvent[] = [];
  try {
    for await (const event of adapter.stream(input, { signal })) events.push(event);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

test('one actual network attempt maps message history, complete tools, reasoning, text and known usage', async () => {
  const data = await endpoint((incoming) => {
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
              function: { name: 'fixture_count', arguments: '{"value":' },
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
              function: { name: 'fixture_count', arguments: '{"value":"old"}' },
            },
          ],
        },
        { role: 'tool', content: 'Saved tool result', tool_call_id: 'old-call' },
        { role: 'user', content: 'Next step' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'fixture_count', parameters: request.tools[0]!.inputSchema },
        },
      ],
    });
    expect(JSON.stringify(result.events)).not.toContain('fixture-secret');
    expect(JSON.stringify(data.bodies)).not.toContain('fixture-secret');
  } finally {
    await data.close();
  }
});

test('strict compatible endpoint round-trips namespaced, colliding, Unicode and long tool IDs with original history', async () => {
  const ids = ['files.read', 'files_read', 'kite_tool_0', '插件.读取', 'a'.repeat(65)];
  const input: ModelRequest = {
    ...request,
    messages: [
      { role: 'user', content: 'Read the file' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'previous', name: 'files.read', arguments: '{}' },
          { id: 'retired', name: 'history.retired', arguments: '{}' },
        ],
      },
      { role: 'tool', content: 'original result', toolCallId: 'previous' },
      { role: 'tool', content: 'historical result', toolCallId: 'retired' },
    ],
    tools: ids.map((id) => ({
      id,
      definitionVersion: '1',
      inputSchema: { type: 'object', additionalProperties: false },
    })),
  };
  const original = JSON.stringify(input);
  const data = await endpoint(async (incoming) => {
    const body = (await incoming.json()) as {
      tools: { function: { name: string } }[];
      messages: { tool_calls?: { function: { name: string } }[] }[];
    };
    const names = [
      ...body.tools.map((entry) => entry.function.name),
      ...body.messages.flatMap((message) =>
        (message.tool_calls ?? []).map((call) => call.function.name),
      ),
    ];
    if (names.some((name) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name)))
      return Response.json({ error: { message: 'invalid function name' } }, { status: 400 });
    return sse(
      chunk({
        tool_calls: body.tools.map((entry, index) => ({
          index,
          id: `call-${index}`,
          type: 'function',
          function: { name: entry.function.name, arguments: '{}' },
        })),
      }) +
        chunk({}, 'tool_calls') +
        'data: [DONE]\n\n',
    );
  });
  try {
    const result = await collect(data.adapter, new AbortController().signal, input);
    expect(result.error).toBeNull();
    expect(data.calls).toBe(1);
    expect(result.events.filter((event) => event.type === 'tool_call')).toEqual(
      ids.map((name, index) => ({ type: 'tool_call', id: `call-${index}`, name, arguments: '{}' })),
    );
    const body = data.bodies[0] as {
      tools: { function: { name: string } }[];
      messages: { tool_calls?: { function: { name: string } }[] }[];
    };
    const names = body.tools.map((entry) => entry.function.name);
    expect(new Set(names).size).toBe(ids.length);
    expect(names[1]).toBe('files_read');
    expect(names[2]).toBe('kite_tool_0');
    expect(body.messages[1]!.tool_calls![0]!.function.name).toBe(names[0]!);
    expect(names).not.toContain(body.messages[1]!.tool_calls![1]!.function.name);
    expect(JSON.stringify(input)).toBe(original);
  } finally {
    await data.close();
  }
});

test('separate usage-only chunk preserves reported totals, original nested details and legacy cache aliases', async () => {
  const usage = {
    prompt_tokens: 123,
    completion_tokens: 45,
    total_tokens: 170,
    prompt_cache_hit_tokens: 50,
    prompt_cache_miss_tokens: 73,
    prompt_tokens_details: { cache_write_tokens: 12, image_tokens: 8 },
    completion_tokens_details: { reasoning_tokens: 9, text_tokens: 36 },
  };
  const data = await endpoint(() =>
    sse(
      chunk({ content: 'Done' }) +
        chunk({}, 'stop') +
        `data: ${JSON.stringify({ choices: [], usage, private_response_field: 'not usage' })}\n\n` +
        'data: [DONE]\n\n',
    ),
  );
  try {
    const result = await collect(data.adapter);
    expect(result.error).toBeNull();
    expect(result.events.at(-1)).toEqual({
      type: 'finish',
      reason: 'stop',
      usage: {
        inputTokens: 123,
        outputTokens: 45,
        totalTokens: 170,
        cachedInputTokens: 50,
        reasoningTokens: 9,
        raw: usage,
      },
    });
    expect(result.events.filter((event) => event.type === 'usage')).toHaveLength(1);
    expect(data.bodies[0]).toMatchObject({ stream_options: { include_usage: true } });
    expect(JSON.stringify(result.events)).not.toContain('private_response_field');
    expect(JSON.stringify(result.events)).not.toContain('fixture-secret');
    expect(data.calls).toBe(1);
  } finally {
    await data.close();
  }
});

test('repeated Provider usage is replaced by the final snapshot rather than added', async () => {
  const first = { prompt_tokens: 31, completion_tokens: 2, total_tokens: 33 };
  const last = { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 };
  const data = await endpoint(() =>
    sse(`${chunk({ content: 'Partial' }, null, first)}${chunk({}, 'stop', last)}data: [DONE]\n\n`),
  );
  try {
    const result = await collect(data.adapter);
    expect(result.error).toBeNull();
    expect(result.events.filter((event) => event.type === 'usage')).toHaveLength(2);
    expect(result.events.at(-1)).toMatchObject({
      type: 'finish',
      usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38, raw: last },
    });
    expect(data.calls).toBe(1);
  } finally {
    await data.close();
  }
});

test('received usage survives a failed or cancelled stream without successful finish or tool dispatch', async () => {
  for (const cancelled of [false, true]) {
    const usage = { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 };
    const data = await endpoint(() =>
      sse(
        chunk({ content: 'Partial' }, null, usage) +
          'data: {"error":{"message":"fixture-secret"}}\n\n',
      ),
    );
    const abort = new AbortController();
    const events: ModelEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of data.adapter.stream(request, { signal: abort.signal })) {
        events.push(event);
        if (cancelled && event.type === 'usage') abort.abort();
      }
    } catch (error) {
      failure = error;
    } finally {
      await data.close();
    }
    expect(failure).toBeInstanceOf(Error);
    expect(events).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38, raw: usage },
    });
    expect(events.some((event) => event.type === 'finish' || event.type === 'tool_call')).toBe(
      false,
    );
    expect(JSON.stringify(failure)).not.toContain('fixture-secret');
    expect(data.calls).toBe(1);
  }
});

test('missing Provider token usage remains null rather than zero', async () => {
  const data = await endpoint(() =>
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
  const data = await endpoint(() =>
    sse(`${chunk({}, 'stop', { completion_tokens: 7 })}data: [DONE]\n\n`),
  );
  try {
    const result = await collect(data.adapter);
    expect(result.error).toBeNull();
    expect(result.events.at(-1)).toEqual({
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: null, outputTokens: 7, raw: { completion_tokens: 7 } },
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
  const data = await endpoint(() => {
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
              function: { name: 'fixture_count', arguments: '{"value":' },
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
    expect(ModelAttemptError.isInstance(result.error)).toBe(true);
    expect(String(result.error)).not.toContain('fixture-secret');
    expect(JSON.stringify(result.error)).not.toContain('fixture-secret');
    expect(data.calls).toBe(1);
  } finally {
    await data.close();
  }
});

test.each([
  ['ECONNREFUSED', 'connection_refused'],
  ['ETIMEDOUT', 'connection_timeout'],
  ['ENOTFOUND', 'name_resolution_failed'],
  ['ECONNRESET', 'connection_interrupted'],
  ['UND_ERR_HEADERS_TIMEOUT', 'request_timeout'],
  ['ENETDOWN', 'connection_interrupted'],
  ['ENETUNREACH', 'connection_interrupted'],
  ['EHOSTDOWN', 'connection_interrupted'],
  ['EHOSTUNREACH', 'connection_interrupted'],
  ['ConnectionClosed', 'connection_interrupted'],
  ['ConnectionRefused', 'connection_refused'],
] as const)('known transport code %s becomes finite safe detail without retaining the error', async (code, detail) => {
  let attempts = 0;
  const model = createCompatibleModelBinding({
    baseURL: 'http://127.0.0.1:1/v1',
    modelId: 'fixture',
    apiKey: 'fixture-secret',
    fetch: Object.assign(async () => {
      attempts++;
      throw new TypeError('private endpoint and fixture-secret', {
        cause: Object.assign(new Error('private log'), { code }),
      });
    }),
  });
  const adapter = createSdkModelAdapter({ models: new Map([['bound', model]]) });
  const result = await collect(adapter);
  expect(attempts).toBe(1);
  expect(result.error).toMatchObject({ reason: 'connection_failed', detail });
  expect(JSON.stringify(result.error)).not.toMatch(/fixture-secret|private|127\.0\.0\.1/);
  expect(ModelAttemptError.isInstance(result.error)).toBe(true);
});

for (const protocol of ['chat-completions', 'responses'] as const) {
  test.each([
    'fetch-error',
    'stream-error',
    'non-error-rejection',
  ] as const)(`${protocol} reconnects unclassified Provider failures without exposing private data: %s`, async (mode) => {
    let attempts = 0;
    const failure =
      mode === 'non-error-rejection'
        ? { private: 'fixture-secret' }
        : new Error('permission denied in private fixture-secret log');
    const model = createCompatibleModelBinding({
      baseURL: 'http://127.0.0.1:1/v1',
      modelId: 'fixture',
      protocol,
      fetch: Object.assign(async () => {
        attempts++;
        if (mode !== 'stream-error') throw failure;
        return new Response(
          new ReadableStream({ start: (controller) => controller.error(failure) }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }),
    });
    const result = await collect(createSdkModelAdapter({ models: new Map([['bound', model]]) }));
    expect(attempts).toBe(1);
    expect(ModelAttemptError.isInstance(result.error)).toBe(true);
    expect(result.events.some((event) => ['tool_call', 'finish'].includes(event.type))).toBe(false);
    expect(String(result.error)).not.toMatch(/private|fixture-secret|127\.0\.0\.1/);
    expect(JSON.stringify(result.error)).not.toMatch(/private|fixture-secret|127\.0\.0\.1/);
    expect((result.error as Error).cause).toBeUndefined();
  });

  test.each([
    400, 401, 403, 404, 408, 409, 422, 429, 500, 503,
  ])(`${protocol} only authentication and permission HTTP refusals stop reconnection: %i`, async (status) => {
    let attempts = 0;
    const model = createCompatibleModelBinding({
      baseURL: 'http://127.0.0.1:1/v1',
      modelId: 'fixture',
      protocol,
      fetch: Object.assign(async () => {
        attempts++;
        const headers = { 'www-authenticate': 'Bearer realm="fixture-secret"' };
        return status === 401
          ? new Response('fixture-secret', { status, headers })
          : Response.json({ error: { message: 'fixture-secret' } }, { status, headers });
      }),
    });
    const result = await collect(createSdkModelAdapter({ models: new Map([['bound', model]]) }));
    expect(attempts).toBe(1);
    expect(ModelAttemptError.isInstance(result.error)).toBe(![401, 403].includes(status));
    expect(result.events.some((event) => ['tool_call', 'finish'].includes(event.type))).toBe(false);
    expect(String(result.error)).not.toContain('fixture-secret');
    expect(JSON.stringify(result.error)).not.toContain('fixture-secret');
    if (status === 401 || status === 403) {
      expect(ModelAccessError.isInstance(result.error)).toBe(true);
      expect((result.error as ModelAccessError).code).toBe(
        status === 401 ? 'model_authentication_required' : 'model_access_denied',
      );
      expect((result.error as ModelAccessError).cause).toBeUndefined();
    }
    if (![401, 403, 408, 429].includes(status) && status < 500)
      expect(result.error).toMatchObject({ reason: 'provider_unavailable', detail: undefined });
  });
}

test('local history validation remains outside the reconnect boundary', async () => {
  const data = await endpoint(() => {
    throw Error('must_not_send_invalid_history');
  });
  try {
    const result = await collect(data.adapter, undefined, {
      ...request,
      messages: [{ role: 'tool', content: 'Unpaired result', toolCallId: 'missing' }],
    });
    expect(data.calls).toBe(0);
    expect(ModelAttemptError.isInstance(result.error)).toBe(false);
    expect((result.error as Error).message).toBe('invalid_tool_history');
  } finally {
    await data.close();
  }
});

test('unrecognized error detail cannot cross the safe model attempt boundary', () => {
  expect(() => new ModelAttemptError('connection_failed', 'raw private log' as never)).toThrow(
    'invalid_model_failure_detail',
  );
});

test('AbortSignal terminates the actual in-flight HTTP stream without retry or successful finish', async () => {
  let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const data = await endpoint(
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
  const data = await endpoint(
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
    await data.close();
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
    const data = await endpoint(
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
      await data.close();
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

test.each([
  408, 429, 500, 502, 503, 504,
])('HTTP %i is explicitly classified without hidden retry or leaking Provider details', async (status) => {
  const data = await endpoint(
    () => new Response(JSON.stringify({ error: { message: 'fixture-secret' } }), { status }),
  );
  try {
    const result = await collect(data.adapter);
    expect(String(result.error)).toContain('MODEL_ATTEMPT_RETRYABLE_FAILURE:provider_unavailable');
    expect(String(result.error)).not.toContain('fixture-secret');
    expect(result.error).toMatchObject({
      detail:
        status === 429
          ? 'rate_limited'
          : status === 408
            ? 'request_timeout'
            : 'service_unavailable',
    });
    expect(JSON.stringify(result.error)).not.toContain('fixture-secret');
    expect(data.calls).toBe(1);
  } finally {
    await data.close();
  }
});

test('a finished malformed Tool argument reaches Core unchanged for rejection; an unfinished call is withheld', async () => {
  const raw = '{"value":';
  const data = await endpoint(() =>
    sse(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'malformed',
            type: 'function',
            function: { name: 'fixture_count', arguments: raw },
          },
        ],
      }) +
        chunk({}, 'tool_calls') +
        'data: [DONE]\n\n',
    ),
  );
  try {
    const result = await collect(data.adapter);
    expect(result.error).toBeNull();
    expect(result.events.filter((event) => event.type === 'tool_call')).toEqual([
      { type: 'tool_call', id: 'malformed', name: 'fixture.count', arguments: raw },
    ]);
    expect(data.calls).toBe(1);
  } finally {
    await data.close();
  }
});

test('actual HTTP stream closure preserves partial text, withholds calls, and classifies native connection code once', async () => {
  const data = await endpoint(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(chunk({ content: 'Actual partial' })));
            setTimeout(() => controller.error(new Error('fixture connection closure')), 20);
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  try {
    const result = await collect(data.adapter);
    expect(result.events).toContainEqual({ type: 'text_delta', text: 'Actual partial' });
    expect(String(result.error)).toContain('MODEL_ATTEMPT_RETRYABLE_FAILURE:connection_failed');
    expect(
      result.events.filter((event) => event.type === 'tool_call' || event.type === 'finish'),
    ).toHaveLength(0);
    expect(data.calls).toBe(1);
  } finally {
    await data.close();
  }
});
