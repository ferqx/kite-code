import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeCommand,
  RuntimeQuery,
  RuntimeSessionProjection,
  RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import {
  RUNTIME_PROTOCOL_SCHEMA,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';
import {
  openRuntimeServerInProcessPair,
  RuntimeServer,
  type RuntimeServerAdmissionInput,
  type RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import {
  createDevelopmentLoopbackCarrier,
  type DevelopmentLoopbackCarrier,
} from '#app/carrier/development-loopback-carrier';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../../..');
const CLI_ENTRYPOINT = join(REPOSITORY_ROOT, 'apps/kite/src/cli/executable.ts');
const DEADLINE_MS = 5_000;
const QUIET_PERIOD_MS = 80;
const PING_SOAK_COUNT = 128;
const METHODS = [
  'initialize',
  'runtime/command',
  'runtime/query',
  'runtime/subscribe',
  'runtime/unsubscribe',
  'server/ping',
] as const;

/**
 * This is deliberately one raw JSON-RPC script, not three near-duplicate
 * carrier tests. Framing, malformed frames, and carrier limits remain owned
 * by their focused stdio/WebSocket tests; this file guards the common logical
 * protocol boundary described by KRSV1-09.
 */
async function runProtocolMatrix(fixture: MatrixFixture): Promise<void> {
  await fixture.send(request('pre-initialize', 'server/ping', {}));
  expect(errorCode(await fixture.next())).toBe('not_initialized');

  await fixture.send(initialize('initialize'));
  const initialized = response(await fixture.next(), 'initialize');
  expect(initialized.result).toMatchObject({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    protocolSchema: RUNTIME_PROTOCOL_SCHEMA,
    capabilities: { methods: METHODS, subscriptions: ['session', 'sessions'] },
  });
  expect((initialized.result as { limits?: unknown }).limits).toBeDefined();

  await fixture.send(initialize('duplicate-initialize'));
  expect(errorCode(await fixture.next())).toBe('already_initialized');

  // A small sequential soak keeps one bounded request outstanding. It proves
  // exact response correlation and ordering without turning WebSocket framing
  // into a synthetic zero-delay barrier benchmark.
  for (let index = 0; index < PING_SOAK_COUNT; index += 1) {
    const id = `ping-soak-${index}`;
    await fixture.send(request(id, 'server/ping', {}));
    expect(response(await fixture.next(), id).result).toEqual({ status: 'ok' });
  }
  await fixture.assertBoundedPingSoak();

  // The advertised method list is a closed wire allowlist, rather than an
  // implementation detail of one carrier.
  await fixture.send(request('unknown-method', 'runtime/not-allowed', {}));
  expect(errorCode(await fixture.next())).toBe('method_not_found');

  const sessionId = `matrix-${fixture.name}-session`;
  await fixture.send(
    request('create-session', 'runtime/command', {
      command: {
        schema: 'kite.runtime-command.v1',
        commandId: `matrix-${fixture.name}-create`,
        type: 'create_session',
        bootstrapSessionId: sessionId,
      },
    }),
  );
  const created = response(await fixture.next(), 'create-session');
  expect(created.result).toMatchObject({ status: 'applied', sessionId });
  // Workspace is intentionally absent from the remote command vocabulary.
  expect(JSON.stringify(created)).not.toContain(fixture.workspace);

  await fixture.send(
    request('query-session', 'runtime/query', {
      query: {
        schema: 'kite.runtime-query.v1',
        type: 'get_session_projection',
        sessionId,
      },
    }),
  );
  const queried = response(await fixture.next(), 'query-session');
  expect(queried.result).toMatchObject({
    status: 'ok',
    queryType: 'get_session_projection',
    session: { sessionId },
  });
  expect(JSON.stringify(queried)).not.toContain(fixture.workspace);
  await fixture.assertWorkspaceAuthority();

  await fixture.send(
    request('subscribe-sessions', 'runtime/subscribe', {
      subscription: { scope: 'sessions' },
    }),
  );
  const subscribed = response(await fixture.next(), 'subscribe-sessions');
  const subscriptionId = subscriptionIdFrom(subscribed);
  const lifecycle = await subscriptionLifecycle(fixture, subscriptionId);
  expect(lifecycle).toEqual(['index_reset_begin', 'index_reset_end', 'ready']);

  await fixture.send(request('unsubscribe', 'runtime/unsubscribe', { subscriptionId }));
  expect(response(await fixture.next(), 'unsubscribe').result).toEqual({ unsubscribed: true });
  await fixture.assertSubscriptionCleanup();

  // A second unsubscribe gives a deterministic wire acknowledgement and
  // proves the first one released the logical subscription.
  await fixture.send(request('unsubscribe-again', 'runtime/unsubscribe', { subscriptionId }));
  expect(response(await fixture.next(), 'unsubscribe-again').result).toEqual({
    unsubscribed: false,
  });

  await fixture.assertNoMutationReplayDuringClose();
}

async function subscriptionLifecycle(
  fixture: MatrixFixture,
  subscriptionId: string,
): Promise<readonly string[]> {
  const types: string[] = [];
  for (let index = 0; index < 16; index += 1) {
    const frame = await fixture.next();
    expect(frame).toMatchObject({
      method: 'runtime/subscription',
      params: { subscriptionId },
    });
    const type = subscriptionMessageType(frame);
    if (type === 'session_upsert') continue;
    types.push(type);
    if (type === 'ready') return types;
  }
  throw new Error(`${fixture.name} did not produce a bounded subscription reset/ready sequence`);
}

type JsonRecord = Readonly<Record<string, unknown>>;

interface MatrixFixture {
  readonly name: string;
  readonly workspace: string;
  send(frame: JsonRecord): Promise<void>;
  next(): Promise<JsonRecord>;
  assertWorkspaceAuthority(): Promise<void>;
  /** The carrier has no public queue metric unless this fixture exposes one. */
  assertBoundedPingSoak(): Promise<void>;
  assertSubscriptionCleanup(): Promise<void>;
  /** Closes/drains the carrier and verifies it did not invoke the mutation again. */
  assertNoMutationReplayDuringClose(): Promise<void>;
  close(): Promise<void>;
}

const inProcessFixture = {
  name: 'in-process RuntimeServer pair',
  create: async (): Promise<MatrixFixture> => {
    const runtime = new MatrixRuntime();
    const admission = new RecordingAdmission('/trusted/in-process-workspace');
    const server = new RuntimeServer(
      { runtime, admission },
      { serverInfo: { version: 'matrix', instanceId: 'in-process-matrix' } },
    );
    const pair = openRuntimeServerInProcessPair(server);
    const messages = pair.client.messages()[Symbol.asyncIterator]();
    let closed = false;
    return {
      name: 'in-process',
      workspace: admission.workspace,
      send: async (frame) => pair.client.send(frame as RuntimeProtocolMessage),
      next: async () => nextRecord(messages, 'in-process protocol message'),
      assertWorkspaceAuthority: async () => {
        expect(runtime.commands).toHaveLength(1);
        expect((runtime.commands[0] as { workspace?: unknown }).workspace).toBe(
          admission.workspace,
        );
        expect(admission.operations).toContain('runtime/command');
      },
      assertBoundedPingSoak: async () => {
        expect(runtime.commands).toHaveLength(0);
        expect(server.connectionCount).toBe(1);
      },
      assertSubscriptionCleanup: async () => {
        await eventually(() => runtime.subscriptionCount === 0, 'in-process subscription cleanup');
      },
      assertNoMutationReplayDuringClose: async () => {
        await pair.connection.close('matrix_disconnect');
        await eventually(() => server.connectionCount === 0, 'in-process connection close');
        await server.beginDraining();
        expect(runtime.commands).toHaveLength(1);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await pair.connection.close('matrix_cleanup');
        await server.beginDraining();
      },
    };
  },
};

const webSocketFixture = {
  name: 'development WebSocket carrier/auth',
  create: async (): Promise<MatrixFixture> => {
    const runtime = new MatrixRuntime();
    const admission = new RecordingAdmission('/trusted/websocket-workspace');
    const server = new RuntimeServer(
      { runtime, admission },
      { serverInfo: { version: 'matrix', instanceId: 'websocket-matrix' } },
    );
    const carrier = createDevelopmentLoopbackCarrier({
      server,
      limits: { drainDeadlineMs: 250, heartbeatIntervalMs: 10_000, heartbeatDeadlineMs: 20_000 },
    });
    const bootstrap = await within(
      fetch(`${carrier.origin}/_kite/bootstrap`, {
        method: 'POST',
        headers: {
          authorization: `Kite-Dev-Bootstrap ${carrier.bootstrapBearer}`,
          origin: carrier.origin,
        },
      }),
      'WebSocket bootstrap',
    );
    expect(bootstrap.status).toBe(204);
    const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie) throw new Error('WebSocket bootstrap omitted a cookie.');
    const socket = await openSocket(carrier, cookie);
    const messages = new SocketMessages(socket);
    let closed = false;
    return {
      name: 'websocket',
      workspace: admission.workspace,
      send: async (frame) => socket.send(JSON.stringify(frame)),
      next: async () => messages.next(),
      assertWorkspaceAuthority: async () => {
        expect(runtime.commands).toHaveLength(1);
        expect((runtime.commands[0] as { workspace?: unknown }).workspace).toBe(
          admission.workspace,
        );
        expect(admission.operations).toContain('runtime/command');
      },
      assertBoundedPingSoak: async () => {
        expect(runtime.commands).toHaveLength(0);
        expect(server.connectionCount).toBe(1);
        expect(messages.maxQueuedFrames).toBeLessThanOrEqual(1);
      },
      assertSubscriptionCleanup: async () => {
        await eventually(() => runtime.subscriptionCount === 0, 'WebSocket subscription cleanup');
      },
      assertNoMutationReplayDuringClose: async () => {
        await closeSocket(socket);
        await eventually(() => server.connectionCount === 0, 'WebSocket logical close');
        await carrier.close();
        expect(runtime.commands).toHaveLength(1);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await closeSocket(socket);
        await carrier.close();
      },
    };
  },
};

const stdioFixture = {
  name: 'App stdio child',
  create: async (): Promise<MatrixFixture> => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-transport-matrix-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const checkpointPath = join(root, 'runtime.sqlite');
    const sessionId = 'matrix-stdio-session';
    mkdirSync(workspace, { recursive: true });
    writeIsolatedConfig(home);
    const child = startChild({ home, workspace, checkpointPath, sessionId });
    let closed = false;
    return {
      name: 'stdio',
      workspace,
      send: async (frame) => {
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      },
      next: async () => child.stdout.next(),
      // The real App child has no test-only admission spy. Its strict remote
      // command schema is exercised above, and the projection must not leak
      // the CLI-owned workspace/checkpoint back onto the wire.
      assertWorkspaceAuthority: async () => undefined,
      assertBoundedPingSoak: async () => {
        expect(child.proc.exitCode).toBeNull();
        expect(child.stdout.maxQueuedFrames).toBeLessThanOrEqual(1);
      },
      assertSubscriptionCleanup: async () => undefined,
      assertNoMutationReplayDuringClose: async () => {
        const before = child.stdout.count;
        child.stdin.end();
        await within(remainsRunning(child.proc, QUIET_PERIOD_MS), 'stdio EOF owner lease');
        child.proc.kill('SIGTERM');
        await expectExit(child.proc, 'stdio owner drain');
        await within(child.stdout.done, 'stdio stdout drain');
        await within(child.stderr.done, 'stdio stderr drain');
        expect(child.stdout.count).toBe(before);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        child.stdin.end();
        if (child.proc.exitCode === null) child.proc.kill('SIGTERM');
        await expectExit(child.proc, 'stdio owner shutdown');
        await within(child.stdout.done, 'stdio stdout close');
        await within(child.stderr.done, 'stdio stderr close');
        child.stdout.assertProtocolOnly();
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
};

class RecordingAdmission implements RuntimeServerAdmissionPort {
  readonly operations: string[] = [];
  readonly workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  async authorize(input: RuntimeServerAdmissionInput) {
    this.operations.push(input.operation);
    return { allowed: true as const, workspace: this.workspace };
  }
}

class MatrixRuntime implements RuntimeAccess {
  readonly commands: RuntimeCommand[] = [];
  readonly #streams = new Set<MatrixStream>();
  #session: RuntimeSessionProjection | undefined;

  get subscriptionCount(): number {
    return this.#streams.size;
  }

  async command(command: RuntimeCommand) {
    this.commands.push(command);
    const sessionId =
      command.type === 'create_session'
        ? (command.bootstrapSessionId ?? 'matrix-session')
        : 'matrix-session';
    this.#session = {
      schema: 'kite.runtime-projection.v1',
      sessionId,
      revision: 0,
      lifecycle: 'open',
    };
    return { status: 'applied' as const, commandId: command.commandId, sessionId, revision: 0 };
  }

  async query(query: RuntimeQuery) {
    if (query.type === 'get_session_projection') {
      return this.#session?.sessionId === query.sessionId
        ? {
            status: 'ok' as const,
            queryType: query.type,
            revision: this.#session.revision,
            session: this.#session,
          }
        : {
            status: 'not_found' as const,
            queryType: query.type,
            code: 'session_not_found' as const,
          };
    }
    return {
      status: 'ok' as const,
      queryType: query.type,
      sessions: this.#session ? [this.#session] : [],
    };
  }

  subscribe(subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
    const notifications: RuntimeAccessNotification[] =
      subscription.spec.scope === 'sessions'
        ? [
            {
              type: 'index_reset_begin',
              serverInstanceId: 'matrix',
              generation: 1,
              indexRevision: 0,
            },
            ...(this.#session
              ? [
                  {
                    type: 'session_upsert' as const,
                    serverInstanceId: 'matrix',
                    generation: 1,
                    indexRevision: 0,
                    session: this.#session,
                  },
                ]
              : []),
            {
              type: 'index_reset_end',
              serverInstanceId: 'matrix',
              generation: 1,
              indexRevision: 0,
            },
          ]
        : [];
    const stream = new MatrixStream(notifications, () => this.#streams.delete(stream));
    this.#streams.add(stream);
    return stream;
  }
}

class MatrixStream implements AsyncIterable<RuntimeAccessNotification> {
  readonly #values: RuntimeAccessNotification[];
  readonly #onClose: () => void;
  #closed = false;

  constructor(values: RuntimeAccessNotification[], onClose: () => void) {
    this.#values = values;
    this.#onClose = onClose;
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeAccessNotification> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { done: false as const, value };
        return await new Promise<IteratorResult<RuntimeAccessNotification>>(() => undefined);
      },
      return: async () => {
        if (!this.#closed) {
          this.#closed = true;
          this.#onClose();
        }
        return { done: true, value: undefined };
      },
    };
  }
}

interface Child {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly stdin: { write(chunk: string): unknown; end(): unknown };
  readonly stdout: JsonlMessages;
  readonly stderr: TextCollector;
}

function startChild(input: {
  readonly home: string;
  readonly workspace: string;
  readonly checkpointPath: string;
  readonly sessionId: string;
}): Child {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      CLI_ENTRYPOINT,
      'server',
      '--stdio',
      '--thread',
      input.sessionId,
      '--workspace',
      input.workspace,
      '--checkpoints',
      input.checkpointPath,
      '--trust-workspace',
      '--no-sandbox',
    ],
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      HOME: input.home,
      KITE_CODE_HOME: input.home,
      XDG_CONFIG_HOME: input.home,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    proc,
    stdin: proc.stdin as Child['stdin'],
    stdout: new JsonlMessages(proc.stdout),
    stderr: new TextCollector(proc.stderr),
  };
}

