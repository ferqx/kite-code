import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalControlFrameJsonV1,
  isRuntimeControlFrameV1,
  type McpStdioCleanupProofV1,
  type McpStdioProcessHandleV1,
  type McpStdioProcessLaunchV1,
  type McpStdioProcessPortV1,
  type McpStdioReadyProofV1,
  type McpStdioTerminalProofV1,
  RUNTIME_CONTROL_FRAME_SCHEMA_V1,
} from '@kite/runtime-spi';
import { createRuntimeControlFrameV1, verifyRuntimeControlFrameV1 } from './control-frame';
import { spawnRuntimeHostProcessV1 } from './process-spawn';
import { guardProcessTree, type ProcessTreeGuard, processTreeSpawnOptions } from './process-tree';

export const MCP_STDIO_CONTROL_DOMAIN_V1 = 'mcp-stdio-v1';
export const MCP_STDIO_HOST_PEER_ID_V1 = 'runtime-host';
export const MCP_STDIO_WRAPPER_PEER_ID_V1 = 'mcp-stdio-wrapper';
export const MCP_STDIO_WRAPPER_ENTRYPOINT_V1 = '--kite-internal-mcp-stdio-v1';
export const MCP_STDIO_MAX_LINE_BYTES_V1 = 1024 * 1024;
export const MCP_STDIO_MAX_TOTAL_OUTPUT_BYTES_V1 = 16 * 1024 * 1024;
// The wrapper must start its exact MCP child before it can publish ready.
// Standalone + TypeScript child cold starts routinely exceed five seconds on
// loaded machines, so retain a finite but realistic startup bound.
export const MCP_STDIO_STARTUP_TIMEOUT_MS_V1 = 15_000;

export function isMcpStdioWrapperInvocationV1(argv: readonly string[]): boolean {
  const markers = argv.filter((argument) => argument === MCP_STDIO_WRAPPER_ENTRYPOINT_V1);
  if (markers.length !== 1 || argv.at(-1) !== MCP_STDIO_WRAPPER_ENTRYPOINT_V1) return false;
  return !argv.some(
    (argument) =>
      argument.startsWith('--kite-internal-') && argument !== MCP_STDIO_WRAPPER_ENTRYPOINT_V1,
  );
}

const MCP_STDIO_MAX_ARGUMENTS_V1 = 256;
const MCP_STDIO_MAX_ARGUMENT_BYTES_V1 = 64 * 1024;
const MCP_STDIO_MAX_CWD_BYTES_V1 = 16 * 1024;
const MCP_STDIO_MAX_ENV_ENTRIES_V1 = 128;
const MCP_STDIO_MAX_ENV_VALUE_BYTES_V1 = 64 * 1024;

