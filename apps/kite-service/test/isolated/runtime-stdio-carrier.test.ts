import { describe, expect, test } from 'bun:test';
import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeCommand,
  RuntimeQuery,
  RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import { RuntimeServer, type RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import {
  createNodeRuntimeStdioOutput,
  createRuntimeStdioCarrier,
  type RuntimeStdioDiagnostics,
  type RuntimeStdioOutput,
  type RuntimeStdioSignals,
} from '#kite-service/carrier/runtime-server-stdio';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('Runtime stdio carrier', () => {
  test('the concrete writable adapter flushes only after write callbacks complete', async () => {
    let completeWrite: ((error?: Error | null) => void) | undefined;
    const output = createNodeRuntimeStdioOutput({
      write: (_chunk, callback) => {
        completeWrite = callback;
        return true;
      },
      once: () => undefined,
    });
    await output.write(encoder.encode('one line'));
    let flushed = false;
    const completion = output.flush?.().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    completeWrite?.();
    await completion;
    expect(flushed).toBe(true);
  });

  test('decodes fragmented, multiple, CRLF JSONL frames and keeps stdout protocol-only', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const carrier = createCarrier({ input, output });

    input.pushText('{"jsonrpc":"2.0","id":"init","method":"initial');
    input.pushText(
      'ize","params":{"protocolVersion":1,"clientInfo":{"name":"test","version":"1","instanceId":"a"}}}\r\n',
    );
    input.pushText('{"jsonrpc":"2.0","id":"ping","method":"server/ping","params":{}}\n');

    await eventually(() => protocolFrames(output).length === 2);
    expect(protocolFrames(output)).toMatchObject([
      { id: 'init', result: { protocolVersion: 1 } },
      { id: 'ping', result: { status: 'ok' } },
    ]);
    expect(output.text()).toMatch(/^\{.*\}\n\{.*\}\n$/s);

    input.close();
    await carrier.done;
  });

  test('emits the standard parse_error and continues with the next line', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const carrier = createCarrier({ input, output });

    input.pushText('{not json}\n');
    input.pushText(initializeLine());

    await eventually(() => protocolFrames(output).length === 2);
    expect(protocolFrames(output)[0]).toMatchObject({
      id: null,
      error: { code: -32700, data: { code: 'parse_error' } },
    });
    expect(protocolFrames(output)[1]).toMatchObject({ id: 'init', result: { protocolVersion: 1 } });

    input.close();
    await carrier.done;
  });

  test('keeps History on the initialized App connection and fails closed without its owner', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const carrier = createCarrier({ input, output });
    const history = JSON.stringify({
      jsonrpc: '2.0',
      id: 'history-1',
      method: 'history/list_sessions',
      params: { request: { limit: 10 } },
    });
    input.pushText(`${history}\n${initializeLine()}`);
    await eventually(() => protocolFrames(output).length === 2);
    expect(protocolFrames(output)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'history-1',
          error: expect.objectContaining({ data: { code: 'not_initialized' } }),
        }),
        expect.objectContaining({
          id: 'init',
          result: expect.objectContaining({ protocolVersion: 1 }),
        }),
      ]),
    );
    input.pushText(`${history.replace('history-1', 'history-2')}\n`);
    await eventually(() => protocolFrames(output).length === 3);
    expect(protocolFrames(output)[2]).toMatchObject({
      id: 'history-2',
      error: { data: { code: 'method_not_found' } },
    });
    input.close();
    await carrier.done;
  });

  test('fails closed for invalid UTF-8 and overlong raw lines without echoing input', async () => {
    const invalidInput = new BytesInput();
    const invalidOutput = new FakeOutput();
    const invalidDiagnostics = new FakeDiagnostics();
    const invalid = createCarrier({
      input: invalidInput,
      output: invalidOutput,
      diagnostics: invalidDiagnostics,
    });
    invalidInput.push(new Uint8Array([0xc3, 0x28, 0x0a]));
    await invalid.done;
    expect(invalidOutput.text()).toBe('');
    expect(invalidDiagnostics.text()).toContain('invalid_utf8');
    expect(invalidDiagnostics.text()).not.toContain('c3');

    const overlongInput = new BytesInput();
    const overlongOutput = new FakeOutput();
    const overlongDiagnostics = new FakeDiagnostics();
    const overlong = createCarrier({
      input: overlongInput,
      output: overlongOutput,
      diagnostics: overlongDiagnostics,
      maxLineBytes: 8,
    });
    overlongInput.pushText('123456789');
    await overlong.done;
    expect(overlongOutput.text()).toBe('');
    expect(overlongDiagnostics.text()).toContain('overlong_line');
  });

  test('serializes stdout writes, waits for drain, and closes on a bounded drain timeout', async () => {
    const input = new BytesInput();
    const output = new FakeOutput({ blockFirstWrite: true });
    const carrier = createCarrier({ input, output, drainDeadlineMs: 50 });

    input.pushText('{not json}\n');
    input.pushText(initializeLine());
    await eventually(() => output.writeCount === 1);
    expect(protocolFrames(output)).toHaveLength(1);
    output.drain();
    await eventually(() => protocolFrames(output).length === 2);
    input.close();
    await carrier.done;

    const timeoutInput = new BytesInput();
    const timeoutOutput = new FakeOutput({ blockFirstWrite: true });
    const timeoutDiagnostics = new FakeDiagnostics();
    const timeout = createCarrier({
      input: timeoutInput,
      output: timeoutOutput,
      diagnostics: timeoutDiagnostics,
      drainDeadlineMs: 5,
    });
    timeoutInput.pushText('{not json}\n');
    await timeout.done;
    await eventually(() => timeout.server.connectionCount === 0);
    expect(timeoutDiagnostics.text()).toContain('stdout_failure');
  });

  test('stdin EOF releases only the Server connection, not the owner composition', async () => {
    const input = new BytesInput();
    let releases = 0;
    const carrier = createCarrier({
      input,
      output: new FakeOutput(),
      shutdownComposition: () => {
        releases += 1;
      },
    });

    expect(carrier.server.connectionCount).toBe(1);
    input.close();
    await carrier.done;
    await eventually(() => carrier.server.connectionCount === 0);
    expect(releases).toBe(0);

    const reconnectInput = new BytesInput();
    const reconnectOutput = new FakeOutput();
    const reconnect = createRuntimeStdioCarrier({
      server: carrier.server,
      stdin: reconnectInput,
      stdout: reconnectOutput,
    });
    reconnectInput.pushText(initializeLine());
    await eventually(() => protocolFrames(reconnectOutput).length === 1);
    reconnectInput.close();
    await reconnect.done;
    expect(releases).toBe(0);
  });

  test('an input transport failure releases its connection without releasing composition', async () => {
    let releases = 0;
    const diagnostics = new FakeDiagnostics();
    const carrier = createCarrier({
      input: new FailingInput(),
      output: new FakeOutput(),
      diagnostics,
      shutdownComposition: () => {
        releases += 1;
      },
    });

    await carrier.done;
    await eventually(() => carrier.server.connectionCount === 0);
    expect(diagnostics.text()).toContain('input_failure');
    expect(releases).toBe(0);
  });

  test('stdin EOF retains owner signals until SIGTERM drains, flushes, and releases composition', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const signals = new FakeSignals();
    let releases = 0;
    const carrier = createCarrier({
      input,
      output,
      signals,
      shutdownComposition: () => {
        releases += 1;
      },
    });

    input.close();
    await carrier.done;
    await eventually(() => carrier.server.connectionCount === 0);
    expect(releases).toBe(0);
    expect(signals.listenerCount()).toBe(2);

    signals.emit('SIGTERM');
    await carrier.shutdown();
    expect(releases).toBe(1);
    expect(output.flushCount).toBe(1);
    expect(signals.listenerCount()).toBe(0);
  });

  test('owner signals and explicit shutdown are idempotent, drain, flush, and release composition once', async () => {
    const input = new BytesInput();
    const output = new FakeOutput();
    const signals = new FakeSignals();
    let releases = 0;
    const carrier = createCarrier({
      input,
      output,
      signals,
      shutdownComposition: async () => {
        releases += 1;
      },
    });

    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    await carrier.shutdown();
    await carrier.done;

    expect(releases).toBe(1);
    expect(output.flushCount).toBe(1);
    expect(protocolFrames(output)).toContainEqual(
      expect.objectContaining({ method: 'server/draining' }),
    );
    expect(signals.listenerCount()).toBe(0);
  });
});

