import { expect, test } from 'bun:test';
import {
  type Change,
  type Command,
  createClient,
  type Execution,
  type Message,
  type Run,
  type ServerInfo,
} from '../src';

const profile = { dataRoot: '/chosen/data', name: 'fixture', accessKey: 'profile-key' };
const identity: ServerInfo = {
  profile,
  instanceId: 'instance-a',
  buildId: 'build-a',
  apiMajor: 1,
  capabilities: ['sessions', 'commands', 'events', 'history'],
  dataAvailability: 'available',
  storeId: 'store-a',
};
const expected = {
  profile,
  instanceId: identity.instanceId,
  buildId: identity.buildId,
  apiMajor: 1,
  requiredCapabilities: ['sessions'],
};
const token = 'secret-fixture-token';
function fixture(handler: (request: Request) => Response | Promise<Response>) {
  const requests: { url: URL; method: string; body?: unknown }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
      const url = new URL(request.url);
      expect(url.href.includes(token)).toBe(false);
      requests.push({
        url,
        method: request.method,
        ...(request.method === 'POST' ? { body: await request.clone().json() } : {}),
      });
      return handler(request);
    },
  });
  const client = createClient({ endpoint: server.url.href, token, expected });
  return {
    requests,
    client,
    endpoint: server.url.href,
    stop: () => {
      client.disposeNetwork();
      server.stop(true);
    },
  };
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
const problem = (code: string) => ({
  code,
  message: code,
  scope: 'request',
  requestId: 'request-a',
  retryable: false,
});
const ready =
  'event: ready\ndata: {"storeId":"store-a","replayFloor":"0","highWaterCursor":"9007199254740994"}\n\n';
const change: Change = {
  cursor: '9007199254740993',
  sessionId: 's',
  objectId: 'm',
  type: 'message',
  revision: '1',
  payload: null,
};
const event = (name: string, value: unknown, id?: string) =>
  `event: ${name}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(value)}\n\n`;
const sse = (text: string) =>
  new Response(text, { headers: { 'content-type': 'text/event-stream' } });

test('before admission every business operation is rejected with zero network requests', async () => {
  const f = fixture(() => json(identity));
  try {
    expect(() => f.client.getView('s')).toThrow('connection_not_admitted');
    expect(() =>
      f.client.startRun('s', {
        commandId: 'c',
        kind: 'run.start',
        content: 'hello',
        expectedStoreId: 'store-a',
      }),
    ).toThrow('connection_not_admitted');
    await expect(f.client.observe({ onChange() {} })).rejects.toMatchObject({
      code: 'connection_not_admitted',
    });
    await expect(f.client.verifyConnection()).rejects.toMatchObject({
      code: 'connection_not_admitted',
    });
    expect(f.requests).toHaveLength(0);
  } finally {
    f.stop();
  }
});

test('read-only identity probes preserve concurrent history and the exact applied observation cursor', async () => {
  let release!: () => void, started!: () => void, applied!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const changeApplied = new Promise<void>((resolve) => {
    applied = resolve;
  });
  let current = identity,
    readSignal: AbortSignal | undefined,
    stream: ReadableStreamDefaultController<Uint8Array> | undefined,
    observationError: unknown,
    streamCancelled = false;
  const f = fixture(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/v1/server') return json(current);
    if (path === '/v1/sessions') {
      readSignal = request.signal;
      started();
      await held;
      return json([]);
    }
    if (path === '/v1/events')
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(
              new TextEncoder().encode(ready + event('change', change, change.cursor)),
            );
          },
          cancel() {
            streamCancelled = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    throw new Error('unexpected_identity_probe_path');
  });
  let observer: Promise<void> | undefined;
  try {
    await f.client.connect();
    observer = f.client
      .observe({
        reconnect: false,
        onChange() {
          applied();
        },
      })
      .catch((error: unknown) => {
        observationError = error;
      });
    const history = f.client.listSessions();
    await Promise.all([readStarted, changeApplied]);
    const cursor = f.client.lastAppliedCursor;
    expect(await Promise.all([f.client.verifyConnection(), f.client.verifyConnection()])).toEqual([
      identity,
      identity,
    ]);
    expect(readSignal?.aborted).toBe(false);
    expect(streamCancelled).toBe(false);
    expect(observationError).toBeUndefined();
    expect(f.client.lastAppliedCursor).toEqual(cursor);
    current = { ...identity, storeId: 'store-replaced' };
    await expect(f.client.verifyConnection()).rejects.toMatchObject({
      code: 'store_identity_mismatch',
    });
    expect(f.client.serverInfo).toEqual(identity);
    expect(f.client.lastAppliedCursor).toEqual(cursor);
    expect(readSignal?.aborted).toBe(false);
    release();
    expect(await history).toEqual([]);
    stream!.close();
    await observer;
    expect(observationError).toBeUndefined();
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    release();
    f.stop();
    await observer;
  }
});