export interface RuntimeHostMcpStdioGoPayloadV1 {
  readonly type: 'go';
  readonly invocationId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface RuntimeHostMcpStdioReadyPayloadV1 {
  readonly type: 'ready';
  readonly invocationId: string;
  readonly wrapperPid: number;
  readonly childPid: number;
  readonly processStartIdentity: string;
}

export interface RuntimeHostMcpStdioTerminalPayloadV1 {
  readonly type: 'terminal';
  readonly invocationId: string;
  readonly wrapperPid: number;
  readonly childPid: number;
  readonly processStartIdentity: string;
  readonly exitCode: number;
  readonly cleanup: 'confirmed';
}

export type RuntimeHostMcpStdioProcessLaunchV1 = McpStdioProcessLaunchV1;
export type RuntimeHostMcpStdioReadyV1 = McpStdioReadyProofV1;
export type RuntimeHostMcpStdioTerminalV1 = McpStdioTerminalProofV1;
export type RuntimeHostMcpStdioCleanupV1 = McpStdioCleanupProofV1;
export type RuntimeHostMcpStdioProcessHandleV1 = McpStdioProcessHandleV1;
export type RuntimeHostMcpStdioProcessPortV1 = McpStdioProcessPortV1;

export interface RuntimeHostMcpStdioProcessPortOptionsV1 {
  /** Test/release composition may pin the wrapper entrypoint explicitly. */
  readonly wrapperPath?: string | null;
  /** Packaged qualification may execute an installed standalone wrapper directly. */
  readonly wrapperExecutablePath?: string;
  /** Explicit allowlist for the actual MCP child environment. */
  readonly allowedEnvironmentKeys?: readonly string[];
}

export function createRuntimeHostMcpStdioProcessPortV1(
  options: RuntimeHostMcpStdioProcessPortOptionsV1 = {},
): RuntimeHostMcpStdioProcessPortV1 {
  if (options.wrapperExecutablePath !== undefined && options.wrapperPath !== undefined) {
    throw new Error('MCP stdio wrapper path and executable path are mutually exclusive.');
  }
  const sourceWrapperPath = join(import.meta.dir, 'mcp-stdio-child-runtime.ts');
  const wrapperPath =
    options.wrapperPath === undefined
      ? existsSync(sourceWrapperPath)
        ? sourceWrapperPath
        : null
      : options.wrapperPath;
  const allowedEnvironmentKeys = new Set(
    options.allowedEnvironmentKeys ?? DEFAULT_MCP_STDIO_ENVIRONMENT_KEYS_V1,
  );
  return Object.freeze({
    spawn: (input: RuntimeHostMcpStdioProcessLaunchV1) =>
      spawnRuntimeHostMcpStdioProcessV1(input, {
        wrapperPath,
        wrapperExecutablePath: options.wrapperExecutablePath,
        allowedEnvironmentKeys,
      }),
  });
}

export const DEFAULT_MCP_STDIO_ENVIRONMENT_KEYS_V1 = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'SHELL',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
] as const);

export function parseMcpStdioJsonLineV1(line: Uint8Array | string): unknown {
  const text = typeof line === 'string' ? line : decodeUtf8StrictV1(line);
  if (!text || text.trim() !== text) throw new Error('MCP stdio JSON line is not exact.');
  const parser = new StrictJsonParserV1(text);
  const value = parser.parse();
  if (!isRecordV1(value)) throw new Error('MCP stdio JSON line must be an object.');
  return value;
}

export function decodeUtf8StrictV1(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = decoder.decode(bytes);
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength !== bytes.byteLength || !bytesEqualV1(encoded, bytes)) {
    throw new Error('MCP stdio JSON line is not canonical UTF-8.');
  }
  return text;
}

export function sanitizeMcpStdioEnvironmentV1(
  env: Readonly<Record<string, string>> | undefined,
  allowedKeys: ReadonlySet<string> = new Set(DEFAULT_MCP_STDIO_ENVIRONMENT_KEYS_V1),
): Readonly<Record<string, string>> {
  if (!env) return Object.freeze({});
  const output: Record<string, string> = {};
  const entries = Object.entries(env);
  if (entries.length > MCP_STDIO_MAX_ENV_ENTRIES_V1) {
    throw new Error('MCP stdio environment has too many entries.');
  }
  for (const [name, value] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) ||
      !allowedKeys.has(name) ||
      name.startsWith('KITE_RUNTIME_MCP_STDIO_') ||
      typeof value !== 'string' ||
      value.includes('\0') ||
      Buffer.byteLength(value, 'utf8') > MCP_STDIO_MAX_ENV_VALUE_BYTES_V1
    ) {
      throw new Error(`MCP stdio environment key '${name}' is not allowed.`);
    }
    output[name] = value;
  }
  return Object.freeze(output);
}

interface SpawnOptionsV1 {
  readonly wrapperPath: string | null;
  readonly wrapperExecutablePath?: string;
  readonly allowedEnvironmentKeys: ReadonlySet<string>;
}

