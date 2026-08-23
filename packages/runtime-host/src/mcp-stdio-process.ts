import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalControlFrameJson,
  isRuntimeControlFrame,
  type McpStdioCleanupProof,
  type McpStdioProcessHandle,
  type McpStdioProcessLaunch,
  type McpStdioProcessPort,
  type McpStdioReadyProof,
  type McpStdioTerminalProof,
  RUNTIME_CONTROL_FRAME_SCHEMA_,
} from '@kite/runtime-spi';
import { createRuntimeControlFrame, verifyRuntimeControlFrame } from './control-frame';
import { spawnRuntimeHostProcess } from './process-spawn';
import { guardProcessTree, type ProcessTreeGuard, processTreeSpawnOptions } from './process-tree';

export const MCP_STDIO_CONTROL_DOMAIN_ = 'mcp-stdio-v1';
export const MCP_STDIO_HOST_PEER_ID_ = 'runtime-host';
export const MCP_STDIO_WRAPPER_PEER_ID_ = 'mcp-stdio-wrapper';
export const MCP_STDIO_WRAPPER_ENTRYPOINT_ = '--kite-internal-mcp-stdio-v1';
export const MCP_STDIO_MAX_LINE_BYTES_ = 1024 * 1024;
export const MCP_STDIO_MAX_TOTAL_OUTPUT_BYTES_ = 16 * 1024 * 1024;
// The wrapper must start its exact MCP child before it can publish ready.
// Standalone + TypeScript child cold starts routinely exceed five seconds on
// loaded machines, so retain a finite but realistic startup bound.
export const MCP_STDIO_STARTUP_TIMEOUT_MS_ = 15_000;

export function isMcpStdioWrapperInvocation(argv: readonly string[]): boolean {
  const markers = argv.filter((argument) => argument === MCP_STDIO_WRAPPER_ENTRYPOINT_);
  if (markers.length !== 1 || argv.at(-1) !== MCP_STDIO_WRAPPER_ENTRYPOINT_) return false;
  return !argv.some(
    (argument) =>
      argument.startsWith('--kite-internal-') && argument !== MCP_STDIO_WRAPPER_ENTRYPOINT_,
  );
}

const MCP_STDIO_MAX_ARGUMENTS_ = 256;
const MCP_STDIO_MAX_ARGUMENT_BYTES_ = 64 * 1024;
const MCP_STDIO_MAX_CWD_BYTES_ = 16 * 1024;
const MCP_STDIO_MAX_ENV_ENTRIES_ = 128;
const MCP_STDIO_MAX_ENV_VALUE_BYTES_ = 64 * 1024;

export interface RuntimeHostMcpStdioGoPayload {
  readonly type: 'go';
  readonly invocationId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface RuntimeHostMcpStdioReadyPayload {
  readonly type: 'ready';
  readonly invocationId: string;
  readonly wrapperPid: number;
  readonly childPid: number;
  readonly processStartIdentity: string;
}

export interface RuntimeHostMcpStdioTerminalPayload {
  readonly type: 'terminal';
  readonly invocationId: string;
  readonly wrapperPid: number;
  readonly childPid: number;
  readonly processStartIdentity: string;
  readonly exitCode: number;
  readonly cleanup: 'confirmed';
}

export type RuntimeHostMcpStdioProcessLaunch = McpStdioProcessLaunch;
export type RuntimeHostMcpStdioReady = McpStdioReadyProof;
export type RuntimeHostMcpStdioTerminal = McpStdioTerminalProof;
export type RuntimeHostMcpStdioCleanup = McpStdioCleanupProof;
export type RuntimeHostMcpStdioProcessHandle = McpStdioProcessHandle;
export type RuntimeHostMcpStdioProcessPort = McpStdioProcessPort;

export interface RuntimeHostMcpStdioProcessPortOptions {
  /** Test/release composition may pin the wrapper entrypoint explicitly. */
  readonly wrapperPath?: string | null;
  /** Packaged qualification may execute an installed standalone wrapper directly. */
  readonly wrapperExecutablePath?: string;
  /** Explicit allowlist for the actual MCP child environment. */
  readonly allowedEnvironmentKeys?: readonly string[];
}

export function createRuntimeHostMcpStdioProcessPort(
  options: RuntimeHostMcpStdioProcessPortOptions = {},
): RuntimeHostMcpStdioProcessPort {
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
    options.allowedEnvironmentKeys ?? DEFAULT_MCP_STDIO_ENVIRONMENT_KEYS_,
  );
  return Object.freeze({
    spawn: (input: RuntimeHostMcpStdioProcessLaunch) =>
      spawnRuntimeHostMcpStdioProcess(input, {
        wrapperPath,
        wrapperExecutablePath: options.wrapperExecutablePath,
        allowedEnvironmentKeys,
      }),
  });
}