function writeIsolatedConfig(home: string): void {
  const configPath = join(home, '.kite-code', 'kite-code.jsonc');
  mkdirSync(resolve(configPath, '..'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      provider: {
        matrix: {
          type: 'openai-compatible',
          apiKey: 'matrix-secret-not-sent',
          baseURL: 'http://127.0.0.1:1/v1',
          model: 'matrix-model',
          models: ['matrix-model'],
        },
      },
      model: { default: { provider: 'matrix', name: 'matrix-model' } },
      interactionMode: 'auto',
      sandbox: { enabled: false },
      features: {},
      mcpServers: {},
    }),
  );
}

class JsonlMessages {
  readonly #frames: JsonRecord[] = [];
  readonly #waiters = new Set<(frame: JsonRecord) => void>();
  readonly #invalid: string[] = [];
  #maxQueuedFrames = 0;
  readonly done: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.done = this.#collect(stream);
  }

  get count(): number {
    return this.#frames.length;
  }

  get maxQueuedFrames(): number {
    return this.#maxQueuedFrames;
  }

  async next(): Promise<JsonRecord> {
    const value = this.#frames.shift();
    if (value) return value;
    return await within(
      new Promise<JsonRecord>((resolve) => this.#waiters.add(resolve)),
      'stdio protocol message',
    );
  }

  assertProtocolOnly(): void {
    expect(this.#invalid).toEqual([]);
  }

  async #collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        pending += decoder.decode(item.value, { stream: true });
        pending = this.#consume(pending);
      }
      pending += decoder.decode();
      if (pending.length > 0) this.#invalid.push(pending);
    } finally {
      reader.releaseLock();
    }
  }

  #consume(text: string): string {
    const lines = text.split('\n');
    const partial = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value)) this.#invalid.push(line);
        else this.#push(value);
      } catch {
        this.#invalid.push(line);
      }
    }
    return partial;
  }

  #push(frame: JsonRecord): void {
    const waiter = this.#waiters.values().next().value as ((frame: JsonRecord) => void) | undefined;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter(frame);
    } else {
      this.#frames.push(frame);
      this.#maxQueuedFrames = Math.max(this.#maxQueuedFrames, this.#frames.length);
    }
  }
}

