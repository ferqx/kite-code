import type { McpStdioProcessHandleV1, McpStdioProcessPortV1 } from '@kite/runtime-spi';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';

const MCP_STDIO_MAX_LINE_BYTES_V1 = 1024 * 1024;

/**
 * SDK-compatible MCP Transport backed by the Host-authenticated process port.
 * The SDK remains responsible only for JSON-RPC semantics; no process spawn,
 * ambient environment inheritance, or authority verification lives here.
 */
export function createMcpStdioTransportV1(
  input: Readonly<{
    command: string;
    args?: readonly string[];
    cwd: string;
    env?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }>,
  port: McpStdioProcessPortV1,
): Transport {
  if (input.command.length === 0 || input.cwd.length === 0) {
    throw new Error('MCP stdio process command and cwd are required.');
  }
  const transport = new HostMcpStdioTransportV1(input, port);
  return transport;
}

class HostMcpStdioTransportV1 implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  readonly #input: Readonly<{
    command: string;
    args?: readonly string[];
    cwd: string;
    env?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }>;
  readonly #port: McpStdioProcessPortV1;
  #handle: McpStdioProcessHandleV1 | undefined;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #readLoop: Promise<void> | undefined;
  #stderrLoop: Promise<void> | undefined;
  #writeChain: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;
  #closeNotified = false;

  constructor(
    input: Readonly<{
      command: string;
      args?: readonly string[];
      cwd: string;
      env?: Readonly<Record<string, string>>;
      signal?: AbortSignal;
    }>,
    port: McpStdioProcessPortV1,
  ) {
    this.#input = input;
    this.#port = port;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('MCP stdio transport already started.');
    this.#started = true;
    this.#handle = await this.#port.spawn({
      command: this.#input.command,
      args: this.#input.args ?? [],
      cwd: this.#input.cwd,
      ...(this.#input.env ? { env: this.#input.env } : {}),
      ...(this.#input.signal ? { signal: this.#input.signal } : {}),
    });
    await this.#handle.ready;
    this.#reader = this.#handle.stdout.getReader();
    this.#readLoop = this.#readMessages();
    this.#stderrLoop = this.#drainStderr();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const handle = this.#handle;
    if (!handle || !this.#started || this.#closed)
      throw new Error('MCP stdio transport is not connected.');
    const json = JSON.stringify(message);
    if (!json || json.includes('\n') || json.includes('\r')) {
      throw new Error('MCP JSON-RPC message is not a bounded single line.');
    }
    const bytes = new TextEncoder().encode(`${json}\n`);
    if (bytes.byteLength > MCP_STDIO_MAX_LINE_BYTES_V1 + 1) {
      throw new Error('MCP JSON-RPC message exceeds the bounded line limit.');
    }
    const write = this.#writeChain.then(() => handle.write(bytes));
    this.#writeChain = write.catch(() => undefined);
    try {
      await write;
    } finally {
      bytes.fill(0);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const handle = this.#handle;
    if (!handle) {
      this.#notifyClose();
      return;
    }
    try {
      await this.#writeChain;
      await handle.closeInput();
      await handle.cleanup();
      await this.#readLoop;
    } catch (error) {
      if (!this.#closed) this.#notifyError(error);
    } finally {
      try {
        await this.#stderrLoop;
      } catch {
        // stderr is diagnostic-only and never changes transport authority.
      }
      this.#notifyClose();
    }
  }

  async #readMessages(): Promise<void> {
    const reader = this.#reader;
    const handle = this.#handle;
    if (!reader || !handle) throw new Error('MCP stdio transport reader is unavailable.');
    let buffer = new Uint8Array(0) as Uint8Array<ArrayBufferLike>;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error('MCP stdio output bytes are invalid.');
        buffer = appendBufferV1(buffer, value);
        while (true) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) break;
          if (newline === 0 || newline > MCP_STDIO_MAX_LINE_BYTES_V1) {
            throw new Error('MCP stdio output line is empty or oversized.');
          }
          const lineBytes = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const line = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes);
          if (line.trim() !== line) throw new Error('MCP stdio output line is not exact.');
          const message = JSONRPCMessageSchema.parse(JSON.parse(line)) as JSONRPCMessage;
          this.onmessage?.(message);
          lineBytes.fill(0);
        }
      }
      if (buffer.byteLength !== 0) throw new Error('MCP stdio output ended with a truncated line.');
      const terminal = await handle.terminal;
      if (typeof terminal.exitCode === 'number' && terminal.exitCode !== 0) {
        throw new Error(`MCP stdio child exited with code ${terminal.exitCode}.`);
      }
    } catch (error) {
      if (!this.#closed) this.#notifyError(error);
      throw error;
    } finally {
      buffer.fill(0);
      reader.releaseLock();
      this.#notifyClose();
    }
  }

  async #drainStderr(): Promise<void> {
    const stream = this.#handle?.stderr;
    if (!stream) return;
    const reader = stream.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    } finally {
      reader.releaseLock();
    }
  }

  #notifyError(error: unknown): void {
    this.onerror?.(error instanceof Error ? error : new Error(String(error)));
  }

  #notifyClose(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.onclose?.();
  }
}

function appendBufferV1(
  buffer: Uint8Array<ArrayBufferLike>,
  chunk: Uint8Array,
): Uint8Array<ArrayBufferLike> {
  if (buffer.byteLength + chunk.byteLength > MCP_STDIO_MAX_LINE_BYTES_V1 + 1) {
    throw new Error('MCP stdio output exceeds the bounded line limit.');
  }
  const result = new Uint8Array(
    buffer.byteLength + chunk.byteLength,
  ) as Uint8Array<ArrayBufferLike>;
  result.set(buffer, 0);
  result.set(chunk, buffer.byteLength);
  buffer.fill(0);
  return result;
}
