import { expect, test } from 'bun:test';
import type { Json, ModelEvent, ModelRequest } from '../src';
import { createCompatibleModelBinding, createSdkModelAdapter } from '../src/sdk';

const event = (type: string, value: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
const created = () =>
  event('response.created', { response: { id: 'resp_fixture', created_at: 1, model: 'gpt-5' } });
const completed = () =>
  event('response.completed', {
    response: {
      usage: {
        input_tokens: 17,
        output_tokens: 9,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 4 },
      },
    },
  });
function output(tool = false, toolName = 'count', toolArguments = '{"value":2}') {
  const reasoning = {
    type: 'reasoning',
    id: 'rs_fixture',
    encrypted_content: 'encrypted-complete',
  };
  const text = { type: 'message', id: 'msg_fixture' };
  const call = {
    type: 'function_call',
    id: 'fc_item',
    call_id: 'call_wire',
    name: toolName,
    arguments: toolArguments,
    status: 'completed',
  };
  return (
    created() +
    event('response.output_item.added', {
      output_index: 0,
      item: { ...reasoning, encrypted_content: 'encrypted-partial' },
    }) +
    event('response.reasoning_summary_text.delta', {
      item_id: reasoning.id,
      summary_index: 0,
      delta: 'Checking',
    }) +
    event('response.output_item.done', { output_index: 0, item: reasoning }) +
    (tool
      ? event('response.output_item.added', { output_index: 1, item: { ...call, arguments: '' } }) +
        event('response.function_call_arguments.delta', {
          output_index: 1,
          item_id: call.id,
          delta: toolArguments.slice(0, 9),
        }) +
        event('response.function_call_arguments.delta', {
          output_index: 1,
          item_id: call.id,
          delta: toolArguments.slice(9),
        }) +
        event('response.output_item.done', { output_index: 1, item: call })
      : event('response.output_item.added', { output_index: 1, item: text }) +
        event('response.output_text.delta', { item_id: text.id, delta: 'Done' }) +
        event('response.output_item.done', { output_index: 1, item: text })) +
    completed()
  );
}
const request: ModelRequest = {
  modelId: 'bound',
  requestId: 'request',
  messages: [
    { role: 'system', content: 'Instructions' },
    { role: 'user', content: 'Count' },
  ],
  tools: [
    {
      id: 'count',
      definitionVersion: '1',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  ],
};
function endpoint(respond: (n: number) => Response) {
  const bodies: Array<{ input: Array<Record<string, unknown>>; [key: string]: unknown }> = [];
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      paths.push(new URL(req.url).pathname);
      bodies.push(await req.json());
      expect(['Bearer fixture-only', 'Bearer fixture-other']).toContain(
        req.headers.get('authorization') ?? '',
      );
      return respond(bodies.length);
    },
  });
  const adapter = createSdkModelAdapter({
    models: new Map([
      [
        'bound',
        createCompatibleModelBinding({
          protocol: 'responses',
          name: 'openai',
          modelId: 'gpt-5',
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          apiKey: 'fixture-only',
        }),
      ],
    ]),
    presets: new Map([['bound', { reasoningEffort: 'high', maxOutputTokens: 99 }]]),
  });
  return {
    adapter,
    bodies,
    paths,
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    close: () => server.stop(true),
  };
}
const sse = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });
async function collect(
  adapter: ReturnType<typeof createSdkModelAdapter>,
  value = request,
  signal = new AbortController().signal,
) {
  const events: ModelEvent[] = [];
  for await (const part of adapter.stream(value, { signal })) events.push(part);
  return events;
}