for (const [name, replacement, code] of [
  ['profile', { profile: { ...profile, dataRoot: '/other' } }, 'profile_identity_mismatch'],
  ['instance', { instanceId: 'wrong' }, 'instance_identity_mismatch'],
  ['build', { buildId: 'wrong' }, 'build_identity_mismatch'],
  ['API', { apiMajor: 2 }, 'api_major_incompatible'],
  ['required capability', { capabilities: [] }, 'required_capability_missing'],
] as const)
  test(`${name} mismatch triggers only server read; business/SSE remain blocked`, async () => {
    const f = fixture(() => json({ ...identity, ...replacement }));
    try {
      await expect(f.client.connect()).rejects.toMatchObject({ code });
      expect(() => f.client.listSessions()).toThrow('connection_not_admitted');
      expect(() =>
        f.client.createSession({
          expectedStoreId: 'store-a',
          commandId: 'c',
          sessionId: 's',
          workspaceId: 'w',
          title: 't',
        }),
      ).toThrow('connection_not_admitted');
      await expect(f.client.observe({ onChange() {} })).rejects.toMatchObject({
        code: 'connection_not_admitted',
      });
      expect(f.requests.map((r) => r.url.pathname)).toEqual(['/v1/server']);
    } finally {
      f.stop();
    }
  });

test('bootstrap must match the actual HTTP identity even when optional instance is not expected', async () => {
  const f = fixture(() => json(identity));
  const client = createClient({
    endpoint: f.endpoint,
    token,
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
    bootstrap: { ...identity, instanceId: 'bootstrap-other' },
  });
  try {
    await expect(client.connect()).rejects.toMatchObject({ code: 'bootstrap_identity_mismatch' });
    expect(f.requests).toHaveLength(1);
  } finally {
    client.disposeNetwork();
    f.stop();
  }
});

test('unknown response fields survive decoding; absent optional capabilities and unavailable data are local', async () => {
  let info: unknown = { ...identity, capabilities: ['sessions'], futureField: { a: 1 } };
  const f = fixture(() => json(info));
  try {
    const result = await f.client.connect();
    expect((result as ServerInfo & { futureField: unknown }).futureField).toEqual({ a: 1 });
    await expect(f.client.observe({ onChange() {} })).rejects.toMatchObject({
      code: 'capability_unavailable',
    });
    expect(f.requests).toHaveLength(1);
    info = { ...identity, dataAvailability: 'unavailable', storeId: undefined };
    await f.client.connect();
    expect(f.client.serverInfo?.profile).toEqual(profile);
    expect(() => f.client.getView('s')).toThrow('data_unavailable');
    expect(f.requests).toHaveLength(2);
  } finally {
    f.stop();
  }
});

test('mutations retain caller command and store IDs, do not retry, and reject unknown request fields', async () => {
  const f = fixture((request) =>
    new URL(request.url).pathname === '/v1/server'
      ? json(identity)
      : json(problem('store_identity_mismatch'), 409),
  );
  try {
    await f.client.connect();
    const intent = {
      commandId: 'same-intent',
      expectedStoreId: 'old-store',
      kind: 'run.start' as const,
      content: 'hello',
    };
    await expect(f.client.startRun('s', intent)).rejects.toMatchObject({
      code: 'store_identity_mismatch',
      status: 409,
    });
    expect(f.requests[1]?.body).toEqual(intent);
    expect(f.requests).toHaveLength(2);
    expect(() => f.client.startRun('s', { ...intent, unknown: 'x' } as typeof intent)).toThrow(
      'Invalid StartCommandRequest request.',
    );
    expect(f.requests).toHaveLength(2);
  } finally {
    f.stop();
  }
});