async function spawnRuntimeHostMcpStdioProcessV1(
  input: RuntimeHostMcpStdioProcessLaunchV1,
  options: SpawnOptionsV1,
): Promise<RuntimeHostMcpStdioProcessHandleV1> {
  validateLaunchInputV1(input);
  const env = sanitizeMcpStdioEnvironmentV1(input.env, options.allowedEnvironmentKeys);
  const invocationId = randomUUID();

  const wrapperCommand = options.wrapperExecutablePath
    ? [options.wrapperExecutablePath, MCP_STDIO_WRAPPER_ENTRYPOINT_V1]
    : options.wrapperPath
      ? [process.execPath, options.wrapperPath, MCP_STDIO_WRAPPER_ENTRYPOINT_V1]
      : [process.execPath, MCP_STDIO_WRAPPER_ENTRYPOINT_V1];
  const proc = spawnRuntimeHostProcessV1(wrapperCommand, {
    cwd: input.cwd,
    env: Object.freeze({}),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    ...processTreeSpawnOptions(),
  });
  const processTree = guardProcessTree(proc);

  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      outputController = controller;
    },
  });
  const readyDeferred = deferred<RuntimeHostMcpStdioReadyV1>();
  const terminalDeferred = deferred<RuntimeHostMcpStdioTerminalV1>();
  void terminalDeferred.promise.catch(() => undefined);
  type ProcessTerminationV1 = Awaited<ReturnType<ProcessTreeGuard['terminate']>>;
  let processTerminationPromise: Promise<ProcessTerminationV1> | undefined;
  const terminateOnce = (): Promise<ProcessTerminationV1> => {
    processTerminationPromise ??= terminateProcessV1(processTree);
    return processTerminationPromise;
  };
  let readySeen = false;
  let terminalSeen = false;
  let outputClosed = false;
  let inputClosed = false;
  let cleanupStarted = false;
  let cleanupResult: RuntimeHostMcpStdioCleanupV1 | undefined;
  let forwardedBytes = 0;

  const closeOutput = (error?: Error): void => {
    if (outputClosed) return;
    outputClosed = true;
    if (error) outputController?.error(error);
    else outputController?.close();
  };
  const failProtocol = (error: Error): void => {
    readyDeferred.reject(error);
    terminalDeferred.reject(error);
    closeOutput(error);
    void terminateOnce().catch(() => undefined);
  };

  const parseTask = consumeWrapperOutputV1(proc.stdout, {
    invocationId,
    wrapperPid: proc.pid,
    lastSequence: -1,
    readySeen: false,
    onReady(ready) {
      readySeen = true;
      readyDeferred.resolve(ready);
    },
    onTerminal(terminal) {
      terminalSeen = true;
      terminalDeferred.resolve(terminal);
    },
    onMessage(bytes) {
      if (!readySeen || terminalSeen) {
        throw new Error('MCP stdio protocol message crossed an invalid lifecycle boundary.');
      }
      forwardedBytes += bytes.byteLength;
      if (forwardedBytes > MCP_STDIO_MAX_TOTAL_OUTPUT_BYTES_V1) {
        throw new Error('MCP stdio output exceeded the bounded process budget.');
      }
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      outputController?.enqueue(copy);
    },
    onError(error) {
      failProtocol(error);
    },
    isClosing: () => cleanupStarted,
  });

  const exited = Promise.resolve(proc.exited);
  void exited.then(async (exitCode) => {
    // Process exit and pipe delivery are separate readiness facts. A fast
    // child can exit immediately after writing its validated terminal;
    // drain the wrapper stream before deciding that terminal evidence is
    // absent, otherwise scheduler load creates a false protocol failure.
    try {
      await parseTask;
    } catch {
      return;
    }
    if (!terminalSeen && !cleanupStarted) {
      failProtocol(new Error(`MCP stdio wrapper exited before terminal evidence (${exitCode}).`));
    }
  });
  void parseTask.catch((error: unknown) => {
    failProtocol(error instanceof Error ? error : new Error(String(error)));
  });

  const goFrame = createRuntimeControlFrameV1({
    schema: RUNTIME_CONTROL_FRAME_SCHEMA_V1,
    domain: MCP_STDIO_CONTROL_DOMAIN_V1,
    peerId: MCP_STDIO_HOST_PEER_ID_V1,
    invocationId,
    sequence: 0,
    payload: {
      type: 'go' as const,
      invocationId,
      command: input.command,
      args: [...input.args],
      cwd: input.cwd,
      env,
    },
  });
  try {
    const goBytes = Buffer.from(`${canonicalControlFrameJsonV1(goFrame)}\n`, 'utf8');
    try {
      await writeFileSinkV1(proc.stdin, goBytes);
    } finally {
      goBytes.fill(0);
    }
  } catch (error) {
    failProtocol(error instanceof Error ? error : new Error(String(error)));
    await terminateOnce();
    throw error;
  }

  let abortListener: (() => void) | undefined;
  const cleanup = async (): Promise<RuntimeHostMcpStdioCleanupV1> => {
    if (cleanupResult) return cleanupResult;
    if (cleanupStarted) return await exited.then(() => cleanupResult!);
    cleanupStarted = true;
    if (abortListener) input.signal?.removeEventListener('abort', abortListener);
    if (!terminalSeen) {
      terminalDeferred.reject(
        new Error('MCP stdio process was intentionally cleaned up before terminal evidence.'),
      );
    }
    if (!inputClosed) {
      inputClosed = true;
      try {
        proc.stdin.end();
      } catch {
        // The wrapper may have already exited.
      }
    }
    let forced = false;
    let confirmedExited = false;
    let unconfirmedProcessCount = 0;
    if (terminalSeen && (await waitForExitV1(exited, 1_000))) {
      confirmedExited = true;
    } else {
      const result = await terminateOnce();
      forced = result.forced;
      confirmedExited = result.confirmedExited;
      unconfirmedProcessCount = result.unconfirmedPids.length;
    }
    closeOutput();
    processTree.dispose();
    cleanupResult = Object.freeze({
      confirmedExited,
      terminalReceived: terminalSeen,
      forced,
      unconfirmedProcessCount,
    });
    return cleanupResult;
  };

  abortListener = () => {
    void cleanup();
  };
  input.signal?.addEventListener('abort', abortListener, { once: true });

  const ready = readyDeferred.promise;
  try {
    await withTimeoutV1(
      ready,
      MCP_STDIO_STARTUP_TIMEOUT_MS_V1,
      'MCP stdio validated ready timed out.',
    );
  } catch (error) {
    await terminateOnce();
    if (abortListener) input.signal?.removeEventListener('abort', abortListener);
    throw error;
  }

  return Object.freeze({
    stdout,
    stderr: proc.stderr,
    ready,
    terminal: terminalDeferred.promise,
    exited,
    async write(data: Uint8Array): Promise<void> {
      if (cleanupStarted || inputClosed) throw new Error('MCP stdio process input is closed.');
      if (!(data instanceof Uint8Array) || data.byteLength > MCP_STDIO_MAX_LINE_BYTES_V1 + 1) {
        throw new Error('MCP stdio process input is not bounded.');
      }
      if (data.byteLength < 2 || data[data.byteLength - 1] !== 0x0a) {
        throw new Error('MCP stdio process input must be one exact JSON-RPC line.');
      }
      const inputLine = data.slice(0, data.byteLength - 1);
      try {
        if (inputLine.includes(0x0a) || !isMcpJsonRpcObjectV1(parseMcpStdioJsonLineV1(inputLine))) {
          throw new Error('MCP stdio process input is not JSON-RPC.');
        }
      } finally {
        inputLine.fill(0);
      }
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      try {
        await writeFileSinkV1(proc.stdin, copy);
      } finally {
        copy.fill(0);
      }
    },
    async closeInput(): Promise<void> {
      if (inputClosed) return;
      inputClosed = true;
      try {
        proc.stdin.end();
      } catch {
        // The wrapper may have already exited.
      }
    },
    cleanup,
  });
}