for (const family of ['openai', 'compatible', 'codex'] as const) {
  test(`Responses ${family} keeps optional file parameters optional and round-trips a path-only call`, async () => {
    const input: ModelRequest = {
      ...request,
      tools: [
        {
          id: 'read_file',
          definitionVersion: '5',
          description: 'Read workspace text or a saved PDF attachment.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['path'],
            properties: {
              path: { type: 'string' },
              start_line: { type: 'integer', minimum: 1 },
              max_lines: { type: 'integer', minimum: 1, default: 200 },
              pages: { type: 'string', pattern: '^[1-9][0-9]*(-[1-9][0-9]*)?$' },
              mode: { enum: ['text', 'image'] },
            },
          },
        },
      ],
    };
    const original = structuredClone(input),
      argumentsText = '{"path":"read-fixture.txt"}',
      baseURL =
        family === 'codex'
          ? 'https://chatgpt.com/backend-api/codex'
          : 'https://responses-fixture.invalid/v1';
    const bodies: Array<{ input: Record<string, unknown>[]; tools: unknown[] }> = [],
      urls: string[] = [];
    const adapter = createSdkModelAdapter({
      models: new Map([
        [
          'bound',
          createCompatibleModelBinding({
            name: family,
            protocol: 'responses',
            modelId: 'fixture-model',
            baseURL,
            apiKey: 'fixture-token',
            ...(family === 'codex'
              ? {
                  headers: { 'chatgpt-account-id': 'fixture-account' },
                  continuationIdentity: {
                    kind: 'codex-local-auth' as const,
                    value: 'a'.repeat(64),
                  },
                }
              : {}),
            fetch: Object.assign(
              async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                urls.push(url instanceof Request ? url.url : String(url));
                bodies.push(JSON.parse(String(init?.body)));
                return sse(output(bodies.length === 1, 'read_file', argumentsText));
              },
              { preconnect: fetch.preconnect },
            ),
          }),
        ],
      ]),
    });
    const first = await collect(adapter, input);
    expect(first).toContainEqual({
      type: 'tool_call',
      id: 'call_wire',
      name: 'read_file',
      arguments: argumentsText,
    });
    const finish = first.at(-1)!;
    expect(finish).toMatchObject({ type: 'finish', reason: 'tool_calls' });
    if (finish.type !== 'finish') throw Error('finish missing');
    const second = await collect(adapter, {
      ...input,
      messages: [
        ...input.messages,
        {
          role: 'assistant',
          content: '',
          continuation: finish.continuation,
          toolCalls: [{ id: 'call_wire', name: 'read_file', arguments: argumentsText }],
        },
        { role: 'tool', toolCallId: 'call_wire', content: 'WORKSPACE_FILE_BYTES' },
      ],
    });
    expect(second).toContainEqual({ type: 'text_delta', text: 'Done' });
    expect(urls).toEqual([`${baseURL}/responses`, `${baseURL}/responses`]);
    for (const body of bodies)
      expect(body.tools).toEqual([
        {
          type: 'function',
          name: 'read_file',
          description: input.tools[0]!.description,
          parameters: input.tools[0]!.inputSchema,
          strict: false,
        },
      ]);
    expect(bodies[1]!.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_wire',
      name: 'read_file',
      arguments: argumentsText,
    });
    expect(bodies[1]!.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_wire',
      output: 'WORKSPACE_FILE_BYTES',
    });
    expect(input).toEqual(original);
    expect(adapter.describeRequest!(input).transformation).toEqual({
      id: 'kite.sdk.messages',
      version: '7',
    });
  });
}

test('Responses HTTP preserves streaming, tool call IDs, encrypted reasoning and stateless multi-turn history', async () => {
  const data = endpoint((n) => sse(output(n === 1)));
  try {
    const first = await collect(data.adapter);
    expect(first).toContainEqual({ type: 'reasoning_delta', text: 'Checking' });
    expect(first).toContainEqual({
      type: 'tool_call',
      id: 'call_wire',
      name: 'count',
      arguments: '{"value":2}',
    });
    const finish = first.at(-1)!;
    expect(finish).toMatchObject({
      type: 'finish',
      reason: 'tool_calls',
      usage: { inputTokens: 17, outputTokens: 9, cachedInputTokens: 3, reasoningTokens: 4 },
    });
    if (finish.type !== 'finish') throw new Error('finish missing');
    expect(JSON.stringify(finish.continuation)).toContain('encrypted-complete');
    expect(JSON.stringify(finish.continuation)).not.toContain('encrypted-partial');
    const next: ModelRequest = {
      ...request,
      requestId: 'second',
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_wire', name: 'count', arguments: '{"value":2}' }],
          continuation: finish.continuation,
        },
        { role: 'tool', toolCallId: 'call_wire', content: '2' },
      ],
    };
    const second = await collect(data.adapter, next);
    expect(second).toContainEqual({ type: 'text_delta', text: 'Done' });
    expect(second.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' });
    expect(data.paths).toEqual(['/v1/responses', '/v1/responses']);
    expect(data.bodies[0]).toMatchObject({
      model: 'gpt-5',
      stream: true,
      store: false,
      max_output_tokens: 99,
      reasoning: { effort: 'high' },
      include: ['reasoning.encrypted_content'],
      tools: [{ type: 'function', name: 'count' }],
    });
    expect(data.bodies[0]!.messages).toBeUndefined();
    expect(data.bodies[1]!.input).toContainEqual({
      type: 'reasoning',
      id: 'rs_fixture',
      encrypted_content: 'encrypted-complete',
      summary: [{ type: 'summary_text', text: 'Checking' }],
    });
    expect(data.bodies[1]!.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_wire',
      name: 'count',
      arguments: '{"value":2}',
    });
    expect(data.bodies[1]!.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_wire',
      output: '2',
    });
    expect(data.bodies[1]!.previous_response_id).toBeUndefined();
    const secondFinish = second.at(-1)!;
    if (secondFinish.type !== 'finish') throw new Error('finish missing');
    await collect(data.adapter, {
      ...next,
      messages: [
        ...next.messages,
        { role: 'assistant', content: 'Done', continuation: secondFinish.continuation },
        { role: 'user', content: 'Again' },
      ],
    });
    expect(data.bodies[2]!.input.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'input_text', text: 'Again' }],
    });
  } finally {
    data.close();
  }
});

