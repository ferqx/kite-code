import { expect, test } from 'bun:test';
import { createBrowserClient } from '../src/browser';

const identity = 'a'.repeat(64);
const info = {
  pageIdentity: identity,
  storeId: 'original',
  instanceId: 'instance',
  buildId: 'build',
  dataAvailability: 'available',
  capabilities: ['workspaces', 'sessions', 'history'],
};
function response(value: unknown, status = 200, page = identity) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'x-kite-web-identity': page, 'content-type': 'application/json' },
  });
}
const expired = () =>
  response(
    {
      code: 'browser_session_expired',
      message: 'expired',
      scope: 'browser',
      requestId: 'request',
      retryable: false,
    },
    401,
  );
function gateway(
  read: (request: Request) => Response | Promise<Response> = () => response([]),
  maximum?: number,
) {
  const requests: Request[] = [];
  const options: RequestInit[] = [];
  let serverInfo = info;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(request.clone());
      return new URL(request.url).pathname === '/browser/v1/server'
        ? response(serverInfo)
        : read(request);
    },
  });
  const transport = ((input: RequestInfo | URL, init?: RequestInit) => {
    options.push(init ?? {});
    return fetch(input, init);
  }) as typeof fetch;
  const client = createBrowserClient({
    origin: `http://127.0.0.1:${server.port}`,
    pageIdentity: identity,
    fetch: transport,
    maxResponseBytes: maximum,
  });
  return {
    client,
    requests,
    options,
    setInfo(value: typeof info) {
      serverInfo = value;
    },
    async close() {
      client.disposeNetwork();
      await server.stop(true);
    },
  };
}

test('Browser admission gates every business read and sends cookie credentials without Native authority', async () => {
  const g = gateway();
  try {
    expect(() => g.client.listWorkspaces()).toThrow('connection_not_admitted');
    expect(() => g.client.listMessages('s')).toThrow('connection_not_admitted');
    expect(g.requests).toHaveLength(0);
    await g.client.connect();
    await g.client.listWorkspaces();
    await g.client.listSessions();
    expect(
      g.requests.every(
        (request) =>
          !request.headers.has('authorization') && !new URL(request.url).searchParams.has('token'),
      ),
    ).toBe(true);
    expect(
      g.options.every((value) => value.credentials === 'same-origin' && value.redirect === 'error'),
    ).toBe(true);
    expect(
      g.requests.every((request) => request.headers.get('x-kite-web-identity') === identity),
    ).toBe(true);
    expect('cancelCommand' in g.client).toBe(false);
  } finally {
    await g.close();
  }
});

