import { expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelAttemptError, type ModelEvent, type ModelRequest } from '../src';
import { reasoningEfforts } from '../src/request-snapshot';
import {
  createCompatibleModelBinding,
  createSdkModelAdapter,
  runOpenAIWebSearch,
} from '../src/sdk';

type Row = Record<string, unknown>;
type Body = { input: Row[]; tools: Row[]; include: string[]; [key: string]: unknown };
const frame = (type: string, value: Row) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
const created = frame('response.created', {
  response: { id: 'response1', model: 'gpt-6.2-astra', created_at: 1 },
});
const done = frame('response.completed', {
  response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 5 } },
});
const call = {
  type: 'web_search_call',
  id: 'ws_1',
  status: 'completed',
  action: {
    type: 'search',
    query: 'query',
    sources: [{ type: 'url', url: 'https://example.org/retrieved' }],
  },
};
const item = (stage: string, pos: number, i: Row) =>
  frame(`response.output_item.${stage}`, { output_index: pos, item: i });
const searching = item('added', 0, { type: 'web_search_call', id: 'ws_1', status: 'in_progress' });
const search = searching + item('done', 0, call);
const annotation = {
  type: 'url_citation',
  title: '引用',
  url: 'https://example.org/cited',
  start_index: 1,
  end_index: 4,
};
function message(pos: number, text: string, annotations: Row[] = []) {
  const id = `msg_${pos}`;
  return (
    item('added', pos, { type: 'message', id }) +
    frame('response.output_text.delta', {
      item_id: id,
      content_index: 0,
      output_index: pos,
      delta: text,
    }) +
    annotations
      .map((a, annotation_index) =>
        frame('response.output_text.annotation.added', {
          item_id: id,
          content_index: 0,
          annotation_index,
          output_index: pos,
          annotation: a,
        }),
      )
      .join('') +
    item('done', pos, {
      type: 'message',
      id,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations }],
    })
  );
}
function local(pos: number, name: string) {
  const c = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'local_1',
    name,
    arguments: '{}',
    status: 'completed',
  };
  return (
    item('added', pos, { ...c, arguments: '' }) +
    frame('response.function_call_arguments.delta', {
      output_index: pos,
      item_id: c.id,
      delta: '{}',
    }) +
    item('done', pos, c)
  );
}
const req: ModelRequest = {
  modelId: 'bound',
  requestId: 'r',
  nativeWebSearch: { dialect: 'openai-web-search' },
  messages: [{ role: 'user', content: 'query' }],
  tools: [],
};
const signal = () => new AbortController().signal;
const baseURL = 'https://api.openai.com/v1';
const options = {
  baseURL,
  modelId: 'gpt-6.2-astra',
  apiKey: 'fixture-token',
  name: 'openai',
  protocol: 'responses' as const,
};
const fakeFetch = (fn: typeof fetch) => Object.assign(fn, { preconnect: fetch.preconnect });
async function fixture(
  respond: (body: Body, request: number) => Response,
  apiKey = options.apiKey,
) {
  const bodies: Body[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      expect(req.headers.get('authorization')).toBe(`Bearer ${apiKey}`);
      const body = (await req.json()) as Body;
      bodies.push(body);
      return respond(body, bodies.length);
    },
  });
  const transport = fakeFetch(
    Object.assign(
      (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(url)).toBe(`${baseURL}/responses`);
        const body = JSON.parse(String(init?.body)) as Body;
        if (body.tools?.some((entry) => entry.type === 'web_search'))
          expect(init?.redirect).toBe('error');
        return fetch(server.url, init);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const adapter = () =>
    createSdkModelAdapter({
      models: new Map([
        ['bound', createCompatibleModelBinding({ ...options, apiKey, fetch: transport })],
      ]),
    });
  return { bodies, transport, adapter, close: () => server.stop(true) };
}
const sse = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });
async function collect(adapter: ReturnType<typeof createSdkModelAdapter>, request = req) {
  const out: ModelEvent[] = [];
  for await (const p of adapter.stream(request, { signal: signal() })) out.push(p);
  return out;
}
test('native declaration is opt-in and exact to endpoint, family, authentication, model and protocol', async () => {
  for (const [overrides, status] of [
    [{}, 'supported'],
    [{ baseURL: 'https://unverified.example/v1' }, 'unknown'],
    [{ name: 'codex' }, 'unknown'],
    [{ name: 'compatible' }, 'unknown'],
    [{ apiKey: '' }, 'unknown'],
    [{ headers: { authorization: 'Bearer fixture' } }, 'unknown'],
    [{ modelId: 'gpt-6.2-astra-new' }, 'unknown'],
    [{ modelId: 'gpt-6-luna' }, 'supported'],
    [{ modelId: 'gpt-6-luna-preview' }, 'unknown'],
    [{ modelId: 'gpt-6-luna', baseURL: 'https://unverified.example/v1' }, 'unknown'],
    [
      {
        modelId: 'gpt-6-luna',
        name: 'codex',
        continuationIdentity: { kind: 'codex-local-auth', value: 'a'.repeat(64) },
      },
      'unknown',
    ],
    [{ protocol: 'chat-completions' }, 'unsupported'],
  ] as const) {
    let n = 0;
    const adapter = createSdkModelAdapter({
      models: new Map([
        [
          'bound',
          createCompatibleModelBinding({
            ...options,
            ...overrides,
            fetch: fakeFetch(
              Object.assign(
                async () => {
                  n++;
                  return sse(created + message(0, 'no search') + done);
                },
                { preconnect: fetch.preconnect },
              ),
            ),
          }),
        ],
      ]),
    });
    expect(adapter.nativeWebSearchCapability?.('bound')).toBe(status);
    if (status !== 'supported') {
      await expect(collect(adapter)).rejects.toThrow('native_web_search_unavailable');
      expect(n).toBe(0);
    }
  }
});
test('explicit Luna reasoning efforts cannot dispatch native search', async () => {
  const f = await fixture(() => {
    throw new Error('unexpected native search request');
  });
  try {
    const model = createCompatibleModelBinding({
      ...options,
      modelId: 'gpt-6-luna',
      fetch: f.transport,
    });
    for (const reasoningEffort of reasoningEfforts) {
      const adapter = createSdkModelAdapter({
        models: new Map([['bound', model]]),
        presets: new Map([['bound', { reasoningEffort }]]),
      });
      expect(adapter.nativeWebSearchCapability?.('bound')).toBe('unknown');
      await expect(collect(adapter)).rejects.toThrow('native_web_search_unavailable');
    }
    expect(f.bodies).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('real SDK: native search, multiple text blocks and local name collision round-trip once after cold restore', async () => {
  const f = await fixture((body, n) => {
    if (n !== 1) return sse(created + message(0, 'done') + done);
    const alias = body.tools.find((t) => t.type === 'function')!.name as string;
    expect(alias).not.toBe('web_search');
    return sse(
      created +
        search +
        message(1, '前文') +
        message(2, '🌱中文章', [annotation, annotation]) +
        local(3, alias) +
        done,
    );
  });
  try {
    const r = {
      ...req,
      tools: [{ id: 'web_search', definitionVersion: '1', inputSchema: { type: 'object' } }],
    };
    const events = await collect(f.adapter(), r);
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', arguments: '{}', id: 'local_1', name: 'web_search' },
    ]);
    const observations = events.flatMap((e) => (e.type === 'web_search' ? [e.observation] : []));
    expect(observations.map((o) => o.kind)).toEqual(['activity', 'activity', 'source', 'citation']);
    expect(observations[2]).toEqual({ kind: 'source', url: 'https://example.org/retrieved' });
    expect(observations[3]).toEqual({
      kind: 'citation',
      url: annotation.url,
      title: annotation.title,
      text: '🌱中文章',
      blockIndex: 1,
      blockStartUtf16: 2,
      startUtf16: 2,
      endUtf16: 5,
    });
    const finish = events.at(-1)!;
    if (finish.type !== 'finish') throw Error('missing finish');
    expect(finish.reason).toBe('tool_calls');
    const next = {
      ...r,
      messages: [
        ...r.messages,
        {
          role: 'assistant' as const,
          content: '前文🌱中文章',
          continuation: JSON.parse(JSON.stringify(finish.continuation)),
          toolCalls: [{ id: 'local_1', name: 'web_search', arguments: '{}' }],
        },
        { role: 'tool' as const, toolCallId: 'local_1', content: 'local result' },
      ],
    };
    await collect(f.adapter(), next);
    expect(f.bodies[0]!.tools.filter((t) => t.type === 'web_search')).toHaveLength(1);
    expect(f.bodies[0]!.include).toContain('web_search_call.action.sources');
    expect(f.bodies[1]!.store).toBe(false);
    expect(f.bodies[1]!.input.filter((e) => e.type === 'web_search_call')).toEqual([call]);
    expect(
      f.bodies[1]!.input.filter((e) => e.type === 'function_call_output').map((r) => r.call_id),
    ).toEqual(['local_1']);
    expect(f.bodies[1]!.input.findIndex((e) => e.type === 'web_search_call')).toBeLessThan(
      f.bodies[1]!.input.findIndex((e) => e.type === 'function_call'),
    );
    // Switching dialect/turn permission always projects ordinary history instead.
    const plain = createSdkModelAdapter({
      models: new Map([
        [
          'bound',
          createCompatibleModelBinding({
            ...options,
            fetch: fakeFetch(
              Object.assign(
                async (_url: unknown, init?: RequestInit) => {
                  const body = JSON.parse(String(init?.body)) as Body;
                  expect(body.tools.some((t) => t.type === 'web_search')).toBe(false);
                  expect(body.input.some((t) => t.type === 'web_search_call')).toBe(false);
                  expect(
                    body.input.some((t) => t.type === 'function_call' && t.name === 'web_search'),
                  ).toBe(true);
                  return sse(created + message(0, 'ok') + done);
                },
                { preconnect: fetch.preconnect },
              ),
            ),
          }),
        ],
      ]),
    });
    await collect(plain, { ...next, nativeWebSearch: undefined });
  } finally {
    f.close();
  }
});
test('forced backend sends only one query, confirms search, and does not invent citations or apply its ranges to primary text', async () => {
  for (const scenario of ['ok', 'no_event', 'failed', 'incomplete', 'http'] as const) {
    const f = await fixture(() =>
      scenario === 'http'
        ? new Response('private fixture', { status: 403 })
        : sse(
            created +
              (scenario === 'ok'
                ? search
                : scenario === 'no_event'
                  ? ''
                  : searching + item('done', 0, { ...call, status: scenario })) +
              message(1, '🌱中文章', [annotation]) +
              done,
          ),
    );
    try {
      const p = runOpenAIWebSearch({
        ...options,
        query: 'query',
        signal: signal(),
        fetch: f.transport,
      });
      if (scenario === 'ok') {
        const result = await p;
        expect(result.searchPerformed).toBe(true);
        expect(result.citations).toEqual([{ url: annotation.url, title: annotation.title }]);
        expect(result.sources).toEqual([{ url: 'https://example.org/retrieved' }]);
      } else if (scenario === 'http')
        await expect(p).rejects.toMatchObject({
          message: 'search_http_error',
          statusCode: 403,
          retrySafety: 'unknown',
        });
      else
        await expect(p).rejects.toThrow(
          scenario === 'no_event' ? 'search_not_performed' : `search_${scenario}`,
        );
      expect(f.bodies).toHaveLength(1);
      const body = f.bodies[0]!;
      expect(body.tools).toEqual([{ type: 'web_search' }]);
      expect(body.tool_choice).toEqual({ type: 'web_search' });
      expect(body.max_tool_calls).toBe(4);
      expect(body.max_output_tokens).toBe(2000);
      expect(body.input).toHaveLength(2);
    } finally {
      f.close();
    }
  }
});
test('loopback receives exactly one POST when disconnected before first SSE or after search starts', async () => {
  for (const afterFirst of [false, true]) {
    const methods: (string | undefined)[] = [];
    const server: Server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        methods.push(req.method);
        if (!afterFirst) {
          res.socket?.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(created + searching);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const transport = fakeFetch(
        Object.assign((_url: unknown, init?: RequestInit) => fetch(target, init), {
          preconnect: fetch.preconnect,
        }),
      );
      const adapter = createSdkModelAdapter({
        models: new Map([
          ['bound', createCompatibleModelBinding({ ...options, fetch: transport })],
        ]),
      });
      const searchEvents: ModelEvent[] = [];
      let error: unknown;
      try {
        for await (const event of adapter.stream(req, { signal: AbortSignal.timeout(4_000) })) {
          if (event.type === 'web_search' && event.observation.kind === 'activity') {
            searchEvents.push(event);
            server.closeAllConnections();
          }
        }
      } catch (cause) {
        error = cause;
      }
      expect(searchEvents).toEqual(
        afterFirst
          ? [
              {
                type: 'web_search',
                observation: { kind: 'activity', callId: 'ws_1', status: 'searching' },
              },
            ]
          : [],
      );
      expect(ModelAttemptError.isInstance(error)).toBe(true);
      expect(error).toMatchObject({ retrySafety: afterFirst ? 'unsafe' : 'unknown' });
      expect(methods).toEqual(['POST']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test('ambiguous emoji offsets keep the verified URL only; changing assistant projection removes native history', async () => {
  const ambiguous = { ...annotation, start_index: 2 };
  const f = await fixture((_body, n) =>
    sse(
      created + (n === 1 ? search + message(1, '🌱中文章', [ambiguous]) : message(0, 'ok')) + done,
    ),
  );
  try {
    const events = await collect(f.adapter());
    expect(
      events.flatMap((e) =>
        e.type === 'web_search' && e.observation.kind === 'citation' ? [e.observation] : [],
      ),
    ).toEqual([{ kind: 'citation', url: annotation.url, title: annotation.title }]);
    const finish = events.at(-1);
    if (finish?.type !== 'finish') throw Error('missing finish');
    await collect(f.adapter(), {
      ...req,
      messages: [
        ...req.messages,
        { role: 'assistant', content: 'compressed content', continuation: finish.continuation },
        { role: 'user', content: 'next' },
      ],
    });
    const next = f.bodies[1]!;
    expect(next.input.some((r) => r.type === 'web_search_call')).toBe(false);
    expect(JSON.stringify(next.input)).toContain('compressed content');
  } finally {
    f.close();
  }
});

test('bounded standalone reader aborts an oversized SSE line before parsing; no second POST', async () => {
  const f = await fixture(() => sse(`data: ${'x'.repeat(2 * 1024 * 1024 + 1)}`));
  try {
    const error = await runOpenAIWebSearch({
      ...options,
      query: 'test',
      signal: signal(),
      fetch: f.transport,
    }).then(
      () => null,
      (e) => e,
    );
    expect(ModelAttemptError.isInstance(error)).toBe(true);
    expect(error.retrySafety).toBe('unknown');
    expect(f.bodies).toHaveLength(1);
  } finally {
    f.close();
  }
});

const lengthText = 'Partial assistant reply';
const lengthMessage = {
  type: 'message',
  id: 'msg_0',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: lengthText, annotations: [] }],
};
const lengthResponse = {
  id: 'response1',
  status: 'incomplete',
  incomplete_details: { reason: 'max_output_tokens' },
  output: [lengthMessage],
  usage: { input_tokens: 3, output_tokens: 5 },
};
const lengthFrame = (response: Row = lengthResponse) => frame('response.incomplete', { response });

test('optional native search preserves only bound encrypted reasoning and text from a proven plain length turn', async () => {
  const reasoning = {
    type: 'reasoning',
    id: 'rs_1',
    summary: [],
    encrypted_content: 'fixture-length-reasoning-private',
  };
  const answer = { ...lengthMessage, id: 'msg_1' };
  const nextResponse = () => sse(created + message(0, 'complete') + done);
  const f = await fixture((_body, n) =>
    n > 1
      ? nextResponse()
      : sse(
          created +
            item('added', 0, reasoning) +
            item('done', 0, reasoning) +
            message(1, lengthText) +
            lengthFrame({ ...lengthResponse, output: [reasoning, answer] }),
        ),
  );
  try {
    const events = await collect(f.adapter());
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.text)
        .join(''),
    ).toBe(lengthText);
    expect(events.filter((e) => e.type === 'web_search' || e.type === 'tool_call')).toEqual([]);
    const finish = events.at(-1);
    expect(finish).toMatchObject({
      type: 'finish',
      reason: 'length',
      usage: { inputTokens: 3, outputTokens: 5 },
    });
    if (finish?.type !== 'finish') throw Error('missing finish');
    expect(JSON.stringify(finish.continuation)).toContain(reasoning.encrypted_content);
    expect(JSON.stringify(events.filter((event) => event.type !== 'finish'))).not.toContain(
      reasoning.encrypted_content,
    );
    expect(f.bodies).toHaveLength(1);
    const next = {
      ...req,
      requestId: 'next-step',
      messages: [
        ...req.messages,
        {
          role: 'assistant' as const,
          content: lengthText,
          continuation: structuredClone(finish.continuation),
        },
        { role: 'user' as const, content: 'Continue the saved response.' },
      ],
    };
    await collect(f.adapter(), next);
    await collect(f.adapter(), { ...next, nativeWebSearch: undefined });
    expect(f.bodies).toHaveLength(3);
    const changed = await fixture(nextResponse, 'fixture-rotated-account');
    try {
      await collect(changed.adapter(), next);
      expect(changed.bodies).toHaveLength(1);
      const authorized = f.bodies[1]!;
      expect(authorized.input.filter((part) => part.type === 'reasoning')).toEqual([reasoning]);
      for (const body of [f.bodies[2]!, changed.bodies[0]!]) {
        expect(body.input.some((part) => part.type === 'reasoning')).toBe(false);
        expect(JSON.stringify(body.input)).not.toContain(reasoning.encrypted_content);
      }
      for (const body of [authorized, f.bodies[2]!, changed.bodies[0]!]) {
        expect(JSON.stringify(body.input)).toContain(lengthText);
        expect(JSON.stringify(body.input)).toContain('Continue the saved response.');
        expect(
          body.input.some((part) =>
            ['web_search_call', 'function_call', 'function_call_output'].includes(
              String(part.type),
            ),
          ),
        ).toBe(false);
      }
    } finally {
      changed.close();
    }
  } finally {
    f.close();
  }
});

test('wire text can arrive in thousands of small deltas without changing a proven native length outcome', async () => {
  const text = 'a'.repeat(4100);
  const scope = { output_index: 0, content_index: 0, item_id: 'msg_0' };
  const part = { type: 'output_text', text, annotations: [] };
  const answer = { ...lengthMessage, status: 'incomplete', content: [part] };
  const f = await fixture(() =>
    sse(
      created +
        frame('response.in_progress', {
          response: { id: 'response1', status: 'in_progress', output: [] },
        }) +
        item('added', 0, {
          id: 'msg_0',
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        }) +
        frame('response.content_part.added', { ...scope, part: { ...part, text: '' } }) +
        frame('response.output_text.delta', { ...scope, delta: 'a' }).repeat(text.length) +
        frame('response.output_text.done', { ...scope, text }) +
        frame('response.content_part.done', { ...scope, part }) +
        item('done', 0, answer) +
        lengthFrame({ ...lengthResponse, output: [answer] }),
    ),
  );
  try {
    const events = await collect(f.adapter());
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'length' });
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.text)
        .join(''),
    ).toBe(text);
    expect(f.bodies).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('native length fails closed when terminal output, visible text, or earlier events cannot exclude tool effects', async () => {
  const stream = message(0, lengthText);
  const terminal = (fields: Row) => stream + lengthFrame({ ...lengthResponse, ...fields });
  const after = (extra: string) => stream + extra + lengthFrame();
  const scenarios = [
    ['no terminal', stream],
    ['no output', terminal({ output: undefined })],
    ['empty output', terminal({ output: [] })],
    [
      'terminal-only ciphertext missing from streamed SDK history',
      item('added', 0, { type: 'reasoning', id: 'rs', summary: [] }) +
        item('done', 0, { type: 'reasoning', id: 'rs', summary: [] }) +
        message(1, lengthText) +
        lengthFrame({
          ...lengthResponse,
          output: [
            { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'fixture-unstreamed' },
            { ...lengthMessage, id: 'msg_1' },
          ],
        }),
    ],
    ['reasoning only', terminal({ output: [{ type: 'reasoning', id: 'rs', summary: [] }] })],
    ['wrong reason', terminal({ incomplete_details: { reason: 'content_filter' } })],
    ['wrong status', terminal({ status: 'completed' })],
    ['response identity', terminal({ id: 'another' })],
    ['response error', terminal({ error: { code: 'failed' } })],
    ['missing assistant text', terminal({ output: [{ ...lengthMessage, content: [] }] })],
    ['unknown message phase', terminal({ output: [{ ...lengthMessage, phase: 'future_phase' }] })],
    [
      'unsupported output token metadata',
      terminal({
        output: [
          {
            ...lengthMessage,
            content: [{ ...lengthMessage.content[0], logprobs: { type: 'future' } }],
          },
        ],
      }),
    ],
    ['invalid terminal usage', terminal({ usage: { input_tokens: -1, output_tokens: 3 } })],
    ['different response model', terminal({ model: 'contradictory-model' })],
    [
      'assistant slot mismatch',
      stream.replace('"item_id":"msg_0"', '"item_id":"other"') + lengthFrame(),
    ],
    [
      'stream status conflicts with terminal',
      terminal({ output: [{ ...lengthMessage, status: 'incomplete' }] }),
    ],
    [
      'terminal annotations only',
      terminal({
        output: [
          {
            ...lengthMessage,
            content: [{ ...lengthMessage.content[0], annotations: [annotation] }],
          },
        ],
      }),
    ],
    [
      'known item with unsupported field',
      terminal({ output: [{ ...lengthMessage, tool_calls: [{ type: 'function' }] }] }),
    ],
    [
      'hidden reasoning content',
      terminal({
        output: [
          { type: 'reasoning', id: 'rs', summary: [{ type: 'function_call' }] },
          lengthMessage,
        ],
      }),
    ],
    ['wrong role', terminal({ output: [{ ...lengthMessage, role: 'user' }] })],
    ['hidden terminal search', terminal({ output: [lengthMessage, call] })],
    [
      'hidden local call',
      terminal({ output: [lengthMessage, { type: 'function_call', id: 'fc' }] }),
    ],
    [
      'unknown terminal item',
      terminal({ output: [lengthMessage, { type: 'future_item', id: 'unknown' }] }),
    ],
    [
      'unknown terminal content',
      terminal({
        output: [{ ...lengthMessage, content: [...lengthMessage.content, { type: 'refusal' }] }],
      }),
    ],
    [
      'different text',
      terminal({
        output: [{ ...lengthMessage, content: [{ type: 'output_text', text: 'different' }] }],
      }),
    ],
    ['different item id', terminal({ output: [{ ...lengthMessage, id: 'another' }] })],
    [
      'missing prior tool',
      after(item('added', 1, { type: 'web_search_call', id: 'ws_orphan', status: 'in_progress' })),
    ],
    [
      'orphan wire tool progress',
      after(frame('response.web_search_call.searching', { output_index: 1, item_id: 'orphan' })),
    ],
    [
      'orphan local argument',
      after(
        frame('response.function_call_arguments.done', {
          output_index: 1,
          item_id: 'orphan',
          arguments: '{}',
        }),
      ),
    ],
    ['unknown wire event', after(frame('response.future_tool_event', {}))],
    [
      'reported citation',
      after(
        frame('response.output_text.annotation.added', {
          output_index: 0,
          content_index: 0,
          annotation_index: 0,
          item_id: 'msg_0',
          annotation,
        }),
      ),
    ],
    ['earlier conflicting terminal', after(done)],
    ['later conflicting terminal', stream + lengthFrame() + lengthFrame()],
    ['raw after terminal', stream + lengthFrame() + frame('response.future_event', {})],
    [
      'role changed midstream',
      item('added', 0, { ...lengthMessage, role: 'tool', content: [] }) + stream + lengthFrame(),
    ],
    [
      'item text changed midstream',
      stream +
        item('done', 0, { ...lengthMessage, content: [{ type: 'output_text', text: 'other' }] }) +
        lengthFrame(),
    ],
    [
      'item hidden in progress envelope',
      frame('response.in_progress', { response: { id: 'response1', output: [call] } }) +
        stream +
        lengthFrame(),
    ],
  ] as const;
  for (const [name, payload] of scenarios) {
    const f = await fixture(() => sse(created + payload));
    try {
      const error: unknown = await collect(f.adapter()).then(
        () => undefined,
        (cause) => cause,
      );
      expect(ModelAttemptError.isInstance(error), name).toBe(true);
      expect(error, name).toMatchObject({
        retrySafety:
          name === 'missing prior tool' || name === 'hidden terminal search' ? 'unsafe' : 'unknown',
      });
      expect(f.bodies, name).toHaveLength(1);
    } finally {
      f.close();
    }
  }
  const f = await fixture(() => sse(created + stream + lengthFrame()));
  try {
    await expect(
      runOpenAIWebSearch({ ...options, query: 'required', signal: signal(), fetch: f.transport }),
    ).rejects.toMatchObject({ retrySafety: 'unknown' });
    expect(f.bodies).toHaveLength(1);
  } finally {
    f.close();
  }
});
