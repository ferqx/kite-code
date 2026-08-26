import { describe, expect, test } from 'bun:test';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import {
  type BunStdioChild,
  BunStdioChildRuntimeClientTransport,
} from '#kite-cli/carrier/bun-stdio-child-transport';

describe('Bun stdio child RuntimeClient transport', () => {
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
    await stuckConnection.close();
    expect(diagnostics).toEqual(
      process.platform === 'win32'
        ? ['stdio_close_deadline']
        : ['stdio_close_deadline', 'stdio_close_deadline'],
    );
    expect(stuck.killCalls).toEqual(process.platform === 'win32' ? [9] : ['SIGTERM', 'SIGKILL']);
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

  constructor(options: { readonly blockFlush?: boolean; readonly killCompletes?: boolean } = {}) {
    this.stdin = new FakeStdin(options.blockFlush);
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
  endCalls = 0;
  #flush: Promise<void> = Promise.resolve();
  #resolveFlush: (() => void) | undefined;

  constructor(blockFlush = false) {
    if (blockFlush) {
      this.#flush = new Promise((resolve) => {
        this.#resolveFlush = resolve;
      });
    }
  }

  write(chunk: Uint8Array): void {
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