test('Responses restored continuation re-encodes original call IDs when the wire-name collision set changes', async () => {
  const data = endpoint((n) => sse(output(n === 1, 'files_read')));
  const input: ModelRequest = {
    ...request,
    tools: [{ ...request.tools[0]!, id: 'files.read' }],
  };
  try {
    const first = await collect(data.adapter, input);
    expect(first).toContainEqual({
      type: 'tool_call',
      id: 'call_wire',
      name: 'files.read',
      arguments: '{"value":2}',
    });
    const finish = first.at(-1)!;
    if (finish.type !== 'finish') throw new Error('finish missing');
    const continuation = JSON.parse(JSON.stringify(finish.continuation)) as Json;
    const saved = JSON.stringify(continuation);
    const restored = createSdkModelAdapter({
      models: new Map([
        [
          'bound',
          createCompatibleModelBinding({
            protocol: 'responses',
            name: 'openai',
            modelId: 'gpt-5',
            baseURL: data.baseURL,
            apiKey: 'fixture-only',
          }),
        ],
      ]),
    });
    const next: ModelRequest = {
      ...input,
      tools: [...input.tools, { ...input.tools[0]!, id: 'files_read' }],
      messages: [
        ...input.messages,
        {
          role: 'assistant',
          content: '',
          continuation,
          toolCalls: [{ id: 'call_wire', name: 'files.read', arguments: '{"value":2}' }],
        },
        { role: 'tool', toolCallId: 'call_wire', content: '2' },
      ],
    };
    await collect(restored, next);
    expect(data.bodies[1]!.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'files_read' }),
        expect.objectContaining({ name: 'files_read_1' }),
      ]),
    );
    expect(data.bodies[1]!.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_wire',
      name: 'files_read_1',
      arguments: '{"value":2}',
    });
    expect(data.bodies[1]!.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_wire',
      output: '2',
    });
    expect(data.bodies[1]!.input).toContainEqual(
      expect.objectContaining({
        type: 'reasoning',
        id: 'rs_fixture',
        encrypted_content: 'encrypted-complete',
      }),
    );
    expect(JSON.stringify(continuation)).toBe(saved);
    // Existing v1 artifacts can predate wire-name encoding. They use the same exact call ID.
    const legacy = JSON.parse(saved) as { content: { type: string; toolName?: string }[] };
    for (const part of legacy.content) if (part.type === 'tool-call') part.toolName = 'files.read';
    await collect(restored, {
      ...next,
      messages: next.messages.map((message) =>
        message.role === 'assistant'
          ? { ...message, continuation: legacy as unknown as Json }
          : message,
      ),
    });
    expect(data.bodies[2]!.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_wire',
      name: 'files_read_1',
      arguments: '{"value":2}',
    });
    const before = data.bodies.length;
    await expect(
      collect(restored, {
        ...next,
        messages: next.messages.map((message) =>
          message.role === 'assistant' ? { ...message, toolCalls: [] } : message,
        ),
      }),
    ).rejects.toThrow('invalid_tool_history');
    expect(data.bodies).toHaveLength(before);
    expect(restored.describeRequest?.(next).transformation.version).toBe('7');
  } finally {
    data.close();
  }
});