class TextCollector {
  readonly done: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.done = this.#collect(stream);
  }

  async #collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) return;
        decoder.decode(item.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  }
}

class SocketMessages {
  readonly #values: JsonRecord[] = [];
  readonly #waiters = new Set<(value: JsonRecord) => void>();
  #maxQueuedFrames = 0;

  constructor(socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const value: unknown = JSON.parse(String(event.data));
      if (!isRecord(value))
        throw new Error('WebSocket carrier emitted a non-object JSON-RPC frame.');
      const waiter = this.#waiters.values().next().value as
        | ((frame: JsonRecord) => void)
        | undefined;
      if (waiter) {
        this.#waiters.delete(waiter);
        waiter(value);
      } else {
        this.#values.push(value);
        this.#maxQueuedFrames = Math.max(this.#maxQueuedFrames, this.#values.length);
      }
    });
  }

  async next(): Promise<JsonRecord> {
    const value = this.#values.shift();
    if (value) return value;
    return await within(
      new Promise<JsonRecord>((resolve) => this.#waiters.add(resolve)),
      'WebSocket protocol message',
    );
  }

  get maxQueuedFrames(): number {
    return this.#maxQueuedFrames;
  }
}

function initialize(id: string): JsonRecord {
  return request(id, 'initialize', {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    clientInfo: { name: 'runtime-transport-conformance', version: '1', instanceId: id },
  });
}