interface WrapperOutputCallbacksV1 {
  readonly invocationId: string;
  readonly wrapperPid: number;
  lastSequence: number;
  readySeen: boolean;
  onReady(ready: RuntimeHostMcpStdioReadyV1): void;
  onTerminal(terminal: RuntimeHostMcpStdioTerminalV1): void;
  onMessage(bytes: Uint8Array): void;
  onError(error: Error): void;
  isClosing(): boolean;
}

async function consumeWrapperOutputV1(
  stream: ReadableStream<Uint8Array>,
  callbacks: WrapperOutputCallbacksV1,
): Promise<void> {
  const reader = stream.getReader();
  let buffer = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  let terminalSeen = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw new Error('MCP stdio wrapper emitted invalid bytes.');
      buffer = appendBoundedBufferV1(buffer, value, MCP_STDIO_MAX_TOTAL_OUTPUT_BYTES_V1);
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = Buffer.from(buffer.subarray(0, newline));
        buffer = Buffer.from(buffer.subarray(newline + 1));
        try {
          if (line.byteLength === 0 || line.byteLength > MCP_STDIO_MAX_LINE_BYTES_V1) {
            throw new Error('MCP stdio wrapper emitted an empty or oversized line.');
          }
          const value = parseMcpStdioJsonLineV1(line);
          if (isRuntimeControlFrameV1(value)) {
            if (canonicalControlFrameJsonV1(value) !== decodeUtf8StrictV1(line)) {
              throw new Error('MCP stdio control frame is not canonical JSON.');
            }
            const payload = verifyRuntimeControlFrameV1({
              frame: value,
              expectedDomain: MCP_STDIO_CONTROL_DOMAIN_V1,
              expectedPeerId: MCP_STDIO_WRAPPER_PEER_ID_V1,
              expectedInvocationId: callbacks.invocationId,
              lastSequence: callbacks.lastSequence,
            });
            callbacks.lastSequence = value.sequence;
            if (!isRecordV1(payload)) {
              throw new Error('MCP stdio control payload is invalid.');
            }
            if (payload.type === 'ready') {
              if (callbacks.readySeen || terminalSeen)
                throw new Error('Duplicate MCP stdio ready frame.');
              const ready = parseReadyPayloadV1(payload, callbacks);
              callbacks.readySeen = true;
              callbacks.onReady(ready);
            } else if (payload.type === 'terminal') {
              if (!callbacks.readySeen || terminalSeen)
                throw new Error('Invalid MCP stdio terminal frame.');
              const terminal = parseTerminalPayloadV1(payload, callbacks);
              terminalSeen = true;
              callbacks.onTerminal(terminal);
            } else {
              throw new Error('Unexpected MCP stdio control frame payload.');
            }
          } else {
            if (!isMcpJsonRpcObjectV1(value) || terminalSeen || !callbacks.readySeen) {
              throw new Error('MCP stdio emitted a protocol message outside validated readiness.');
            }
            const output = Buffer.alloc(line.byteLength + 1);
            line.copy(output, 0);
            output[line.byteLength] = 0x0a;
            callbacks.onMessage(output);
            output.fill(0);
          }
        } finally {
          line.fill(0);
        }
      }
    }
    if (buffer.byteLength !== 0 && !callbacks.isClosing()) {
      throw new Error('MCP stdio wrapper output was truncated.');
    }
    if (!terminalSeen && !callbacks.isClosing()) {
      throw new Error('MCP stdio wrapper closed without terminal evidence.');
    }
  } catch (error) {
    if (callbacks.isClosing()) return;
    callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    buffer.fill(0);
    reader.releaseLock();
  }
}

