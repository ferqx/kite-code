import { guardProcessTree, processTreeSpawnOptions } from '@/core/tools/process-tree';
import type { ShellExecutor } from '@/core/tools/shell';
import {
  appendTimeoutMessage,
  readWithProgress,
  resolveShellTimeoutMs,
  shellTool,
  timeoutMessage,
} from '@/core/tools/shell';
import type { ShellNetworkMode, ShellResult } from '@/core/types';
import { generateBwrapArgs } from './bwrap';
import { detectSandboxBackend } from './platform';
import { discoverRuntimeReadOnlyRoots, generateSandboxProfile } from './profile';
import { findApplySeccomp, resolveSeccompPath } from './seccomp';
import {
  buildEnvExportSnippet,
  buildEnvStripSnippet,
  buildHardenedEnv,
  buildUlimitPreamble,
  checkDangerousPaths,
  cleanupSandboxRuntimeDir,
  createSandboxRuntimeDir,
} from './shell-wrapper';
import type { SandboxOptions } from './types';

export function resolveSandboxExitCode(
  exitCode: number,
  state: { timedOut: boolean; cancelled: boolean; processCleanupConfirmed: boolean },
): number {
  if (state.timedOut) return 124;
  if (state.cancelled) return 130;
  if (!state.processCleanupConfirmed) return -1;
  return exitCode;
}

/** 获取当前系统 shell 路径 / Get current system shell path */
function getSystemShell(): string {
  return process.env.SHELL || '/bin/sh';
}

/** 创建沙箱化的 ShellExecutor / Create a sandboxed ShellExecutor */
export function createSandboxExecutor(options: SandboxOptions): ShellExecutor {
  const { enabled } = options;

  if (!enabled) {
    if (options.unavailableFallback === 'fail') {
      return createUnavailableExecutor('sandbox_disabled');
    }
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
      if (options.unavailableFallback === 'fail') {
        return createUnavailableExecutor('sandbox_backend_unavailable');
      }
      warn('No supported sandbox backend. Shell commands will run without isolation.');
      return shellTool;
  }
}

function createUnavailableExecutor(reason: string): ShellExecutor {
  return async (input) => ({
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr: `Sandbox unavailable (${reason}); refusing unsandboxed shell execution.`,
  });
}

/** macOS Seatbelt executor（参照 Codex create_seatbelt_command_args 使用 -p 传 profile）*/
function createSeatbeltExecutor(options: SandboxOptions): ShellExecutor {
  const { workspace, resourceLimits } = options;
  const runtimeReadOnlyRoots = options.runtimeReadOnlyRoots ?? discoverRuntimeReadOnlyRoots();

  return createWrappedExecutor(
    workspace,
    resourceLimits,
    (wrappedCommand, networkMode, sandboxRuntimeDir) => {
      const profile = generateSandboxProfile(workspace, {
        network: networkMode,
        filesystemScope: options.filesystemScope,
        sandboxRuntimeDir,
        runtimeReadOnlyRoots,
      });
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
  const seccompBinary = findApplySeccomp();

  return createWrappedExecutor(
    workspace,
    resourceLimits,
    (wrappedCommand, networkMode, sandboxRuntimeDir) => {
      const seccompPath = resolveSeccompPath(seccompBinary, workspace, sandboxRuntimeDir);
      const bwrapArgs = generateBwrapArgs(workspace, {
        network: networkMode,
        sandboxRuntimeDir,
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
    sandboxRuntimeDir: string,
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
    let processCleanupFailed = false;
    let sandboxRuntimeDir: string | undefined;
    let outcome: ShellResult | undefined;
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

      sandboxRuntimeDir = createSandboxRuntimeDir(workspace);
      const hardenedEnv = buildHardenedEnv(workspace, sandboxRuntimeDir);

      const preamble = [
        buildEnvStripSnippet(),
        buildUlimitPreamble(resourceLimits),
        buildEnvExportSnippet(hardenedEnv),
      ].join(' ');

      const wrappedCommand = `${preamble} ${input.command}`;
      const { cmd, stdin } = buildSpawn(
        wrappedCommand,
        input.networkMode ?? defaultNetworkMode,
        sandboxRuntimeDir,
      );

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
      if (!termination) {
        termination = processTree.terminate();
        terminationResult = await termination;
      }
      if (timeoutId) clearTimeout(timeoutId);

      outcome = {
        ok:
          !timedOut && !cancelled && exitCode === 0 && (terminationResult?.confirmedExited ?? true),
        command: input.command,
        exitCode: resolveSandboxExitCode(exitCode, {
          timedOut,
          cancelled,
          processCleanupConfirmed: terminationResult?.confirmedExited ?? true,
        }),
        stdout,
        stderr: timedOut
          ? appendTimeoutMessage(stderr, timeoutMs)
          : cancelled
            ? stderr.trimEnd()
              ? `${stderr.trimEnd()}\nCommand cancelled by user.`
              : 'Command cancelled by user.'
            : terminationResult && !terminationResult.confirmedExited
              ? stderr.trimEnd()
                ? `${stderr.trimEnd()}\nSandbox process cleanup could not confirm descendant exit.`
                : 'Sandbox process cleanup could not confirm descendant exit.'
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
      return outcome;
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      if (processTree && !termination) termination = processTree.terminate();
      if (termination) {
        try {
          terminationResult = await termination;
        } catch {
          processCleanupFailed = true;
        }
      }
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const baseError = timedOut
        ? timeoutMessage(timeoutMs)
        : cancelled || isAbort
          ? 'Command cancelled by user.'
          : error instanceof Error
            ? error.message
            : String(error);
      outcome = {
        ok: false,
        command: input.command,
        exitCode: resolveSandboxExitCode(-1, {
          timedOut,
          cancelled: cancelled || isAbort,
          processCleanupConfirmed: !processCleanupFailed,
        }),
        stdout: '',
        stderr: processCleanupFailed ? `${baseError}\nSandbox process cleanup failed.` : baseError,
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
      return outcome;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      input.signal?.removeEventListener('abort', cancel);
      processTree?.dispose();
      if (sandboxRuntimeDir && outcome) {
        const processCleanupConfirmed = !processTree || terminationResult?.confirmedExited === true;
        const runtimeCleanupConfirmed =
          processCleanupConfirmed && cleanupSandboxRuntimeDir(sandboxRuntimeDir);
        if (!runtimeCleanupConfirmed) {
          outcome.ok = false;
          outcome.exitCode = -1;
          const message = processCleanupConfirmed
            ? 'Sandbox runtime cleanup failed.'
            : 'Sandbox runtime retained because process cleanup was not confirmed.';
          outcome.stderr = outcome.stderr.trimEnd()
            ? `${outcome.stderr.trimEnd()}\n${message}`
            : message;
        }
      }
    }
  };
}

let sandboxWarned = false;

function warn(message: string): void {
  if (sandboxWarned) return;
  sandboxWarned = true;
  console.warn(`[sandbox] ${message}`);
}
