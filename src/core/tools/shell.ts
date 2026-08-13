import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ShellInput, ShellResult } from '@/core/types';
import { findBashBinary, findSystemBash } from './bash-path';
import { normalizeMsys2PathsInText } from './path-utils';
import { guardProcessTree, processTreeSpawnOptions } from './process-tree';
import { BoundedOutputBuffer, BoundedProgressLineBuffer } from './stream-output';
import {
  buildPolicyProvenReadOnlyEnv,
  isCanonicalPathOutsideWorkspace,
  POLICY_PROVEN_READ_ONLY_EXECUTION,
} from './trusted-readonly-environment';

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

export type HostShellKindV1 = 'bash' | 'cmd' | 'powershell' | 'posix';

export interface HostShellInvocationV1 {
  kind: HostShellKindV1;
  argv: string[];
}

export interface HostShellResolutionDepsV1 {
  platform: NodeJS.Platform;
  systemRoot: string;
  configuredShell?: string;
  systemBash?: string | null;
  vendoredBash?: string | null;
  which: (name: string) => string | null;
}

/**
 * Policy-proven reads bypass user/login profiles and never select a shell from
 * a Workspace-controlled path. Windows keeps fixed or independently located
 * hosts, while POSIX uses the platform /bin/sh directly.
 */
