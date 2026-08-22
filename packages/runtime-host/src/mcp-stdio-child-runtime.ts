import { randomUUID } from 'node:crypto';
import {
  AUTHORITY_FRAME_SCHEMA_V1,
  type AuthorityFrameUnsignedV1,
  canonicalAuthorityJson,
  isAuthorityFrameV1,
} from '@kite/runtime-spi';
import {
  type AuthorityKeyV1,
  sealAuthorityFrameV1,
  verifyAuthorityFrameV1,
} from './authority-boundary';
import {
  decodeMcpStdioAuthorityBootstrapV1,
  decodeUtf8StrictV1,
  MCP_STDIO_AUTHORITY_DOMAIN_V1,
  MCP_STDIO_HOST_PEER_ID_V1,
  MCP_STDIO_MAX_LINE_BYTES_V1,
  MCP_STDIO_WRAPPER_ENTRYPOINT_V1,
  MCP_STDIO_WRAPPER_PEER_ID_V1,
  parseMcpStdioJsonLineV1,
} from './mcp-stdio-process';
import { spawnRuntimeHostProcessV1 } from './process-spawn';

const MAX_BOOTSTRAP_BUFFER_BYTES_V1 = 1024 * 1024;
const CHILD_ENV_MAX_ENTRIES_V1 = 128;

