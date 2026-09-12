import { Buffer } from 'node:buffer';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { AsyncMutex } from '../async-mutex';

export const MAX_FRAME_BYTES = 1_048_576;
const QUEUED_FRAMES = 16;
const CLOSE_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 5_000;

type QueueWaiter<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

class BoundedQueue<T> {
  readonly #capacity: number;
  readonly #items: T[] = [];
  readonly #readers: QueueWaiter<T>[] = [];
  readonly #writers: Array<{ value: T; resolve: () => void; reject: (error: Error) => void }> = [];
  #ended?: Error;
  #discarding?: Error;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  async push(value: T): Promise<void> {
    if (this.#ended) throw this.#ended;
    if (this.#discarding) return;
    const reader = this.#readers.shift();
    if (reader) {
      this.#detachAbort(reader);
      reader.resolve(value);
      return;
    }
    if (this.#items.length < this.#capacity) {
      this.#items.push(value);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#writers.push({ value, resolve, reject });
    });
  }

  async shift(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw cancelledReceive();
    if (this.#discarding) throw this.#discarding;
    const item = this.#items.shift();
    if (item !== undefined) {
      this.#admitWriter();
      return item;
    }
    const writer = this.#writers.shift();
    if (writer) {
      writer.resolve();
      return writer.value;
    }
    if (this.#ended) throw this.#ended;
    return new Promise<T>((resolve, reject) => {
      const waiter: QueueWaiter<T> = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.abort = () => {
          const index = this.#readers.indexOf(waiter);
          if (index >= 0) this.#readers.splice(index, 1);
          reject(cancelledReceive());
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.#readers.push(waiter);
    });
  }

  end(error: Error): void {
    if (this.#ended) return;
    this.#ended = error;
    for (const reader of this.#readers.splice(0)) {
      this.#detachAbort(reader);
      reader.reject(error);
    }
    for (const writer of this.#writers.splice(0)) writer.reject(error);
  }

  discard(error: Error): void {
    if (this.#discarding) return;
    this.#discarding = error;
    this.#items.length = 0;
    for (const reader of this.#readers.splice(0)) {
      this.#detachAbort(reader);
      reader.reject(error);
    }
    for (const writer of this.#writers.splice(0)) writer.resolve();
  }

  #admitWriter(): void {
    const writer = this.#writers.shift();
    if (!writer) return;
    const reader = this.#readers.shift();
    if (reader) {
      this.#detachAbort(reader);
      reader.resolve(writer.value);
    } else {
      this.#items.push(writer.value);
    }
    writer.resolve();
  }

  #detachAbort(waiter: QueueWaiter<T>): void {
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
  }
}

export interface ServiceProcessOptions {
  executable: string;
  workspace: string;
  home: string;
  runtimeRoot: string;
  buildId: string;
  environmentKeys: readonly string[];
}

/** One exact paired Service child with bounded stdout retention and EOF-owned cleanup. */
export class ServiceProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #output = new BoundedQueue<string>(QUEUED_FRAMES);
  readonly #write = new AsyncMutex();
  #receiving = false;
  #receiverSettled: Promise<void> = Promise.resolve();
  #settleReceiver: (() => void) | undefined;
  #finished = false;
  #closing = false;
  #closePromise?: Promise<void>;
  readonly #ready: Promise<void>;
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  static async start(options: ServiceProcessOptions): Promise<ServiceProcess> {
    const process = new ServiceProcess(options);
    await process.#ready;
    return process;
  }

  private constructor(options: ServiceProcessOptions) {
    const source = process.env;
    const environment: NodeJS.ProcessEnv = {
      HOME: options.home,
      USERPROFILE: options.home,
      PATH: source.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      NODE_ENV: 'production',
      KITE_CODE_HOME: options.runtimeRoot,
      KITE_CODE_CONFIG_HOME: join(options.home, '.kite-code'),
      KITE_APP_SERVER_BUILD_ID: options.buildId,
      KITE_STANDALONE_EXECUTABLE: '1',
    };
    if (options.workspace) environment.KITE_APP_SERVER_WORKSPACE = options.workspace;
    for (const key of options.environmentKeys) {
      const value = source[key];
      if (value !== undefined) environment[key] = value;
    }
    this.#child = spawn(options.executable, ['app-server', 'run-stdio'], {
      cwd: options.home,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // A broken Service pipe must reject the bounded write, never become an
    // unhandled EventEmitter error that terminates Electron's main process.
    this.#child.stdin.on('error', () => undefined);
    this.#child.stdout.on('error', () => undefined);
    this.#child.stderr.on('error', () => undefined);
    this.#child.stderr.resume();
    this.#ready = new Promise((resolve, reject) => {
      this.#child.once('spawn', resolve);
      this.#child.once('error', () =>
        reject(new Error('无法启动配套服务，请检查安装与执行权限。')),
      );
    });
    this.#exit = new Promise((resolve, reject) => {
      this.#child.once('error', reject);
      this.#child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    void this.#readOutput(this.#child.stdout);
    void this.#exit.then(
      () => {
        this.#finished = true;
      },
      () => {
        this.#finished = true;
      },
    );
  }

