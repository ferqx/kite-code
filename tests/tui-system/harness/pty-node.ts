import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  startWindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../../../packages/agent/src/platform/process/windows-owned-child';

type Signal = 'SIGTERM' | 'SIGKILL';
export interface OwnedTestProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: Signal): void;
}
export interface OwnedPtyProcess extends OwnedTestProcess {
  readonly ready: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  write(bytes: string | Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  setRawMode(enabled: boolean): Promise<void>;
  hangup(): Promise<void>;
  close(): void;
}
interface Options {
  command: readonly string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  detach: boolean;
  onData(bytes: Uint8Array): void;
}
const driver = fileURLToPath(new URL('./pty-posix.py', import.meta.url));
const windowsDriver = fileURLToPath(new URL('./pty-windows-driver.ts', import.meta.url));

interface Controller {
  exited: Promise<number>;
  write(frame: string): Promise<void>;
  close(): void;
}

function windowsController(
  options: Options,
  receive: (line: string) => void,
  fail: (error: Error) => void,
): Controller {
  const start = async () => {
    try {
      return startWindowsOwnedChild({
        executable: process.execPath,
        argv: ['--no-global-search-paths', windowsDriver],
        cwd: options.cwd,
        env: options.env,
        stdin: 'pipe',
      });
    } catch (error) {
      if (error instanceof WindowsOwnedChildStartError) await error.cleanup;
      throw error;
    }
  };
  const owner = start();
  const read = owner.then(async (child) => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let rest = '';
    for await (const chunk of child.stdout) {
      rest += decoder.decode(chunk, { stream: true });
      for (let offset = rest.indexOf('\n'); offset !== -1; offset = rest.indexOf('\n')) {
        if (offset > 2 * 1024 * 1024) throw Error('test_pty_controller_frame_too_large');
        receive(rest.slice(0, offset));
        rest = rest.slice(offset + 1);
      }
      if (rest.length > 2 * 1024 * 1024) throw Error('test_pty_controller_frame_too_large');
    }
    if (rest || decoder.decode()) throw Error('test_pty_controller_incomplete_frame');
  });
  const stderr = owner.then(async (child) => {
    for await (const bytes of child.stderr) process.stderr.write(bytes);
  });
  const close = () => void owner.then((child) => child.close()).catch(fail);
  const exited = Promise.all([owner.then((child) => child.exited), read, stderr])
    .then(async ([code]) => {
      const child = await owner;
      await child.close();
      const evidence = child.readEvidence();
      if (
        !evidence.closed ||
        evidence.closeUnknown ||
        !evidence.job.treeStopped ||
        !evidence.root.waitConfirmed
      )
        throw Error('test_windows_pty_owner_close_unknown');
      return code;
    })
    .catch((error: Error) => {
      close();
      throw error;
    });
  const write = (frame: string) => owner.then((child) => child.writeStdin(Buffer.from(frame)));
  const { command, cwd, env, cols, rows } = options;
  void write(`${JSON.stringify({ command, cwd, env, cols, rows })}\n`).catch(fail);
  return { exited, write, close };
}

function posixController(
  options: Options,
  receive: (line: string) => void,
  fail: (error: Error) => void,
): Controller {
  const child = spawn(
    'python3',
    [
      '-u',
      driver,
      String(options.cols),
      String(options.rows),
      options.detach ? 'detached' : 'inherited',
      ...options.command,
    ],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
    },
  );
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (!stdin || !stdout) throw Error('test_pty_controller_pipes_missing');
  stdin.on('error', fail);
  stdout.on('data', options.onData);
  const controls = createInterface({ input: child.stdio[3] as Readable, crlfDelay: Infinity });
  controls.on('line', receive);
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  return {
    exited,
    write: (frame) =>
      new Promise((resolve, reject) => {
        stdin.write(frame, (error) => (error ? reject(error) : resolve()));
      }),
    close: () => stdin.destroy(),
  };
}

export function spawnOwnedPty(options: Options): OwnedPtyProcess {
  let pid = 0;
  let terminalCode: number | undefined;
  let terminalSignal: NodeJS.Signals | null = null;
  let lastError: Error | undefined;
  let forced = false;
  let sequence = 0;
  let readyResolve!: (pid: number) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  const fail = (error: Error) => {
    lastError ??= error;
    readyReject(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    controller.close();
  };
  const receive = (line: string) => {
    try {
      const value = JSON.parse(line) as {
        pid?: number;
        code?: number;
        id?: number;
        data?: string;
        signal?: NodeJS.Signals | null;
      };
      if (!pid && Number.isSafeInteger(value.pid) && value.pid! > 0) {
        pid = value.pid!;
        readyResolve(pid);
      } else if (pid && Number.isSafeInteger(value.code) && terminalCode === undefined) {
        terminalCode = value.code!;
        terminalSignal = value.signal ?? null;
      } else if (pid && Number.isSafeInteger(value.id) && pending.has(value.id!)) {
        pending.get(value.id!)!.resolve();
        pending.delete(value.id!);
      } else if (
        process.platform === 'win32' &&
        pid &&
        typeof value.data === 'string' &&
        terminalCode === undefined
      ) {
        const data = Buffer.from(value.data, 'base64');
        if (data.toString('base64') !== value.data) throw Error('test_pty_output_invalid');
        options.onData(data);
      } else throw Error('test_pty_controller_receipt_invalid');
    } catch (error) {
      fail(error instanceof Error ? error : Error('test_pty_controller_receipt_invalid'));
    }
  };
  const controller =
    process.platform === 'win32'
      ? windowsController(options, receive, fail)
      : posixController(options, receive, fail);
  const exited = controller.exited
    .then((code) => {
      if (forced && !lastError && terminalCode === undefined) return 137;
      if (code !== 0 || terminalCode === undefined || lastError)
        throw lastError ?? Error('test_pty_controller_exit_unconfirmed');
      for (const entry of pending.values()) entry.reject(Error('test_pty_input_closed'));
      pending.clear();
      return terminalCode;
    })
    .catch((error: Error) => {
      fail(error);
      throw error;
    });
  void exited.catch(() => {});
  const request = (value: Record<string, unknown>) => {
    if (lastError || terminalCode !== undefined)
      return Promise.reject(lastError ?? Error('test_pty_input_closed'));
    const id = ++sequence;
    return new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void controller.write(`${JSON.stringify({ id, ...value })}\n`).catch(fail);
    });
  };
  return {
    get pid() {
      return pid;
    },
    get exitCode() {
      return terminalSignal ? null : (terminalCode ?? (forced ? 137 : null));
    },
    get signalCode() {
      return terminalSignal;
    },
    ready,
    exited,
    write(value) {
      return request({
        kind: 'write',
        data: (typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)).toString(
          'base64',
        ),
      });
    },
    resize(cols, rows) {
      return request({ kind: 'resize', cols, rows });
    },
    setRawMode(enabled) {
      return request({ kind: 'raw', enabled });
    },
    hangup() {
      return request({ kind: 'hangup' });
    },
    close: () => {
      if (terminalCode === undefined) controller.close();
    },
    kill(signal = 'SIGTERM') {
      if (signal === 'SIGKILL' && (!pid || process.platform === 'win32')) {
        forced = true;
        controller.close();
      } else if (terminalCode === undefined) void request({ kind: 'kill', signal }).catch(() => {});
    },
  };
}