function request(id: string, method: string, params: JsonRecord): JsonRecord {
  return { jsonrpc: '2.0', id, method, params };
}

function response(frame: JsonRecord, id: string): JsonRecord {
  expect(frame).toMatchObject({ jsonrpc: '2.0', id });
  if (!('result' in frame) || !isRecord(frame.result))
    throw new Error(`Expected result for '${id}'.`);
  return frame;
}

function errorCode(frame: JsonRecord): unknown {
  if (!isRecord(frame.error) || !isRecord(frame.error.data))
    throw new Error('Expected a JSON-RPC error.');
  return frame.error.data.code;
}

function subscriptionIdFrom(frame: JsonRecord): string {
  if (!isRecord(frame.result) || typeof frame.result.subscriptionId !== 'string') {
    throw new Error('Subscribe acknowledgement omitted subscriptionId.');
  }
  return frame.result.subscriptionId;
}

function subscriptionMessageType(frame: JsonRecord): string {
  if (!isRecord(frame.params) || !isRecord(frame.params.message)) {
    throw new Error('Malformed runtime/subscription frame.');
  }
  const type = frame.params.message.type;
  if (typeof type !== 'string') throw new Error('Subscription message omitted type.');
  return type;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function nextRecord(
  iterator: AsyncIterator<RuntimeProtocolMessage>,
  label: string,
): Promise<JsonRecord> {
  const item = await within(iterator.next(), label);
  if (item.done || !isRecord(item.value)) throw new Error(`${label} ended unexpectedly.`);
  return item.value;
}

async function openSocket(carrier: DevelopmentLoopbackCarrier, cookie: string): Promise<WebSocket> {
  return await within(
    new Promise<WebSocket>((resolvePromise, reject) => {
      const socket = new WebSocket(carrier.rpcUrl, {
        headers: { Cookie: cookie, Origin: carrier.origin },
      } as unknown as string[]);
      const resolve = () => finish(() => resolvePromise(socket));
      const fail = () => finish(() => reject(new Error('WebSocket failed to open.')));
      const finish = (settle: () => void) => {
        socket.removeEventListener('open', resolve);
        socket.removeEventListener('error', fail);
        settle();
      };
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', fail, { once: true });
    }),
    'WebSocket open',
  );
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState >= WebSocket.CLOSING) return;
  await within(
    new Promise<void>((resolve) => {
      socket.addEventListener('close', () => resolve(), { once: true });
      socket.close();
    }),
    'WebSocket close',
  );
}

async function remainsRunning(
  proc: ReturnType<typeof Bun.spawn>,
  durationMs: number,
): Promise<void> {
  await Bun.sleep(durationMs);
  if (proc.exitCode !== null) throw new Error(`stdio child exited early with ${proc.exitCode}.`);
}

async function expectExit(proc: ReturnType<typeof Bun.spawn>, label: string): Promise<void> {
  await within(proc.exited, label);
}

async function eventually(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} deadline exceeded.`);
    await Bun.sleep(5);
  }
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return await Promise.race([
    promise,
    Bun.sleep(DEADLINE_MS).then(() => {
      throw new Error(`${label} deadline exceeded after ${DEADLINE_MS}ms.`);
    }),
  ]);
}

for (const definition of [inProcessFixture, stdioFixture, webSocketFixture]) {
  test(`Runtime transport conformance: ${definition.name}`, async () => {
    const fixture = await definition.create();
    try {
      await runProtocolMatrix(fixture);
    } finally {
      await fixture.close();
    }
  }, 30_000);
}