export const DEFAULT_MCP_STDIO_ENVIRONMENT_KEYS_ = Object.freeze([
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

export function parseMcpStdioJsonLine(line: Uint8Array | string): unknown {
  const text = typeof line === 'string' ? line : decodeUtf8Strict(line);
  if (!text || text.trim() !== text) throw new Error('MCP stdio JSON line is not exact.');
  const parser = new StrictJsonParser(text);
  const value = parser.parse();
  if (!isRecord(value)) throw new Error('MCP stdio JSON line must be an object.');
  return value;
}

export function decodeUtf8Strict(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = decoder.decode(bytes);
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength !== bytes.byteLength || !bytesEqual(encoded, bytes)) {
    throw new Error('MCP stdio JSON line is not canonical UTF-8.');
  }
  return text;
}

export function sanitizeMcpStdioEnvironment(
  env: Readonly<Record<string, string>> | undefined,
  allowedKeys: ReadonlySet<string> = new Set(DEFAULT_MCP_STDIO_ENVIRONMENT_KEYS_),
): Readonly<Record<string, string>> {
  if (!env) return Object.freeze({});
  const output: Record<string, string> = {};
  const entries = Object.entries(env);
  if (entries.length > MCP_STDIO_MAX_ENV_ENTRIES_) {
    throw new Error('MCP stdio environment has too many entries.');
  }
  for (const [name, value] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) ||
      !allowedKeys.has(name) ||
      name.startsWith('KITE_RUNTIME_MCP_STDIO_') ||
      typeof value !== 'string' ||
      value.includes('\0') ||
      Buffer.byteLength(value, 'utf8') > MCP_STDIO_MAX_ENV_VALUE_BYTES_
    ) {
      throw new Error(`MCP stdio environment key '${name}' is not allowed.`);
    }
    output[name] = value;
  }
  return Object.freeze(output);
}

interface SpawnOptions {
  readonly wrapperPath: string | null;
  readonly wrapperExecutablePath?: string;
  readonly allowedEnvironmentKeys: ReadonlySet<string>;
}

