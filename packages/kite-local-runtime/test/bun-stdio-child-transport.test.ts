import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  RuntimeClient,
  type RuntimeClientConnection,
  RuntimeClientStartupError,
} from '@kite-ai/runtime-client';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import {
  type BunStdioChild,
  BunStdioChildRuntimeClientTransport,
  type BunStdioStartupSignals,
} from '../src/client/bun-stdio-child-transport';
import {
  encodeServiceStartupProgress,
  SERVICE_STARTUP_DIAGNOSTIC_PREFIX,
  type ServiceStartupProgress,
} from '../src/service-startup-diagnostic';

describe('Bun stdio child RuntimeClient transport', () => {
  test('real child exit before initialize preserves only whitelisted Store startup facts', async () => {
    for (const code of [
      'store_incompatible',
      'store_history_reconciliation_required',
      'store_insufficient_space',
    ] as const) {
      const line = `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}${JSON.stringify({
        code,
        actualSchema: 11,
        expectedSchema: 10,
      })}\n`;
      const runtime = new RuntimeClient({
        clientInfo: { name: 'test', version: '1', instanceId: 'startup-test' },
        transport: new BunStdioChildRuntimeClientTransport({
          argv: [
            process.execPath,
            '-e',
            `process.stderr.write(${JSON.stringify(line)}); process.stderr.write('secret-path\\n'); process.exit(1);`,
          ],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        }),
      });
      try {
        const error: unknown = await withTestDeadline(runtime.connect(), 3_000).catch(
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(RuntimeClientStartupError);
        expect(error).toMatchObject({ diagnosticCode: code, actualSchema: 11, expectedSchema: 10 });
        expect(String(error)).not.toContain('secret-path');
      } finally {
        await runtime.close();
      }
    }
  });

  test('real child arbitrary stderr remains a generic startup disconnect', async () => {
    const runtime = new RuntimeClient({
      clientInfo: { name: 'test', version: '1', instanceId: 'untrusted-startup-test' },
      transport: new BunStdioChildRuntimeClientTransport({
        argv: [process.execPath, '-e', `process.stderr.write('secret-path\\n'); process.exit(1);`],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      }),
    });
    try {
      await expect(withTestDeadline(runtime.connect(), 3_000)).rejects.toMatchObject({
        code: 'connection_closed',
      });
    } finally {
      await runtime.close();
    }
  });

  test('initialize write failure racing stderr and EOF retains the typed startup fact', async () => {
    const child = new FakeChild({ failWrite: true });
    const runtime = new RuntimeClient({
      clientInfo: { name: 'test', version: '1', instanceId: 'write-race-test' },
      transport: transport(() => child),
    });
    const connecting = runtime.connect();
    child.stderrText(
      `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}${JSON.stringify({
        code: 'store_migration_required',
        actualSchema: 9,
        expectedSchema: 10,
      })}\n`,
    );
    child.exit();
    child.closeStreams();
    await expect(withTestDeadline(connecting, 3_000)).rejects.toMatchObject({
      code: 'startup_failure',
      diagnosticCode: 'store_migration_required',
    });
    await runtime.close();
  });

  test('reports only complete strict progress and retains a terminal fact after long stderr', async () => {
    const child = new FakeChild({ failWrite: true });
    const progress: ServiceStartupProgress[] = [];
    const runtime = new RuntimeClient({
      clientInfo: { name: 'test', version: '1', instanceId: 'progress-test' },
      transport: transport(() => child, { onStartupProgress: (event) => progress.push(event) }),
    });
    const connecting = runtime.connect();
    child.stderrText(encodeServiceStartupProgress('inspecting').slice(0, 19));
    child.stderrText(encodeServiceStartupProgress('inspecting').slice(19));
    child.stderrText('secret='.concat('x'.repeat(12_000), '\n'));
    child.stderrText(
      `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}${JSON.stringify({
        code: 'store_access_denied',
        actualSchema: null,
        expectedSchema: 10,
        stage: 'preparing',
      })}\n`,
    );
    child.exit();
    child.closeStreams();
    await expect(withTestDeadline(connecting, 3_000)).rejects.toMatchObject({
      code: 'startup_failure',
      diagnosticCode: 'store_access_denied',
      stage: 'preparing',
    });
    expect(progress).toEqual([{ phase: 'inspecting' }]);
    await runtime.close();
  });

  test('disconnect after a valid initialize remains a generic connection failure', async () => {
    const child = new FakeChild();
    const progress: ServiceStartupProgress[] = [];
    const connection = await transport(() => child, {
      onStartupProgress: (event) => progress.push(event),
    }).connect();
    const messages = connection.messages()[Symbol.asyncIterator]();
    await connection.send({
      jsonrpc: '2.0',
      id: 'initialize-1',
      method: 'initialize',
      params: {
        protocolVersion: 2,
        clientInfo: { name: 'test', version: '1', instanceId: 'test' },
      },
    });
    child.stdoutText(
      line({
        jsonrpc: '2.0',
        id: 'initialize-1',
        result: {
          protocolVersion: 2,
          protocolSchema: 'kite.runtime-protocol.v2',
          serverInfo: { version: '1', instanceId: 'server-1' },
          capabilities: {
            methods: [
              'initialize',
              'runtime/command',
              'runtime/query',
              'runtime/subscribe',
              'runtime/unsubscribe',
              'server/ping',
            ],
            subscriptions: ['session', 'sessions'],
          },
          limits: {
            maxMessageBytes: 1024,
            maxDepth: 8,
            maxInFlightRequests: 8,
            maxSubscriptions: 8,
            maxOutboundMessages: 8,
          },
        },
      }),
    );
    expect((await messages.next()).done).toBe(false);
    child.stderrText(encodeServiceStartupProgress('preparing'));
    child.stderrText(
      `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}${JSON.stringify({
        code: 'store_incompatible',
        actualSchema: 11,
        expectedSchema: 10,
      })}\n`,
    );
    child.exit();
    child.closeStreams();
    await expect(messages.next()).rejects.toThrow('Runtime stdio connection failed.');
    expect(progress).toEqual([]);
    await connection.close();
  });
  test('decodes fragmented, multiple, and CRLF stdout JSONL frames', async () => {
    const child = new FakeChild();
    const connection = await transport(() => child).connect();
    const messages = connection.messages()[Symbol.asyncIterator]();

    child.stdoutText('{"jsonrpc":"2.0","id":"one","result":{"status":"ok"');
    child.stdoutText('}}\r\n{"jsonrpc":"2.0","id":"two","result":{"status":"ok"}}\n');

    expect(await messages.next()).toEqual({ done: false, value: pingResponse('one') });
    expect(await messages.next()).toEqual({ done: false, value: pingResponse('two') });
    await connection.close();
  });

  test('strictly encodes writes as UTF-8 JSONL and awaits the pipe flush', async () => {
    const child = new FakeChild({ blockFlush: true });
    const connection = await transport(() => child).connect();

    const sending = connection.send(pingRequest());
    await Promise.resolve();
    expect(child.stdin.writes).toEqual([`${JSON.stringify(pingRequest())}\n`]);
    let settled = false;
    void sending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdin.releaseFlush();
    await sending;

    await expect(
      connection.send({ jsonrpc: '2.0', id: 'x', method: 'unknown', params: {} } as never),
    ).rejects.toThrow('invalid protocol message');
    await connection.close();
  });

  test('finishes an already-started write before stdin EOF and child termination', async () => {
    const child = new FakeChild({ blockFlush: true });
    const connection = await transport(() => child).connect();
    const sending = connection.send(pingRequest());
    await Promise.resolve();

    const closing = connection.close();
    await Promise.resolve();
    expect(child.stdin.endCalls).toBe(0);
    expect(child.killCalls).toEqual([]);

    child.stdin.releaseFlush();
    await sending;
    await closing;
    expect(child.stdin.endCalls).toBe(1);
    expect(child.killCalls).toEqual([process.platform === 'win32' ? 9 : 'SIGTERM']);
  });

  test('bounds the receive queue and fails closed for overlong or malformed stdout', async () => {
    const queuedChild = new FakeChild();
    const queuedDiagnostics: string[] = [];
    const queued = await transport(() => queuedChild, {
      maxQueuedMessages: 1,
      onDiagnostic: (code) => queuedDiagnostics.push(code),
    }).connect();
    queuedChild.stdoutText(`${line(pingResponse('one'))}${line(pingResponse('two'))}`);
    await Bun.sleep(0);
    await expect(queued.messages()[Symbol.asyncIterator]().next()).rejects.toThrow(
      'Runtime stdio connection failed.',
    );
    expect(queuedDiagnostics).toEqual(['stdio_stdout_failure']);

    const overlongChild = new FakeChild();
    const overlongDiagnostics: string[] = [];
    const overlong = await transport(() => overlongChild, {
      maxLineBytes: 16,
      onDiagnostic: (code) => overlongDiagnostics.push(code),
    }).connect();
    overlongChild.stdoutText('{"secret":"must-not-echo"\n');
    await expect(overlong.messages()[Symbol.asyncIterator]().next()).rejects.toThrow(
      'Runtime stdio connection failed.',
    );
    expect(overlongDiagnostics).toEqual(['stdio_stdout_overlong_line']);
    expect(JSON.stringify(overlongDiagnostics)).not.toContain('must-not-echo');

    const malformedChild = new FakeChild();
    const malformedDiagnostics: string[] = [];
    const malformed = await transport(() => malformedChild, {
      onDiagnostic: (code) => malformedDiagnostics.push(code),
    }).connect();
    malformedChild.stdoutText('{"secret":"must-not-echo"\n');
    await expect(malformed.messages()[Symbol.asyncIterator]().next()).rejects.toThrow(
      'Runtime stdio connection failed.',
    );
    expect(malformedDiagnostics).toEqual(['stdio_stdout_malformed_json']);
    expect(JSON.stringify(malformedDiagnostics)).not.toContain('must-not-echo');
  });

  test('drains stderr without surfacing its contents and fails on child crash', async () => {
    const child = new FakeChild();
    const diagnostics: string[] = [];
    const connection = await transport(() => child, {
      onDiagnostic: (code) => diagnostics.push(code),
    }).connect();
    const pending = connection.messages()[Symbol.asyncIterator]().next();

    child.stderrText('credential=must-not-echo\n');
    child.exit();
    await expect(pending).rejects.toThrow('Runtime stdio connection failed.');
    expect(diagnostics).toEqual(['stdio_child_exited']);
    expect(JSON.stringify(diagnostics)).not.toContain('credential');
  });

  test('closes idempotently by EOF first, then terminates and bounds handle waits', async () => {
    const child = new FakeChild();
    const connection = await transport(() => child, { closeDeadlineMs: 50 }).connect();
    await connection.close();
    await connection.close();
    expect(child.stdin.endCalls).toBe(1);
    expect(child.killCalls).toEqual([process.platform === 'win32' ? 9 : 'SIGTERM']);

    const stuck = new FakeChild({ killCompletes: false });
    const diagnostics: string[] = [];
    const stuckConnection = await transport(() => stuck, {
      closeDeadlineMs: 5,
      onDiagnostic: (code) => diagnostics.push(code),
    }).connect();
    await initialize(stuckConnection, stuck);
    await stuckConnection.close();
    expect(diagnostics).toEqual(
      process.platform === 'win32'
        ? ['stdio_close_deadline']
        : ['stdio_close_deadline', 'stdio_close_deadline'],
    );
    expect(stuck.killCalls).toEqual(process.platform === 'win32' ? [9] : ['SIGTERM', 'SIGKILL']);
  });

  test('pre-initialize close waits beyond deadline for real exit without force kill', async () => {
    const child = new FakeChild({ killCompletes: false });
    const diagnostics: string[] = [];
    const connection = await transport(() => child, {
      closeDeadlineMs: 5,
      onDiagnostic: (code) => diagnostics.push(code),
    }).connect();
    let closed = false;
    const closing = connection.close().then(() => {
      closed = true;
    });
    await Bun.sleep(25);
    expect(closed).toBe(false);
    expect(child.killCalls).toEqual(['SIGTERM']);
    expect(diagnostics).toEqual([]);
    child.exit();
    child.closeStreams();
    await withTestDeadline(closing, 1_000);
    expect(closed).toBe(true);
    expect(child.killCalls).toEqual(['SIGTERM']);
  });

  test('startup signal closes the owned child and keeps the listener until exit', async () => {
    const child = new FakeChild({ killCompletes: false });
    const signals = new EventEmitter();
    const connection = await transport(() => child, {
      closeDeadlineMs: 5,
      startupSignals: signals,
    }).connect();
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    signals.emit('SIGINT');
    await Bun.sleep(25);
    expect(child.killCalls).toEqual(['SIGTERM']);
    expect(signals.listenerCount('SIGINT')).toBe(1);
    child.exit();
    child.closeStreams();
    await withTestDeadline(connection.close(), 1_000);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  test('successful initialize removes temporary startup signal listeners', async () => {
    const child = new FakeChild();
    const signals = new EventEmitter();
    const connection = await transport(() => child, { startupSignals: signals }).connect();
    await initialize(connection, child);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    signals.emit('SIGINT');
    expect(child.killCalls).toEqual([]);
    await connection.close();
  });

  test('spawns a fresh child for every reconnect', async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const children = [first, second];
    let calls = 0;
    const runtime = transport(() => {
      calls += 1;
      const child = children.shift();
      if (!child) throw new Error('unexpected child');
      return child;
    });

    const firstConnection = await runtime.connect();
    await firstConnection.close();
    const secondConnection = await runtime.connect();
    expect(calls).toBe(2);
    expect(secondConnection).not.toBe(firstConnection);
    await secondConnection.close();
  });
});

function transport(
  spawn: () => BunStdioChild,
  options: {
    readonly closeDeadlineMs?: number;
    readonly maxLineBytes?: number;
    readonly maxQueuedMessages?: number;
    readonly onDiagnostic?: (code: string) => void;
    readonly onStartupProgress?: (progress: ServiceStartupProgress) => void;
    readonly startupSignals?: BunStdioStartupSignals;
  } = {},
): BunStdioChildRuntimeClientTransport {
  return new BunStdioChildRuntimeClientTransport({
    argv: ['kite-runtime-child', '--stdio'],
    cwd: '/isolated/runtime',
    env: { KITE_RUNTIME_TEST: '1' },
    spawn: () => spawn(),
    ...options,
  });
}

function pingRequest(): RuntimeProtocolMessage {
  return { jsonrpc: '2.0', id: 'ping', method: 'server/ping', params: {} };
}

function pingResponse(id: string) {
  return { jsonrpc: '2.0' as const, id, result: { status: 'ok' } };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function initialize(connection: RuntimeClientConnection, child: FakeChild): Promise<void> {
  const messages = connection.messages()[Symbol.asyncIterator]();
  await connection.send({
    jsonrpc: '2.0',
    id: 'initialize-1',
    method: 'initialize',
    params: {
      protocolVersion: 2,
      clientInfo: { name: 'test', version: '1', instanceId: 'test' },
    },
  });
  child.stdoutText(
    line({
      jsonrpc: '2.0',
      id: 'initialize-1',
      result: {
        protocolVersion: 2,
        protocolSchema: 'kite.runtime-protocol.v2',
        serverInfo: { version: '1', instanceId: 'server-1' },
        capabilities: {
          methods: [
            'initialize',
            'runtime/command',
            'runtime/query',
            'runtime/subscribe',
            'runtime/unsubscribe',
            'server/ping',
          ],
          subscriptions: ['session', 'sessions'],
        },
        limits: {
          maxMessageBytes: 1024,
          maxDepth: 8,
          maxInFlightRequests: 8,
          maxSubscriptions: 8,
          maxOutboundMessages: 8,
        },
      },
    }),
  );
  expect((await messages.next()).done).toBe(false);
}

class FakeChild implements BunStdioChild {
  readonly stdin: FakeStdin;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<void>;
  readonly killCalls: (string | number | undefined)[] = [];
  #stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  #stderrController!: ReadableStreamDefaultController<Uint8Array>;
  #resolveExited!: () => void;
  #finished = false;
  readonly #killCompletes: boolean;

  constructor(
    options: {
      readonly blockFlush?: boolean;
      readonly killCompletes?: boolean;
      readonly failWrite?: boolean;
    } = {},
  ) {
    this.stdin = new FakeStdin(options.blockFlush, options.failWrite);
    this.#killCompletes = options.killCompletes ?? true;
    this.stdout = new ReadableStream({
      start: (controller) => {
        this.#stdoutController = controller;
      },
    });
    this.stderr = new ReadableStream({
      start: (controller) => {
        this.#stderrController = controller;
      },
    });
    this.exited = new Promise((resolve) => {
      this.#resolveExited = resolve;
    });
  }

  stdoutText(value: string): void {
    this.#stdoutController.enqueue(new TextEncoder().encode(value));
  }

  stderrText(value: string): void {
    this.#stderrController.enqueue(new TextEncoder().encode(value));
  }

  exit(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#resolveExited();
  }

  closeStreams(): void {
    this.#stdoutController.close();
    this.#stderrController.close();
  }

  kill(signal?: string | number): void {
    this.killCalls.push(signal);
    if (!this.#killCompletes || this.#finished) return;
    this.#finished = true;
    this.#stdoutController.close();
    this.#stderrController.close();
    this.#resolveExited();
  }
}

class FakeStdin {
  readonly writes: string[] = [];
  readonly failWrite: boolean;
  endCalls = 0;
  #flush: Promise<void> = Promise.resolve();
  #resolveFlush: (() => void) | undefined;

  constructor(blockFlush = false, failWrite = false) {
    this.failWrite = failWrite;
    if (blockFlush) {
      this.#flush = new Promise((resolve) => {
        this.#resolveFlush = resolve;
      });
    }
  }

  write(chunk: Uint8Array): void {
    if (this.failWrite) throw new Error('EPIPE private detail');
    this.writes.push(new TextDecoder().decode(chunk));
  }

  flush(): Promise<void> {
    return this.#flush;
  }

  end(): void {
    this.endCalls += 1;
  }

  releaseFlush(): void {
    this.#resolveFlush?.();
  }
}

function withTestDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('test deadline exceeded')), milliseconds),
    ),
  ]);
}
