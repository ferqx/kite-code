import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createBunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeClientConnection } from '@kite-ai/runtime-client';
import { startTestHttpServer } from '../../../tests/helpers/test-http-server';
import {
  createMockModelServer,
  type MockResponse,
} from '../../../tests/tui-system/harness/fixtures';
import { CommandResultUnknown, DesktopClient } from '../src/client';
import { createTestDesktopBridge, type DesktopTestCall } from './desktop-bridge';

// Real Service, with response gates at the renderer IPC boundary. No private client state is patched.
async function fixture(responses: MockResponse[] = [], providerBaseURL?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-session-cache-')));
  for (const name of ['workspace', 'home', 'runtime', 'config'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const workspace = join(root, 'workspace');
  const model = createMockModelServer();
  model.setResponses(responses);
  writeFileSync(
    join(root, 'config/kite-code.jsonc'),
    JSON.stringify({
      provider: {
        test: {
          type: 'openai-compatible',
          apiKey: 'fixture',
          baseURL: providerBaseURL ?? model.baseURL,
          model: 'mock-model',
          models: ['mock-model'],
        },
      },
      model: { default: { provider: 'test', name: 'mock-model' } },
      interactionMode: 'accept_edits',
      sandbox: { enabled: false },
      mcpServers: {},
    }),
  );
  let generation = 0;
  let historyRequests = 0;
  let droppedEvent: string | undefined;
  let nextLiveFailure: 'projection' | 'subscription' | undefined;
  let nextSubscriptionGate: ReturnType<typeof gate> | undefined;
  let nextFailure: 'temporary' | 'unauthorized' | 'missing' | undefined;
  let nextGate: ReturnType<typeof gate> | undefined;
  let nextCreationGate: ReturnType<typeof gate> | undefined;
  const lostCreations = new Set<unknown>();
  const allGates: ReturnType<typeof gate>[] = [];
  const gated = new Map<unknown, ReturnType<typeof gate>>();
  const failures = new Map<unknown, NonNullable<typeof nextFailure>>();
  const carriers = new Map<
    number,
    { connection: RuntimeClientConnection; messages: AsyncIterator<unknown> }
  >();
  const call: DesktopTestCall = async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === 'runtime_status') return { workspace, connectionId: generation || null } as T;
    if (command === 'activate_workspace' || command === 'pick_workspace') return workspace as T;
    if (command === 'list_projects') return [{ path: workspace, lastOpenedAt: 1 }] as T;
    if (command === 'check_workspace' || command === 'runtime_detach') return undefined as T;
    if (command === 'query_workspace_branch')
      return {
        workspace,
        repository: false,
        root: null,
        current: null,
        head: null,
        branches: [],
        dirty: false,
        canSwitch: false,
      } as T;
    if (command === 'runtime_open') {
      const connection = await createBunStdioChildRuntimeClientTransport({
        argv: [
          process.execPath,
          resolve('scripts/release/entrypoints/service.ts'),
          'app-server',
          'run-stdio',
        ],
        cwd: '/',
        env: {
          KITE_CODE_HOME: join(root, 'runtime'),
          KITE_CODE_CONFIG_HOME: join(root, 'config'),
          KITE_APP_SERVER_WORKSPACE: workspace,
          KITE_APP_SERVER_BUILD_ID: 'session-cache-test',
          HOME: join(root, 'home'),
          USERPROFILE: join(root, 'home'),
          PATH: process.env.PATH ?? '/usr/bin:/bin',
        },
      }).connect();
      carriers.set(++generation, {
        connection,
        messages: connection.messages()[Symbol.asyncIterator](),
      });
      return {
        connectionId: generation,
        workspace,
        expectedServerVersion: kiteAppServerVersion('session-cache-test'),
      } as T;
    }
    const carrier = carriers.get(args?.connectionId as number)!;
    if (command === 'runtime_send') {
      const message = JSON.parse(args?.frame as string);
      // This fixture keeps a lost creation genuinely unknown: its receipt read is unavailable too.
      if (message.method === 'runtime/query' && message.params.query.type === 'get_command_receipt')
        failures.set(message.id, 'temporary');
      if (
        message.method === 'runtime/command' &&
        message.params?.command?.type === 'create_session' &&
        nextCreationGate
      ) {
        gated.set(message.id, nextCreationGate);
        lostCreations.add(message.id);
        nextCreationGate = undefined;
      }
      if (
        (nextLiveFailure === 'projection' &&
          message.method === 'runtime/query' &&
          message.params.query.type === 'get_session_projection') ||
        (nextLiveFailure === 'subscription' && message.method === 'runtime/subscribe')
      ) {
        failures.set(message.id, 'temporary');
        nextLiveFailure = undefined;
      }
      if (message.method === 'runtime/subscribe' && nextSubscriptionGate) {
        gated.set(message.id, nextSubscriptionGate);
        nextSubscriptionGate = undefined;
      }
      if (message.method === 'history/load_session') {
        historyRequests++;
        if (nextGate) {
          gated.set(message.id, nextGate);
          nextGate = undefined;
        }
        if (nextFailure) {
          failures.set(message.id, nextFailure);
          nextFailure = undefined;
        }
      }
      await carrier.connection.send(message);
    } else if (command === 'runtime_receive') {
      let item = await carrier.messages.next();
      const eventType = (value: unknown) => {
        const frame = value as {
          method?: string;
          params?: { message?: { durability?: string; event?: { type?: string } } };
        };
        return frame.method === 'runtime/subscription' &&
          frame.params?.message?.durability === 'durable'
          ? frame.params.message.event?.type
          : undefined;
      };
      if (!item.done && droppedEvent && eventType(item.value) === droppedEvent) {
        droppedEvent = undefined;
        item = await carrier.messages.next();
      }
      if (item.done) throw new Error('closed');
      const message = item.value as { id?: unknown };
      const waiting = gated.get(message.id);
      if (waiting) {
        gated.delete(message.id);
        waiting.arrive();
        await waiting.released;
      }
      if (lostCreations.delete(message.id))
        return JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: 'fixture lost creation receipt',
            data: { code: 'internal_error' },
          },
        }) as T;
      const failure = failures.get(message.id);
      if (failure) {
        failures.delete(message.id);
        return JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: failure === 'unauthorized' ? -32005 : -32603,
            message: 'fixture history failure',
            data: {
              code: failure === 'unauthorized' ? 'unauthorized' : 'internal_error',
              ...(failure === 'missing' ? { detailCode: 'session_not_found' } : {}),
            },
          },
        }) as T;
      }
      return JSON.stringify(message) as T;
    } else if (command === 'runtime_close') await carrier.connection.close();
    else throw new Error(`Unexpected IPC ${command}`);
    return undefined as T;
  };
  const client = new DesktopClient(createTestDesktopBridge(call));
  await client.activateProject(workspace);
  const a = await client.newSession();
  await client.selectSession(a);
  const b = await client.newSession();
  await client.selectSession(b);
  await client.refreshSessions();
  return {
    client,
    a,
    b,
    model,
    dropLiveEvent(type: string) {
      droppedEvent = type;
    },
    holdSubscription() {
      nextSubscriptionGate = gate();
      allGates.push(nextSubscriptionGate);
      return nextSubscriptionGate;
    },
    failLiveRead(kind: 'projection' | 'subscription') {
      nextLiveFailure = kind;
    },
    get historyRequests() {
      return historyRequests;
    },
    failHistory(failure: NonNullable<typeof nextFailure>) {
      nextFailure = failure;
    },
    holdHistory() {
      nextGate = gate();
      allGates.push(nextGate);
      return nextGate;
    },
    holdUnknownCreation() {
      nextCreationGate = gate();
      allGates.push(nextCreationGate);
      return nextCreationGate;
    },
    async close() {
      for (const pending of allGates) pending.release();
      for (const pending of gated.values()) pending.release();
      await client.disconnect();
      for (const carrier of carriers.values()) await carrier.connection.close();
      model.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function gate() {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrive, release, arrived, released };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Service state did not settle');
    await Bun.sleep(10);
  }
}