test('Responses passes every configured effort, including ultar, to an alias without rewriting it', async () => {
  const data = endpoint(() => sse(output()));
  try {
    for (const effort of [
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultar',
    ] as const) {
      const adapter = createSdkModelAdapter({
        models: new Map([
          [
            'bound',
            createCompatibleModelBinding({
              protocol: 'responses',
              name: 'compatible',
              modelId: 'custom-model-alias',
              baseURL: data.baseURL,
              apiKey: 'fixture-only',
            }),
          ],
        ]),
        presets: new Map([['bound', { reasoningEffort: effort }]]),
      });
      await collect(adapter);
      expect(data.bodies.at(-1)).toMatchObject({
        model: 'custom-model-alias',
        reasoning: { effort },
        store: false,
        include: ['reasoning.encrypted_content'],
      });
      expect(adapter.describeRequest?.(request).settings.reasoningEffort).toBe(effort);
    }
    expect(data.bodies).toHaveLength(8);
    expect(data.paths.every((path) => path === '/v1/responses')).toBe(true);
  } finally {
    data.close();
  }
});

test('Responses errors and incomplete streams cannot dispatch tools or leak provider errors', async () => {
  for (const body of [
    created(),
    created() +
      event('response.failed', {
        sequence_number: 1,
        response: { error: { code: 'quota', message: 'secret endpoint fixture-only' } },
      }),
    created() + event('error', { sequence_number: 1, code: 'error', message: 'fixture-only' }),
  ]) {
    const data = endpoint(() => sse(body));
    try {
      const events: ModelEvent[] = [];
      let error: unknown;
      try {
        for await (const part of data.adapter.stream(request, {
          signal: new AbortController().signal,
        }))
          events.push(part);
      } catch (value) {
        error = value;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('fixture-only');
      expect(events.some((item) => item.type === 'finish' || item.type === 'tool_call')).toBe(
        false,
      );
      expect(data.bodies).toHaveLength(1);
    } finally {
      data.close();
    }
  }
});

test('Responses cancellation reaches live HTTP stream without successful finish', async () => {
  const abort = new AbortController();
  const data = endpoint(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                created() +
                  event('response.output_item.added', {
                    output_index: 0,
                    item: { type: 'message', id: 'msg' },
                  }) +
                  event('response.output_text.delta', { item_id: 'msg', delta: 'Partial' }),
              ),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  try {
    const events: ModelEvent[] = [];
    let error: unknown;
    try {
      for await (const part of data.adapter.stream(request, { signal: abort.signal })) {
        events.push(part);
        if (part.type === 'text_delta') abort.abort(new Error('cancel-test'));
      }
    } catch (value) {
      error = value;
    }
    expect(String(error)).toContain('cancel-test');
    expect(events.some((item) => item.type === 'finish')).toBe(false);
    expect(data.bodies).toHaveLength(1);
  } finally {
    data.close();
  }
});

test('Responses partial tool input is rejected even when provider sends completed', async () => {
  const data = endpoint(() =>
    sse(
      created() +
        event('response.output_item.added', {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_partial',
            call_id: 'call_partial',
            name: 'count',
            arguments: '',
          },
        }) +
        event('response.function_call_arguments.delta', {
          output_index: 0,
          item_id: 'fc_partial',
          delta: '{"value":',
        }) +
        completed(),
    ),
  );
  try {
    await expect(collect(data.adapter)).rejects.toThrow('stream_incomplete');
  } finally {
    data.close();
  }
});

test('Responses opaque state is isolated from other endpoints and model routes', async () => {
  const a = endpoint(() => sse(output(true)));
  const b = endpoint(() => sse(output()));
  try {
    const finish = (await collect(a.adapter)).at(-1)!;
    if (finish.type !== 'finish') throw new Error('finish missing');
    const history: ModelRequest = {
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: '',
          continuation: finish.continuation,
          toolCalls: [{ id: 'call_wire', name: 'count', arguments: '{"value":2}' }],
        },
        { role: 'tool', toolCallId: 'call_wire', content: '2' },
      ],
    };
    await collect(b.adapter, history);
    expect(b.bodies[0]!.input.some((item) => item.type === 'reasoning')).toBe(false);
    expect(b.bodies[0]!.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_wire',
      name: 'count',
      arguments: '{"value":2}',
    });
    const modified = structuredClone(history);
    (modified.messages.at(-2)!.continuation as Record<string, unknown>).modelId = 'other-route';
    await collect(a.adapter, modified);
    expect(a.bodies[1]!.input.some((item) => item.type === 'reasoning')).toBe(false);
    expect(JSON.stringify(finish.continuation)).not.toContain('fixture-only');
    expect(JSON.stringify(finish.continuation)).not.toContain('127.0.0.1');
  } finally {
    a.close();
    b.close();
  }
});

