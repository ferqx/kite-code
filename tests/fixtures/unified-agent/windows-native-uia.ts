import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startWindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../../../packages/agent/src/platform/process/windows-owned-child';

export interface WindowsNativeUIAElement {
  runtimeId: number[];
  name: string;
  controlType: string;
  automationId: string;
  enabled: boolean;
  offscreen: boolean;
  /** Full supported property; absence is not permission to use Name as body text. */
  text?: string;
  value?: string;
}
export type WindowsNativeUIARequest = {
  pid: number;
  creationTime: string;
  executablePath: string;
} & (
  | { action: 'snapshot' | 'quit' }
  | { action: 'clickByName'; name: string; match?: 'exact' | 'regex' }
  | { action: 'fillByName'; name: string; match?: 'exact' | 'regex'; text: string }
);
export interface WindowsNativeUIAResult {
  elements?: WindowsNativeUIAElement[];
  observation?: { code: 'uia_snapshot_changed'; type: string; hresult: number };
  invoked?: WindowsNativeUIAElement;
  element?: WindowsNativeUIAElement;
  filled?: string;
  quitRequested?: true;
}
/** Absolute deadline, capped at the original 45s driver budget. No product is launched here. */
export async function createWindowsNativeUIA(options: {
  home: string;
  env: Readonly<Record<string, string>>;
  deadline: number;
}) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('uia_platform_unsupported');
  const deadline = Math.min(options.deadline, Date.now() + 45000);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw Error('uia_deadline');
  // Fixed system location, not PATH/COMSPEC or caller-provided executable/DLL selection.
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    GetSystemDirectoryW: { args: ['ptr', 'u32'], returns: 'u32' },
  });
  let system: string;
  try {
    const buffer = new Uint16Array(32768);
    const length = kernel.symbols.GetSystemDirectoryW(ptr(buffer), buffer.length);
    if (!length || length >= buffer.length) throw Error('uia_system_directory_unavailable');
    system = Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le');
  } finally {
    kernel.close();
  }
  let child: ReturnType<typeof startWindowsOwnedChild>;
  try {
    child = startWindowsOwnedChild({
      executable: win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      argv: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-File',
        fileURLToPath(new URL('./windows-native-uia.ps1', import.meta.url)),
      ],
      cwd: options.home,
      env: options.env,
      stdin: 'pipe',
    });
  } catch (error) {
    if (error instanceof WindowsOwnedChildStartError) {
      try {
        await error.cleanup;
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'uia_start_cleanup_unknown');
      }
    }
    throw error;
  }
  let sealed = false;
  let failure: unknown;
  let closePromise: Promise<void> | undefined;
  const pending = new Map<
    string,
    {
      resolve(value: WindowsNativeUIAResult): void;
      reject(error: unknown): void;
    }
  >();
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  let receivedReady = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});
  const fail = (error: unknown) => {
    if (failure === undefined) failure = error;
    sealed = true;
    readyReject(failure);
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  };
  let stderr = '';
  const stderrTask = (async () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const bytes of child.stderr) {
      stderr += decoder.decode(bytes, { stream: true });
      if (stderr.length > 16384) throw Error('uia_stderr_too_large');
    }
    stderr += decoder.decode();
  })();
  const stdoutTask = (async () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    for await (const bytes of child.stdout) {
      text += decoder.decode(bytes, { stream: true });
      if (text.length > 8388608) throw Error('uia_frame_too_large');
      for (;;) {
        const end = text.indexOf('\n');
        if (end < 0) break;
        const line = text.slice(0, end).replace(/\r$/, '');
        text = text.slice(end + 1);
        const frame = JSON.parse(line);
        if (!receivedReady) {
          if (Object.keys(frame).join(',') !== 'ready' || frame.ready !== true)
            throw Error('uia_ready_invalid');
          receivedReady = true;
          readyResolve();
          continue;
        }
        if (
          !frame ||
          typeof frame.id !== 'string' ||
          !['id,result', 'error,id'].includes(Object.keys(frame).sort().join(','))
        )
          throw Error('uia_response_invalid');
        const waiter = pending.get(frame.id);
        if (!waiter) throw Error('uia_response_unbound');
        pending.delete(frame.id);
        if ('error' in frame) waiter.reject(Error(String(frame.error)));
        else if (!frame.result || typeof frame.result !== 'object' || Array.isArray(frame.result))
          throw Error('uia_result_invalid');
        else waiter.resolve(frame.result);
      }
    }
    text += decoder.decode();
    if (text.trim()) throw Error('uia_incomplete_frame');
    if (!sealed) throw Error('uia_unexpected_eof');
  })();
  void stdoutTask.catch(fail);
  void stderrTask.catch(fail);
  const timer = setTimeout(
    () => {
      fail(Error('uia_driver_deadline'));
      void close().catch(() => {});
    },
    Math.max(1, deadline - Date.now()),
  );
  function close(): Promise<void> {
    closePromise ??= (async () => {
      sealed = true;
      clearTimeout(timer);
      for (const waiter of pending.values()) waiter.reject(Error('uia_closed'));
      pending.clear();
      const errors: unknown[] = [];
      try {
        await child.endStdin();
      } catch (error) {
        errors.push(error);
      }
      try {
        await child.stop({ graceMs: 0 });
      } catch (error) {
        errors.push(error);
      }
      try {
        await child.close();
      } catch (error) {
        errors.push(error);
      }
      // An unconfirmed native close retains the original owner; do not wait
      // indefinitely for streams whose pending IO could not be confirmed closed.
      if (errors.length) throw new AggregateError(errors, `uia_cleanup_unknown: ${stderr}`);
      const settled = await Promise.allSettled([child.exited, stdoutTask, stderrTask]);
      for (const result of settled) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length) throw new AggregateError(errors, `uia_cleanup_unknown: ${stderr}`);
    })();
    return closePromise;
  }
  try {
    await ready;
    if (failure !== undefined) throw failure;
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'uia_ready_cleanup_failed');
    }
    throw error;
  }
  let performing = false;
  return {
    async perform(
      request: WindowsNativeUIARequest,
      timeoutMs = 10000,
    ): Promise<WindowsNativeUIAResult> {
      if (sealed) throw failure ?? Error('uia_closed');
      if (performing) throw Error('uia_concurrent_action');
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000)
        throw Error('uia_action_budget_invalid');
      performing = true;
      const id = randomBytes(16).toString('hex');
      const actionDeadline = Math.min(Date.now() + timeoutMs, deadline);
      let actionTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = new Promise<WindowsNativeUIAResult>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          actionTimer = setTimeout(
            () => {
              fail(Error('uia_action_deadline'));
              void close().catch(() => {});
            },
            Math.max(1, actionDeadline - Date.now()),
          );
        });
        void response.catch(() => {});
        const frame = JSON.stringify({
          ...request,
          ...('name' in request ? { match: request.match ?? 'exact' } : {}),
          id,
          budgetMs: Math.max(1, actionDeadline - Date.now()),
        });
        if (frame.length > 1048576) throw Error('uia_request_too_large');
        await child.writeStdin(Buffer.from(`${frame}\n`, 'utf8'));
        return await response;
      } catch (error) {
        fail(error);
        try {
          await close();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'uia_action_cleanup_failed');
        }
        throw error;
      } finally {
        performing = false;
        pending.delete(id);
        if (actionTimer) clearTimeout(actionTimer);
      }
    },
    close,
  };
}