test('only successfully applied explicit IDs advance; checkpoint supports filtered scope', async () => {
  const f = fixture((request) =>
    new URL(request.url).pathname === '/v1/server'
      ? json(identity)
      : sse(
          ready +
            event('heartbeat', {}) +
            event('change', change, change.cursor) +
            event(
              'checkpoint',
              { storeId: 'store-a', cursor: '9007199254740994' },
              '9007199254740994',
            ),
        ),
  );
  try {
    await f.client.connect();
    await f.client.observe({
      sessionIds: ['s'],
      reconnect: false,
      async onChange(value) {
        expect(value).toEqual(change);
        expect(f.client.lastAppliedCursor?.sequence).toBe('0');
      },
    });
    expect(f.client.lastAppliedCursor).toEqual({
      storeId: 'store-a',
      sequence: '9007199254740994',
    });
    await expect(
      f.client.observe({ sessionIds: ['different'], reconnect: false, onChange() {} }),
    ).rejects.toMatchObject({ code: 'scope_checkpoint_required' });
    expect(f.requests).toHaveLength(2);
  } finally {
    f.stop();
  }
});

test('failed application never advances cursor or triggers mutation/network retry', async () => {
  const f = fixture((request) =>
    new URL(request.url).pathname === '/v1/server'
      ? json(identity)
      : sse(ready + event('change', change, change.cursor)),
  );
  try {
    await f.client.connect();
    await expect(
      f.client.observe({
        onChange() {
          throw new Error('application refused');
        },
      }),
    ).rejects.toMatchObject({ code: 'event_application_failed' });
    expect(f.client.lastAppliedCursor?.sequence).toBe('0');
    expect(f.requests).toHaveLength(2);
  } finally {
    f.stop();
  }
});

test('a reloaded snapshot start boundary only changes replay admission; failed callbacks retain the original applied checkpoint', async () => {
  const boundary = '9007199254740992';
  let fail = true;
  const f = fixture((request) => {
    const url = new URL(request.url);
    if (url.pathname === '/v1/server') return json(identity);
    if (url.searchParams.get('after') === '0') return sse(ready);
    return sse(
      event('ready', {
        storeId: 'store-a',
        replayFloor: boundary,
        highWaterCursor: '9007199254740994',
      }) +
        event('change', change, change.cursor) +
        event('checkpoint', { storeId: 'store-a', cursor: '9007199254740994' }, '9007199254740994'),
    );
  });
  try {
    await f.client.connect();
    await f.client.observe({ reconnect: false, onChange() {} });
    expect(f.client.lastAppliedCursor?.sequence).toBe('0');
    const startAfter = { storeId: 'store-a', sequence: boundary },
      watching = f.client.observe({
        startAfter,
        reconnect: false,
        onChange() {
          expect(f.client.lastAppliedCursor?.sequence).toBe('0');
          if (fail) throw Error('application refused');
        },
      });
    startAfter.storeId = 'caller-change';
    startAfter.sequence = '0';
    const error = await watching.catch((caught: unknown) => caught);
    expect((error as { code: string }).code).toBe('event_application_failed');
    expect(f.client.lastAppliedCursor?.sequence).toBe('0');
    expect(f.requests.at(-1)!.url.searchParams.get('after')).toBe(boundary);
    fail = false;
    await f.client.observe({
      startAfter: { storeId: 'store-a', sequence: boundary },
      reconnect: false,
      onChange() {
        expect(f.client.lastAppliedCursor?.sequence).toBe('0');
      },
      onCheckpoint() {
        expect(f.client.lastAppliedCursor?.sequence).toBe(change.cursor);
      },
    });
    expect(f.client.lastAppliedCursor?.sequence).toBe('9007199254740994');
    const requests = f.requests.length;
    const regressed = await f.client
      .observe({ startAfter: { storeId: 'store-a', sequence: boundary }, onChange() {} })
      .catch((caught: unknown) => caught);
    expect((regressed as { code: string }).code).toBe('observation_start_regressed');
    expect(f.requests).toHaveLength(requests);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    f.stop();
  }
});

