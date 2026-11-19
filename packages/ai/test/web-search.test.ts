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
async function fixture(respond: (body: Body, request: number) => Response) {
  const bodies: Body[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      expect(req.headers.get('authorization')).toBe('Bearer fixture-token');
      const body = (await req.json()) as Body;
      bodies.push(body);
      return respond(body, bodies.length);
    },
  });
  const transport = fakeFetch(
    Object.assign(
      (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(url)).toBe(`${baseURL}/responses`);
        expect(init?.redirect).toBe('error');
        return fetch(server.url, init);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const adapter = () =>
    createSdkModelAdapter({
      models: new Map([['bound', createCompatibleModelBinding({ ...options, fetch: transport })]]),
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
    let requests = 0;
    const server: Server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests++;
        if (!afterFirst) {
          res.socket?.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(created + searching);
        setTimeout(() => res.socket?.destroy(), 20);
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
      const err = await collect(adapter).then(
        () => null,
        (e) => e,
      );
      expect(ModelAttemptError.isInstance(err)).toBe(true);
      expect(err.retrySafety).toBe(afterFirst ? 'unsafe' : 'unknown');
      expect(requests).toBe(1);
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