export function buildPolicyProvenReadOnlyHostShellInvocationsV1(
  command: string,
  workspace: string,
  deps: Pick<HostShellResolutionDepsV1, 'platform' | 'systemRoot'> & {
    systemBash?: string | null;
    vendoredBash?: string | null;
    canonicalPathOutsideWorkspace?: (path: string) => boolean;
  } = {
    platform: process.platform,
    systemRoot: process.env.SystemRoot || 'C:\\Windows',
    systemBash: process.platform === 'win32' ? findSystemBash() : null,
    vendoredBash: process.platform === 'win32' ? findBashBinary() : null,
  },
): HostShellInvocationV1[] {
  if (deps.platform !== 'win32') {
    return [{ kind: 'posix', argv: ['/bin/sh', '-c', command] }];
  }

  const outsideWorkspace =
    deps.canonicalPathOutsideWorkspace ??
    ((path: string) => isCanonicalPathOutsideWorkspace(workspace, path));
  const candidates: HostShellInvocationV1[] = [];
  const seen = new Set<string>();
  for (const bash of [deps.systemBash, deps.vendoredBash]) {
    if (!bash || !outsideWorkspace(bash)) continue;
    const identity = bash.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push({
      kind: 'bash',
      argv: [bash, '-c', `export PATH="/usr/bin:$PATH" && ${command}`],
    });
  }
  candidates.push({
    kind: 'cmd',
    argv: [`${deps.systemRoot}\\System32\\cmd.exe`, '/d', '/c', command],
  });
  candidates.push({
    kind: 'powershell',
    argv: [
      `${deps.systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ],
  });
  return candidates;
}

/**
 * Resolve host interpreters in a stable cross-platform order. A later
 * candidate is attempted only when the previous interpreter could not start;
 * a user command that starts and exits non-zero is never replayed.
 */
export function buildHostShellInvocationsV1(
  command: string,
  deps: HostShellResolutionDepsV1 = {
    platform: process.platform,
    systemRoot: process.env.SystemRoot || 'C:\\Windows',
    configuredShell: process.env.SHELL,
    systemBash: process.platform === 'win32' ? findSystemBash() : null,
    vendoredBash: process.platform === 'win32' ? findBashBinary() : null,
    which: (name) => Bun.which(name),
  },
): HostShellInvocationV1[] {
  const candidates: HostShellInvocationV1[] = [];
  const seen = new Set<string>();
  const add = (kind: HostShellKindV1, argv: string[]) => {
    const executable = argv[0];
    if (!executable) return;
    const key = deps.platform === 'win32' ? executable.toLowerCase() : executable;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ kind, argv });
  };

  if (deps.platform === 'win32') {
    for (const bash of [deps.systemBash, deps.vendoredBash]) {
      if (bash) {
        add('bash', [bash, '-c', `export PATH="/usr/bin:$PATH" && ${command}`]);
      }
    }
    add('cmd', [`${deps.systemRoot}\\System32\\cmd.exe`, '/d', '/c', command]);
    for (const powershell of [
      deps.which('pwsh'),
      deps.which('powershell.exe'),
      deps.which('powershell'),
    ]) {
      if (powershell) {
        add('powershell', [
          powershell,
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          command,
        ]);
      }
    }
    return candidates;
  }

  const bash = deps.which('bash');
  if (bash) add('bash', [bash, '-lc', command]);
  if (deps.configuredShell) add('posix', [deps.configuredShell, '-lc', command]);
  const cmd = deps.which('cmd') ?? deps.which('cmd.exe');
  if (cmd) add('cmd', [cmd, '/d', '/c', command]);
  for (const powershell of [deps.which('pwsh'), deps.which('powershell')]) {
    if (powershell) {
      add('powershell', [
        powershell,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command,
      ]);
    }
  }
  add('posix', ['/bin/sh', '-lc', command]);
  return candidates;
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

/** 逐行读取 ReadableStream，每行触发 onLine，返回有界的 head+tail 文本。
 *  Line-by-line stream reader — emits per-line callbacks as data arrives,
 *  returns a bounded head+tail capture when stream closes. */
export async function readWithProgress(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
  stopSignal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const output = new BoundedOutputBuffer();
  const progressLines = new BoundedProgressLineBuffer();
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
      output.append(text);
      if (onLine) progressLines.push(text, onLine);
    }
    // Flush partial multi-byte sequences from TextDecoder internal buffer
    if (!stopped) {
      const flushed = decoder.decode();
      if (flushed) {
        output.append(flushed);
        if (onLine) progressLines.push(flushed, onLine);
      }
      if (onLine) progressLines.flush(onLine);
    }
  } catch {
    // Stream interrupted (e.g. process killed) — return what we have
    if (!stopped && onLine) progressLines.flush(onLine);
  } finally {
    stopSignal?.removeEventListener('abort', stop);
    // Release reader lock to avoid leaks
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return output.value();
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
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    let lastSpawnError: unknown;
    const policyProvenReadOnly = input.executionTrust === POLICY_PROVEN_READ_ONLY_EXECUTION;
    const candidates = policyProvenReadOnly
      ? buildPolicyProvenReadOnlyHostShellInvocationsV1(input.command, input.workspace)
      : buildHostShellInvocationsV1(input.command);
    const trustedEnv = policyProvenReadOnly
      ? buildPolicyProvenReadOnlyEnv(input.workspace)
      : undefined;
    for (const candidate of candidates) {
      try {
        proc = Bun.spawn(candidate.argv, {
          cwd: input.workspace,
          stdout: 'pipe',
          stderr: 'pipe',
          env: trustedEnv,
          ...processTreeSpawnOptions(),
        });
        break;
      } catch (error) {
        lastSpawnError = error;
      }
    }
    if (!proc) {
      throw lastSpawnError instanceof Error
        ? lastSpawnError
        : new Error('No Bash, cmd, PowerShell, or POSIX shell could be started.');
    }
    processTree = guardProcessTree(proc);

    timeoutId = setTimeout(() => terminate('timeout'), timeoutMs);
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) cancel();

    // Always consume both streams through the cancellable reader. This keeps
    // the no-progress path from hanging on inherited pipes as well.
    const [stdout, rawStderr] = await Promise.all([
      readWithProgress(
        proc.stdout as ReadableStream<Uint8Array>,
        input.onProgress ? (line) => input.onProgress!(line, 'stdout') : undefined,
        outputStop.signal,
      ),
      readWithProgress(
        proc.stderr as ReadableStream<Uint8Array>,
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
      ...(timedOut
        ? { terminationReason: 'timed_out' as const }
        : cancelled
          ? { terminationReason: 'cancelled' as const }
          : {}),
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
      ...(timedOut
        ? { terminationReason: 'timed_out' as const }
        : cancelled || isAbort
          ? { terminationReason: 'cancelled' as const }
          : {}),
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