test('ready-only snapshot start is never an applied acknowledgement; wrong Store or conflicting start inputs fail before an observation GET', async () => {
  const f = fixture((request) =>
    new URL(request.url).pathname === '/v1/server' ? json(identity) : sse(ready),
  );
  try {
    await f.client.connect();
    let readyCount = 0;
    await f.client.observe({
      startAfter: { storeId: 'store-a', sequence: '9007199254740992' },
      reconnect: false,
      onReady(frame) {
        expect(frame).toEqual({
          storeId: 'store-a',
          replayFloor: '0',
          highWaterCursor: '9007199254740994',
        });
        expect(f.client.lastAppliedCursor).toBeUndefined();
        readyCount++;
      },
      onChange() {},
    });
    expect(readyCount).toBe(1);
    expect(f.client.lastAppliedCursor).toBeUndefined();
    const requests = f.requests.length;
    for (const [input, code] of [
      [{ startAfter: { storeId: 'other', sequence: '0' } }, 'store_identity_mismatch'],
      [
        {
          startAfter: { storeId: 'store-a', sequence: '0' },
          cursor: { storeId: 'store-a', sequence: '0' },
        },
        'invalid_observation_start',
      ],
    ] as const) {
      const error = await f.client
        .observe({ ...input, onChange() {} })
        .catch((caught: unknown) => caught);
      expect((error as { code: string }).code).toBe(code);
    }
    expect(f.requests).toHaveLength(requests);
    expect(f.client.lastAppliedCursor).toBeUndefined();
  } finally {
    f.stop();
  }
});

test('validated stream readiness awaits snapshot application before changes and cannot acknowledge the replay boundary', async () => {
  let release!: () => void, admitted!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
  const f = fixture((request) =>
    new URL(request.url).pathname === '/v1/server'
      ? json(identity)
      : sse(ready + event('change', change, change.cursor)),
  );
  try {
    await f.client.connect();
    let changes = 0;
    const observation = f.client.observe({
      startAfter: { storeId: 'store-a', sequence: '9007199254740992' },
      reconnect: false,
      async onReady(frame) {
        expect(frame.storeId).toBe('store-a');
        expect(f.client.lastAppliedCursor).toBeUndefined();
        admitted();
        await gate;
        expect(f.client.lastAppliedCursor).toBeUndefined();
      },
      onChange() {
        expect(f.client.lastAppliedCursor).toBeUndefined();
        changes++;
      },
    });
    await admission;
    expect(changes).toBe(0);
    expect(f.client.lastAppliedCursor).toBeUndefined();
    release();
    await observation;
    expect(changes).toBe(1);
    expect(f.client.lastAppliedCursor?.sequence).toBe(change.cursor);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    release();
    f.stop();
  }
});

test('invalid readiness, failed readiness application and observation cancellation never deliver changes or advance an acknowledgement', async () => {
  let invalid = false;
  const f = fixture((request) =>
    new URL(request.url).pathname === '/v1/server'
      ? json(identity)
      : sse(
          (invalid
            ? event('ready', {
                storeId: 'foreign-store',
                replayFloor: '0',
                highWaterCursor: change.cursor,
              })
            : ready) + event('change', change, change.cursor),
        ),
  );
  try {
    await f.client.connect();
    let readyCount = 0,
      changes = 0;
    const input = {
      startAfter: { storeId: 'store-a', sequence: '9007199254740992' },
      onChange() {
        changes++;
      },
    };
    const failed = await f.client
      .observe({
        ...input,
        onReady() {
          readyCount++;
          throw Error('snapshot refused');
        },
      })
      .catch((error: unknown) => error);
    expect((failed as { code: string }).code).toBe('event_application_failed');
    expect(readyCount).toBe(1);
    expect(f.client.lastAppliedCursor).toBeUndefined();
    invalid = true;
    const rejected = await f.client
      .observe({
        ...input,
        onReady() {
          readyCount++;
        },
      })
      .catch((error: unknown) => error);
    expect((rejected as { code: string }).code).toBe('invalid_sse_ready');
    expect(readyCount).toBe(1);
    invalid = false;
    const controller = new AbortController();
    const canceled = await f.client
      .observe({
        ...input,
        signal: controller.signal,
        onReady() {
          readyCount++;
          controller.abort('closed snapshot');
        },
      })
      .catch((error: unknown) => error);
    expect(canceled).toBe('closed snapshot');
    expect(readyCount).toBe(2);
    expect(changes).toBe(0);
    expect(f.client.lastAppliedCursor).toBeUndefined();
    expect(f.requests).toHaveLength(4);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    f.stop();
  }
});

