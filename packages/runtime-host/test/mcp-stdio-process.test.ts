import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  createRuntimeHostMcpStdioProcessPort,
  isMcpStdioWrapperInvocation,
  MCP_STDIO_WRAPPER_ENTRYPOINT_,
  parseMcpStdioJsonLine,
} from '../src/process/mcp-stdio-process';

const workspace = join(import.meta.dir, '../..', '..');
const fixture = join(workspace, 'tests/fixtures/mcp-governance-server.ts');

function createPort(wrapperPath?: string) {
  return createRuntimeHostMcpStdioProcessPort({
    ...(wrapperPath ? { wrapperPath } : {}),
  });
}

describe('Runtime Host MCP stdio process port', () => {
  test('admits only one final private wrapper marker with no competing internal mode', () => {
    expect(isMcpStdioWrapperInvocation(['kite', MCP_STDIO_WRAPPER_ENTRYPOINT_])).toBe(true);
    for (const argv of [
      ['kite'],
      ['kite', MCP_STDIO_WRAPPER_ENTRYPOINT_, '--version'],
      ['kite', MCP_STDIO_WRAPPER_ENTRYPOINT_, MCP_STDIO_WRAPPER_ENTRYPOINT_],
      ['kite', '--kite-internal-posix-supervisor-v1', MCP_STDIO_WRAPPER_ENTRYPOINT_],
    ]) {
      expect(isMcpStdioWrapperInvocation(argv)).toBe(false);
    }
  });

  test('validates ready/terminal control frames and proxies MCP JSONL', async () => {
    const handle = await createPort().spawn({
      command: process.execPath,
      args: [fixture],
      cwd: workspace,
    });
    expect((await handle.ready).childPid).toBeGreaterThan(0);
    const reader = handle.stdout.getReader();
    await handle.write(
      new TextEncoder().encode(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'runtime-host-test', version: '1' },
          },
        })}\n`,
      ),
    );
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(
      parseMcpStdioJsonLine(new TextDecoder().decode(first.value).replace(/\n$/u, '')),
    ).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
    });
    reader.releaseLock();
    await handle.closeInput();
    await expect(handle.terminal).resolves.toMatchObject({ cleanup: 'confirmed', exitCode: 0 });
    await expect(handle.cleanup()).resolves.toMatchObject({
      confirmedExited: true,
      terminalReceived: true,
    });
  });

  test('fails closed when the wrapper uses the wrong peer', async () => {
    for (const name of ['mcp-stdio-wrong-peer-wrapper.ts']) {
      const wrapperPath = join(import.meta.dir, 'fixtures', name);
      await expect(
        createPort(wrapperPath).spawn({
          command: process.execPath,
          args: [fixture],
          cwd: workspace,
        }),
      ).rejects.toThrow();
    }
  });

  test('rejects replay, unknown fields, truncated frames, oversized frames, and pre-ready MCP', async () => {
    const cases = [
      'mcp-stdio-replay-wrapper.ts',
      'mcp-stdio-unknown-wrapper.ts',
      'mcp-stdio-truncated-wrapper.ts',
      'mcp-stdio-oversize-wrapper.ts',
      'mcp-stdio-pre-ready-wrapper.ts',
    ];
    for (const name of cases) {
      const wrapperPath = join(import.meta.dir, 'fixtures', name);
      const spawned = createPort(wrapperPath).spawn({
        command: process.execPath,
        args: [fixture],
        cwd: workspace,
      });
      if (name === 'mcp-stdio-replay-wrapper.ts') {
        const handle = await spawned;
        await expect(handle.terminal).rejects.toThrow();
        await handle.cleanup();
      } else {
        await expect(spawned).rejects.toThrow();
      }
    }
  });

  test('rejects duplicate JSON object keys before control-frame validation', () => {
    expect(() => parseMcpStdioJsonLine('{"jsonrpc":"2.0","jsonrpc":"2.0"}')).toThrow(
      /Duplicate JSON object key/u,
    );
  });
});