function parseReadyPayloadV1(
  payload: unknown,
  callbacks: WrapperOutputCallbacksV1,
): RuntimeHostMcpStdioReadyV1 {
  if (
    !isRecordV1(payload) ||
    payload.type !== 'ready' ||
    payload.invocationId !== callbacks.invocationId ||
    payload.wrapperPid !== callbacks.wrapperPid ||
    !isPositiveIntegerV1(payload.childPid) ||
    typeof payload.processStartIdentity !== 'string' ||
    payload.processStartIdentity.length === 0 ||
    !exactKeysV1(payload, [
      'type',
      'invocationId',
      'wrapperPid',
      'childPid',
      'processStartIdentity',
    ])
  ) {
    throw new Error('MCP stdio ready payload identity mismatch.');
  }
  return Object.freeze({
    invocationId: payload.invocationId,
    wrapperPid: payload.wrapperPid,
    childPid: payload.childPid,
    processStartIdentity: payload.processStartIdentity,
  });
}

function parseTerminalPayloadV1(
  payload: unknown,
  callbacks: WrapperOutputCallbacksV1,
): RuntimeHostMcpStdioTerminalV1 {
  if (
    !isRecordV1(payload) ||
    payload.type !== 'terminal' ||
    payload.invocationId !== callbacks.invocationId ||
    payload.wrapperPid !== callbacks.wrapperPid ||
    !isPositiveIntegerV1(payload.childPid) ||
    typeof payload.processStartIdentity !== 'string' ||
    payload.processStartIdentity.length === 0 ||
    typeof payload.exitCode !== 'number' ||
    !Number.isSafeInteger(payload.exitCode) ||
    payload.exitCode < 0 ||
    payload.exitCode > 255 ||
    payload.cleanup !== 'confirmed' ||
    !exactKeysV1(payload, [
      'type',
      'invocationId',
      'wrapperPid',
      'childPid',
      'processStartIdentity',
      'exitCode',
      'cleanup',
    ])
  ) {
    throw new Error('MCP stdio terminal payload identity mismatch.');
  }
  return Object.freeze({
    invocationId: payload.invocationId,
    wrapperPid: payload.wrapperPid,
    childPid: payload.childPid,
    processStartIdentity: payload.processStartIdentity,
    exitCode: payload.exitCode,
    cleanup: 'confirmed',
  });
}

