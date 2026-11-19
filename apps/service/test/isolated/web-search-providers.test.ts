import { expect, test } from 'bun:test';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createWebSearchProviderPort,
  type WebSearchProviderOptions,
  webSearchProviderBaseURL,
} from '../../src/web-search-providers';

const key = 'fixture-only-credential-do-not-log';
const context = (signal = new AbortController().signal) => ({
  signal,
  executionId: 'owned-execution',
});
type Fixture = (request: IncomingMessage, response: ServerResponse) => Promise<void> | void;

async function localServer(serve: Fixture) {
  const server = createServer((req, res) => {
    Promise.resolve(serve(req, res)).catch(() => res.destroy());
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function fixture(serve: Fixture) {
  const calls: { url: string; redirect?: string; credentials?: string }[] = [];
  const local = await localServer(serve);
  const options: WebSearchProviderOptions = {
    adapter: 'deepseek-search',
    baseURL: 'https://api.deepseek.com/v1/',
    resolveApiKey: () => key,
    fetch: (url, init) => {
      calls.push({ url, redirect: init.redirect, credentials: init.credentials });
      // Only the test transport connects to a loopback socket. Production has no
      // endpoint override/env flag that can direct a credential at this origin.
      return fetch(local.origin + new URL(url).pathname, init);
    },
  };
  return {
    port: (overrides: Partial<WebSearchProviderOptions> = {}) =>
      createWebSearchProviderPort({ ...options, ...overrides }),
    calls,
    close: local.close,
  };
}

async function jsonBody(req: IncomingMessage) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res: ServerResponse, data: unknown) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

test('DeepSeek receives only current query, count, false for content; normalizes /v1 and projects summary/snippet', async () => {
  const requests: unknown[] = [];
  const f = await fixture(async (req, res) => {
    requests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      body: await jsonBody(req),
    });
    json(res, {
      results: [
        {
          title: '熊猫',
          url: 'https://example.org/a',
          summary: '完整摘要',
          snippet: '短',
          date: '2026-01-01T00:00:00Z',
          content: 'FULL SECRET MATERIAL',
        },
        {
          title: 'two',
          url: 'https://example.org/b',
          summary: ' ',
          snippet: 'fallback',
          site_icon: 'javascript:boom()',
        },
      ],
    });
  });
  try {
    const port = f.port({ maxResults: 2 });
    const args = {
      query: '  "🪁" site:example.org  ',
      history: ['private message'],
      baseURL: 'https://not-used.invalid',
      maxResults: 1,
    };
    const result = await port.search(args, context());
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/v1/tools/search',
        authorization: `Bearer ${key}`,
        body: { query: '"🪁" site:example.org', count: 2, need_content: false },
      },
    ]);
    expect(f.calls).toEqual([
      { url: 'https://api.deepseek.com/v1/tools/search', redirect: 'manual', credentials: 'omit' },
    ]);
    expect(result).toEqual({
      kind: 'results',
      query: '"🪁" site:example.org',
      items: [
        {
          title: '熊猫',
          url: 'https://example.org/a',
          snippet: '完整摘要',
          publishedAt: '2026-01-01T00:00:00Z',
        },
        { title: 'two', url: 'https://example.org/b', snippet: 'fallback' },
      ],
      truncated: false,
    });
  } finally {
    f.close();
  }
});

