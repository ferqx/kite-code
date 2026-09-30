import type { McpStdioProcessHandle, McpStdioProcessPort } from '@kite-ai/runtime-spi';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * SDK-compatible MCP Transport backed by the Host-authenticated process port.
 * The SDK remains responsible only for JSON-RPC semantics; no process spawn,
 * ambient environment inheritance, or authority verification lives here.
 */
export function createMcpStdioTransport(
  input: Readonly<{
    command: string;
    args?: readonly string[];
    cwd: string;
    env?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }>,
  port: McpStdioProcessPort,
): Transport {
  if (input.command.length === 0 || input.cwd.length === 0) {
    throw new Error('MCP stdio process command and cwd are required.');
  }
  const transport = new HostMcpStdioTransport(input, port);
  return transport;
}

class HostMcpStdioTransport implements Transport {
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
  readonly #port: McpStdioProcessPort;
  #handle: McpStdioProcessHandle | undefined;
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
    port: McpStdioProcessPort,
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
    const prior = this.#writeChain;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#writeChain = prior.then(() => gate);
    await prior;
    let bytes: Uint8Array | undefined;
    try {
      const json = JSON.stringify(message);
      if (!json || json.includes('\n') || json.includes('\r')) {
        throw new Error('MCP JSON-RPC message is not a single line.');
      }
      bytes = new TextEncoder().encode(`${json}\n`);
      await handle.write(bytes);
    } finally {
      bytes?.fill(0);
      release();
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
    const parts: Uint8Array[] = [];
    let pendingBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error('MCP stdio output bytes are invalid.');
        let offset = 0;
        while (offset < value.byteLength) {
          const newline = value.indexOf(0x0a, offset);
          if (newline < 0) {
            const tail = value.slice(offset);
            parts.push(tail);
            pendingBytes += tail.byteLength;
            break;
          }
          const segment = value.slice(offset, newline);
          parts.push(segment);
          pendingBytes += segment.byteLength;
          if (pendingBytes === 0) throw new Error('MCP stdio output line is empty.');
          const lineBytes = new Uint8Array(pendingBytes);
          let copied = 0;
          for (const part of parts) {
            lineBytes.set(part, copied);
            copied += part.byteLength;
            part.fill(0);
          }
          parts.length = 0;
          pendingBytes = 0;
          try {
            const line = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes);
            if (line.trim() !== line) throw new Error('MCP stdio output line is not exact.');
            const message = JSONRPCMessageSchema.parse(JSON.parse(line)) as JSONRPCMessage;
            this.onmessage?.(message);
          } finally {
            lineBytes.fill(0);
          }
          offset = newline + 1;
        }
      }
      if (pendingBytes !== 0) throw new Error('MCP stdio output ended with a truncated line.');
      const terminal = await handle.terminal;
      if (typeof terminal.exitCode === 'number' && terminal.exitCode !== 0) {
        throw new Error(`MCP stdio child exited with code ${terminal.exitCode}.`);
      }
    } catch (error) {
      if (!this.#closed) this.#notifyError(error);
      throw error;
    } finally {
      for (const part of parts) part.fill(0);
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
