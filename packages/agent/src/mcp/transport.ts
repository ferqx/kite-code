import { type ChildProcess, spawn } from 'node:child_process';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

/** Bounded newline transport; the SDK's unbounded stdio read buffer is not used. */
export class BoundedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcess;
  private buffer = Buffer.alloc(0);
  private closeTask?: Promise<void>;
  private writes = 0;
  private readonly options: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  };
  private readonly maximum: number;
  constructor(
    options: { command: string; args: string[]; cwd: string; env: Record<string, string> },
    maximum: number,
  ) {
    this.options = options;
    this.maximum = maximum;
  }
  async start() {
    if (this.child) throw new Error('mcp_transport_already_started');
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr?.resume();
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        // Drain complete lines incrementally without accumulating a combined giant chunk.
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          if (this.buffer.length + end - offset > this.maximum) throw new Error('mcp_frame_limit');
          this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)]);
          if (newline < 0) break;
          const line = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer);
          this.buffer = Buffer.alloc(0);
          this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
          offset = newline + 1;
        }
      } catch {
        this.onerror?.(new Error('mcp_frame_invalid'));
        void this.close();
      }
    });
    child.on('error', () => this.onerror?.(new Error('mcp_stdio_error')));
    child.on('close', () => {
      this.buffer = Buffer.alloc(0);
      this.onclose?.();
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new Error('mcp_stdio_error')));
    });
  }
  async send(message: JSONRPCMessage) {
    const value = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(value) > this.maximum) throw new Error('mcp_frame_limit');
    if (!this.child?.stdin?.writable) throw new Error('mcp_transport_closed');
    if (this.writes >= 32) throw new Error('mcp_write_capacity');
    this.writes++;
    try {
      await new Promise<void>((resolve, reject) =>
        this.child!.stdin!.write(value, (error) =>
          error ? reject(new Error('mcp_write_failed')) : resolve(),
        ),
      );
    } finally {
      this.writes--;
    }
  }
  close() {
    if (this.closeTask) return this.closeTask;
    this.closeTask = (async () => {
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.stdin?.end();
      child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    })();
    return this.closeTask;
  }
}
export function boundedFetch(maximum: number): FetchLike {
  return async (input, init) => {
    if (typeof init?.body === 'string' && Buffer.byteLength(init.body) > maximum)
      throw new Error('mcp_frame_limit');
    const response = await fetch(input, { ...init, redirect: 'error' });
    if (!response.body) return response;
    let bytes = 0;
    const stream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > maximum) throw new Error('mcp_frame_limit');
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