function validateLaunchInputV1(input: RuntimeHostMcpStdioProcessLaunchV1): void {
  if (!isSafeTextV1(input.command, MCP_STDIO_MAX_ARGUMENT_BYTES_V1)) {
    throw new Error('MCP stdio command is invalid.');
  }
  if (!Array.isArray(input.args) || input.args.length > MCP_STDIO_MAX_ARGUMENTS_V1) {
    throw new Error('MCP stdio argument vector is invalid.');
  }
  for (const arg of input.args) {
    if (!isSafeTextV1(arg, MCP_STDIO_MAX_ARGUMENT_BYTES_V1)) {
      throw new Error('MCP stdio argument is invalid.');
    }
  }
  if (!isSafeTextV1(input.cwd, MCP_STDIO_MAX_CWD_BYTES_V1)) {
    throw new Error('MCP stdio cwd is invalid.');
  }
}

function isSafeTextV1(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}

function isMcpJsonRpcObjectV1(value: unknown): value is Record<string, unknown> {
  return isRecordV1(value) && value.jsonrpc === '2.0';
}

function isRecordV1(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveIntegerV1(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function exactKeysV1(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function appendBoundedBufferV1(
  buffer: Buffer<ArrayBufferLike>,
  chunk: Uint8Array,
  maximumBytes: number,
): Buffer<ArrayBufferLike> {
  const nextLength = buffer.byteLength + chunk.byteLength;
  if (nextLength > maximumBytes) {
    throw new Error('MCP stdio wrapper emitted an oversized buffered line.');
  }
  const next = Buffer.alloc(nextLength) as Buffer<ArrayBufferLike>;
  buffer.copy(next, 0);
  Buffer.from(chunk).copy(next, buffer.byteLength);
  buffer.fill(0);
  return next;
}

async function writeFileSinkV1(sink: Bun.FileSink, bytes: Uint8Array): Promise<void> {
  await Promise.resolve(sink.write(bytes));
  await Promise.resolve(sink.flush());
}

async function terminateProcessV1(
  processTree: ProcessTreeGuard,
): Promise<ReturnType<ProcessTreeGuard['terminate']> extends Promise<infer T> ? T : never> {
  return processTree.terminate();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function withTimeoutV1<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForExitV1(promise: Promise<number>, timeoutMs: number): Promise<boolean> {
  try {
    await withTimeoutV1(promise, timeoutMs, 'MCP stdio process exit timed out.');
    return true;
  } catch {
    return false;
  }
}

function bytesEqualV1(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

class StrictJsonParserV1 {
  #index = 0;
  #depth = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.#index !== this.text.length) throw new Error('Trailing JSON bytes.');
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    if (++this.#depth > 64) throw new Error('JSON nesting exceeds the bounded limit.');
    try {
      const character = this.text[this.#index];
      if (character === '{') return this.parseObject();
      if (character === '[') return this.parseArray();
      if (character === '"') return this.parseString();
      if (character === 't' && this.consumeLiteral('true')) return true;
      if (character === 'f' && this.consumeLiteral('false')) return false;
      if (character === 'n' && this.consumeLiteral('null')) return null;
      return this.parseNumber();
    } finally {
      this.#depth -= 1;
    }
  }

  private parseObject(): Record<string, unknown> {
    this.expect('{');
    const object = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.consume('}')) return object;
    while (true) {
      this.skipWhitespace();
      if (this.text[this.#index] !== '"') throw new Error('JSON object key is invalid.');
      const key = this.parseString();
      if (typeof key !== 'string' || keys.has(key)) throw new Error('Duplicate JSON object key.');
      keys.add(key);
      this.skipWhitespace();
      this.expect(':');
      object[key] = this.parseValue();
      this.skipWhitespace();
      if (this.consume('}')) return object;
      this.expect(',');
    }
  }

  private parseArray(): unknown[] {
    this.expect('[');
    const array: unknown[] = [];
    this.skipWhitespace();
    if (this.consume(']')) return array;
    while (true) {
      array.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume(']')) return array;
      this.expect(',');
    }
  }

  private parseString(): string {
    const start = this.#index;
    this.expect('"');
    let escaped = false;
    while (this.#index < this.text.length) {
      const character = this.text[this.#index++];
      if (character === undefined) throw new Error('Unterminated JSON string.');
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') {
        const raw = this.text.slice(start, this.#index);
        const value = JSON.parse(raw) as unknown;
        if (typeof value !== 'string') throw new Error('JSON string is invalid.');
        return value;
      }
      if (character < ' ') throw new Error('JSON string contains a control byte.');
    }
    throw new Error('Unterminated JSON string.');
  }

  private parseNumber(): number {
    const match = this.text
      .slice(this.#index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) throw new Error('JSON value is invalid.');
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error('JSON number is not finite.');
    return value;
  }

  private consumeLiteral(literal: string): boolean {
    if (this.text.startsWith(literal, this.#index)) {
      this.#index += literal.length;
      return true;
    }
    return false;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.text[this.#index] ?? '')) this.#index += 1;
  }

  private consume(character: string): boolean {
    if (this.text[this.#index] === character) {
      this.#index += 1;
      return true;
    }
    return false;
  }

  private expect(character: string): void {
    if (!this.consume(character)) throw new Error(`Expected JSON '${character}'.`);
  }
}
