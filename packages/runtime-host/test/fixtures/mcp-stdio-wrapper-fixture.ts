import { canonicalControlFrameJson, RUNTIME_CONTROL_FRAME_SCHEMA_ } from '@kite/runtime-spi';
import { createRuntimeControlFrame } from '../../src/kernel-adapter/control-frame';
import {
  MCP_STDIO_CONTROL_DOMAIN_,
  MCP_STDIO_MAX_LINE_BYTES_,
  MCP_STDIO_WRAPPER_PEER_ID_,
  parseMcpStdioJsonLine,
} from '../../src/process/mcp-stdio-process';

export type McpStdioWrapperFixtureMode =
  | 'wrong-peer'
  | 'replay'
  | 'unknown'
  | 'truncated'
  | 'oversize'
  | 'pre-ready';

export async function runMcpStdioWrapperFixture(mode: McpStdioWrapperFixtureMode): Promise<void> {
  const invocationId = await readGo();
  if (mode === 'truncated') {
    process.stdout.write('{"schema":"kite.runtime-control-frame.v1"');
    closeFixtureInput();
    return;
  }
  if (mode === 'oversize') {
    process.stdout.write(`${'x'.repeat(MCP_STDIO_MAX_LINE_BYTES_ + 2)}\n`);
    closeFixtureInput();
    return;
  }
  if (mode === 'pre-ready') {
    process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    closeFixtureInput();
    return;
  }
  const payload: Record<string, unknown> = {
    type: 'ready',
    invocationId,
    wrapperPid: process.pid,
    childPid: process.pid + 1,
    processStartIdentity: 'fixture-start',
    ...(mode === 'unknown' ? { unexpected: true } : {}),
  };
  const frame = createRuntimeControlFrame({
    schema: RUNTIME_CONTROL_FRAME_SCHEMA_,
    domain: MCP_STDIO_CONTROL_DOMAIN_,
    peerId: mode === 'wrong-peer' ? 'evil-peer' : MCP_STDIO_WRAPPER_PEER_ID_,
    invocationId,
    sequence: 0,
    payload,
  });
  const encoded = `${canonicalControlFrameJson(frame)}\n`;
  process.stdout.write(encoded);
  if (mode === 'replay') process.stdout.write(encoded);
  closeFixtureInput();
}

function closeFixtureInput(): void {
  try {
    process.stdin.destroy();
  } catch {}
}

async function readGo(): Promise<string> {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const onData = (chunk: Uint8Array) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const go = parseMcpStdioJsonLine(buffer.subarray(0, newline));
        const invocationId = (go as Record<string, unknown>).invocationId;
        if (typeof invocationId !== 'string') throw new Error('fixture invocation unavailable');
        process.stdin.off('data', onData);
        resolve(invocationId);
      } catch (error) {
        process.stdin.off('data', onData);
        reject(error);
      }
    };
    process.stdin.on('data', onData);
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}
