import { AUTHORITY_FRAME_SCHEMA_V1, canonicalAuthorityJson } from '@kite/runtime-spi';
import { type AuthorityKeyV1, sealAuthorityFrameV1 } from '../../src/authority-boundary';
import {
  decodeMcpStdioAuthorityBootstrapV1,
  MCP_STDIO_AUTHORITY_DOMAIN_V1,
  MCP_STDIO_MAX_LINE_BYTES_V1,
  MCP_STDIO_WRAPPER_PEER_ID_V1,
  parseMcpStdioJsonLineV1,
} from '../../src/mcp-stdio-process';

export type McpStdioWrapperFixtureModeV1 =
  | 'wrong-key'
  | 'wrong-peer'
  | 'replay'
  | 'unknown'
  | 'truncated'
  | 'oversize'
  | 'pre-ready';

export async function runMcpStdioWrapperFixtureV1(
  mode: McpStdioWrapperFixtureModeV1,
): Promise<void> {
  const input = await readBootstrapAndGoV1();
  if (mode === 'truncated') {
    process.stdout.write('{"schema":"kite.runtime-authority-frame.v1"');
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

  const key =
    mode === 'wrong-key'
      ? ({
          keyId: input.key.keyId,
          key: new Uint8Array(input.key.key).map((value, index) =>
            index === 0 ? value ^ 1 : value,
          ),
        } satisfies AuthorityKeyV1)
      : input.key;
  const payload: Record<string, unknown> = {
    type: 'ready',
    keyId: input.key.keyId,
    invocationId: input.invocationId,
    wrapperPid: process.pid,
    childPid: process.pid + 1,
    processStartIdentity: 'fixture-start',
    ...(mode === 'unknown' ? { unexpected: true } : {}),
  };
  const frame = sealAuthorityFrameV1({
    schema: AUTHORITY_FRAME_SCHEMA_V1,
    domain: MCP_STDIO_AUTHORITY_DOMAIN_V1,
    peerId: mode === 'wrong-peer' ? 'evil-peer' : MCP_STDIO_WRAPPER_PEER_ID_V1,
    invocationId: input.invocationId,
    sequence: 0,
    payload,
    key,
  });
  const encoded = `${canonicalAuthorityJson(frame)}\n`;
  process.stdout.write(encoded);
  if (mode === 'replay') process.stdout.write(encoded);
  closeFixtureInputV1();
}

function closeFixtureInputV1(): void {
  try {
    process.stdin.destroy();
  } catch {
    // The parent may already have closed the bootstrap stream.
  }
}

async function readBootstrapAndGoV1(): Promise<{ key: AuthorityKeyV1; invocationId: string }> {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const onData = (chunk: Uint8Array) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.byteLength < 11) return;
      const keyIdBytes = buffer.readUInt16BE(9);
      const bootstrapBytes = 11 + keyIdBytes + 32;
      if (buffer.byteLength < bootstrapBytes) return;
      const newline = buffer.indexOf(0x0a, bootstrapBytes);
      if (newline < 0) return;
      try {
        const key = decodeMcpStdioAuthorityBootstrapV1(buffer.subarray(0, bootstrapBytes));
        if (!key) throw new Error('fixture bootstrap key unavailable');
        const go = parseMcpStdioJsonLineV1(buffer.subarray(bootstrapBytes, newline));
        if (
          !go ||
          typeof go !== 'object' ||
          typeof (go as Record<string, unknown>).invocationId !== 'string'
        ) {
          throw new Error('fixture invocation identity unavailable');
        }
        const invocationId = (go as Record<string, unknown>).invocationId;
        if (typeof invocationId !== 'string')
          throw new Error('fixture invocation identity unavailable');
        process.stdin.off('data', onData);
        resolve({ key, invocationId });
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