test('Perplexity uses independent Search, distinct publication/update dates, and accepts empty without retry', async () => {
  const bodies: unknown[] = [];
  const f = await fixture(async (req, res) => {
    bodies.push(await jsonBody(req));
    json(res, {
      id: 'not-a-model',
      results:
        bodies.length === 1
          ? [
              {
                title: 'article',
                url: 'https://example.org/',
                snippet: 'summary',
                date: '2024-01-02',
                last_updated: '2025-12-31',
              },
            ]
          : [],
    });
  });
  try {
    const port = f.port({ adapter: 'perplexity-search', baseURL: 'https://api.perplexity.ai' });
    expect(await port.search({ query: 'q' }, context())).toEqual({
      kind: 'results',
      query: 'q',
      items: [
        {
          title: 'article',
          url: 'https://example.org/',
          snippet: 'summary',
          publishedAt: '2024-01-02',
          updatedAt: '2025-12-31',
        },
      ],
      truncated: false,
    });
    expect(await port.search({ query: 'empty' }, context())).toEqual({
      kind: 'results',
      query: 'empty',
      items: [],
      truncated: false,
    });
    expect(f.calls.map((x) => x.url)).toEqual(Array(2).fill('https://api.perplexity.ai/search'));
    expect(bodies).toEqual([
      { query: 'q', max_results: 5 },
      { query: 'empty', max_results: 5 },
    ]);
  } finally {
    f.close();
  }
});

test('untrusted endpoint and token placeholders fail before sending; resolver errors never leak', async () => {
  const f = await fixture((_req, res) => json(res, { results: [] }));
  try {
    for (const baseURL of [
      'http://api.deepseek.com',
      'https://api.deepseek.com@else.invalid',
      'https://api.deepseek.com.invalid',
      'https://api.deepseek.com:8443',
      'https://api.deepseek.com/v1?',
      'https://api.deepseek.com/v1#',
      'https://api.deepseek.com/%2f',
      'https://api.deepseek.com/a/../v1',
      'https://api.openai.com/v1',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal unresolved configuration sentinel
      '${ENDPOINT}',
    ]) {
      expect(() => f.port({ baseURL })).toThrow('search_provider_invalid');
    }
    expect(webSearchProviderBaseURL('deepseek-search', 'https://api.deepseek.com/v1')).toBe(
      'https://api.deepseek.com',
    );
    for (const token of [
      '',
      'OPENAI_API_KEY',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal unresolved credential sentinel
      '${API_KEY}',
      '<user-key>',
      '[redacted]',
      '•••••',
      '*****',
      'your_api_key',
      'key\r\nextra: forged',
      undefined,
    ]) {
      await expect(
        f.port({ resolveApiKey: () => token }).search({ query: 'q' }, context()),
      ).rejects.toMatchObject({ code: 'search_credential_unavailable', retrySafety: 'safe' });
    }
    await expect(
      f
        .port({
          resolveApiKey: () => {
            throw Error(key);
          },
        })
        .search({ query: 'q' }, context()),
    ).rejects.toThrow(/^search_credential_unavailable$/);
    for (const maxResults of [0, 11, 2.5])
      expect(() => f.port({ maxResults })).toThrow('search_provider_invalid');
    expect(f.calls).toHaveLength(0);
  } finally {
    f.close();
  }
});