test('wrong page identity fails before renewal and changed Store cannot rebind an admitted browser', async () => {
  const g = gateway(() => response({}, 401, 'b'.repeat(64)));
  try {
    await g.client.connect();
    await expect(g.client.listWorkspaces()).rejects.toThrow('browser_identity_mismatch');
    expect(g.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    g.setInfo({ ...info, storeId: 'other' });
    await expect(g.client.connect()).rejects.toThrow('browser_identity_mismatch');
    expect(g.client.serverInfo?.storeId).toBe('original');
  } finally {
    await g.close();
  }
});

test('available Store is mandatory, unavailable data stays local, and optional missing history blocks only that read', async () => {
  for (const mode of ['missing-store', 'unavailable', 'no-history'] as const) {
    const g = gateway();
    try {
      g.setInfo({
        ...info,
        ...(mode === 'missing-store'
          ? { storeId: null }
          : mode === 'unavailable'
            ? { storeId: null, dataAvailability: 'unavailable' }
            : { capabilities: ['workspaces', 'sessions'] }),
      } as unknown as typeof info);
      if (mode === 'missing-store') {
        await expect(g.client.connect()).rejects.toThrow('browser_identity_mismatch');
        expect(() => g.client.listWorkspaces()).toThrow('connection_not_admitted');
      } else {
        await g.client.connect();
        const count = g.requests.length;
        expect(() => g.client.listMessages('s')).toThrow(
          mode === 'unavailable' ? 'data_unavailable' : 'capability_unavailable',
        );
        expect(g.requests).toHaveLength(count);
        if (mode === 'no-history') await g.client.listWorkspaces();
      }
    } finally {
      await g.close();
    }
  }
});

test('overlapping expired reads share one renewal and each retries at most once', async () => {
  let renewed = false,
    renews = 0,
    reads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const g = gateway(async (request) => {
    if (request.method === 'POST') {
      renews++;
      await held;
      renewed = true;
      return response(null, 200);
    }
    reads++;
    return renewed ? response([]) : expired();
  });
  try {
    await g.client.connect();
    const one = g.client.listWorkspaces(),
      two = g.client.listSessions();
    while (reads < 2 || renews < 1) await Bun.sleep(1);
    release();
    await Promise.all([one, two]);
    expect(renews).toBe(1);
    expect(reads).toBe(4);
  } finally {
    release();
    await g.close();
  }
  const permanent = gateway((request) => (request.method === 'POST' ? response(null) : expired()));
  try {
    await permanent.client.connect();
    await expect(permanent.client.listWorkspaces()).rejects.toThrow('expired');
    expect(permanent.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(
      permanent.requests.filter((request) => new URL(request.url).pathname.endsWith('workspaces')),
    ).toHaveLength(2);
  } finally {
    await permanent.close();
  }
});

test('a late 401 from the same expired generation retries after the existing renewal without renewing again', async () => {
  let renews = 0,
    first = 0,
    second = 0,
    release!: () => void;
  const oldResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  const g = gateway(async (request) => {
    if (request.method === 'POST') {
      renews++;
      return response(null);
    }
    if (new URL(request.url).pathname.endsWith('workspaces'))
      return first++ === 0 ? expired() : response([]);
    if (second++ === 0) {
      await oldResponse;
      return expired();
    }
    return response([]);
  });
  try {
    await g.client.connect();
    const one = g.client.listWorkspaces(),
      two = g.client.listSessions();
    await one;
    release();
    await two;
    expect(renews).toBe(1);
  } finally {
    release();
    await g.close();
  }
});

test('invalid pagination is rejected locally and precise Decimal64 values are never rounded', async () => {
  const g = gateway();
  try {
    await g.client.connect();
    const before = g.requests.length;
    for (const afterSeq of ['-1', '01', '9223372036854775808'])
      expect(() => g.client.listMessages('s', { afterSeq })).toThrow();
    for (const limit of [0, 201, 1.5])
      expect(() => g.client.listMessages('s', { limit })).toThrow('invalid_page_limit');
    expect(() => g.client.listMessages('s', { afterSeq: '8', upperSeq: '7' })).toThrow(
      'invalid_cursor',
    );
    expect(g.requests).toHaveLength(before);
    await g.client.listMessages('s', {
      afterSeq: '9007199254740993',
      upperSeq: '9223372036854775807',
      limit: 200,
    });
    const query = new URL(g.requests.at(-1)!.url).searchParams;
    expect(query.get('afterSeq')).toBe('9007199254740993');
    expect(query.get('upperSeq')).toBe('9223372036854775807');
  } finally {
    await g.close();
  }
});

test('bad JSON, incompatible DTO and oversized responses are localized without renewing or cancelling', async () => {
  for (const mode of ['json', 'schema', 'budget'] as const) {
    const g = gateway(
      () =>
        mode === 'json'
          ? new Response('{', { headers: { 'x-kite-web-identity': identity } })
          : response(mode === 'schema' ? {} : ['x'.repeat(1000)]),
      512,
    );
    try {
      await g.client.connect();
      await expect(g.client.listWorkspaces()).rejects.toThrow(
        mode === 'budget' ? 'response_too_large' : /Invalid BrowserWorkspaceList|invalid_response/,
      );
    } finally {
      await g.close();
    }
  }
});

test('network disposal aborts a held read without DELETE, renewal or Runtime cancellation', async () => {
  let started = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const g = gateway(async () => {
    started = true;
    await gate;
    return response([]);
  });
  try {
    await g.client.connect();
    const pending = g.client.listWorkspaces();
    while (!started) await Bun.sleep(1);
    g.client.disposeNetwork();
    await expect(pending).rejects.toThrow();
    expect(g.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    release();
    await g.close();
  }
});

test('network disposal aborts a held cookie renewal and prevents the original read retry', async () => {
  let renewing = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const g = gateway(async (request) => {
    if (request.method === 'POST') {
      renewing = true;
      await gate;
      return response(null);
    }
    return expired();
  });
  try {
    await g.client.connect();
    const pending = g.client.listWorkspaces();
    while (!renewing) await Bun.sleep(1);
    g.client.disposeNetwork();
    expect(g.options.find((value) => value.method === 'POST')?.signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow();
    expect(
      g.requests.filter(
        (request) =>
          request.method === 'GET' && new URL(request.url).pathname.endsWith('workspaces'),
      ),
    ).toHaveLength(1);
    expect(g.requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);
  } finally {
    release();
    await g.close();
  }
});

test('explicit browser close settles the old renewal before DELETE and prevents new admission or reads', async () => {
  let renewing = false,
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const g = gateway(async (request) => {
    if (request.method === 'POST') {
      renewing = true;
      await held;
      return response(null);
    }
    if (request.method === 'DELETE') return response(null);
    return expired();
  });
  try {
    await g.client.connect();
    const pending = g.client.listWorkspaces();
    const rejected = pending.then(
      () => null,
      (error: unknown) => error,
    );
    while (!renewing) await Bun.sleep(1);
    const closing = g.client.closeBrowserSession();
    expect(g.options.find((value) => value.method === 'POST')?.signal?.aborted).toBe(true);
    release();
    await closing;
    expect(await rejected).toBeInstanceOf(Error);
    await g.client.closeBrowserSession();
    expect(g.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect(g.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(() => g.client.listWorkspaces()).toThrow('browser_session_closed');
    await expect(g.client.connect()).rejects.toThrow('browser_session_closed');
  } finally {
    release();
    await g.close();
  }
});

test('read-only diagnostics keep fixed cursor and selection identity; authority fields and missing capabilities fail locally', async () => {
  const context = {
    selection: {
      id: 'selected',
      sessionId: 's',
      previousSelectionId: null,
      boundaryMessageId: null,
      boundarySeq: '0',
      tailFromSeq: '0',
      ranges: [],
    },
    highWaterSeq: '9007199254740993',
    messages: [],
    resultSources: [],
    nextAfterSeq: null,
    nextAfterSourceId: null,
    snapshotCursor: '9223372036854775807',
  };
  const output = {
    highWaterSeq: '9007199254740993',
    items: [
      {
        executionId: 'job',
        seq: '9007199254740993',
        throughSeq: '9007199254740993',
        stream: 'stdout' as const,
        content: 'exact bytes α',
        droppedBytes: null,
      },
    ],
  };
  const g = gateway((request) =>
    response(new URL(request.url).pathname.endsWith('/context') ? context : output),
  );
  try {
    await g.client.connect();
    const local = g.requests.length;
    expect(() => g.client.getContext('s')).toThrow('capability_unavailable');
    expect(() => g.client.listExecutionOutput('s', 'job')).toThrow('capability_unavailable');
    expect(g.requests).toHaveLength(local);
    g.setInfo({ ...info, capabilities: [...info.capabilities, 'context', 'execution_output'] });
    await g.client.connect();
    const before = g.requests.length;
    expect(() => g.client.getContext('s', { storeId: 'forged' } as never)).toThrow(
      'Invalid BrowserContextQuery',
    );
    expect(() =>
      g.client.getContext('s', { contextSelectionId: 'selected', sourceLimit: 101 }),
    ).toThrow('Invalid BrowserContextQuery');
    expect(() => g.client.getContext('s', { afterSeq: '2', upperSeq: '1' })).toThrow(
      'invalid_cursor',
    );
    expect(() => g.client.listExecutionOutput('s', 'job', { afterSeq: '01' })).toThrow(
      'Invalid cursor sequence',
    );
    expect(() => g.client.listExecutionOutput('s', 'job', { limit: 201 })).toThrow(
      'invalid_page_limit',
    );
    expect(g.requests).toHaveLength(before);
    expect(
      await g.client.getContext('s', {
        contextSelectionId: 'selected',
        afterSeq: '9007199254740993',
        upperSeq: '9223372036854775807',
      }),
    ).toEqual(context);
    const query = new URL(g.requests.at(-1)!.url).searchParams;
    expect(query.has('storeId')).toBe(false);
    expect(query.get('afterSeq')).toBe('9007199254740993');
    expect(
      await g.client.listExecutionOutput('s', 'job', { upperSeq: '9007199254740993' }),
    ).toEqual(output);
    expect(g.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    await g.close();
  }
});

test('diagnostics reject foreign selection or output receipt and never substitute another target', async () => {
  let wrong = 'context';
  const g = gateway(() =>
    response(
      wrong === 'context'
        ? {
            selection: {
              id: 'other',
              sessionId: 'other',
              previousSelectionId: null,
              boundaryMessageId: null,
              boundarySeq: '0',
              tailFromSeq: '0',
              ranges: [],
            },
            highWaterSeq: '0',
            messages: [],
            resultSources: [],
            nextAfterSeq: null,
            nextAfterSourceId: null,
            snapshotCursor: '0',
          }
        : {
            highWaterSeq: '1',
            items: [
              {
                executionId: 'foreign',
                seq: '1',
                throughSeq: '1',
                stream: 'stdout',
                content: 'foreign',
                droppedBytes: null,
              },
            ],
          },
    ),
  );
  try {
    g.setInfo({ ...info, capabilities: [...info.capabilities, 'context', 'execution_output'] });
    await g.client.connect();
    await expect(g.client.getContext('s', { contextSelectionId: 'selected' })).rejects.toThrow(
      'browser_identity_mismatch',
    );
    wrong = 'output';
    await expect(g.client.listExecutionOutput('s', 'job')).rejects.toThrow(
      'browser_identity_mismatch',
    );
    expect(g.requests.filter((request) => request.method !== 'GET')).toHaveLength(0);
  } finally {
    await g.close();
  }
});
