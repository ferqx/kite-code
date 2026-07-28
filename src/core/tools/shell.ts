import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ShellInput, ShellResult } from '@/core/types';
import { findBashBinary, findSystemBash } from './bash-path';
import { normalizeMsys2PathsInText } from './path-utils';

/** Shell 执行器函数签名 / Shell executor function signature */
export type ShellExecutor = (input: ShellInput) => Promise<ShellResult>;

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function terminateControlledProcessTree(
  proc: ReturnType<typeof Bun.spawn>,
  input: { platform?: NodeJS.Platform; graceMs?: number } = {},
): Promise<boolean> {
  const platform = input.platform ?? process.platform;
  const graceMs = input.graceMs ?? 3_000;
  if (platform === 'win32') {
    const killed = Bun.spawnSync(['taskkill.exe', '/pid', String(proc.pid), '/t', '/f'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const settled = await settlesWithin(proc.exited, graceMs);
    return settled && (killed.exitCode === 0 || killed.exitCode === 128);
  }
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      return settlesWithin(proc.exited, graceMs);
    }
  }
  if (await settlesWithin(proc.exited, graceMs)) return true;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Fall through to the convergence check.
    }
  }
  return settlesWithin(proc.exited, graceMs);
}

/** 断言目标路径在工作区范围内 / Assert target path is inside workspace */
export function assertInsideWorkspace(workspace: string, targetPath: string): string {
  const workspaceRoot = resolve(workspace);
  const absoluteTarget = resolve(workspaceRoot, targetPath.replace(/[\\/]+/g, '/'));
  const relativeTarget = relative(workspaceRoot, absoluteTarget);

  if (
    relativeTarget &&
    (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget))
  ) {
    throw new Error(`Refusing path outside workspace: ${targetPath}`);
  }

  return absoluteTarget;
}

/** 逐行读取 ReadableStream，每行触发 onLine，返回完整文本。
 *  Line-by-line stream reader — emits per-line callbacks as data arrives,
 *  returns accumulated full text when stream closes. */
export async function readWithProgress(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
  stopSignal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let buffer = '';
  let stopped = false;
  const stop = () => {
    stopped = true;
    void reader.cancel();
  };
  stopSignal?.addEventListener('abort', stop, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (stopped) break;
      const text = decoder.decode(value, { stream: true });
      result += text;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine?.(line);
    }
    // Flush partial multi-byte sequences from TextDecoder internal buffer
    if (!stopped && buffer.length > 0) {
      const flushed = decoder.decode();
      if (flushed) {
        buffer += flushed;
        result += flushed;
      }
      onLine?.(buffer);
    }
  } catch {
    // Stream interrupted (e.g. process killed) — return what we have
    if (!stopped && buffer.length > 0) {
      onLine?.(buffer);
    }
  } finally {
    stopSignal?.removeEventListener('abort', stop);
    // Release reader lock to avoid leaks
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return result;
}