test('trusted Codex identity preserves opaque history across rotated bindings while ordinary credentials and source boundaries stay isolated', async () => {
  const bodies: Array<{ input: Record<string, unknown>[] }> = [];
  const base = {
    protocol: 'responses' as const,
    name: 'codex',
    baseURL: 'https://codex-fixture.invalid/responses-api',
    modelId: 'fixture-codex',
    apiKey: 'fixture-token-original',
    headers: { 'chatgpt-account-id': 'fixture-account' },
    continuationIdentity: { kind: 'codex-local-auth' as const, value: 'a'.repeat(64) },
    fetch: Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sse(output());
      },
      { preconnect: fetch.preconnect },
    ),
  };
  const adapter = (change: Partial<Parameters<typeof createCompatibleModelBinding>[0]> = {}) =>
    createSdkModelAdapter({
      models: new Map([['bound', createCompatibleModelBinding({ ...base, ...change })]]),
    });
  const initial = adapter();
  const finish = (await collect(initial)).at(-1)!;
  if (finish.type !== 'finish') throw Error('finish missing');
  const history: ModelRequest = {
    ...request,
    messages: [
      ...request.messages,
      { role: 'assistant', content: 'Done', continuation: finish.continuation },
    ],
  };
  await collect(adapter({ apiKey: 'fixture-token-rotated' }), history);
  expect(bodies.at(-1)!.input).toContainEqual(
    expect.objectContaining({
      type: 'reasoning',
      encrypted_content: 'encrypted-complete',
    }),
  );
  for (const change of [
    { baseURL: 'https://other-codex-fixture.invalid/responses-api' },
    { modelId: 'other-codex-model' },
    { continuationIdentity: { kind: 'codex-local-auth' as const, value: 'b'.repeat(64) } },
    { headers: { 'chatgpt-account-id': 'other-account' } },
    { continuationIdentity: undefined },
  ]) {
    await collect(adapter(change), history);
    expect(bodies.at(-1)!.input.some((item) => item.type === 'reasoning')).toBe(false);
  }
  for (const name of ['openai', 'codex']) {
    const original = adapter({ name, continuationIdentity: undefined });
    const event = (await collect(original)).at(-1)!;
    if (event.type !== 'finish') throw Error('finish missing');
    const ordinaryHistory: ModelRequest = {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: 'Done', continuation: event.continuation },
      ],
    };
    await collect(adapter({ name, continuationIdentity: undefined }), ordinaryHistory);
    expect(bodies.at(-1)!.input.some((item) => item.type === 'reasoning')).toBe(true);
    await collect(
      adapter({ name, continuationIdentity: undefined, apiKey: 'fixture-token-rotated' }),
      ordinaryHistory,
    );
    expect(bodies.at(-1)!.input.some((item) => item.type === 'reasoning')).toBe(false);
  }
  for (const privateValue of [
    base.continuationIdentity.value,
    base.apiKey,
    base.baseURL,
    'fixture-account',
  ]) {
    expect(JSON.stringify(initial.describeRequest!(request))).not.toContain(privateValue);
    expect(JSON.stringify(finish.continuation)).not.toContain(privateValue);
  }
});

test('Codex continuation identity rejects invalid values and injection into ordinary providers before transport', () => {
  let calls = 0;
  const base = {
    protocol: 'responses' as const,
    name: 'codex',
    baseURL: 'https://codex-fixture.invalid/responses-api',
    modelId: 'fixture-codex',
    continuationIdentity: { kind: 'codex-local-auth' as const, value: 'a'.repeat(64) },
    fetch: Object.assign(
      async () => {
        calls++;
        return sse(output());
      },
      { preconnect: fetch.preconnect },
    ),
  };
  for (const identity of [
    null,
    '',
    {},
    { kind: 'other', value: 'a'.repeat(64) },
    { kind: 'codex-local-auth', value: '' },
    { kind: 'codex-local-auth', value: 'g'.repeat(64) },
    { kind: 'codex-local-auth', value: 'a'.repeat(65) },
  ])
    expect(() =>
      createCompatibleModelBinding({
        ...base,
        continuationIdentity: identity as typeof base.continuationIdentity,
      }),
    ).toThrow('model_continuation_identity_unsupported');
  for (const change of [
    { name: 'openai' },
    { name: 'compatible' },
    { protocol: 'chat-completions' as const },
  ])
    expect(() => createCompatibleModelBinding({ ...base, ...change })).toThrow(
      'model_continuation_identity_unsupported',
    );
  expect(calls).toBe(0);
});