test('provider authentication failure is visible once during live delivery and after history reload', async () => {
  let requests = 0;
  const provider = startTestHttpServer({
    fetch() {
      requests++;
      return Response.json(
        { error: { message: 'private authentication response', type: 'authentication_error' } },
        { status: 401 },
      );
    },
  });
  const f = await fixture([], `${provider.url.origin}/v1`);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Hello');
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'failed');
    await waitFor(() =>
      f.client.getSnapshot().messages.some((message) => message.role === 'system'),
    );
    const notices = () =>
      f.client.getSnapshot().messages.filter((message) => message.role === 'system');
    const live = notices();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: 'failed', settled: true });
    expect(live[0]!.text).toContain('认证失败');
    expect(live[0]!.text).toContain('凭据');
    expect(JSON.stringify(f.client.getSnapshot().messages)).not.toContain('private authentication');
    expect(
      f.client.getSnapshot().messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    expect(f.client.getSnapshot().messages.some((message) => message.role === 'assistant')).toBe(
      false,
    );
    expect(requests).toBe(1);

    await f.client.selectSession(f.b);
    await f.client.selectSession(f.a);
    expect(notices()).toEqual(live);
    expect(requests).toBe(1);
  } finally {
    await f.close();
    provider.stop(true);
  }
}, 20_000);

