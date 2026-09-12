import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createBunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeClientConnection } from '@kite-ai/runtime-client';
import {
  createMockModelServer,
  type MockResponse,
} from '../../../tests/tui-system/harness/fixtures';
import { DesktopClient } from '../src/client';
import { createTestDesktopBridge, type DesktopTestCall } from './desktop-bridge';

// Real Service, with response gates at the renderer IPC boundary. No private client state is patched.
async function fixture(responses: MockResponse[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-session-cache-')));
  for (const name of ['workspace', 'home', 'runtime', 'config']) mkdirSync(join(root, name));
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
          baseURL: model.baseURL,
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
  let nextFailure: 'temporary' | 'unauthorized' | 'missing' | undefined;
  let nextGate: ReturnType<typeof gate> | undefined;
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
      const item = await carrier.messages.next();
      if (item.done) throw new Error('closed');
      const message = item.value as { id?: unknown };
      const waiting = gated.get(message.id);
      if (waiting) {
        gated.delete(message.id);
        waiting.arrive();
        await waiting.released;
      }
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
