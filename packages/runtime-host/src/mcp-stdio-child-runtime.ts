import { randomUUID } from 'node:crypto';
import {
  canonicalControlFrameJson,
  isRuntimeControlFrame,
  RUNTIME_CONTROL_FRAME_SCHEMA_,
  type RuntimeControlFrameInput,
} from '@kite/runtime-spi';
import { createRuntimeControlFrame, verifyRuntimeControlFrame } from './control-frame';
import {
  decodeUtf8Strict,
  MCP_STDIO_CONTROL_DOMAIN_,
  MCP_STDIO_HOST_PEER_ID_,
  MCP_STDIO_MAX_LINE_BYTES_,
  MCP_STDIO_WRAPPER_ENTRYPOINT_,
  MCP_STDIO_WRAPPER_PEER_ID_,
  parseMcpStdioJsonLine,
} from './mcp-stdio-process';
import { spawnRuntimeHostProcess } from './process-spawn';

const MAX_BOOTSTRAP_BUFFER_BYTES_ = 1024 * 1024;
const CHILD_ENV_MAX_ENTRIES_ = 128;

type GoPayload = {
  readonly type: 'go';
  readonly invocationId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

type ReadyPayload = {
  readonly type: 'ready';
  readonly invocationId: string;
  readonly wrapperPid: number;
  readonly childPid: number;
  readonly processStartIdentity: string;
};

type TerminalPayload = {
  readonly type: 'terminal';
  readonly invocationId: string;
  readonly wrapperPid: number;
  readonly childPid: number;
  readonly processStartIdentity: string;
  readonly exitCode: number;
  readonly cleanup: 'confirmed';
};

export function runMcpStdioChildRuntime(args: readonly string[] = process.argv.slice(2)): void {
  if (args.length !== 1 || args[0] !== MCP_STDIO_WRAPPER_ENTRYPOINT_) {
    process.exitCode = 125;
    return;
  }

  let buffer = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
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
      buffer = appendBoundedBuffer(buffer, chunk);
      if (!goSeen) {
        const line = takeLine(buffer);
        if (!line) return;
        buffer = line.rest;
        const parsed = parseMcpStdioJsonLine(line.line);
        if (!isRuntimeControlFrame(parsed)) {
          throw new Error('MCP stdio wrapper expected a GO control frame.');
        }
        if (canonicalControlFrameJson(parsed) !== decodeLineForCanonicalCheck(line.line)) {
          throw new Error('MCP stdio GO frame is not canonical JSON.');
        }
        const frameInvocationId = parsed.invocationId;
        if (typeof frameInvocationId !== 'string' || frameInvocationId.length === 0) {
          throw new Error('MCP stdio GO frame invocation identity is invalid.');
        }
        const payload = verifyRuntimeControlFrame({
          frame: parsed,
          expectedDomain: MCP_STDIO_CONTROL_DOMAIN_,
          expectedPeerId: MCP_STDIO_HOST_PEER_ID_,
          expectedInvocationId: frameInvocationId,
          lastSequence: hostSequence,
        });
        hostSequence = parsed.sequence;
        const go = parseGoPayload(payload, frameInvocationId);
        goSeen = true;
        void startChild(go).catch(failClosed);
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

  async function startChild(go: GoPayload): Promise<void> {
    if (child || failed) throw new Error('MCP stdio wrapper child lifecycle is invalid.');
    child = spawnRuntimeHostProcess([go.command, ...go.args], {
      cwd: go.cwd,
      env: go.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
    childPid = child.pid;
    processStartIdentity = `${childPid}:${Date.now()}:${randomUUID()}`;
    await writeRuntimeControlFrame({
      schema: RUNTIME_CONTROL_FRAME_SCHEMA_,
      domain: MCP_STDIO_CONTROL_DOMAIN_,
      peerId: MCP_STDIO_WRAPPER_PEER_ID_,
      invocationId: go.invocationId,
      sequence: childSequence++,
      payload: {
        type: 'ready',
        invocationId: go.invocationId,
        wrapperPid: process.pid,
        childPid,
        processStartIdentity,
      } satisfies ReadyPayload,
    });

    const stdoutPump = forwardChildStream(child.stdout, process.stdout);
    const stderrPump = forwardChildStream(child.stderr, process.stderr);
    const [exitCode] = await Promise.all([child.exited, stdoutPump, stderrPump]);
    if (failed) return;
    await writeRuntimeControlFrame({
      schema: RUNTIME_CONTROL_FRAME_SCHEMA_,
      domain: MCP_STDIO_CONTROL_DOMAIN_,
      peerId: MCP_STDIO_WRAPPER_PEER_ID_,
      invocationId: go.invocationId,
      sequence: childSequence++,
      payload: {
        type: 'terminal',
        invocationId: go.invocationId,
        wrapperPid: process.pid,
        childPid,
        processStartIdentity,
        exitCode: normalizeExitCode(exitCode),
        cleanup: 'confirmed',
      } satisfies TerminalPayload,
    });
    try {
      process.stdin.destroy();
    } catch {
      // The parent may have already closed stdin.
    }
    process.exitCode = normalizeExitCode(exitCode);
  }
}

async function forwardChildStream(
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
      await writeWritable(target, value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeRuntimeControlFrame<T>(frame: RuntimeControlFrameInput<T>): Promise<void> {
  const controlFrame = createRuntimeControlFrame(frame);
  const bytes = Buffer.from(`${canonicalControlFrameJson(controlFrame)}\n`, 'utf8');
  try {
    await writeWritable(process.stdout, bytes);
  } finally {
    bytes.fill(0);
  }
}

function parseGoPayload(payload: unknown, invocationId: string): GoPayload {
  if (
    !isRecord(payload) ||
    payload.type !== 'go' ||
    payload.invocationId !== invocationId ||
    !isSafeText(payload.command) ||
    !Array.isArray(payload.args) ||
    payload.args.length > 256 ||
    payload.args.some((arg) => !isSafeText(arg)) ||
    !isSafeText(payload.cwd) ||
    !isEnvironment(payload.env) ||
    !exactKeys(payload, ['type', 'invocationId', 'command', 'args', 'cwd', 'env'])
  ) {
    throw new Error('MCP stdio GO payload identity or shape mismatch.');
  }
  return {
    type: 'go',
    invocationId: payload.invocationId,
    command: payload.command,
    args: Object.freeze([...payload.args]),
    cwd: payload.cwd,
    env: Object.freeze({ ...payload.env }),
  };
}

function decodeLineForCanonicalCheck(line: Uint8Array): string {
  return decodeUtf8Strict(line);
}

function takeLine(buffer: Buffer): { line: Buffer; rest: Buffer } | undefined {
  const newline = buffer.indexOf(0x0a);
  if (newline < 0) {
    if (buffer.byteLength > MCP_STDIO_MAX_LINE_BYTES_) {
      throw new Error('MCP stdio control line exceeds the bounded limit.');
    }
    return undefined;
  }
  if (newline === 0 || newline > MCP_STDIO_MAX_LINE_BYTES_) {
    throw new Error('MCP stdio control line is empty or oversized.');
  }
  const line = Buffer.from(buffer.subarray(0, newline));
  const rest = Buffer.from(buffer.subarray(newline + 1));
  buffer.fill(0);
  return { line, rest };
}

function appendBoundedBuffer(
  buffer: Buffer<ArrayBufferLike>,
  chunk: Uint8Array,
): Buffer<ArrayBufferLike> {
  if (buffer.byteLength + chunk.byteLength > MAX_BOOTSTRAP_BUFFER_BYTES_) {
    throw new Error('MCP stdio wrapper stdin exceeds the bounded bootstrap limit.');
  }
  const result = Buffer.alloc(buffer.byteLength + chunk.byteLength) as Buffer<ArrayBufferLike>;
  buffer.copy(result);
  Buffer.from(chunk).copy(result, buffer.byteLength);
  buffer.fill(0);
  return result;
}

function isEnvironment(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= CHILD_ENV_MAX_ENTRIES_ &&
    entries.every(
      ([name, part]) =>
        /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) &&
        typeof part === 'string' &&
        !part.includes('\0') &&
        Buffer.byteLength(part, 'utf8') <= 64 * 1024,
    )
  );
}

function isSafeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= 64 * 1024
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function normalizeExitCode(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : 125;
}

async function writeWritable(target: NodeJS.WritableStream, data: Uint8Array): Promise<void> {
  if (target.write(data)) return;
  await new Promise<void>((resolve) => target.once('drain', resolve));
}

if (import.meta.main) {
  void runMcpStdioChildRuntime();
}
