import { expect, test } from 'bun:test';
import type { McpStdioProcessPort } from '@kite-ai/runtime-spi';
import { createMcpStdioTransport } from '../src/mcp/stdio-transport';

test('MCP stdio accepts coalesced legal frames and a large individual response', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const writes: Uint8Array[] = [];
  const port = {
    spawn: async () => ({
      ready: Promise.resolve({}),
      stdout: new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(value) {
          value.close();
        },
      }),
      terminal: Promise.resolve({ exitCode: 0 }),
      exited: Promise.resolve(0),
      write: async (value: Uint8Array) => {
        writes.push(value.slice());
      },
      closeInput: async () => {},
      cleanup: async () => {
        controller.close();
        return {};
      },
    }),
  } as unknown as McpStdioProcessPort;
  const transport = createMcpStdioTransport({ command: 'test', cwd: process.cwd() }, port);
  const received: number[] = [];
  transport.onmessage = (message) => {
    if ('id' in message) received.push(Number(message.id));
  };
  await transport.start();
  try {
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'large',
      params: { body: 'x'.repeat(2 * 1024 * 1024) },
    });
    expect(writes[0]?.byteLength).toBeGreaterThan(1024 * 1024);
    const lines = [1, 2, 3].map(
      (id) =>
        `${JSON.stringify({ jsonrpc: '2.0', id, result: { body: 'x'.repeat(id === 3 ? 2 * 1024 * 1024 : 520_000) } })}\n`,
    );
    const bytes = new TextEncoder().encode(lines.join(''));
    for (let offset = 0; offset < bytes.byteLength; offset += 65_536) {
      controller.enqueue(bytes.slice(offset, offset + 65_536));
    }
    for (let attempt = 0; attempt < 100 && received.length < 3; attempt++) await Bun.sleep(1);
    expect(received).toEqual([1, 2, 3]);
  } finally {
    await transport.close();
  }
});
