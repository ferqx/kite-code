import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ShellInput, ShellResult } from '@/core/types';
import { findBashBinary, findSystemBash } from './bash-path';
import { normalizeMsys2PathsInText } from './path-utils';
import { guardProcessTree, processTreeSpawnOptions } from './process-tree';

/** Shell 执行器函数签名 / Shell executor function signature */
export type ShellExecutor = (input: ShellInput) => Promise<ShellResult>;

/** Default hard limit for shell commands when the caller omits timeout_ms. */
export const DEFAULT_SHELL_TIMEOUT_MS = 10 * 60 * 1000;

/** Resolve every shell execution to a finite positive timeout. */
export function resolveShellTimeoutMs(timeoutMs?: number): number {
  return timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_SHELL_TIMEOUT_MS;
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
  const timeoutMs = resolveShellTimeoutMs(input.timeoutMs);
  let timedOut = false;
  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let termination: ReturnType<ReturnType<typeof guardProcessTree>['terminate']> | undefined;
  let terminationResult:
    | Awaited<ReturnType<ReturnType<typeof guardProcessTree>['terminate']>>
    | undefined;
  let processTree: ReturnType<typeof guardProcessTree> | undefined;
  const outputStop = new AbortController();
  const terminate = (reason: 'timeout' | 'cancelled') => {
    if (timedOut || cancelled) return;
    timedOut = reason === 'timeout';
    cancelled = reason === 'cancelled';
    outputStop.abort();
    termination = processTree?.terminate();
  };
  const cancel = () => {
    if (timeoutId) clearTimeout(timeoutId);
    terminate('cancelled');
  };
  try {
    const proc = Bun.spawn(buildShellInvocation(input.command), {
      cwd: input.workspace,
      stdout: 'pipe',
      stderr: 'pipe',
      ...processTreeSpawnOptions(),
    });
    processTree = guardProcessTree(proc);

    timeoutId = setTimeout(() => terminate('timeout'), timeoutMs);
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) cancel();

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
    if (termination) terminationResult = await termination;
    const exitCode = await proc.exited;
    if (timeoutId) clearTimeout(timeoutId);

    return {
      ok: !timedOut && !cancelled && exitCode === 0,
      command: input.command,
      exitCode: timedOut ? 124 : cancelled ? 130 : exitCode,
      stdout: normalizeMsys2PathsInText(stdout),
      stderr: timedOut
        ? appendTimeoutMessage(cleanMsys2Noise(normalizeMsys2PathsInText(rawStderr)), timeoutMs)
        : cancelled
          ? appendTerminalMessage(
              cleanMsys2Noise(normalizeMsys2PathsInText(rawStderr)),
              'Command cancelled by user.',
            )
          : cleanMsys2Noise(normalizeMsys2PathsInText(rawStderr)),
      ...(terminationResult
        ? {
            processCleanup: {
              confirmedExited: terminationResult.confirmedExited,
              gracefulRequested: terminationResult.gracefulRequested,
              forced: terminationResult.forced,
              unconfirmedDescendantCount: terminationResult.unconfirmedPids.length,
            },
          }
        : {}),
    };
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    if (termination) {
      try {
        terminationResult = await termination;
      } catch {
        // Preserve the original shell outcome when process cleanup fails.
      }
    }
    // AbortError 表示用户主动取消，标记为非失败 / AbortError means user cancellation, mark as non-failure
    const isAbort = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      command: input.command,
      exitCode: timedOut ? 124 : cancelled || isAbort ? 130 : -1,
      stdout: '',
      stderr: timedOut
        ? timeoutMessage(timeoutMs)
        : cancelled || isAbort
          ? 'Command cancelled by user.'
          : error instanceof Error
            ? error.message
            : String(error),
      ...(terminationResult
        ? {
            processCleanup: {
              confirmedExited: terminationResult.confirmedExited,
              gracefulRequested: terminationResult.gracefulRequested,
              forced: terminationResult.forced,
              unconfirmedDescendantCount: terminationResult.unconfirmedPids.length,
            },
          }
        : {}),
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', cancel);
    processTree?.dispose();
  }
}

/** 构建平台特定的 Shell 调用参数 / Build platform-specific shell invocation arguments */
function buildShellInvocation(command: string): string[] {
  if (process.platform === 'win32') {
    // Prefer system bash (Git for Windows) — full MSYS2 env, no DLL issues
    // PATH fix: ensures GNU coreutils (find, grep, sort, etc.) take priority
    // over Windows System32 equivalents that shadow them on MSYS2 PATH
    const systemBash = findSystemBash();
    if (systemBash) {
      return [systemBash, '-c', `export PATH="/usr/bin:$PATH" && ${command}`];
    }

    // Fallback to vendored bash with PATH fix for coreutils
    const vendoredBash = findBashBinary();
    if (vendoredBash) {
      return [vendoredBash, '-c', `export PATH="/usr/bin:$PATH" && ${command}`];
    }

    // Last resort: cmd.exe
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    return [`${systemRoot}\\System32\\cmd.exe`, '/d', '/c', command];
  }

  return [process.env.SHELL || '/bin/sh', '-lc', command];
}

/** 过滤 MSYS2 启动时的无害噪音（/tmp 警告等） */
function cleanMsys2Noise(stderr: string): string {
  return stderr.replace(/^bash\.exe: warning: could not find \/tmp, please create!\r?\n/gm, '');
}

export function timeoutMessage(timeoutMs: number): string {
  return `Command timed out after ${timeoutMs}ms.`;
}

export function appendTimeoutMessage(stderr: string, timeoutMs: number): string {
  return appendTerminalMessage(stderr, timeoutMessage(timeoutMs));
}

function appendTerminalMessage(stderr: string, message: string): string {
  return stderr.trimEnd() ? `${stderr.trimEnd()}\n${message}` : message;
}