function createCarrier(options: {
  readonly input: AsyncIterable<Uint8Array>;
  readonly output: FakeOutput;
  readonly diagnostics?: FakeDiagnostics;
  readonly signals?: FakeSignals;
  readonly maxLineBytes?: number;
  readonly drainDeadlineMs?: number;
  readonly shutdownComposition?: () => void | Promise<void>;
}) {
  const server = new RuntimeServer(
    { runtime: new FakeRuntime(), admission: allowAdmission },
    { serverInfo: { version: 'test', instanceId: 'server-1' } },
  );
  const carrier = createRuntimeStdioCarrier({
    server,
    stdin: options.input,
    stdout: options.output,
    stderr: options.diagnostics,
    signals: options.signals,
    maxLineBytes: options.maxLineBytes,
    drainDeadlineMs: options.drainDeadlineMs,
    shutdownComposition: options.shutdownComposition,
  });
  return { ...carrier, server };
}

const allowAdmission: RuntimeServerAdmissionPort = {
  authorize: async () => ({ allowed: true, workspace: '/trusted/workspace' }),
};

function initializeLine(): string {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'test', version: '1', instanceId: 'a' },
    },
  })}\n`;
}

function protocolFrames(output: FakeOutput): unknown[] {
  return output
    .text()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

class BytesInput implements AsyncIterable<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #waiters = new Set<(result: IteratorResult<Uint8Array>) => void>();
  #closed = false;

  push(value: Uint8Array): void {
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter({ done: false, value });
      return;
    }
    this.#values.push(value);
  }

  pushText(value: string): void {
    this.push(encoder.encode(value));
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters) waiter({ done: true, value: undefined });
    this.#waiters.clear();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<Uint8Array>>((resolve) => this.#waiters.add(resolve));
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

class FailingInput implements AsyncIterable<Uint8Array> {
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        throw new Error('simulated child transport failure');
      },
    };
  }
}

class FakeOutput implements RuntimeStdioOutput {
  readonly #chunks: Uint8Array[] = [];
  readonly #blockFirstWrite: boolean;
  #drainPromise: Promise<void> | undefined;
  #resolveDrain: (() => void) | undefined;
  writeCount = 0;
  flushCount = 0;

  constructor(options: { readonly blockFirstWrite?: boolean } = {}) {
    this.#blockFirstWrite = options.blockFirstWrite ?? false;
  }

  write(chunk: Uint8Array): boolean {
    this.writeCount += 1;
    this.#chunks.push(new Uint8Array(chunk));
    if (this.#blockFirstWrite && this.writeCount === 1) {
      this.#drainPromise ??= new Promise<void>((resolve) => {
        this.#resolveDrain = resolve;
      });
      return false;
    }
    return true;
  }

  waitForDrain(): Promise<void> {
    return this.#drainPromise ?? Promise.resolve();
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }

  drain(): void {
    this.#resolveDrain?.();
  }

  text(): string {
    return decoder.decode(concat(this.#chunks));
  }
}

class FakeDiagnostics implements RuntimeStdioDiagnostics {
  readonly #messages: string[] = [];

  write(message: string): void {
    this.#messages.push(message);
  }

  text(): string {
    return this.#messages.join('');
  }
}

class FakeSignals implements RuntimeStdioSignals {
  readonly #listeners = new Map<'SIGINT' | 'SIGTERM', Set<() => void>>();

  subscribe(signal: 'SIGINT' | 'SIGTERM', listener: () => void): () => void {
    const listeners = this.#listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(signal, listeners);
    return () => listeners.delete(listener);
  }

  emit(signal: 'SIGINT' | 'SIGTERM'): void {
    for (const listener of this.#listeners.get(signal) ?? []) listener();
  }

  listenerCount(): number {
    return [...this.#listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

class FakeRuntime implements RuntimeAccess {
  command(_command: RuntimeCommand) {
    return Promise.resolve({
      status: 'applied' as const,
      commandId: 'unused',
      sessionId: 'unused',
      revision: 1,
    });
  }

  query(_query: RuntimeQuery) {
    return Promise.resolve({
      status: 'ok' as const,
      queryType: 'list_sessions' as const,
      sessions: [],
    });
  }

  subscribe(_subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<RuntimeAccessNotification>>(() => undefined),
      }),
    };
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition did not settle.');
}
