import type { ShellExecutor } from '@/core/tools/shell';
import {
  appendTimeoutMessage,
  readWithProgress,
  shellTool,
  terminateControlledProcessTree,
  timeoutMessage,
} from '@/core/tools/shell';
import type { ShellNetworkMode } from '@/core/types';
import { generateBwrapArgs } from './bwrap';
import { detectSandboxBackend } from './platform';
import { generateSandboxProfile } from './profile';
import { findApplySeccomp, resolveSeccompPath } from './seccomp';
import {
  buildEnvExportSnippet,
  buildEnvStripSnippet,
  buildHardenedEnv,
  buildUlimitPreamble,
  checkDangerousPaths,
  getSandboxRuntimeDir,
} from './shell-wrapper';
import type { SandboxOptions } from './types';

export interface SandboxExecutorDependencies {
  platform?: NodeJS.Platform;
  detectBackend?: typeof detectSandboxBackend;
  unsandboxedExecutor?: ShellExecutor;
}

/** 获取当前系统 shell 路径 / Get current system shell path */
function getSystemShell(): string {
  return process.env.SHELL || '/bin/sh';
}

/** 创建沙箱化的 ShellExecutor / Create a sandboxed ShellExecutor */
export function createSandboxExecutor(
  options: SandboxOptions,
  dependencies: SandboxExecutorDependencies = {},
): ShellExecutor {
  const { enabled } = options;
  const platform = dependencies.platform ?? process.platform;
  const detectBackend = dependencies.detectBackend ?? detectSandboxBackend;
  const unsandboxedExecutor = dependencies.unsandboxedExecutor ?? shellTool;

  if (!enabled) {
    warn('Sandbox disabled by flag. Shell commands will run without isolation.');
    return unsandboxedExecutor;
  }

  return async (input) => {
    // Admission is invocation-scoped: a backend that disappears after startup
    // must not silently downgrade an enabled sandbox to a raw shell.
    const backend = detectBackend();
    if (platform === 'win32') {
      return unsandboxedExecutor(input);
    }
    switch (backend) {
      case 'seatbelt':
        return createSeatbeltExecutor(options)(input);
      case 'bubblewrap':
        return createBwrapExecutor(options)(input);
      default:
        return {
          ok: false,
          command: input.command,
          exitCode: -1,
          stdout: '',
          stderr: 'Sandbox admission denied: enabled sandbox backend is unavailable.',
        };
    }
  };
}

/** macOS Seatbelt executor（参照 Codex create_seatbelt_command_args 使用 -p 传 profile）*/
function createSeatbeltExecutor(options: SandboxOptions): ShellExecutor {
  const { workspace, resourceLimits } = options;

  return createWrappedExecutor(
    workspace,
    resourceLimits,
    'sandboxed_seatbelt',
    (wrappedCommand, networkMode) => {
      const profile = generateSandboxProfile(workspace, { network: networkMode });
      return {
        cmd: ['/usr/bin/sandbox-exec', '-p', profile, getSystemShell(), '-c', wrappedCommand],
      };
    },
    options.network?.mode,
  );
}

/** Linux Bubblewrap executor */
function createBwrapExecutor(options: SandboxOptions): ShellExecutor {
  const { workspace, resourceLimits } = options;
  const bwrapPath = Bun.which('bwrap')!;
  const seccompPath = resolveSeccompPath(findApplySeccomp(), workspace);

  return createWrappedExecutor(
    workspace,
    resourceLimits,
    'sandboxed_bubblewrap',
    (wrappedCommand, networkMode) => {
      const bwrapArgs = generateBwrapArgs(workspace, {
        network: networkMode,
        sandboxRuntimeDir: getSandboxRuntimeDir(),
      });
      const shell = getSystemShell();
      const innerCmd = seccompPath
        ? [seccompPath, shell, '-c', wrappedCommand]
        : [shell, '-c', wrappedCommand];
      return { cmd: [bwrapPath, ...bwrapArgs, ...innerCmd] };
    },
    options.network?.mode,
  );
}

/**
 * 构建 wrapped command（ulimit + 环境硬化 + 用户命令）并执行
 * Build wrapped command (ulimit + env hardening + user command) and execute
 */
function createWrappedExecutor(
  workspace: string,
  resourceLimits: SandboxOptions['resourceLimits'],
  executionBoundary: 'sandboxed_seatbelt' | 'sandboxed_bubblewrap',
  buildSpawn: (
    wrappedCommand: string,
    networkMode: ShellNetworkMode,
  ) => { cmd: string[]; stdin?: string },
  defaultNetworkMode: ShellNetworkMode = 'disabled',
): ShellExecutor {
  return async (input) => {
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const outputStop = new AbortController();
    let cleanupPromise: Promise<boolean> | undefined;
    let cancelled = false;
    let removeAbortListener: (() => void) | undefined;
    const effectiveTimeoutMs =
      input.deadlineAt !== undefined
        ? Math.min(input.timeoutMs ?? Number.POSITIVE_INFINITY, input.deadlineAt - Date.now())
        : input.timeoutMs;
    try {
      // 执行前检查命令是否引用危险文件路径 / Pre-execution dangerous path check
      const dangerous = checkDangerousPaths(input.command);
      if (dangerous) {
        return {
          ok: false,
          command: input.command,
          exitCode: -1,
          stdout: '',
          stderr: `Rejected: command references protected path '${dangerous}'`,
        };
      }

      const hardenedEnv = buildHardenedEnv(workspace);

      const preamble = [
        buildEnvStripSnippet(),
        buildUlimitPreamble(resourceLimits),
        buildEnvExportSnippet(hardenedEnv),
      ].join(' ');

      const wrappedCommand = `${preamble} ${input.command}`;
      const { cmd, stdin } = buildSpawn(wrappedCommand, input.networkMode ?? defaultNetworkMode);

      const proc = Bun.spawn(cmd, {
        cwd: workspace,
        stdin: stdin !== undefined ? 'pipe' : 'inherit',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
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
          // Background descendants may retain inherited pipes after the shell
          // is killed. Cancel readers so the tool cannot remain non-terminal.
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

      if (stdin !== undefined && proc.stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      }

      const [stdout, stderr] = await Promise.all([
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
      removeAbortListener?.();

      return {
        ok: cleanupSucceeded && !timedOut && !cancelled && exitCode === 0,
        command: input.command,
        exitCode: timedOut ? 124 : cancelled ? 130 : exitCode,
        stdout,
        stderr: !cleanupSucceeded
          ? 'cancellation_cleanup_failed: controlled process tree did not converge.'
          : timedOut
            ? appendTimeoutMessage(stderr, effectiveTimeoutMs ?? 0)
            : stderr,
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
  };
}

let sandboxWarned = false;

function warn(message: string): void {
  if (sandboxWarned) return;
  sandboxWarned = true;
  console.warn(`[sandbox] ${message}`);
}