/** 通过 Bun.spawn 执行 Shell 命令，返回结构化结果 / Execute shell command via Bun.spawn, return structured result */
export async function shellTool(input: ShellInput): Promise<ShellResult> {
  let timedOut = false;
  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const outputStop = new AbortController();
  const executionBoundary =
    process.platform === 'win32' ? ('unsandboxed_bash' as const) : ('unsandboxed_shell' as const);
  let removeAbortListener: (() => void) | undefined;
  let cleanupPromise: Promise<boolean> | undefined;
  const effectiveTimeoutMs =
    input.deadlineAt !== undefined
      ? Math.min(input.timeoutMs ?? Number.POSITIVE_INFINITY, input.deadlineAt - Date.now())
      : input.timeoutMs;
  try {
    const proc = Bun.spawn(buildShellInvocation(input.command), {
      cwd: input.workspace,
      stdout: 'pipe',
      stderr: 'pipe',
      ...(process.platform === 'win32' ? {} : { detached: true }),
    });
    const abort = () => {
      if (timedOut || cancelled) return;
      cancelled = true;
      outputStop.abort();
      cleanupPromise ??= terminateControlledProcessTree(proc, {
        graceMs: input.cancellationGraceMs,
      });
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    removeAbortListener = () => input.signal?.removeEventListener('abort', abort);
    if (input.signal?.aborted) abort();

    if (effectiveTimeoutMs !== undefined && effectiveTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (timedOut || cancelled) return;
        timedOut = true;
        // A background child can keep inherited stdout/stderr pipes open even
        // after the shell process is killed. Stop readers first so timeout
        // always reaches a terminal tool result.
        outputStop.abort();
        cleanupPromise ??= terminateControlledProcessTree(proc, {
          graceMs: input.cancellationGraceMs,
        });
      }, effectiveTimeoutMs);
    } else if (effectiveTimeoutMs !== undefined) {
      timedOut = true;
      outputStop.abort();
      cleanupPromise = terminateControlledProcessTree(proc, {
        graceMs: input.cancellationGraceMs,
      });
    }

    // Always consume both streams through the cancellable reader. This keeps
    // the no-progress path from hanging on inherited pipes as well.
    const [stdout, rawStderr] = await Promise.all([
      readWithProgress(
        proc.stdout,
        input.onProgress ? (line) => input.onProgress!(line, 'stdout') : undefined,
        outputStop.signal,
      ),
      readWithProgress(
        proc.stderr,
        input.onProgress ? (line) => input.onProgress!(line, 'stderr') : undefined,
        outputStop.signal,
      ),
    ]);
    const cleanupSucceeded = cleanupPromise ? await cleanupPromise : true;
    const exitCode = await proc.exited;
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortListener();

    return {
      ok: cleanupSucceeded && !timedOut && !cancelled && exitCode === 0,
      command: input.command,
      exitCode: timedOut ? 124 : cancelled ? 130 : exitCode,
      stdout: normalizeMsys2PathsInText(stdout),
      stderr: !cleanupSucceeded
        ? 'cancellation_cleanup_failed: controlled process tree did not converge.'
        : timedOut
          ? appendTimeoutMessage(
              cleanMsys2Noise(normalizeMsys2PathsInText(rawStderr)),
              effectiveTimeoutMs ?? 0,
            )
          : cleanMsys2Noise(normalizeMsys2PathsInText(rawStderr)),
      executionBoundary,
      ...(!cleanupSucceeded
        ? { failureCode: 'cancellation_cleanup_failed' as const }
        : timedOut
          ? { failureCode: 'deadline_exceeded' as const }
          : {}),
    };
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortListener?.();
    // AbortError 表示用户主动取消，标记为非失败 / AbortError means user cancellation, mark as non-failure
    const isAbort = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      command: input.command,
      exitCode: timedOut ? 124 : isAbort ? 130 : -1,
      stdout: '',
      stderr: timedOut
        ? timeoutMessage(input.timeoutMs ?? 0)
        : isAbort
          ? 'Command cancelled by user.'
          : error instanceof Error
            ? error.message
            : String(error),
      executionBoundary,
    };
  }
}

/** 构建平台特定的 Shell 调用参数 / Build platform-specific shell invocation arguments */
export interface ShellInvocationDependencies {
  platform?: NodeJS.Platform;
  findSystemBash?: () => string | null;
  findVendoredBash?: () => string | null;
  unixShell?: string;
}

export function buildShellInvocation(
  command: string,
  dependencies: ShellInvocationDependencies = {},
): string[] {
  if ((dependencies.platform ?? process.platform) === 'win32') {
    // Prefer system bash (Git for Windows) — full MSYS2 env, no DLL issues
    // PATH fix: ensures GNU coreutils (find, grep, sort, etc.) take priority
    // over Windows System32 equivalents that shadow them on MSYS2 PATH
    const systemBash = (dependencies.findSystemBash ?? findSystemBash)();
    if (systemBash) {
      return [systemBash, '-c', `export PATH="/usr/bin:$PATH" && ${command}`];
    }

    // Fallback to vendored bash with PATH fix for coreutils
    const vendoredBash = (dependencies.findVendoredBash ?? findBashBinary)();
    if (vendoredBash) {
      return [vendoredBash, '-c', `export PATH="/usr/bin:$PATH" && ${command}`];
    }

    throw new Error(
      'Shell admission denied: Windows requires Git for Windows Bash or the vendored MSYS2 Bash.',
    );
  }

  return [dependencies.unixShell ?? process.env.SHELL ?? '/bin/sh', '-lc', command];
}

/** 过滤 MSYS2 启动时的无害噪音（/tmp 警告等） */
function cleanMsys2Noise(stderr: string): string {
  return stderr.replace(/^bash\.exe: warning: could not find \/tmp, please create!\r?\n/gm, '');
}

export function timeoutMessage(timeoutMs: number): string {
  return `Command timed out after ${timeoutMs}ms.`;
}

export function appendTimeoutMessage(stderr: string, timeoutMs: number): string {
  const message = timeoutMessage(timeoutMs);
  return stderr.trimEnd() ? `${stderr.trimEnd()}\n${message}` : message;
}