async function spawnRuntimeHostMcpStdioProcess(
  input: RuntimeHostMcpStdioProcessLaunch,
  options: SpawnOptions,
): Promise<RuntimeHostMcpStdioProcessHandle> {
  validateLaunchInput(input);
  const env = sanitizeMcpStdioEnvironment(input.env, options.allowedEnvironmentKeys);
  const invocationId = randomUUID();

  const wrapperCommand = options.wrapperExecutablePath
    ? [options.wrapperExecutablePath, MCP_STDIO_WRAPPER_ENTRYPOINT_]
    : options.wrapperPath
      ? [process.execPath, options.wrapperPath, MCP_STDIO_WRAPPER_ENTRYPOINT_]
      : [process.execPath, MCP_STDIO_WRAPPER_ENTRYPOINT_];
  const proc = spawnRuntimeHostProcess(wrapperCommand, {
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
  const readyDeferred = deferred<RuntimeHostMcpStdioReady>();
  const terminalDeferred = deferred<RuntimeHostMcpStdioTerminal>();
  void terminalDeferred.promise.catch(() => undefined);
  type ProcessTermination = Awaited<ReturnType<ProcessTreeGuard['terminate']>>;
  let processTerminationPromise: Promise<ProcessTermination> | undefined;
  const terminateOnce = (): Promise<ProcessTermination> => {
    processTerminationPromise ??= terminateProcess(processTree);
    return processTerminationPromise;
  };
  let readySeen = false;
  let terminalSeen = false;
  let outputClosed = false;
  let inputClosed = false;
  let cleanupStarted = false;
  let cleanupResult: RuntimeHostMcpStdioCleanup | undefined;
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

  const parseTask = consumeWrapperOutput(proc.stdout, {
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
      if (forwardedBytes > MCP_STDIO_MAX_TOTAL_OUTPUT_BYTES_) {
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

  const goFrame = createRuntimeControlFrame({
    schema: RUNTIME_CONTROL_FRAME_SCHEMA_,
    domain: MCP_STDIO_CONTROL_DOMAIN_,
    peerId: MCP_STDIO_HOST_PEER_ID_,
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
    const goBytes = Buffer.from(`${canonicalControlFrameJson(goFrame)}\n`, 'utf8');
    try {
      await writeFileSink(proc.stdin, goBytes);
    } finally {
      goBytes.fill(0);
    }
  } catch (error) {
    failProtocol(error instanceof Error ? error : new Error(String(error)));
    await terminateOnce();
    throw error;
  }

  let abortListener: (() => void) | undefined;
  const cleanup = async (): Promise<RuntimeHostMcpStdioCleanup> => {
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
    if (terminalSeen && (await waitForExit(exited, 1_000))) {
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
    await withTimeout(ready, MCP_STDIO_STARTUP_TIMEOUT_MS_, 'MCP stdio validated ready timed out.');
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
      if (!(data instanceof Uint8Array) || data.byteLength > MCP_STDIO_MAX_LINE_BYTES_ + 1) {
        throw new Error('MCP stdio process input is not bounded.');
      }
      if (data.byteLength < 2 || data[data.byteLength - 1] !== 0x0a) {
        throw new Error('MCP stdio process input must be one exact JSON-RPC line.');
      }
      const inputLine = data.slice(0, data.byteLength - 1);
      try {
        if (inputLine.includes(0x0a) || !isMcpJsonRpcObject(parseMcpStdioJsonLine(inputLine))) {
          throw new Error('MCP stdio process input is not JSON-RPC.');
        }
      } finally {
        inputLine.fill(0);
      }
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      try {
        await writeFileSink(proc.stdin, copy);
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

interface WrapperOutputCallbacks {
  readonly invocationId: string;
  readonly wrapperPid: number;
  lastSequence: number;
  readySeen: boolean;
  onReady(ready: RuntimeHostMcpStdioReady): void;
  onTerminal(terminal: RuntimeHostMcpStdioTerminal): void;
  onMessage(bytes: Uint8Array): void;
  onError(error: Error): void;
  isClosing(): boolean;
}

async function consumeWrapperOutput(
  stream: ReadableStream<Uint8Array>,
  callbacks: WrapperOutputCallbacks,
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
      buffer = appendBoundedBuffer(buffer, value, MCP_STDIO_MAX_TOTAL_OUTPUT_BYTES_);
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = Buffer.from(buffer.subarray(0, newline));
        buffer = Buffer.from(buffer.subarray(newline + 1));
        try {
          if (line.byteLength === 0 || line.byteLength > MCP_STDIO_MAX_LINE_BYTES_) {
            throw new Error('MCP stdio wrapper emitted an empty or oversized line.');
          }
          const value = parseMcpStdioJsonLine(line);
          if (isRuntimeControlFrame(value)) {
            if (canonicalControlFrameJson(value) !== decodeUtf8Strict(line)) {
              throw new Error('MCP stdio control frame is not canonical JSON.');
            }
            const payload = verifyRuntimeControlFrame({
              frame: value,
              expectedDomain: MCP_STDIO_CONTROL_DOMAIN_,
              expectedPeerId: MCP_STDIO_WRAPPER_PEER_ID_,
              expectedInvocationId: callbacks.invocationId,
              lastSequence: callbacks.lastSequence,
            });
            callbacks.lastSequence = value.sequence;
            if (!isRecord(payload)) {
              throw new Error('MCP stdio control payload is invalid.');
            }
            if (payload.type === 'ready') {
              if (callbacks.readySeen || terminalSeen)
                throw new Error('Duplicate MCP stdio ready frame.');
              const ready = parseReadyPayload(payload, callbacks);
              callbacks.readySeen = true;
              callbacks.onReady(ready);
            } else if (payload.type === 'terminal') {
              if (!callbacks.readySeen || terminalSeen)
                throw new Error('Invalid MCP stdio terminal frame.');
              const terminal = parseTerminalPayload(payload, callbacks);
              terminalSeen = true;
              callbacks.onTerminal(terminal);
            } else {
              throw new Error('Unexpected MCP stdio control frame payload.');
            }
          } else {
            if (!isMcpJsonRpcObject(value) || terminalSeen || !callbacks.readySeen) {
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

function parseReadyPayload(
  payload: unknown,
  callbacks: WrapperOutputCallbacks,
): RuntimeHostMcpStdioReady {
  if (
    !isRecord(payload) ||
    payload.type !== 'ready' ||
    payload.invocationId !== callbacks.invocationId ||
    payload.wrapperPid !== callbacks.wrapperPid ||
    !isPositiveInteger(payload.childPid) ||
    typeof payload.processStartIdentity !== 'string' ||
    payload.processStartIdentity.length === 0 ||
    !exactKeys(payload, ['type', 'invocationId', 'wrapperPid', 'childPid', 'processStartIdentity'])
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

function parseTerminalPayload(
  payload: unknown,
  callbacks: WrapperOutputCallbacks,
): RuntimeHostMcpStdioTerminal {
  if (
    !isRecord(payload) ||
    payload.type !== 'terminal' ||
    payload.invocationId !== callbacks.invocationId ||
    payload.wrapperPid !== callbacks.wrapperPid ||
    !isPositiveInteger(payload.childPid) ||
    typeof payload.processStartIdentity !== 'string' ||
    payload.processStartIdentity.length === 0 ||
    typeof payload.exitCode !== 'number' ||
    !Number.isSafeInteger(payload.exitCode) ||
    payload.exitCode < 0 ||
    payload.exitCode > 255 ||
    payload.cleanup !== 'confirmed' ||
    !exactKeys(payload, [
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

function validateLaunchInput(input: RuntimeHostMcpStdioProcessLaunch): void {
  if (!isSafeText(input.command, MCP_STDIO_MAX_ARGUMENT_BYTES_)) {
    throw new Error('MCP stdio command is invalid.');
  }
  if (!Array.isArray(input.args) || input.args.length > MCP_STDIO_MAX_ARGUMENTS_) {
    throw new Error('MCP stdio argument vector is invalid.');
  }
  for (const arg of input.args) {
    if (!isSafeText(arg, MCP_STDIO_MAX_ARGUMENT_BYTES_)) {
      throw new Error('MCP stdio argument is invalid.');
    }
  }
  if (!isSafeText(input.cwd, MCP_STDIO_MAX_CWD_BYTES_)) {
    throw new Error('MCP stdio cwd is invalid.');
  }
}

function isSafeText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}

function isMcpJsonRpcObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.jsonrpc === '2.0';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function appendBoundedBuffer(
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

async function writeFileSink(sink: Bun.FileSink, bytes: Uint8Array): Promise<void> {
  await Promise.resolve(sink.write(bytes));
  await Promise.resolve(sink.flush());
}

async function terminateProcess(
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

async function waitForExit(promise: Promise<number>, timeoutMs: number): Promise<boolean> {
  try {
    await withTimeout(promise, timeoutMs, 'MCP stdio process exit timed out.');
    return true;
  } catch {
    return false;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

class StrictJsonParser {
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
