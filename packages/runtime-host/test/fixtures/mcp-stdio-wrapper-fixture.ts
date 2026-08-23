import { canonicalControlFrameJsonV1, RUNTIME_CONTROL_FRAME_SCHEMA_V1 } from '@kite/runtime-spi';
import { createRuntimeControlFrameV1 } from '../../src/control-frame';
import {
  MCP_STDIO_CONTROL_DOMAIN_V1,
  MCP_STDIO_MAX_LINE_BYTES_V1,
  MCP_STDIO_WRAPPER_PEER_ID_V1,
  parseMcpStdioJsonLineV1,
} from '../../src/mcp-stdio-process';

export type McpStdioWrapperFixtureModeV1 =
  | 'wrong-peer'
  | 'replay'
  | 'unknown'
  | 'truncated'
  | 'oversize'
  | 'pre-ready';

export async function runMcpStdioWrapperFixtureV1(
  mode: McpStdioWrapperFixtureModeV1,
): Promise<void> {
  const invocationId = await readGoV1();
  if (mode === 'truncated') {
    process.stdout.write('{"schema":"kite.runtime-control-frame.v1"');
    closeFixtureInputV1();
    return;
  }
  if (mode === 'oversize') {
    process.stdout.write(`${'x'.repeat(MCP_STDIO_MAX_LINE_BYTES_V1 + 2)}\n`);
    closeFixtureInputV1();
    return;
  }
  if (mode === 'pre-ready') {
    process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    closeFixtureInputV1();
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
  const frame = createRuntimeControlFrameV1({
    schema: RUNTIME_CONTROL_FRAME_SCHEMA_V1,
    domain: MCP_STDIO_CONTROL_DOMAIN_V1,
    peerId: mode === 'wrong-peer' ? 'evil-peer' : MCP_STDIO_WRAPPER_PEER_ID_V1,
    invocationId,
    sequence: 0,
    payload,
  });
  const encoded = `${canonicalControlFrameJsonV1(frame)}\n`;
  process.stdout.write(encoded);
  if (mode === 'replay') process.stdout.write(encoded);
  closeFixtureInputV1();
}

function closeFixtureInputV1(): void {
  try {
    process.stdin.destroy();
  } catch {}
}

async function readGoV1(): Promise<string> {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const onData = (chunk: Uint8Array) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const go = parseMcpStdioJsonLineV1(buffer.subarray(0, newline));
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