test('ready and metadata reads never advance; malformed explicit cursor requires resync', async () => {
  const f = fixture((request) =>
    new URL(request.url).pathname === '/v1/server'
      ? json(identity)
      : sse(ready + event('change', change, '01')),
  );
  try {
    await f.client.connect();
    await expect(f.client.observe({ onChange() {} })).rejects.toMatchObject({
      code: 'invalid_sse_cursor',
    });
    expect(f.client.lastAppliedCursor?.sequence).toBe('0');
    expect(f.requests).toHaveLength(2);
  } finally {
    f.stop();
  }
});

test('network disposal aborts the sole SSE stream and sends no cancel command', async () => {
  let opened!: () => void;
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const f = fixture((request) => {
    if (new URL(request.url).pathname === '/v1/server') return json(identity);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ready));
          opened();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  try {
    await f.client.connect();
    const watching = f.client.observe({ onChange() {} });
    await open;
    await expect(f.client.observe({ onChange() {} })).rejects.toMatchObject({
      code: 'observation_already_active',
    });
    f.client.disposeNetwork();
    await expect(watching).rejects.toBeDefined();
    expect(f.requests.map((r) => r.method)).toEqual(['GET', 'GET']);
    expect(() => f.client.getCommand('c')).toThrow('connection_not_admitted');
  } finally {
    f.stop();
  }
});

test('SDK routes decode generated resources, bounded history and snapshots leave cursor unchanged', async () => {
  const session = {
    id: 's',
    workspaceId: 'w',
    parentSessionId: null,
    title: 't',
    controlRevision: '1',
    contextSelectionId: 'ctx',
    nextSeq: '1',
    deletedAt: null,
  };
  const command: Command = {
    id: 'c',
    sessionId: 's',
    kind: 'run.start',
    status: 'applied',
    receipt: null,
    originStoreId: 'store-a',
    cancelRequestedAt: null,
  };
  const run: Run = {
    id: 'r',
    sessionId: 's',
    originCommandId: 'c',
    originStoreId: 'store-a',
    status: 'completed',
    isActive: false,
    createdAt: 1,
    finishedAt: 2,
    reason: null,
  };
  const execution: Execution = {
    id: 'e',
    sessionId: 's',
    runId: 'r',
    kind: 'model',
    definitionId: 'd',
    definitionVersion: '1',
    status: 'succeeded',
    result: null,
    resultRevision: '1',
    cancelRequestedAt: null,
  };
  const workspace = { id: 'w', rootUri: 'file:///tmp/fixture', name: 'w' };
  const message: Message = {
    id: 'm',
    sessionId: 's',
    runId: 'r',
    seq: '1',
    status: 'complete',
    role: 'assistant',
    content: 'done',
  };
  const f = fixture((request) => {
    const path = new URL(request.url).pathname;
    if (path === '/v1/server') return json(identity);
    if (path.endsWith('/view'))
      return json({
        session,
        runs: [run],
        executions: [execution],
        messages: [message],
        snapshotCursor: '10',
        storeId: 'store-a',
      });
    if (path.endsWith('/messages')) return json([message]);
    if (path === '/v1/commands/c' || path.endsWith('/commands')) return json(command);
    if (path === '/v1/runs/r') return json(run);
    if (path === '/v1/executions/e') return json(execution);
    if (path === '/v1/sessions') return json(request.method === 'POST' ? session : [session]);
    return json(request.method === 'POST' ? workspace : [workspace]);
  });
  try {
    await f.client.connect();
    expect(await f.client.createWorkspace({ ...workspace, expectedStoreId: 'store-a' })).toEqual(
      workspace,
    );
    expect(
      await f.client.createSession({
        sessionId: 's',
        workspaceId: 'w',
        commandId: 'new-session',
        expectedStoreId: 'store-a',
        title: 't',
      }),
    ).toEqual(session);
    expect(
      await f.client.startRun('s', {
        commandId: 'c',
        expectedStoreId: 'store-a',
        kind: 'run.start',
        content: 'hi',
      }),
    ).toEqual(command);
    expect(
      await f.client.cancelCommand('s', {
        commandId: 'cancel-c',
        expectedStoreId: 'store-a',
        kind: 'command.cancel',
        targetCommandId: 'c',
      }),
    ).toEqual(command);
    expect((await f.client.getView('s')).snapshotCursor).toBe('10');
    expect(await f.client.getCommand('c')).toEqual(command);
    expect(await f.client.getRun('r')).toEqual(run);
    expect(await f.client.getExecution('e')).toEqual(execution);
    expect(await f.client.listMessages('s', { afterSeq: '0', upperSeq: '1', limit: 20 })).toEqual([
      message,
    ]);
    expect(f.requests.at(-1)?.url.searchParams.toString()).toBe('afterSeq=0&upperSeq=1&limit=20');
    expect(await f.client.listSessions()).toEqual([session]);
    expect(await f.client.listWorkspaces()).toEqual([workspace]);
    expect(f.client.lastAppliedCursor).toBeUndefined();
  } finally {
    f.stop();
  }
});