type GoPayloadV1 = {
  readonly type: 'go';
  readonly keyId: string;
  readonly invocationId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

type ReadyPayloadV1 = {
  readonly type: 'ready';
  readonly keyId: string;
  readonly invocationId: string;
  readonly wrapperPid: number;
  readonly childPid: number;
  readonly processStartIdentity: string;
};

type TerminalPayloadV1 = {
  readonly type: 'terminal';
  readonly keyId: string;
  readonly invocationId: string;
  readonly wrapperPid: number;
  readonly childPid: number;
  readonly processStartIdentity: string;
  readonly exitCode: number;
  readonly cleanup: 'confirmed';
};

export function runMcpStdioChildRuntimeV1(args: readonly string[] = process.argv.slice(2)): void {
  if (args.length !== 1 || args[0] !== MCP_STDIO_WRAPPER_ENTRYPOINT_V1) {
    process.exitCode = 125;
    return;
  }

  let buffer = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  let key: AuthorityKeyV1 | undefined;
  let goSeen = false;
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  let childPid = 0;
  let processStartIdentity = '';
  let hostSequence = -1;
  let childSequence = 0;
  let failed = false;

  const failClosed = (error?: unknown): void => {
    if (failed) return;
    failed = true;
    if (error) {
      try {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      } catch {
        // The parent may already have closed stderr.
      }
    }
    if (child) {
      try {
        child.kill();
      } catch {
        // The child may already have exited.
      }
    }
    key?.key.fill(0);
    key = undefined;
    try {
      process.stdin.destroy();
    } catch {
      // stdin may already be closed.
    }
    process.exitCode = 125;
  };

  const handleData = (chunk: Uint8Array): void => {
    if (failed) return;
    if (!(chunk instanceof Uint8Array)) {
      failClosed(new Error('MCP stdio wrapper received invalid stdin bytes.'));
      return;
    }
    if (goSeen) {
      if (!child?.stdin) {
        failClosed(new Error('MCP stdio wrapper child stdin is unavailable.'));
        return;
      }
      try {
        child.stdin.write(chunk);
      } catch (error) {
        failClosed(error);
      }
      return;
    }
    try {
      buffer = appendBoundedBufferV1(buffer, chunk);
      if (!key) {
        const bootstrap = takeBootstrapV1(buffer);
        if (!bootstrap) return;
        key = bootstrap.key;
        buffer = bootstrap.rest;
      }
      if (!goSeen) {
        const line = takeLineV1(buffer);
        if (!line) return;
        buffer = line.rest;
        const parsed = parseMcpStdioJsonLineV1(line.line);
        if (!isAuthorityFrameV1(parsed)) {
          throw new Error('MCP stdio wrapper expected an authenticated GO frame.');
        }
        if (canonicalAuthorityJson(parsed) !== decodeLineForCanonicalCheckV1(line.line)) {
          throw new Error('MCP stdio GO frame is not canonical JSON.');
        }
        const frameInvocationId = parsed.invocationId;
        if (typeof frameInvocationId !== 'string' || frameInvocationId.length === 0) {
          throw new Error('MCP stdio GO frame invocation identity is invalid.');
        }
        const payload = verifyAuthorityFrameV1({
          frame: parsed,
          key,
          expectedDomain: MCP_STDIO_AUTHORITY_DOMAIN_V1,
          expectedPeerId: MCP_STDIO_HOST_PEER_ID_V1,
          expectedInvocationId: frameInvocationId,
          lastSequence: hostSequence,
        });
        hostSequence = parsed.sequence;
        const go = parseGoPayloadV1(payload, key, frameInvocationId);
        goSeen = true;
        void startChildV1(go).catch(failClosed);
      }
      if (goSeen && buffer.byteLength > 0 && child?.stdin) {
        const pending = buffer;
        buffer = Buffer.alloc(0);
        child.stdin.write(pending);
        pending.fill(0);
      }
    } catch (error) {
      failClosed(error);
    }
  };

  process.stdin.on('data', handleData);
  process.stdin.on('end', () => {
    if (!goSeen && !failed) failClosed(new Error('MCP stdio wrapper stdin ended before GO.'));
    if (goSeen && child?.stdin) {
      try {
        child.stdin.end();
      } catch {
        failClosed(new Error('MCP stdio child stdin could not close.'));
      }
    }
  });
  process.stdin.on('error', failClosed);
  process.stdin.resume();

  async function startChildV1(go: GoPayloadV1): Promise<void> {
    if (!key || child || failed) throw new Error('MCP stdio wrapper child lifecycle is invalid.');
    child = spawnRuntimeHostProcessV1([go.command, ...go.args], {
      cwd: go.cwd,
      env: go.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
    childPid = child.pid;
    processStartIdentity = `${childPid}:${Date.now()}:${randomUUID()}`;
    await writeAuthorityFrameV1({
      schema: AUTHORITY_FRAME_SCHEMA_V1,
      domain: MCP_STDIO_AUTHORITY_DOMAIN_V1,
      peerId: MCP_STDIO_WRAPPER_PEER_ID_V1,
      invocationId: go.invocationId,
      sequence: childSequence++,
      payload: {
        type: 'ready',
        keyId: key.keyId,
        invocationId: go.invocationId,
        wrapperPid: process.pid,
        childPid,
        processStartIdentity,
      } satisfies ReadyPayloadV1,
      key,
    });

    const stdoutPump = forwardChildStreamV1(child.stdout, process.stdout);
    const stderrPump = forwardChildStreamV1(child.stderr, process.stderr);
    const [exitCode] = await Promise.all([child.exited, stdoutPump, stderrPump]);
    if (failed || !key) return;
    await writeAuthorityFrameV1({
      schema: AUTHORITY_FRAME_SCHEMA_V1,
      domain: MCP_STDIO_AUTHORITY_DOMAIN_V1,
      peerId: MCP_STDIO_WRAPPER_PEER_ID_V1,
      invocationId: go.invocationId,
      sequence: childSequence++,
      payload: {
        type: 'terminal',
        keyId: key.keyId,
        invocationId: go.invocationId,
        wrapperPid: process.pid,
        childPid,
        processStartIdentity,
        exitCode: normalizeExitCodeV1(exitCode),
        cleanup: 'confirmed',
      } satisfies TerminalPayloadV1,
      key,
    });
    key.key.fill(0);
    key = undefined;
    try {
      process.stdin.destroy();
    } catch {
      // The parent may have already closed stdin.
    }
    process.exitCode = normalizeExitCodeV1(exitCode);
  }
}

async function forwardChildStreamV1(
  stream: ReadableStream<Uint8Array> | null,
  target: NodeJS.WritableStream,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!(value instanceof Uint8Array)) throw new Error('MCP stdio child emitted invalid bytes.');
      await writeWritableV1(target, value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeAuthorityFrameV1<T>(
  frame: AuthorityFrameUnsignedV1<T> & { key: AuthorityKeyV1 },
): Promise<void> {
  const sealed = sealAuthorityFrameV1(frame);
  const bytes = Buffer.from(`${canonicalAuthorityJson(sealed)}\n`, 'utf8');
  try {
    await writeWritableV1(process.stdout, bytes);
  } finally {
    bytes.fill(0);
  }
}

function parseGoPayloadV1(
  payload: unknown,
  key: AuthorityKeyV1,
  invocationId: string,
): GoPayloadV1 {
  if (
    !isRecordV1(payload) ||
    payload.type !== 'go' ||
    payload.keyId !== key.keyId ||
    payload.invocationId !== invocationId ||
    !isSafeTextV1(payload.command) ||
    !Array.isArray(payload.args) ||
    payload.args.length > 256 ||
    payload.args.some((arg) => !isSafeTextV1(arg)) ||
    !isSafeTextV1(payload.cwd) ||
    !isEnvironmentV1(payload.env) ||
    !exactKeysV1(payload, ['type', 'keyId', 'invocationId', 'command', 'args', 'cwd', 'env'])
  ) {
    throw new Error('MCP stdio GO payload identity or shape mismatch.');
  }
  return {
    type: 'go',
    keyId: payload.keyId,
    invocationId: payload.invocationId,
    command: payload.command,
    args: Object.freeze([...payload.args]),
    cwd: payload.cwd,
    env: Object.freeze({ ...payload.env }),
  };
}

function decodeLineForCanonicalCheckV1(line: Uint8Array): string {
  return decodeUtf8StrictV1(line);
}

function takeBootstrapV1(buffer: Buffer): { key: AuthorityKeyV1; rest: Buffer } | undefined {
  const minimum = 8 + 1 + 2;
  if (buffer.byteLength < minimum) return undefined;
  const keyIdBytes = buffer.readUInt16BE(9);
  const expected = minimum + keyIdBytes + 32;
  if (keyIdBytes === 0 || keyIdBytes > 255 || expected > buffer.byteLength) return undefined;
  const record = Buffer.from(buffer.subarray(0, expected));
  const key = decodeMcpStdioAuthorityBootstrapV1(record);
  record.fill(0);
  if (!key) throw new Error('MCP stdio authority bootstrap is invalid.');
  const rest = Buffer.from(buffer.subarray(expected));
  buffer.fill(0);
  return { key, rest };
}

function takeLineV1(buffer: Buffer): { line: Buffer; rest: Buffer } | undefined {
  const newline = buffer.indexOf(0x0a);
  if (newline < 0) {
    if (buffer.byteLength > MCP_STDIO_MAX_LINE_BYTES_V1) {
      throw new Error('MCP stdio authority line exceeds the bounded limit.');
    }
    return undefined;
  }
  if (newline === 0 || newline > MCP_STDIO_MAX_LINE_BYTES_V1) {
    throw new Error('MCP stdio authority line is empty or oversized.');
  }
  const line = Buffer.from(buffer.subarray(0, newline));
  const rest = Buffer.from(buffer.subarray(newline + 1));
  buffer.fill(0);
  return { line, rest };
}

function appendBoundedBufferV1(
  buffer: Buffer<ArrayBufferLike>,
  chunk: Uint8Array,
): Buffer<ArrayBufferLike> {
  if (buffer.byteLength + chunk.byteLength > MAX_BOOTSTRAP_BUFFER_BYTES_V1) {
    throw new Error('MCP stdio wrapper stdin exceeds the bounded bootstrap limit.');
  }
  const result = Buffer.alloc(buffer.byteLength + chunk.byteLength) as Buffer<ArrayBufferLike>;
  buffer.copy(result);
  Buffer.from(chunk).copy(result, buffer.byteLength);
  buffer.fill(0);
  return result;
}

function isEnvironmentV1(value: unknown): value is Record<string, string> {
  if (!isRecordV1(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= CHILD_ENV_MAX_ENTRIES_V1 &&
    entries.every(
      ([name, part]) =>
        /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) &&
        typeof part === 'string' &&
        !part.includes('\0') &&
        Buffer.byteLength(part, 'utf8') <= 64 * 1024,
    )
  );
}

function isSafeTextV1(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= 64 * 1024
  );
}

function isRecordV1(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeysV1(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function normalizeExitCodeV1(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : 125;
}

async function writeWritableV1(target: NodeJS.WritableStream, data: Uint8Array): Promise<void> {
  if (target.write(data)) return;
  await new Promise<void>((resolve) => target.once('drain', resolve));
}

if (import.meta.main) {
  void runMcpStdioChildRuntimeV1();
}
