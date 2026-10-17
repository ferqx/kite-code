import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startWindowsOwnedChild,
  type WindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../../../packages/agent/src/platform/process/windows-owned-child';

export interface WindowsInstalledTuiPtyExit {
  productExitCode: number;
  ptyExitCode: number;
  outputBytes: number;
}
const MAX_FRAME = 2 * 1024 * 1024;
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    throw Error('tui_pty_frame_invalid');
}
/** The trusted driver joins its original Job before it can create the product/ConPTY. */
export async function startWindowsInstalledTuiPty(options: {
  runtimeExecutable: string;
  launcher: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  productEnv: Readonly<Record<string, string>>;
  deadline: number;
  onOutput(bytes: Uint8Array): void | Promise<void>;
}) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('tui_pty_platform_unsupported');
  const deadline = Math.min(options.deadline, Date.now() + 30000);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw Error('tui_pty_deadline');
  const nonce = randomBytes(16).toString('hex');
  let originalOwner: WindowsOwnedChild;
  try {
    originalOwner = startWindowsOwnedChild({
      executable: options.runtimeExecutable,
      argv: [
        '--no-env-file',
        '--no-install',
        `--config=${win32.join(win32.dirname(options.runtimeExecutable), 'windows-bunfig.toml')}`,
        `--tsconfig-override=${win32.join(win32.dirname(options.runtimeExecutable), 'windows-tsconfig.json')}`,
        fileURLToPath(new URL('./windows-installed-tui-pty-driver.ts', import.meta.url)),
      ],
      cwd: options.cwd,
      env: { ...options.env },
      stdin: 'pipe',
    });
  } catch (error) {
    if (error instanceof WindowsOwnedChildStartError) {
      try {
        await error.cleanup;
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'tui_pty_start_cleanup_unknown');
      }
    }
    throw error;
  }
  let failure: unknown,
    sealed = false,
    productPid = 0,
    sequence = 0,
    outputBytes = 0;
  let terminal: WindowsInstalledTuiPtyExit | undefined;
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveTerminal!: (result: WindowsInstalledTuiPtyExit) => void,
    rejectTerminal!: (error: unknown) => void;
  const ended = new Promise<WindowsInstalledTuiPtyExit>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  void ready.catch(() => {});
  void ended.catch(() => {});
  const pending = new Map<string, { resolve(): void; reject(error: unknown): void }>();
  const fail = (error: unknown) => {
    if (failure !== undefined) return;
    failure = error;
    sealed = true;
    rejectReady(error);
    rejectTerminal(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  let stderr = '';
  let closePromise: Promise<void> | undefined;
  const stderrTask = (async () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const bytes of originalOwner.stderr) {
      stderr += decoder.decode(bytes, { stream: true });
      if (stderr.length > 16384) throw Error('tui_pty_stderr_too_large');
    }
    stderr += decoder.decode();
  })();
  const stdoutTask = (async () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    const receive = async (value: unknown) => {
      if (!value || typeof value !== 'object' || Reflect.get(value, 'nonce') !== nonce || terminal)
        throw Error('tui_pty_frame_binding');
      const type = Reflect.get(value, 'type');
      if (type === 'ready') {
        exact(value, ['nonce', 'type', 'productPid']);
        if (
          productPid ||
          !Number.isSafeInteger(value.productPid) ||
          (value.productPid as number) <= 0
        )
          throw Error('tui_pty_ready_invalid');
        productPid = value.productPid as number;
        resolveReady();
      } else if (type === 'output') {
        exact(value, ['nonce', 'type', 'sequence', 'data']);
        if (
          !productPid ||
          value.sequence !== sequence ||
          typeof value.data !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
        )
          throw Error('tui_pty_output_invalid');
        const bytes = Buffer.from(value.data, 'base64');
        if (!bytes.length || bytes.length > 32768 || bytes.toString('base64') !== value.data)
          throw Error('tui_pty_output_invalid');
        sequence++;
        outputBytes += bytes.length;
        await options.onOutput(bytes);
      } else if (type === 'written') {
        exact(value, ['nonce', 'type', 'id']);
        const entry = typeof value.id === 'string' ? pending.get(value.id) : undefined;
        if (!productPid || !entry) throw Error('tui_pty_write_binding');
        pending.delete(value.id as string);
        entry.resolve();
      } else if (type === 'terminal') {
        exact(value, [
          'nonce',
          'type',
          'sequence',
          'productExitCode',
          'ptyExitCode',
          'outputBytes',
        ]);
        if (
          !productPid ||
          value.sequence !== sequence ||
          value.outputBytes !== outputBytes ||
          value.productExitCode !== 0 ||
          value.ptyExitCode !== 0 ||
          pending.size
        )
          throw Error('tui_pty_terminal_invalid');
        terminal = { productExitCode: 0, ptyExitCode: 0, outputBytes };
        resolveTerminal(terminal);
      } else if (type === 'error') {
        exact(value, ['nonce', 'type', 'code']);
        throw Error(typeof value.code === 'string' ? value.code : 'tui_pty_driver_error');
      } else throw Error('tui_pty_frame_invalid');
    };
    for await (const bytes of originalOwner.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      let end = buffer.indexOf('\n');
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_FRAME) throw Error('tui_pty_frame_too_large');
        await receive(JSON.parse(line));
        end = buffer.indexOf('\n');
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME) throw Error('tui_pty_frame_too_large');
    }
    buffer += decoder.decode();
    if (buffer || !terminal) throw Error('tui_pty_incomplete_eof');
  })();
  for (const task of [stdoutTask, stderrTask])
    void task.catch((error) => {
      fail(error);
      void close().catch(() => {});
    });
  const timer = setTimeout(
    () => {
      fail(Error('tui_pty_deadline'));
      void close().catch(() => {});
    },
    Math.max(1, deadline - Date.now()),
  );
  const exited = (async () => {
    try {
      const [result, driverExit] = await Promise.all([
        ended,
        originalOwner.exited,
        stdoutTask,
        stderrTask,
      ]);
      if (driverExit !== 0 || stderr) throw Error(`tui_pty_driver_exit:${driverExit}:${stderr}`);
      await originalOwner.close();
      if (failure !== undefined) throw failure;
      const evidence = originalOwner.readEvidence();
      if (
        !evidence.closed ||
        evidence.closeUnknown ||
        !evidence.root.waitConfirmed ||
        evidence.root.exitCode !== 0 ||
        !evidence.job.treeStopped ||
        evidence.job.activeProcesses !== 0 ||
        evidence.job.terminationRequested
      )
        throw Error('tui_pty_original_owner_not_natural');
      sealed = true;
      clearTimeout(timer);
      return result;
    } catch (error) {
      fail(error);
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError([failure, cleanup], 'tui_pty_cleanup_unknown');
      }
      throw failure;
    }
  })();
  void exited.catch(() => {});
  function close(): Promise<void> {
    sealed = true;
    clearTimeout(timer);
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const errors: unknown[] = [];
      if (!terminal && failure === undefined) fail(Error('tui_pty_closed_before_terminal'));
      try {
        await originalOwner.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'tui_pty_original_close_unknown');
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const results = await Promise.race([
        Promise.allSettled([originalOwner.exited, stdoutTask, stderrTask]),
        new Promise<never>((_, reject) => {
          settleTimer = setTimeout(() => reject(Error('tui_pty_cleanup_stream_unknown')), 5000);
        }),
      ]).finally(() => clearTimeout(settleTimer));
      for (const result of results)
        if (result.status === 'rejected' && result.reason !== failure) errors.push(result.reason);
      if (errors.length) throw new AggregateError(errors, 'tui_pty_cleanup_failed');
    })();
    return closePromise;
  }
  try {
    const init = JSON.stringify({
      type: 'start',
      nonce,
      launcher: options.launcher,
      argv: options.argv,
      cwd: options.cwd,
      env: options.productEnv,
      deadline,
    });
    if (Buffer.byteLength(init) > MAX_FRAME) throw Error('tui_pty_frame_too_large');
    await originalOwner.writeStdin(Buffer.from(`${init}\n`));
    await ready;
  } catch (error) {
    fail(error);
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([failure, cleanup], 'tui_pty_start_cleanup_unknown');
    }
    throw failure;
  }
  let writing = false;
  return {
    originalOwner,
    productPid,
    exited,
    close,
    async write(value: Uint8Array | string, timeoutMs = 10000): Promise<void> {
      if (sealed || writing) throw failure ?? Error('tui_pty_write_closed');
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000)
        throw Error('tui_pty_write_budget');
      const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
      if (!bytes.length || bytes.length > 65536) throw Error('tui_pty_write_invalid');
      writing = true;
      const id = randomBytes(16).toString('hex');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ack = new Promise<void>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          timer = setTimeout(
            () => {
              fail(Error('tui_pty_write_deadline'));
              void close().catch(() => {});
            },
            Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
          );
        });
        void ack.catch(() => {});
        await originalOwner.writeStdin(
          Buffer.from(
            `${JSON.stringify({ type: 'write', nonce, id, data: bytes.toString('base64') })}\n`,
          ),
        );
        await ack;
      } catch (error) {
        fail(error);
        try {
          await close();
        } catch (cleanup) {
          throw new AggregateError([failure, cleanup], 'tui_pty_write_cleanup_unknown');
        }
        throw failure;
      } finally {
        clearTimeout(timer);
        writing = false;
      }
    },
  };
}