  get finished(): boolean {
    return this.#finished;
  }

  async send(frame: string): Promise<void> {
    if (
      Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES ||
      frame.includes('\n') ||
      frame.includes('\r') ||
      this.#finished ||
      this.#closing
    )
      throw new Error('消息无效或连接已关闭。');
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      throw new Error('无效的协议消息。');
    }
    if (!isRecord(value)) throw new Error('无效的协议消息。');
    return this.#write.run(async () => {
      if (this.#finished || this.#closing || !this.#child.stdin.writable)
        throw new Error('连接已关闭。');
      try {
        await withTimeout(
          write(this.#child, `${frame}\n`),
          SEND_TIMEOUT_MS,
          '发送超时，提交结果未知。',
        );
      } catch (error) {
        void this.close().catch(() => undefined);
        if (error instanceof Error && error.message.includes('超时')) throw error;
        throw new Error('发送结果未知，请检查会话。');
      }
    });
  }

  async receive(signal?: AbortSignal): Promise<string> {
    if (this.#receiving) throw new Error('同一连接只能有一个消息消费者。');
    this.#receiving = true;
    this.#receiverSettled = new Promise<void>((resolve) => {
      this.#settleReceiver = resolve;
    });
    try {
      return await this.#output.shift(signal);
    } finally {
      this.#receiving = false;
      this.#settleReceiver?.();
      this.#settleReceiver = undefined;
    }
  }

  async waitForReceiver(): Promise<void> {
    await this.#receiverSettled;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closing = true;
    // Once shutdown owns the peer, no renderer may consume retained output.
    // Release queue backpressure and keep the stdout task draining so the
    // Service can observe stdin EOF and finish its own cleanup.
    this.#output.discard(new Error('连接已关闭。'));
    if (!this.#child.stdin.destroyed) this.#child.stdin.end();
    let result: { code: number | null; signal: NodeJS.Signals | null };
    try {
      result = await withTimeout(this.#exit, CLOSE_TIMEOUT_MS, 'timeout');
    } catch (error) {
      if (!(error instanceof OperationTimeout)) throw new Error('无法确认服务退出。');
      this.#child.kill('SIGKILL');
      await withTimeout(this.#exit, 5_000, 'kill timeout').catch(() => undefined);
      throw new Error('服务清理超时，已终止自有进程；任务副作用需要检查。');
    }
    if (result.code !== 0) throw new Error('配套服务异常退出，请检查任务结果。');
  }

  async #readOutput(stream: Readable): Promise<void> {
    let frame = Buffer.alloc(0);
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(0x0a, offset);
          const end = newline < 0 ? chunk.length : newline + 1;
          if (frame.length + end - offset > MAX_FRAME_BYTES + 2)
            throw new Error('服务输出超过协议大小限制。');
          frame = Buffer.concat([frame, chunk.subarray(offset, end)]);
          offset = end;
          if (newline >= 0) {
            frame = frame.subarray(0, -1);
            if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
            if (frame.length > MAX_FRAME_BYTES) throw new Error('服务输出超过协议大小限制。');
            const text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
            frame = Buffer.alloc(0);
            await this.#output.push(text);
          }
        }
      }
      if (frame.length) throw new Error('服务输出消息被截断。');
      this.#output.end(new Error('配套服务连接已关闭。'));
    } catch (error) {
      this.#output.end(
        error instanceof TypeError
          ? new Error('服务输出不是有效 UTF-8。')
          : error instanceof Error
            ? error
            : new Error('服务输出读取失败。'),
      );
      // Invalid, oversized or truncated stdout invalidates the protocol peer.
      // EOF gives the owned Service its normal cancellation/cleanup path.
      void this.close().catch(() => undefined);
    }
  }
}

function write(child: ChildProcessWithoutNullStreams, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.write(value, (error) => (error ? reject(error) : resolve()));
  });
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OperationTimeout(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class OperationTimeout extends Error {}

function cancelledReceive(): Error {
  return new Error('页面连接已被替换。');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