test('Responses preserves encrypted reasoning without a visible summary', async () => {
  const data = endpoint((n) =>
    sse(
      n === 1
        ? output(true).replace(
            event('response.reasoning_summary_text.delta', {
              item_id: 'rs_fixture',
              summary_index: 0,
              delta: 'Checking',
            }),
            '',
          )
        : output(),
    ),
  );
  try {
    const finish = (await collect(data.adapter)).at(-1)!;
    if (finish.type !== 'finish') throw new Error('finish missing');
    expect(JSON.stringify(finish.continuation)).toContain('encrypted-complete');
    await collect(data.adapter, {
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: '',
          continuation: finish.continuation,
          toolCalls: [{ id: 'call_wire', name: 'count', arguments: '{"value":2}' }],
        },
        { role: 'tool', toolCallId: 'call_wire', content: '2' },
      ],
    });
    expect(data.bodies[1]!.input).toContainEqual({
      type: 'reasoning',
      id: 'rs_fixture',
      encrypted_content: 'encrypted-complete',
      summary: [],
    });
  } finally {
    data.close();
  }
});

test('Responses changed credentials cannot replay opaque state to the same endpoint', async () => {
  const data = endpoint((n) => sse(output(n === 1)));
  try {
    const finish = (await collect(data.adapter)).at(-1)!;
    if (finish.type !== 'finish') throw new Error('finish missing');
    const other = createSdkModelAdapter({
      models: new Map([
        [
          'bound',
          createCompatibleModelBinding({
            protocol: 'responses',
            name: 'openai',
            modelId: 'gpt-5',
            baseURL: data.baseURL,
            apiKey: 'fixture-other',
          }),
        ],
      ]),
    });
    await collect(other, {
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: '',
          continuation: finish.continuation,
          toolCalls: [{ id: 'call_wire', name: 'count', arguments: '{"value":2}' }],
        },
        { role: 'tool', toolCallId: 'call_wire', content: '2' },
      ],
    });
    expect(data.bodies[1]!.input.some((item) => item.type === 'reasoning')).toBe(false);
  } finally {
    data.close();
  }
});

test('Responses SDK warnings never log encrypted continuation or history', async () => {
  const data = endpoint((n) => sse(output(n === 1)));
  const warnings: unknown[] = [];
  const previous = globalThis.AI_SDK_LOG_WARNINGS;
  globalThis.AI_SDK_LOG_WARNINGS = (value) => {
    warnings.push(value);
  };
  try {
    const finish = (await collect(data.adapter)).at(-1)!;
    if (finish.type !== 'finish') throw new Error('finish missing');
    const continuation = structuredClone(finish.continuation) as {
      content: Json[];
      [key: string]: Json;
    };
    continuation.content.push({
      type: 'reasoning',
      text: '',
      providerOptions: {
        openai: { itemId: 'rs_fixture', reasoningEncryptedContent: 'private-warning-fixture' },
      },
    });
    await collect(data.adapter, {
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: '',
          continuation,
          toolCalls: [{ id: 'call_wire', name: 'count', arguments: '{"value":2}' }],
        },
        { role: 'tool', toolCallId: 'call_wire', content: '2' },
      ],
    });
    expect(JSON.stringify(warnings)).toContain('Provider warning details omitted.');
    expect(JSON.stringify(warnings)).not.toContain('private-warning-fixture');
    expect(JSON.stringify(warnings)).not.toContain('encrypted-complete');
  } finally {
    globalThis.AI_SDK_LOG_WARNINGS = previous;
    data.close();
  }
});

test('Responses compatible anonymous endpoints receive no synthesized Authorization header', async () => {
  let authorization: string | null | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(incoming) {
      authorization = incoming.headers.get('authorization');
      await incoming.json();
      return sse(output());
    },
  });
  try {
    const adapter = createSdkModelAdapter({
      models: new Map([
        [
          'bound',
          createCompatibleModelBinding({
            protocol: 'responses',
            modelId: 'gpt-5',
            baseURL: `http://127.0.0.1:${server.port}/v1`,
          }),
        ],
      ]),
    });
    expect((await collect(adapter)).at(-1)).toMatchObject({ type: 'finish', reason: 'stop' });
    expect(authorization).toBeNull();
  } finally {
    server.stop(true);
  }
});
