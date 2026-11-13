import { spawnSync as run, type Serializable, spawn as start } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable, type Writable } from 'node:stream';

type Channel = 'pipe' | 'inherit' | 'ignore' | number;
type Input = Channel | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;
type Output<C extends Channel> = C extends 'pipe' ? ReadableStream<Uint8Array> : undefined;
type InputPipe<I extends Input> = I extends 'pipe' ? ProcessStdin : undefined;

interface ProcessStdin {
  write(value: string | Uint8Array | ArrayBuffer): number;
  end(value?: string | Uint8Array | ArrayBuffer): void;
  flush(): void;
}
interface ProcessOptions<I extends Input, O extends Channel, E extends Channel> {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: I;
  stdout?: O;
  stderr?: E;
  detached?: boolean;
  timeout?: number;
  signal?: AbortSignal;
  killSignal?: NodeJS.Signals | number;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
  ipc?(message: unknown, child: Subprocess<I, O, E>): void;
}
export interface Subprocess<
  I extends Input = Input,
  O extends Channel = Channel,
  E extends Channel = Channel,
> {
  readonly pid: number;
  readonly stdin: InputPipe<I>;
  readonly stdout: Output<O>;
  readonly stderr: Output<E>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals | number): void;
  send(message: Serializable): boolean;
  disconnect(): void;
  ref(): void;
  unref(): void;
}
function binary(value: string | Uint8Array | ArrayBuffer) {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}
function pipeStdin(stream: Writable): ProcessStdin {
  return {
    write(value) {
      stream.write(binary(value));
      return typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
    },
    end(value) {
      if (value === undefined) stream.end();
      else stream.end(binary(value));
    },
    // Node's stream owns its backpressure queue and writes as soon as possible.
    flush() {},
  };
}
function signalStatus(signal: NodeJS.Signals | null) {
  return signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0);
}
type Command<I extends Input, O extends Channel, E extends Channel> =
  | readonly string[]
  | (ProcessOptions<I, O, E> & { cmd: readonly string[] });
function command<I extends Input, O extends Channel, E extends Channel>(
  args: Command<I, O, E>,
  options?: ProcessOptions<I, O, E>,
) {
  const flags = 'cmd' in args ? args : (options ?? {});
  const [file, ...argv] = 'cmd' in args ? args.cmd : args;
  if (!file) throw Error('process_command_required');
  return { file, argv, flags };
}

/** Spawn one process with explicit pipes. PTY and native Job ownership have separate APIs. */
export function spawn<
  I extends Input = 'ignore',
  O extends Channel = 'pipe',
  E extends Channel = 'inherit',
>(args: Command<I, O, E>, options?: ProcessOptions<I, O, E>): Subprocess<I, O, E> {
  const { file, argv, flags } = command(args, options);
  const { stdin = 'ignore', stdout = 'pipe', stderr = 'inherit', ipc, ...settings } = flags;
  const providedInput = typeof stdin === 'object';
  const child = start(file, argv, {
    ...settings,
    windowsHide: settings.windowsHide ?? true,
    stdio: [providedInput ? 'pipe' : stdin, stdout, stderr, ...(ipc ? ['ipc' as const] : [])],
    ...(ipc ? { serialization: 'advanced' } : {}),
  });
  let inputError: unknown;
  child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') inputError = error;
  });
  if (providedInput && child.stdin) {
    if (stdin instanceof Blob || stdin instanceof ReadableStream) {
      const input = stdin instanceof Blob ? stdin.stream() : stdin;
      const reader = input.getReader();
      const write = async () => {
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done || child.stdin!.destroyed) break;
            await new Promise<void>((ok, fail) =>
              child.stdin!.write(item.value, (error) => (error ? fail(error) : ok())),
            );
          }
          child.stdin!.end();
        } finally {
          reader.releaseLock();
        }
      };
      void write().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') inputError = error;
        child.stdin!.destroy();
      });
      child.once('exit', () => void reader.cancel().catch(() => {}));
    } else {
      child.stdin.end(binary(stdin));
    }
  }
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (inputError !== undefined) reject(inputError);
      else resolve(code ?? signalStatus(signal));
    });
  });
  void exited.catch(() => {});
  const subprocess: Subprocess<I, O, E> = {
    get pid() {
      return child.pid!;
    },
    stdin: (stdin === 'pipe' && child.stdin ? pipeStdin(child.stdin) : undefined) as InputPipe<I>,
    stdout: (child.stdout ? Readable.toWeb(child.stdout) : undefined) as Output<O>,
    stderr: (child.stderr ? Readable.toWeb(child.stderr) : undefined) as Output<E>,
    exited,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    get killed() {
      return child.killed;
    },
    kill: (signal) => {
      child.kill(signal);
    },
    send(message) {
      if (!child.connected || !child.send) throw Error('process_ipc_not_connected');
      return child.send(message);
    },
    disconnect() {
      if (child.connected) child.disconnect();
    },
    ref: () => child.ref(),
    unref: () => child.unref(),
  };
  if (ipc) child.on('message', (message) => ipc(message, subprocess));
  return subprocess;
}

type SyncInput = Channel | Uint8Array | ArrayBuffer | string;
type SyncOutput<C extends Channel> = C extends 'pipe' ? Buffer : undefined;
export function spawnSync<
  I extends SyncInput = 'ignore',
  O extends Channel = 'pipe',
  E extends Channel = 'pipe',
>(
  args: readonly string[],
  options: Omit<ProcessOptions<Input, O, E>, 'stdin' | 'signal' | 'ipc'> & {
    stdin?: I;
    maxBuffer?: number;
  } = {},
): {
  exitCode: number | null;
  signalCode: NodeJS.Signals | undefined;
  stdout: SyncOutput<O>;
  stderr: SyncOutput<E>;
  success: boolean;
  error?: Error;
} {
  const [file, ...argv] = args;
  if (!file) throw Error('process_command_required');
  const { stdin = 'ignore', stdout = 'pipe', stderr = 'pipe', ...settings } = options;
  const mode: Channel =
    typeof stdin === 'number' || stdin === 'pipe' || stdin === 'ignore' || stdin === 'inherit'
      ? (stdin as Channel)
      : 'pipe';
  const result = run(file, argv, {
    ...settings,
    windowsHide: settings.windowsHide ?? true,
    maxBuffer: settings.maxBuffer ?? 64 * 1024 * 1024,
    stdio: [mode, stdout, stderr],
    input: mode === stdin ? undefined : binary(stdin as string | Uint8Array | ArrayBuffer),
  });
  return {
    exitCode: result.status,
    signalCode: result.signal ?? undefined,
    stdout: (result.stdout ?? undefined) as unknown as SyncOutput<O>,
    stderr: (result.stderr ?? undefined) as unknown as SyncOutput<E>,
    success: result.status === 0 && !result.error,
    error: result.error,
  };
}

/** Locate a file using the supplied PATH; an explicit path never falls through to PATH. */
export function which(name: string, options: { PATH?: string; cwd?: string } = {}): string | null {
  if (!name || name.includes('\0')) return null;
  const windows = process.platform === 'win32';
  const explicit = isAbsolute(name) || name.includes(sep) || (windows && name.includes('/'));
  const path = options.PATH ?? process.env.PATH ?? '';
  const roots = explicit ? [''] : path.split(delimiter).filter(Boolean);
  const extensions =
    windows && !/\.[^\\/.]+$/u.test(name)
      ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
      : [''];
  for (const root of roots) {
    for (const extension of extensions) {
      const candidate = resolve(options.cwd ?? process.cwd(), join(root, name + extension));
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}
