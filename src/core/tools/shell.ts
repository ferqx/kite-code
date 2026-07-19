import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ShellInput, ShellResult } from '@/core/types';
import { findBashBinary, findSystemBash } from './bash-path';
import { normalizeMsys2PathsInText } from './path-utils';

/** Shell 执行器函数签名 / Shell executor function signature */
export type ShellExecutor = (input: ShellInput) => Promise<ShellResult>;

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
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const outputStop = new AbortController();
  try {
    const proc = Bun.spawn(buildShellInvocation(input.command), {
      cwd: input.workspace,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: input.signal,
    });

    if (input.timeoutMs && input.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        // A background child can keep inherited stdout/stderr pipes open even
        // after the shell process is killed. Stop readers first so timeout
        // always reaches a terminal tool result.
        outputStop.abort();
        try {
          proc.kill();
        } catch {
          /* process may have exited already */
        }
      }, input.timeoutMs);
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
    const exitCode = await proc.exited;
    if (timeoutId) clearTimeout(timeoutId);

    return {
      ok: !timedOut && exitCode === 0,
      command: input.command,
      exitCode: timedOut ? 124 : exitCode,
      stdout: normalizeMsys2PathsInText(stdout),
      stderr: timedOut
        ? appendTimeoutMessage(
            cleanMsys2Noise(normalizeMsys2PathsInText(rawStderr)),
            input.timeoutMs!,
          )
        : cleanMsys2Noise(normalizeMsys2PathsInText(rawStderr)),
    };
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
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
    };
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
  const message = timeoutMessage(timeoutMs);
  return stderr.trimEnd() ? `${stderr.trimEnd()}\n${message}` : message;
}