test('stream reconnect checks identity; Store change requests snapshot without rebinding or mutation', async () => {
  let serverReads = 0;
  let streamReads = 0;
  const f = fixture((request) => {
    if (new URL(request.url).pathname === '/v1/server')
      return json({ ...identity, storeId: ++serverReads === 1 ? 'store-a' : 'store-b' });
    streamReads++;
    return sse(ready + event('change', change, change.cursor));
  });
  try {
    await f.client.connect();
    const resets: string[] = [];
    await f.client.observe({
      retryDelayMs: 0,
      onChange() {},
      onReset(reason) {
        resets.push(reason);
      },
    });
    expect(resets).toEqual(['store_changed']);
    expect(streamReads).toBe(1);
    expect(f.client.serverInfo?.storeId).toBe('store-b');
    expect(f.client.lastAppliedCursor?.storeId).toBe('store-a');
    expect(f.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET']);
  } finally {
    f.stop();
  }
});

test('reconnect rejected target blocks subsequent business calls and preserves confirmed cursor', async () => {
  let serverReads = 0;
  const f = fixture((request) =>
    new URL(request.url).pathname === '/v1/server'
      ? json({
          ...identity,
          instanceId: ++serverReads === 1 ? identity.instanceId : 'another-instance',
        })
      : sse(ready),
  );
  try {
    await f.client.connect();
    await expect(f.client.observe({ retryDelayMs: 0, onChange() {} })).rejects.toMatchObject({
      code: 'instance_identity_mismatch',
    });
    expect(() => f.client.getView('s')).toThrow('connection_not_admitted');
    expect(f.client.lastAppliedCursor?.sequence).toBe('0');
    expect(f.requests).toHaveLength(3);
  } finally {
    f.stop();
  }
});

test('expired SSE is a scoped reset and never an automatic mutation retry', async () => {
  const f = fixture((request) =>
    new URL(request.url).pathname === '/v1/server'
      ? json(identity)
      : json(problem('cursor_expired'), 410),
  );
  try {
    await f.client.connect();
    const reasons: string[] = [];
    await f.client.observe({
      onChange() {},
      onReset(reason) {
        reasons.push(reason);
      },
    });
    expect(reasons).toEqual(['cursor_expired']);
    expect(f.client.lastAppliedCursor?.sequence).toBe('0');
    expect(f.requests).toHaveLength(2);
  } finally {
    f.stop();
  }
});

test('generic extension routes retain public envelopes, use fixed intent and bound encoded Query inputs', async () => {
  const publicView = {
    extensionId: 'external.example',
    contentType: 'external.result',
    contentVersion: 42,
    summary: 'Saved',
    payload: { unknown: { value: 'kept' } },
    artifactRefs: [],
    actions: [
      {
        actionId: 'external.action',
        definitionVersion: '1',
        label: 'Apply',
        input: { future: true },
        futureAction: 'kept',
      },
    ],
    futureView: true,
  };
  const f = fixture((request) => {
    const path = new URL(request.url).pathname;
    if (path === '/v1/server')
      return json({
        ...identity,
        capabilities: [...identity.capabilities, 'extension_queries', 'extensions_actions'],
      });
    if (path === '/v1/extensions')
      return json([
        { extensionId: 'external.example', version: '1', actions: [], queries: [], future: true },
      ]);
    if (path.includes('/queries/')) return json([publicView]);
    return json({
      id: 'action-c',
      sessionId: 's',
      kind: 'extension.invoke',
      status: 'accepted',
      receipt: null,
      originStoreId: 'store-a',
      cancelRequestedAt: null,
    });
  });
  try {
    await f.client.connect();
    expect(await f.client.listExtensions()).toMatchObject([
      { extensionId: 'external.example', future: true },
    ]);
    const input = { text: '你好 &+', unknown: [true, null] };
    expect(await f.client.queryExtension('s', 'external.example', 'external.query', input)).toEqual(
      [publicView],
    );
    expect(JSON.parse(f.requests.at(-1)!.url.searchParams.get('input')!)).toEqual(input);
    const intent = {
      commandId: 'action-c',
      expectedStoreId: 'store-a',
      kind: 'extension.invoke' as const,
      extensionId: 'external.example',
      actionId: 'external.action',
      definitionVersion: '1',
      input: publicView.actions[0]!.input,
    };
    await f.client.invokeExtension('s', intent);
    expect(f.requests.at(-1)?.body).toEqual(intent);
    const count = f.requests.length;
    expect(() =>
      f.client.queryExtension('s', 'external.example', 'external.query', {
        long: '你'.repeat(1000),
      }),
    ).toThrow('invalid_query_arguments');
    expect(() =>
      f.client.queryExtension('s', 'external.example', 'external.query', Number.NaN),
    ).toThrow('invalid_query_arguments');
    expect(f.requests).toHaveLength(count);
  } finally {
    f.stop();
  }
});

test('optional extension capabilities fail locally without blocking supported history', async () => {
  const f = fixture((request) =>
    new URL(request.url).pathname === '/v1/server' ? json(identity) : json([]),
  );
  try {
    await f.client.connect();
    expect(() => f.client.listExtensions()).toThrow('capability_unavailable');
    expect(() =>
      f.client.invokeExtension('s', {
        commandId: 'a',
        expectedStoreId: 'store-a',
        kind: 'extension.invoke',
        extensionId: 'external',
        actionId: 'a',
        definitionVersion: '1',
        input: {},
      }),
    ).toThrow('capability_unavailable');
    expect(await f.client.listMessages('s')).toEqual([]);
    expect(f.requests).toHaveLength(2);
  } finally {
    f.stop();
  }
});

test('missingStoreId HTTP available response fails admission and triggers zero business requests', async () => {
  const { storeId: _omitted, ...withoutStore } = identity;
  const f = fixture(() => json(withoutStore));
  try {
    await expect(f.client.connect()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(() => f.client.getView('s')).toThrow('connection_not_admitted');
    expect(() =>
      f.client.createSession({
        expectedStoreId: 'original-store',
        commandId: 'intent',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Draft',
      }),
    ).toThrow('connection_not_admitted');
    await expect(f.client.observe({ onChange() {} })).rejects.toMatchObject({
      code: 'connection_not_admitted',
    });
    expect(f.requests.map((request) => request.url.pathname)).toEqual(['/v1/server']);
  } finally {
    f.stop();
  }
});

test('missingStoreId bootstrap fails before HTTP and preserves the startup expectation', async () => {
  const { storeId: _omitted, ...withoutStore } = identity;
  const f = fixture(() => json(identity));
  try {
    await expect(f.client.connect({ bootstrap: withoutStore as ServerInfo })).rejects.toMatchObject(
      { code: 'invalid_response' },
    );
    expect(f.requests).toHaveLength(0);
    expect(() => f.client.listSessions()).toThrow('connection_not_admitted');
    await expect(f.client.observe({ onChange() {} })).rejects.toMatchObject({
      code: 'connection_not_admitted',
    });
    expect(f.requests).toHaveLength(0);
  } finally {
    f.stop();
  }
});

test('failedReadmission clears business access without replacing previous confirmed identity or saved intent', async () => {
  let valid = true;
  const { storeId: _omitted, ...withoutStore } = identity;
  const f = fixture(() => json(valid ? identity : withoutStore));
  const intent = {
    expectedStoreId: 'store-a',
    commandId: 'saved-intent',
    kind: 'run.start' as const,
    content: 'Draft',
  };
  try {
    await f.client.connect();
    valid = false;
    await expect(f.client.connect()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(f.client.serverInfo).toEqual(identity);
    expect(() => f.client.startRun('s', intent)).toThrow('connection_not_admitted');
    expect(intent).toEqual({
      expectedStoreId: 'store-a',
      commandId: 'saved-intent',
      kind: 'run.start',
      content: 'Draft',
    });
    expect(f.requests.map((request) => request.url.pathname)).toEqual(['/v1/server', '/v1/server']);
  } finally {
    f.stop();
  }
});
