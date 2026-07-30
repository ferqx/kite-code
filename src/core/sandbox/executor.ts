import { guardProcessTree, processTreeSpawnOptions } from '@/core/tools/process-tree';
import type { ShellExecutor } from '@/core/tools/shell';
import {
  appendTimeoutMessage,
  readWithProgress,
  resolveShellTimeoutMs,
  shellTool,
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

/** 获取当前系统 shell 路径 / Get current system shell path */
function getSystemShell(): string {
  return process.env.SHELL || '/bin/sh';
}

/** 创建沙箱化的 ShellExecutor / Create a sandboxed ShellExecutor */
export function createSandboxExecutor(options: SandboxOptions): ShellExecutor {
  const { enabled } = options;

  if (!enabled) {
    warn('Sandbox disabled by flag. Shell commands will run without isolation.');
    return shellTool;
  }

  const backend = detectSandboxBackend();

  switch (backend) {
    case 'seatbelt':
      return createSeatbeltExecutor(options);
    case 'bubblewrap':
      return createBwrapExecutor(options);
    default:
      return shellTool;
  }
}

/** macOS Seatbelt executor（参照 Codex create_seatbelt_command_args 使用 -p 传 profile）*/
function createSeatbeltExecutor(options: SandboxOptions): ShellExecutor {
  const { workspace, resourceLimits } = options;

  return createWrappedExecutor(
    workspace,
    resourceLimits,
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
  buildSpawn: (
    wrappedCommand: string,
    networkMode: ShellNetworkMode,
  ) => { cmd: string[]; stdin?: string },
  defaultNetworkMode: ShellNetworkMode = 'disabled',
): ShellExecutor {
  return async (input) => {
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
        ...processTreeSpawnOptions(),
      });
      processTree = guardProcessTree(proc);

      timeoutId = setTimeout(() => terminate('timeout'), timeoutMs);
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (input.signal?.aborted) cancel();

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
      if (termination) terminationResult = await termination;
      const exitCode = await proc.exited;
      if (timeoutId) clearTimeout(timeoutId);

      return {
        ok: !timedOut && !cancelled && exitCode === 0,
        command: input.command,
        exitCode: timedOut ? 124 : cancelled ? 130 : exitCode,
        stdout,
        stderr: timedOut
          ? appendTimeoutMessage(stderr, timeoutMs)
          : cancelled
            ? stderr.trimEnd()
              ? `${stderr.trimEnd()}\nCommand cancelled by user.`
              : 'Command cancelled by user.'
            : stderr,
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
          // Preserve the original sandbox outcome when process cleanup fails.
        }
      }
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
  };
}

let sandboxWarned = false;

function warn(message: string): void {
  if (sandboxWarned) return;
  sandboxWarned = true;
  console.warn(`[sandbox] ${message}`);
}