test('DeepSeek 128 Unicode codepoints, not UTF-16 units; no attempt when invalid', async () => {
  const f = await fixture((_req, res) => json(res, { results: [] }));
  try {
    const port = f.port();
    await port.search({ query: '🪁'.repeat(128) }, context());
    for (const [query, code] of [
      ['🪁'.repeat(129), 'search_query_too_long'],
      ['中文'.repeat(65), 'search_query_too_long'],
      [' \t ', 'search_query_invalid'],
      ['\uD800', 'search_query_invalid'],
    ] as const) {
      await expect(port.search({ query }, context())).rejects.toMatchObject({
        code,
        retrySafety: 'safe',
      });
    }
    expect(f.calls).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('maps HTTP errors to safe stable codes; redirects never reach target, including same-origin 307', async () => {
  let hit = 0;
  const target = await localServer((_req, res) => {
    hit++;
    res.end('unexpected');
  });
  let status = 0;
  const f = await fixture((req, res) => {
    if (req.url !== '/v1/tools/search') {
      hit++;
      res.end('unexpected');
      return;
    }
    res
      .writeHead(status, { Location: status === 307 ? '/leak' : `${target.origin}/leak` })
      .end(key);
  });
  try {
    const port = f.port();
    for (const [s, code] of [
      [302, 'search_redirect_refused'],
      [307, 'search_redirect_refused'],
      [400, 'search_bad_request'],
      [401, 'search_auth_failed'],
      [402, 'search_payment_required'],
      [403, 'search_forbidden'],
      [429, 'search_rate_limited'],
      [503, 'search_provider_unavailable'],
      [504, 'search_timeout'],
    ] as const) {
      status = s;
      await expect(port.search({ query: 'q' }, context())).rejects.toMatchObject({
        code,
        message: code,
        retrySafety: 'unknown',
      });
    }
    expect(f.calls).toHaveLength(9);
    expect(hit).toBe(0);
  } finally {
    f.close();
    target.close();
  }
});

test('malformed and over-limit streamed bodies fail closed; incomplete responses never resubmit', async () => {
  let kind = '';
  const f = await fixture((_req, res) => {
    if (kind === 'chunked') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"results":[],"extra":"');
      res.end(`${'x'.repeat(2 * 1024 * 1024)}"}`);
    } else if (kind === 'header') {
      res.writeHead(200, { 'content-length': 4 * 1024 * 1024 });
      res.write('{}');
    } else if (kind === 'dropped') {
      res.destroy();
    } else if (kind === 'utf8') {
      res.end(Buffer.from([0xff]));
    } else {
      res.end(kind);
    }
  });
  try {
    const port = f.port();
    for (const [payload, code] of [
      ['chunked', 'search_response_too_large'],
      ['header', 'search_response_too_large'],
      ['dropped', 'search_network_error'],
      ['utf8', 'search_invalid_response'],
      ['not-json', 'search_invalid_response'],
      ['{}', 'search_invalid_response'],
      ['{"results":[{}]}', 'search_invalid_response'],
    ] as const) {
      kind = payload;
      await expect(port.search({ query: 'q' }, context())).rejects.toMatchObject({
        code,
        retrySafety: 'unknown',
      });
    }
    expect(f.calls).toHaveLength(7);
  } finally {
    f.close();
  }
});

test('deadline and cancellation cannot dispatch after credential lookup or transfer a second time', async () => {
  let started!: () => void;
  const arrived = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture((_req, res) => {
    res.writeHead(200);
    res.write('{"partial":');
    started();
  });
  try {
    let release!: (v: string) => void;
    const port = f.port({
      timeoutMs: 35,
      resolveApiKey: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await expect(port.search({ query: 'q' }, context())).rejects.toMatchObject({
      code: 'search_timeout',
      retrySafety: 'safe',
    });
    release(key);
    await expect(
      f.port().search({ query: 'q' }, context(AbortSignal.abort(key))),
    ).rejects.toMatchObject({ code: 'search_cancelled', retrySafety: 'safe' });
    expect(f.calls).toHaveLength(0);
    const ac = new AbortController();
    const work = f.port().search({ query: 'q' }, context(ac.signal));
    await arrived;
    ac.abort(key);
    await expect(work).rejects.toMatchObject({
      message: 'search_cancelled',
      retrySafety: 'unknown',
    });
    await expect(f.port({ timeoutMs: 35 }).search({ query: 'q' }, context())).rejects.toMatchObject(
      { code: 'search_timeout', retrySafety: 'unknown' },
    );
    expect(f.calls).toHaveLength(2);
  } finally {
    f.close();
  }
});

test('raw rows and unsafe links are never returned; serialized model material stays within 16 KiB', async () => {
  const f = await fixture((_req, res) =>
    json(res, {
      results: [
        { title: 'bad', url: 'javascript:alert(1)' },
        { title: 'pw', url: 'https://user:password@example.com/' },
        ...Array.from({ length: 16 }, (_, i) => ({
          title: '标'.repeat(150),
          url: `https://example.org/${i}`,
          snippet: '🪁\u0000'.repeat(3500),
          content: 'NOT FOR MODEL',
        })),
      ],
    }),
  );
  try {
    const r = await f.port({ maxResults: 10 }).search({ query: 'q' }, context());
    expect(r.kind).toBe('results');
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(16384);
    expect(JSON.stringify(r)).not.toMatch(/javascript:|user:password|NOT FOR MODEL/);
  } finally {
    f.close();
  }
});

test('OpenAI invokes only the chosen one-shot search with query and validated account; caps/filters answer material', async () => {
  const seen: string[][] = [];
  const usage: unknown[] = [];
  const base: WebSearchProviderOptions = {
    onUsage: (u) => {
      usage.push(u);
    },
    adapter: 'openai-search',
    baseURL: 'https://api.openai.com',
    modelId: 'gpt-test',
    resolveApiKey: () => key,
    openaiSearch: async (input) => {
      seen.push(Object.keys(input).sort());
      expect(input.baseURL).toBe('https://api.openai.com/v1');
      expect(input.apiKey).toBe(key);
      return {
        kind: 'answer',
        query: input.query,
        text: '知识🪁'.repeat(8000),
        citations: [{ url: 'https://example.org/c' }],
        sources: [{ url: 'javascript:no' }, { url: 'https://example.org/s' }],
        searchPerformed: true,
        truncated: false,
        usage: {
          inputTokens: 7,
          outputTokens: 13,
          totalTokens: 20,
          raw: { discard: 'NOT FOR MODEL' },
        },
      };
    },
  };
  const result = await createWebSearchProviderPort(base).search({ query: '问题' }, context());
  expect(seen).toEqual([['apiKey', 'baseURL', 'modelId', 'query', 'signal']]);
  expect(usage).toEqual([
    {
      executionId: 'owned-execution',
      adapter: 'openai-search',
      requests: 1,
      searchModelTokens: { inputTokens: 7, outputTokens: 13, totalTokens: 20 },
    },
  ]);
  expect(result.kind).toBe('answer');
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384);
  expect(JSON.stringify(result)).not.toMatch(/javascript:|NOT FOR MODEL|fixture-only/);
  for (const message of ['search_not_performed', 'search_failed', 'search_incomplete', key]) {
    const port = createWebSearchProviderPort({
      ...base,
      openaiSearch: async () => {
        throw Error(message);
      },
    });
    await expect(port.search({ query: 'q' }, context())).rejects.toMatchObject({
      message: message === key ? 'search_network_error' : message,
      retrySafety: 'unknown',
    });
  }
});

test('a known SDK HTTP or terminal failure is sanitized without losing retry safety', async () => {
  const port = createWebSearchProviderPort({
    adapter: 'openai-search',
    baseURL: 'https://api.openai.com/v1',
    modelId: 'model/id',
    resolveApiKey: () => key,
    openaiSearch: async () => {
      throw Object.assign(Error('search_http_error'), {
        statusCode: 402,
        retrySafety: 'unsafe',
        detail: key,
      });
    },
  });
  await expect(port.search({ query: 'q' }, context())).rejects.toMatchObject({
    message: 'search_payment_required',
    retrySafety: 'unsafe',
  });
});

test('credential never appears in a query, result or error, including a successful provider echo', async () => {
  const f = await fixture((_req, res) =>
    json(res, { results: [{ url: 'https://example.org/', title: key, snippet: 'ok' }] }),
  );
  try {
    const port = f.port();
    await expect(port.search({ query: `find ${key}` }, context())).rejects.toMatchObject({
      code: 'search_query_invalid',
      retrySafety: 'safe',
    });
    await expect(port.search({ query: 'q' }, context())).rejects.toMatchObject({
      message: 'search_invalid_response',
      retrySafety: 'unknown',
    });
    expect(f.calls).toHaveLength(1);
  } finally {
    f.close();
  }
});