test.each([
  false,
  true,
])('an unknown creation cannot replace a newer selection (return to original: %s)', async (returnToOriginal) => {
  const f = await fixture();
  try {
    const held = f.holdUnknownCreation();
    const creation = f.client.newSession().catch((error: unknown) => error);
    await held.arrived;
    const reading = f.client.selectSession(f.a);
    const returning = returnToOriginal ? f.client.selectSession(f.b) : undefined;
    held.release();
    const error = await creation;
    await Promise.all([reading, returning]);
    expect(error).toBeInstanceOf(CommandResultUnknown);
    if (!(error instanceof CommandResultUnknown)) throw new Error('Expected an unknown receipt');
    expect(error.sessionId).toBeDefined();
    const selected = returnToOriginal ? f.b : f.a;
    expect(f.client.getSnapshot()).toMatchObject({
      selected,
      projection: { sessionId: selected },
      ready: true,
      hasLoadedHistory: true,
    });
    await f.client.refreshSessions();
    expect(
      f.client.getSnapshot().sessions.filter((s) => s.sessionId === error.sessionId),
    ).toHaveLength(1);
    expect(f.client.getSnapshot().selected).toBe(selected);
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('an unknown creation detaches the previous reading subscription without stopping its run', async () => {
  const f = await fixture([
    { message: { content_chunks: ['first ', 'later ', 'finished'] }, chunk_delay: 200 },
  ]);
  try {
    await f.client.send('Keep running while a new conversation is created.');
    await waitFor(() => f.client.getSnapshot().messages.some((m) => m.role === 'assistant'));
    const held = f.holdUnknownCreation();
    const creation = f.client.newSession().catch((error: unknown) => error);
    await held.arrived;
    held.release();
    const error = await creation;
    if (!(error instanceof CommandResultUnknown)) throw new Error('Expected an unknown receipt');
    expect(f.client.getSnapshot().selected).toBe(error.sessionId);
    await Bun.sleep(800);
    expect(f.client.getSnapshot().messages).toEqual([]);
    expect(f.client.getSnapshot().ready).toBe(false);
    await f.client.selectSession(f.b);
    await waitFor(() =>
      f.client.getSnapshot().messages.some((m) => m.role === 'assistant' && m.settled),
    );
    expect(f.client.getSnapshot().messages.find((m) => m.role === 'assistant')?.text).toBe(
      'first later finished',
    );
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('cached empty history appears before calibration and duplicate selections share one request', async () => {
  const f = await fixture();
  try {
    const held = f.holdHistory();
    const before = f.historyRequests;
    const selection = f.client.selectSession(f.a);
    expect(f.client.getSnapshot()).toMatchObject({
      selected: f.a,
      messages: [],
      hasLoadedHistory: true,
      loadingSession: true,
      ready: false,
    });
    expect(f.client.selectSession(f.a)).toBe(selection);
    await held.arrived;
    expect(f.client.getSnapshot().ready).toBe(false);
    await expect(f.client.send('must remain a draft')).rejects.toThrow('同步');
    expect(f.historyRequests).toBe(before + 1);
    held.release();
    await selection;
    expect(f.client.getSnapshot().ready).toBe(true);
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('failed calibration retains cached history but cannot regain readiness until retry succeeds', async () => {
  const f = await fixture([{ message: { content: 'durable answer' } }]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('remember this');
    await waitFor(() =>
      f.client.getSnapshot().messages.some((m) => m.text === 'durable answer' && m.settled),
    );
    const previous = f.client.getSnapshot().messages;
    await f.client.selectSession(f.b);
    f.failHistory('temporary');
    await expect(f.client.selectSession(f.a)).rejects.toThrow('fixture history failure');
    expect(f.client.getSnapshot().messages).toBe(previous);
    await f.client.refreshDirectory();
    expect(f.client.getSnapshot()).toMatchObject({
      ready: false,
      loadingSession: false,
      hasLoadedHistory: true,
    });
    await f.client.selectSession(f.a);
    expect(f.client.getSnapshot().ready).toBe(true);
    // Historical folding may add durable details; a second unchanged calibration must preserve the array.
    const settled = f.client.getSnapshot().messages;
    await f.client.selectSession(f.b);
    await f.client.selectSession(f.a);
    expect(f.client.getSnapshot().messages).toBe(settled);
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test.each([
  'unauthorized',
  'missing',
] as const)('explicit %s discards history; switching away cannot resurrect it', async (failure) => {
  const f = await fixture();
  try {
    f.failHistory(failure);
    await expect(f.client.selectSession(f.a)).rejects.toThrow();
    expect(f.client.getSnapshot()).toMatchObject({
      hasLoadedHistory: false,
      messages: [],
      ready: false,
    });
    await f.client.selectSession(f.b);
    const next = f.client.selectSession(f.a);
    expect(f.client.getSnapshot().hasLoadedHistory).toBe(false);
    await next;
  } finally {
    await f.close();
  }
}, 20_000);

test('late failed selection cannot clear the next view and reconnect discards inactive cache', async () => {
  const f = await fixture();
  try {
    const held = f.holdHistory();
    f.failHistory('unauthorized');
    const stale = f.client.selectSession(f.a);
    await held.arrived;
    const current = f.client.selectSession(f.b);
    held.release();
    await Promise.all([stale, current]);
    expect(f.client.getSnapshot()).toMatchObject({
      selected: f.b,
      ready: true,
      hasLoadedHistory: true,
      error: undefined,
    });
    await f.client.disconnect();
    await f.client.connect();
    const next = f.client.selectSession(f.a);
    expect(f.client.getSnapshot().hasLoadedHistory).toBe(false);
    await next;
  } finally {
    await f.close();
  }
}, 20_000);

test('switching back during streaming joins full history with queued live events exactly once', async () => {
  const f = await fixture([
    { message: { content_chunks: ['first ', 'second ', 'final'] }, chunk_delay: 100 },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('stream then finish');
    await waitFor(() => f.client.getSnapshot().messages.some((m) => m.role === 'assistant'));
    const reading = f.client.getSnapshot().messages;
    await f.client.selectSession(f.b);
    const held = f.holdHistory();
    const selection = f.client.selectSession(f.a);
    expect(f.client.getSnapshot().messages).toBe(reading);
    await held.arrived;
    await Bun.sleep(800);
    held.release();
    await selection;
    await waitFor(() =>
      f.client.getSnapshot().messages.some((m) => m.role === 'assistant' && m.settled),
    );
    expect(
      f.client
        .getSnapshot()
        .messages.filter((m) => m.role === 'assistant')
        .map((m) => m.text),
    ).toEqual(['first second final']);
    await f.client.selectSession(f.b);
    await f.client.selectSession(f.a);
    expect(
      f.client
        .getSnapshot()
        .messages.filter((m) => m.role === 'assistant')
        .map((m) => m.text),
    ).toEqual(['first second final']);
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('a cached waiting interaction remains non-actionable until fresh history and subscription settle', async () => {
  const f = await fixture([
    {
      message: {
        tool_calls: [
          {
            id: 'question',
            name: 'ask_user',
            args: {
              questions: [
                {
                  question: 'Choose a language',
                  options: [
                    { label: 'TypeScript', description: 'Typed code', recommended: true },
                    { label: 'Python', description: 'Scripts', recommended: false },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'question', contentIncludes: ['TypeScript'] }],
      },
      message: { content: 'Question answered.' },
    },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Ask me which language to use.');
    await waitFor(
      () =>
        f.client
          .getSnapshot()
          .projection?.interactionQueue.interactions.some((item) => item.kind === 'input') === true,
    );
    const oldInteraction = f.client.getSnapshot().projection!.interactionQueue.interactions[0]!;
    expect(oldInteraction.kind).toBe('input');
    if (oldInteraction.kind !== 'input') throw new Error('Expected a question');
    await f.client.selectSession(f.b);
    const held = f.holdHistory();
    const loading = f.client.selectSession(f.a);
    await held.arrived;
    expect(f.client.getSnapshot().hasLoadedHistory).toBe(true);
    await expect(f.client.respondInput(f.a, oldInteraction, 'TypeScript')).rejects.toThrow('会话');
    held.release();
    await loading;
    const fresh = f.client.getSnapshot().projection!.interactionQueue.interactions[0]!;
    if (fresh.kind !== 'input') throw new Error('Expected a fresh question');
    await f.client.respondInput(f.a, fresh, 'TypeScript');
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((message) => message.text === 'Question answered.' && message.settled),
    );
    expect(new Set(f.client.getSnapshot().messages.map((message) => message.id)).size).toBe(
      f.client.getSnapshot().messages.length,
    );
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('one ask_user call projects and settles every question with stable ownership', async () => {
  const f = await fixture([
    {
      message: {
        tool_calls: [
          {
            id: 'batch-question',
            name: 'ask_user',
            args: {
              questions: [
                {
                  question: 'Choose a language',
                  options: [
                    { label: 'TypeScript', description: 'Typed code', recommended: true },
                    { label: 'Python', description: 'Scripts', recommended: false },
                  ],
                },
                {
                  question: 'Choose a database',
                  options: [
                    { label: 'Postgres', description: 'Server database', recommended: true },
                    { label: 'SQLite', description: 'Local database', recommended: false },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'batch-question', contentIncludes: ['TypeScript', 'SQLite'] }],
      },
      message: { content: 'Both questions answered.' },
    },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Ask both questions in one call.');
    await waitFor(
      () => f.client.getSnapshot().projection?.interactionQueue.interactions[0]?.kind === 'input',
    );
    const interaction = f.client.getSnapshot().projection!.interactionQueue.interactions[0]!;
    if (interaction.kind !== 'input') throw new Error('Expected a batch question');
    expect(interaction.questions?.map((question) => question.id)).toEqual(['q1', 'q2']);
    expect(interaction.questions?.map((question) => question.question)).toEqual([
      'Choose a language',
      'Choose a database',
    ]);
    await f.client.respondInput(f.a, interaction, 'q1: TypeScript\nq2: SQLite', {
      q1: 'q1-o1',
      q2: 'q2-o2',
    });
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((message) => message.text === 'Both questions answered.' && message.settled),
    );
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('cached approval requires fresh calibration before an external file write can be approved', async () => {
  const f = await fixture();
  const path = resolve(f.client.getSnapshot().workspace, '../home/approved.txt');
  f.model.setResponses([
    {
      message: {
        tool_calls: [
          { id: 'write-approved', name: 'write_file', args: { path, content: 'approved' } },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'write-approved', contentIncludes: ['approved.txt'] }],
      },
      message: { content: 'Approved write completed.' },
    },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Write the requested file.');
    await waitFor(
      () =>
        f.client
          .getSnapshot()
          .projection?.interactionQueue.interactions.some((item) => item.kind === 'approval') ===
        true,
    );
    const old = f.client.getSnapshot().projection!.interactionQueue.interactions[0]!;
    if (old.kind !== 'approval') throw new Error('Expected an approval');
    await f.client.selectSession(f.b);
    const held = f.holdHistory();
    const loading = f.client.selectSession(f.a);
    await held.arrived;
    expect(f.client.getSnapshot().hasLoadedHistory).toBe(true);
    await expect(f.client.respondApproval(f.a, old, 'approve_once')).rejects.toThrow('会话');
    held.release();
    await loading;
    const fresh = f.client.getSnapshot().projection!.interactionQueue.interactions[0]!;
    if (fresh.kind !== 'approval') throw new Error('Expected a fresh approval');
    await f.client.respondApproval(f.a, fresh, 'approve_once');
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((m) => m.text === 'Approved write completed.' && m.settled),
    );
    expect(await Bun.file(path).text()).toBe('approved');
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('an explicit new-session send keeps its target while another cached selection calibrates', async () => {
  const f = await fixture([{ message: { content: 'Reply belongs to the new session.' } }]);
  try {
    const created = await f.client.newSession();
    expect(f.client.getSnapshot().selected).toBe(f.b);
    const held = f.holdHistory();
    const reading = f.client.selectSession(f.a);
    await held.arrived;
    const sending = f.client.send('Send to the newly created session.', created);
    held.release();
    await Promise.all([reading, sending]);
    expect(f.client.getSnapshot().selected).toBe(f.a);
    expect(f.client.getSnapshot().messages).toEqual([]);
    await f.client.selectSession(created);
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((m) => m.text === 'Reply belongs to the new session.' && m.settled),
    );
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test.each([
  'projection',
  'subscription',
] as const)('first history stays readable when live %s fails', async (kind) => {
  const f = await fixture([{ message: { content: 'Saved before the live failure.' } }]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Keep this history readable.');
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((m) => m.text === 'Saved before the live failure.' && m.settled),
    );
    await f.client.selectSession(f.b);
    await f.client.disconnect();
    await f.client.connect();
    f.failLiveRead(kind);
    await expect(f.client.selectSession(f.a)).rejects.toThrow('fixture history failure');
    expect(f.client.getSnapshot()).toMatchObject({
      selected: f.a,
      hasLoadedHistory: true,
      loadingSession: false,
      ready: false,
    });
    expect(
      f.client.getSnapshot().messages.some((m) => m.text === 'Saved before the live failure.'),
    ).toBe(true);
    await expect(f.client.send('must not send while uncalibrated')).rejects.toThrow('同步');
    await f.client.selectSession(f.a);
    expect(f.client.getSnapshot().ready).toBe(true);
    expect(f.model.getRequestCount()).toBe(1);
  } finally {
    await f.close();
  }
}, 20_000);

test('a subscription that never becomes ready times out without hiding first-read history', async () => {
  const f = await fixture([{ message: { content: 'Readable during live outage.' } }]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Save this before the outage.');
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((m) => m.text === 'Readable during live outage.' && m.settled),
    );
    await f.client.selectSession(f.b);
    await f.client.disconnect();
    await f.client.connect();
    const held = f.holdSubscription();
    const loading = f.client.selectSession(f.a);
    const timeout = expect(loading).rejects.toThrow('会话加载超时');
    await held.arrived;
    expect(f.client.getSnapshot()).toMatchObject({ hasLoadedHistory: true, ready: false });
    expect(
      f.client.getSnapshot().messages.some((m) => m.text === 'Readable during live outage.'),
    ).toBe(true);
    await timeout;
    expect(f.client.getSnapshot()).toMatchObject({
      hasLoadedHistory: true,
      loadingSession: false,
      ready: false,
    });
    held.release();
    await f.client.selectSession(f.a);
    expect(f.client.getSnapshot().ready).toBe(true);
    expect(f.model.getRequestCount()).toBe(1);
  } finally {
    await f.close();
  }
}, 30_000);

test('a live durable gap reloads omitted messages before restoring selected-session readiness', async () => {
  const f = await fixture([{ message: { content: 'answer after gap' } }]);
  try {
    await f.client.selectSession(f.a);
    const before = f.historyRequests;
    const held = f.holdHistory();
    f.dropLiveEvent('user.message');
    await f.client.send('message omitted from live delivery');
    await Promise.race([
      held.arrived,
      Bun.sleep(2000).then(() => {
        throw new Error('Gap did not trigger history calibration');
      }),
    ]);
    expect(f.client.getSnapshot()).toMatchObject({
      selected: f.a,
      ready: false,
      hasLoadedHistory: true,
    });
    held.release();
    await waitFor(
      () =>
        f.client.getSnapshot().ready &&
        f.client
          .getSnapshot()
          .messages.some((message) => message.text === 'answer after gap' && message.settled),
    );
    expect(
      f.client
        .getSnapshot()
        .messages.filter((message) => message.text === 'message omitted from live delivery'),
    ).toHaveLength(1);
    expect(f.historyRequests).toBeGreaterThan(before);
    const after = f.historyRequests;
    await f.client.refreshDirectory();
    await Bun.sleep(30);
    expect(f.historyRequests).toBe(after);
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);
