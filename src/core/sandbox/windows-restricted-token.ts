import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { normalizeMsys2DrivePathsInShellCommand } from '@/core/tools/path-utils';
import type { ShellExecutor } from '@/core/tools/shell';
import {
  appendTimeoutMessage,
  readWithProgress,
  resolveShellTimeoutMs,
  timeoutMessage,
} from '@/core/tools/shell';
import { BoundedOutputBuffer, BoundedProgressLineBuffer } from '@/core/tools/stream-output';
import type { ShellInput, ShellResult } from '@/core/types';
import {
  checkDangerousPaths,
  cleanupSandboxRuntimeDir,
  createSandboxRuntimeDir,
} from './shell-wrapper';
import type { SandboxOptions, ShellNetworkMode } from './types';
import {
  resolveWindowsSandboxRunnerV1,
  WINDOWS_SANDBOX_PROTOCOL_VERSION,
  type WindowsSandboxRunnerV1,
} from './windows-runner';

/**
 * The direct restricted-token runner has no large workspace staging phase.
 * This is only a small outer watchdog in case its control plane wedges after
 * the shell's own timeout has elapsed.
 */
const WINDOWS_RESTRICTED_TOKEN_CONTROL_PLANE_GRACE_MS = 5_000;
const WINDOWS_RESTRICTED_TOKEN_WATCHDOG_MS = 5_000;

/** Default hard active-process limit when no boundary supplies one. */
export const DEFAULT_WINDOWS_RESTRICTED_TOKEN_MAX_PROCESSES = 31;

/**
 * Environment variables inherited by the restricted child. The direct mode
 * keeps a deliberately narrow process environment even though its token is
 * deliberately narrow. In particular, credentials, proxy settings,
 * SSH agents and runtime injection variables are omitted. For an approved
 * Online invocation, the trusted native parent may independently project a
 * credential-free loopback proxy from the initiating user's WinINet settings.
 */
export const WINDOWS_RESTRICTED_TOKEN_ENV_ALLOWLIST = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMPUTERNAME',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'SESSIONNAME',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
] as const;

interface RestrictedTokenInvocationRequest {
  version: typeof WINDOWS_SANDBOX_PROTOCOL_VERSION;
  directWorkspace: WindowsRestrictedTokenDirectWorkspaceV1;
  /** Protocol-compatible invocation identity. */
  invocationName: string;
  commandLine: string;
  cwd: string;
  env: Record<string, string>;
  filesystemScope: 'workspace_write' | 'read_only' | 'full_access';
  workspaceRoot: string;
  runtimeRoot: string;
  shellRuntimeRoot: string;
  shellRuntime: 'bash' | 'busybox' | 'isksh';
  shellRuntimeDigest: string;
  coreutilsDigest: string;
  maxProcesses: number;
  timeoutMs: number;
  /** Explicit per-invocation authorization projected by the trusted adapter. */
  networkMode: 'off' | 'allow_all';
}

interface ExecutionReceipt {
  version: number;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  peakProcesses: number;
  activeProcessLimit: number;
  cleanupConfirmed: boolean;
  invocationName: string;
  error: string | null;
}

/** Per-invocation synthetic SIDs accepted by the native direct-workspace mode. */
export interface WindowsRestrictedTokenDirectWorkspaceV1 {
  runtimeCapabilitySid: string;
  /** Restricted-only SID denied on fixed protected paths for full-access calls. */
  approvedFilesystemGuardSid?: string;
  /** Present only for an internal startup probe; never persisted. */
  ephemeralWorkspaceCapabilitySid?: string;
}

export interface WindowsRestrictedTokenExecutorOptionsV1 extends SandboxOptions {
  /**
   * Internal composition probe. It verifies native token/process setup without
   * creating the normal persistent workspace capability ledger.
   */
  startupProbe?: boolean;
}

/**
 * Generate the four 32-bit components used by the native synthetic
 * `S-1-5-21-a-b-c-d` capability SID format. `randomUUID` is cryptographic on
 * supported Bun/Windows builds, and avoids relying on a host-managed account.
 */
export function createWindowsRestrictedTokenCapabilitySidV1(
  random: () => string = randomUUID,
): string {
  const hex = random().replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error('Unable to generate a valid Windows restricted-token capability SID.');
  }
  const components: string[] = [];
  for (let offset = 0; offset < hex.length; offset += 8) {
    const component = Number.parseInt(hex.slice(offset, offset + 8), 16);
    if (!Number.isSafeInteger(component)) {
      throw new Error('Unable to generate a valid Windows restricted-token capability SID.');
    }
    components.push(String(component));
  }
  return `S-1-5-21-${components.join('-')}`;
}

export function createWindowsRestrictedTokenDirectWorkspaceV1(input: {
  startupProbe: boolean;
  approvedFilesystem?: boolean;
  createCapabilitySid?: () => string;
}): WindowsRestrictedTokenDirectWorkspaceV1 {
  const createCapabilitySid =
    input.createCapabilitySid ?? createWindowsRestrictedTokenCapabilitySidV1;
  const runtimeCapabilitySid = createCapabilitySid();
  if (input.approvedFilesystem) {
    return {
      runtimeCapabilitySid,
      approvedFilesystemGuardSid: createCapabilitySid(),
    };
  }
  return input.startupProbe
    ? {
        runtimeCapabilitySid,
        ephemeralWorkspaceCapabilitySid: createCapabilitySid(),
      }
    : { runtimeCapabilitySid };
}

/**
 * The direct runner reuses the framed V1 protocol's validated id shape for
 * crash cleanup.
 */
export function createWindowsRestrictedTokenInvocationName(): string {
  return `kitecode.${randomUUID().replaceAll('-', '')}`;
}

/**
 * Direct restricted tokens cannot host the allowlist broker. Development
 * `allow_all` remains an explicit authorization signal, not structural
 * network-isolation evidence.
 */
export function restrictedTokenNetworkUnsupportedReasonV1(input: {
  hasNetworkBroker: boolean;
}): string | null {
  if (input.hasNetworkBroker) {
    return 'Network broker/allowlist execution is unavailable for the Windows restricted-token backend.';
  }
  return null;
}

/** Project the same per-invocation development network grant used by macOS and Linux. */
export function resolveWindowsRestrictedTokenNetworkModeV1(input: {
  configuredNetworkMode?: ShellNetworkMode;
  invocationNetworkMode?: ShellNetworkMode;
}): 'off' | 'allow_all' {
  return input.configuredNetworkMode === 'allow_all' || input.invocationNetworkMode === 'allow_all'
    ? 'allow_all'
    : 'off';
}

export function resolveWindowsRestrictedTokenFilesystemScopeV1(input: {
  configuredFilesystemScope?: 'read_only' | 'workspace_write';
  invocationFilesystemMode?: import('@/core/types').ShellFilesystemMode;
}): 'read_only' | 'workspace_write' | 'full_access' {
  if (input.invocationFilesystemMode === 'allow_all') return 'full_access';
  return input.configuredFilesystemScope === 'read_only' ? 'read_only' : 'workspace_write';
}

const WINDOWS_PACKAGE_MANAGER_SHIM_PRELUDE = [
  'npm() { cmd.exe /d /c npm.cmd "$@"; }',
  'npx() { cmd.exe /d /c npx.cmd "$@"; }',
  'pnpm() { cmd.exe /d /c pnpm.cmd "$@"; }',
  'pnpx() { cmd.exe /d /c pnpx.cmd "$@"; }',
  'yarn() { cmd.exe /d /c yarn.cmd "$@"; }',
  'yarnpkg() { cmd.exe /d /c yarnpkg.cmd "$@"; }',
  'corepack() { cmd.exe /d /c corepack.cmd "$@"; }',
].join('; ');

/**
 * The verified POSIX runtime does not apply Windows PATHEXT during bare-name
 * lookup and otherwise selects npm's extensionless Unix shim. Route standard
 * package-manager names through cmd.exe and their Windows command shims. The
 * explicit batch host also preserves PATH entries such as `C:\Program Files`
 * that isksh cannot launch as a `.cmd` file directly. This does not change the
 * command recorded for approval or receipts.
 */
export function wrapWindowsRestrictedTokenCommandV1(command: string): string {
  return `${WINDOWS_PACKAGE_MANAGER_SHIM_PRELUDE};\n${normalizeMsys2DrivePathsInShellCommand(command)}`;
}

/**
 * Create the Windows direct-workspace Shell executor. Local calls use the
 * unelevated token path; protocol V6 projects approved network/filesystem
 * authority while retaining the restricted token and Job Object boundary.
 */
export function createWindowsRestrictedTokenExecutor(
  options: WindowsRestrictedTokenExecutorOptionsV1,
): ShellExecutor {
  const runner = resolveWindowsSandboxRunnerV1();
  if (!runner) {
    return createUnavailableExecutor('windows_restricted_token_runner_unavailable');
  }
  return createRunnerExecutor(options, runner);
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

function createRunnerExecutor(
  options: WindowsRestrictedTokenExecutorOptionsV1,
  runner: WindowsSandboxRunnerV1,
): ShellExecutor {
  return async (input) => {
    const networkReason = restrictedTokenNetworkUnsupportedReasonV1({
      hasNetworkBroker: input.networkBroker !== undefined,
    });
    if (networkReason) return reject(input, networkReason);
    const networkMode = resolveWindowsRestrictedTokenNetworkModeV1({
      configuredNetworkMode: options.network?.mode,
      invocationNetworkMode: input.networkMode,
    });

    // This remains defense in depth only. The direct backend must not claim
    // that command-string filtering is a structural protected-path boundary.
    const dangerous = checkDangerousPaths(input.command);
    if (dangerous) {
      return reject(input, `Rejected: command references protected path '${dangerous}'`);
    }

    let workspaceRoot: string;
    let runtimeRoot: string;
    try {
      workspaceRoot = realpathSync.native(options.workspace);
      runtimeRoot = createSandboxRuntimeDir(workspaceRoot);
    } catch (error) {
      return reject(
        input,
        `Sandbox direct-workspace setup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const filesystemScope = resolveWindowsRestrictedTokenFilesystemScopeV1({
      configuredFilesystemScope: options.filesystemScope,
      invocationFilesystemMode: input.filesystemMode,
    });
    const directWorkspace = createWindowsRestrictedTokenDirectWorkspaceV1({
      startupProbe: options.startupProbe === true && filesystemScope === 'workspace_write',
      approvedFilesystem: filesystemScope === 'full_access',
    });
    const request: RestrictedTokenInvocationRequest = {
      version: WINDOWS_SANDBOX_PROTOCOL_VERSION,
      directWorkspace,
      invocationName: createWindowsRestrictedTokenInvocationName(),
      commandLine: wrapWindowsRestrictedTokenCommandV1(input.command),
      cwd: workspaceRoot,
      env: buildWindowsRestrictedTokenEnv(runtimeRoot, runner),
      filesystemScope,
      workspaceRoot,
      runtimeRoot,
      shellRuntimeRoot: runner.shellRuntimePath,
      shellRuntime: runner.shellRuntime,
      shellRuntimeDigest: runner.shellRuntimeDigest,
      coreutilsDigest: runner.coreutilsDigest,
      maxProcesses: options.maxProcessTreeTasks ?? DEFAULT_WINDOWS_RESTRICTED_TOKEN_MAX_PROCESSES,
      timeoutMs: resolveShellTimeoutMs(input.timeoutMs),
      networkMode,
    };

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([runner.path], {
        cwd: workspaceRoot,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (error) {
      const runtimeCleaned = cleanupSandboxRuntimeDir(runtimeRoot);
      const message = `Sandbox runner launch failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return reject(
        input,
        runtimeCleaned
          ? message
          : appendTerminalMessage(message, 'Sandbox runtime cleanup failed.'),
      );
    }

    const timeoutMs = request.timeoutMs;
    let timedOut = false;
    let cancelled = false;
    let runnerKilled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let outputStop: AbortController | undefined;
    let outcome: ShellResult | undefined;
    let receiptSeen = false;
    let receiptCleanupConfirmed = false;

    const terminate = (reason: 'timeout' | 'cancelled') => {
      if (timedOut || cancelled) return;
      timedOut = reason === 'timeout';
      cancelled = reason === 'cancelled';
      outputStop?.abort();
      void sendCancelFrame(proc);
    };
    const cancel = () => terminate('cancelled');

    try {
      if (!proc.stdin) throw new Error('runner stdin unavailable');
      (proc.stdin as { write(data: Uint8Array): void }).write(encodeFrame(request));
      timeoutId = setTimeout(
        () => terminate('timeout'),
        timeoutMs + WINDOWS_RESTRICTED_TOKEN_CONTROL_PLANE_GRACE_MS,
      );
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (input.signal?.aborted) cancel();

      outputStop = new AbortController();
      const stdoutAccumulator = new BoundedOutputBuffer();
      const stderrAccumulator = new BoundedOutputBuffer();
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      const stdoutProgress = new BoundedProgressLineBuffer();
      const stderrProgress = new BoundedProgressLineBuffer();
      const runnerStderr = readWithProgress(
        proc.stderr as ReadableStream<Uint8Array>,
        undefined,
        outputStop.signal,
      );
      const framePromise = (async () => {
        let receipt: ExecutionReceipt | undefined;
        try {
          for await (const payload of readFrames(proc.stdout as ReadableStream<Uint8Array>)) {
            const frame = parseFrame(payload);
            if (!frame) continue;
            if (frame.type === 'stdout') {
              onOutputFrame(
                input,
                Buffer.from(frame.data, 'base64'),
                'stdout',
                stdoutDecoder,
                stdoutAccumulator,
                stdoutProgress,
              );
            } else if (frame.type === 'stderr') {
              onOutputFrame(
                input,
                Buffer.from(frame.data, 'base64'),
                'stderr',
                stderrDecoder,
                stderrAccumulator,
                stderrProgress,
              );
            } else if (frame.type === 'exit') {
              receipt = frame.receipt;
              break;
            }
          }
        } finally {
          flushOutputFrames(input, 'stdout', stdoutDecoder, stdoutAccumulator, stdoutProgress);
          flushOutputFrames(input, 'stderr', stderrDecoder, stderrAccumulator, stderrProgress);
        }
        return receipt;
      })();

      const watchdogId = setTimeout(
        () => {
          try {
            proc.kill();
            runnerKilled = true;
          } catch {
            // The runner already exited.
          }
        },
        timeoutMs +
          WINDOWS_RESTRICTED_TOKEN_CONTROL_PLANE_GRACE_MS +
          WINDOWS_RESTRICTED_TOKEN_WATCHDOG_MS,
      );
      watchdogId.unref?.();
      let receipt: ExecutionReceipt | undefined;
      let runnerDiag = '';
      try {
        receipt = await framePromise;
        // Keep the watchdog armed until both pipes settle. A malformed runner
        // can close stdout without an exit receipt while retaining stderr and
        // its Job Object; clearing it after stdout alone would reintroduce an
        // unbounded control-plane wait.
        runnerDiag = (await runnerStderr).trim();
      } finally {
        clearTimeout(watchdogId);
      }
      receiptSeen = receipt !== undefined;
      receiptCleanupConfirmed = receipt?.cleanupConfirmed === true && receipt.error === null;
      if (timeoutId) clearTimeout(timeoutId);
      input.signal?.removeEventListener('abort', cancel);

      if (!receipt) {
        // Final cleanup kills and bounded-waits the runner before it invokes
        // the ACL recovery executable. Do not await `proc.exited` here: a
        // runner that closed stdout can otherwise wedge this invocation.
        runnerKilled = true;
        outcome = {
          ok: false,
          command: input.command,
          exitCode: timedOut ? 124 : cancelled ? 130 : -1,
          stdout: stdoutAccumulator.value(),
          stderr: timedOut
            ? appendTimeoutMessage(stderrAccumulator.value(), timeoutMs)
            : cancelled
              ? appendTerminalMessage(
                  runnerDiag || stderrAccumulator.value(),
                  'Command cancelled by user.',
                )
              : runnerDiag
                ? appendTerminalMessage(
                    runnerDiag,
                    'Sandbox runner exited without a receipt; process cleanup could not be confirmed.',
                  )
                : 'Sandbox runner exited without a receipt; process cleanup could not be confirmed.',
        };
        return outcome;
      }

      timedOut ||= receipt.timedOut;
      cancelled ||= receipt.cancelled;
      const stdout = stdoutAccumulator.value();
      const stderr = stderrAccumulator.value();
      const cleanupConfirmed = receipt.cleanupConfirmed && receipt.error === null;
      const processCleanup = {
        confirmedExited: cleanupConfirmed,
        gracefulRequested: !receipt.timedOut && !receipt.cancelled,
        forced: receipt.timedOut || receipt.cancelled,
        unconfirmedDescendantCount: cleanupConfirmed ? 0 : 1,
      };
      if (receipt.error) {
        outcome = {
          ok: false,
          command: input.command,
          exitCode: -1,
          stdout,
          stderr: appendTerminalMessage(stderr, `Sandbox error (${receipt.error}).`),
          processCleanup,
        };
        return outcome;
      }
      if (!receipt.cleanupConfirmed) {
        outcome = {
          ok: false,
          command: input.command,
          exitCode: timedOut ? 124 : cancelled ? 130 : receipt.exitCode,
          stdout,
          stderr: appendTerminalMessage(
            stderr,
            'Sandbox process cleanup could not confirm descendant exit.',
          ),
          processCleanup,
        };
        return outcome;
      }
      outcome = {
        ok: !timedOut && !cancelled && receipt.exitCode === 0,
        command: input.command,
        exitCode: timedOut ? 124 : cancelled ? 130 : receipt.exitCode,
        stdout,
        stderr: timedOut
          ? appendTimeoutMessage(stderr, timeoutMs)
          : cancelled
            ? appendTerminalMessage(stderr, 'Command cancelled by user.')
            : stderr,
        processCleanup,
      };
      return outcome;
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      input.signal?.removeEventListener('abort', cancel);
      const baseError = error instanceof Error ? error.message : String(error);
      outcome = {
        ok: false,
        command: input.command,
        exitCode: timedOut ? 124 : cancelled ? 130 : -1,
        stdout: '',
        stderr: timedOut
          ? timeoutMessage(timeoutMs)
          : cancelled
            ? 'Command cancelled by user.'
            : baseError,
      };
      return outcome;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      input.signal?.removeEventListener('abort', cancel);
      const recoveryRequired = runnerKilled || !receiptSeen || !receiptCleanupConfirmed;
      let recovered = !recoveryRequired;
      let runnerShutdownConfirmed = !recoveryRequired;
      if (recoveryRequired) {
        // The runner owns the Job Object. Its exit closes the Job and is the
        // prerequisite for an out-of-process ACL recovery helper; otherwise
        // recovery could revoke an ACE while a restricted child is still live.
        try {
          proc.kill();
          runnerKilled = true;
        } catch {
          // The runner may already have exited.
        }
        runnerShutdownConfirmed = await waitForRunnerExit(proc, 5_000);
        if (runnerShutdownConfirmed) {
          recovered = await recoverRestrictedTokenAcl(runner, request, workspaceRoot);
          if (!recovered && outcome) {
            outcome.ok = false;
            outcome.exitCode = -1;
            outcome.stderr = appendTerminalMessage(
              outcome.stderr,
              'Sandbox ACL crash recovery failed.',
            );
          }
        } else {
          recovered = false;
          if (outcome) {
            outcome.ok = false;
            outcome.exitCode = -1;
            outcome.stderr = appendTerminalMessage(
              outcome.stderr,
              'Sandbox runner shutdown could not be confirmed; ACL crash recovery was skipped.',
            );
          }
        }
      } else {
        try {
          proc.kill();
        } catch {
          // The runner already exited.
        }
      }

      // Only a native receipt proves the restricted Job was empty. A recovery
      // helper can revoke the invocation ACL after the runner exits, but it
      // must not race a surviving child by deleting its runtime directory.
      if (outcome && receiptCleanupConfirmed) {
        if (!cleanupSandboxRuntimeDir(runtimeRoot)) {
          outcome.ok = false;
          outcome.exitCode = -1;
          outcome.stderr = appendTerminalMessage(outcome.stderr, 'Sandbox runtime cleanup failed.');
        }
      } else if (outcome && (!recovered || !runnerShutdownConfirmed)) {
        outcome.stderr = appendTerminalMessage(
          outcome.stderr,
          'Sandbox runtime retained because cleanup was not confirmed.',
        );
      }
    }
  };
}

function reject(input: ShellInput, stderr: string): ShellResult {
  return {
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr,
  };
}

async function waitForRunnerExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.exited.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeoutMs);
        timeoutId.unref?.();
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
async function recoverRestrictedTokenAcl(
  runner: WindowsSandboxRunnerV1,
  request: RestrictedTokenInvocationRequest,
  cwd: string,
): Promise<boolean> {
  let cleanup: ReturnType<typeof Bun.spawn> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    cleanup = Bun.spawn([runner.path, '--cleanup'], {
      cwd,
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    if (!cleanup.stdin) return false;
    (cleanup.stdin as { write(data: Uint8Array): void }).write(encodeFrame(request));
    const timeout = new Promise<false>((resolve) => {
      timeoutId = setTimeout(() => {
        try {
          cleanup?.kill();
        } catch {
          // Already exited.
        }
        resolve(false);
      }, 5_000);
      timeoutId.unref?.();
    });
    const exitCode = await Promise.race([cleanup.exited.then((code) => code === 0), timeout]);
    return exitCode;
  } catch {
    try {
      cleanup?.kill();
    } catch {
      // Already exited.
    }
    return false;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function buildWindowsRestrictedTokenEnv(
  runtimeRoot: string,
  runner: WindowsSandboxRunnerV1,
): Record<string, string> {
  return buildWindowsRestrictedTokenEnvForTest(
    process.env,
    runtimeRoot,
    runner.shellRuntimePath,
    resolveBunExecutableForWindowsRestrictedTokenV1(),
  );
}

/** Build the direct token's child environment without touching the filesystem. */
export function buildWindowsRestrictedTokenEnvForTest(
  processEnv: NodeJS.ProcessEnv,
  runtimeRoot: string,
  shellRuntimePath: string,
  bunExecutablePath: string | null = null,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WINDOWS_RESTRICTED_TOKEN_ENV_ALLOWLIST) {
    const value = processEnv[key];
    if (value !== undefined) env[key] = value;
  }
  env.TEMP = runtimeRoot;
  env.TMP = runtimeRoot;
  env.HOME = runtimeRoot;
  env.BUN_INSTALL_CACHE_DIR = win32.join(runtimeRoot, 'bun-cache');
  const pathEntries = [runtimeRoot, win32.join(runtimeRoot, 'kite-coreutils'), shellRuntimePath];
  if (bunExecutablePath) pathEntries.push(win32.dirname(bunExecutablePath));
  if (env.PATH) pathEntries.push(env.PATH);
  env.PATH = pathEntries.join(';');
  return env;
}

/** Resolve an independently canonical Bun executable for the direct PATH entry. */
export function resolveBunExecutableForWindowsRestrictedTokenV1(
  input: {
    which?: () => string | null;
    execPath?: string | null;
    realpath?: (path: string) => string;
  } = {},
): string | null {
  let whichCandidate: string | null = null;
  try {
    whichCandidate = (input.which ?? (() => Bun.which('bun')))();
  } catch {
    // Fall through to process.execPath when PATH resolution is unavailable.
  }
  const execCandidate = input.execPath === undefined ? process.execPath : input.execPath;
  const canonicalize = input.realpath ?? realpathSync.native;
  for (const candidate of [whichCandidate, execCandidate]) {
    if (!candidate) continue;
    try {
      const canonical = canonicalize(candidate);
      const executableName = win32.basename(canonical).toLowerCase();
      if (executableName === 'bun.exe' || executableName === 'bun') return canonical;
    } catch {
      // Try the next independently validated candidate.
    }
  }
  return null;
}

function onOutputFrame(
  input: ShellInput,
  bytes: Uint8Array,
  stream: 'stdout' | 'stderr',
  decoder: TextDecoder,
  accumulator: BoundedOutputBuffer,
  progress: BoundedProgressLineBuffer,
): void {
  const text = decoder.decode(bytes, { stream: true });
  accumulator.append(text);
  if (input.onProgress) progress.push(text, (line) => input.onProgress?.(line, stream));
}

function flushOutputFrames(
  input: ShellInput,
  stream: 'stdout' | 'stderr',
  decoder: TextDecoder,
  accumulator: BoundedOutputBuffer,
  progress: BoundedProgressLineBuffer,
): void {
  const text = decoder.decode();
  if (text) {
    accumulator.append(text);
    if (input.onProgress) progress.push(text, (line) => input.onProgress?.(line, stream));
  }
  if (input.onProgress) progress.flush((line) => input.onProgress?.(line, stream));
}

async function sendCancelFrame(proc: { stdin?: unknown } | undefined): Promise<void> {
  const stdin = proc?.stdin;
  if (stdin && typeof stdin === 'object' && 'write' in stdin) {
    try {
      (stdin as { write(data: Uint8Array): void }).write(encodeFrame({ type: 'cancel' }));
    } catch {
      // The runner may already be gone; its Job kill-on-close backstop applies.
    }
  }
}

function encodeFrame(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  frame.set(payload, 4);
  return frame;
}

async function* readFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = stream.getReader();
  let buffer = Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = Buffer.concat([buffer, value]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) break;
        yield buffer.subarray(4, 4 + length);
        buffer = Buffer.from(buffer.subarray(4 + length));
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}

type RunnerFrame =
  | { type: 'log'; level: string; message: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; receipt: ExecutionReceipt };

function parseFrame(payload: Buffer): RunnerFrame | null {
  try {
    const value = JSON.parse(payload.toString('utf8'));
    if (
      value?.type === 'log' &&
      typeof value.level === 'string' &&
      typeof value.message === 'string'
    ) {
      return { type: 'log', level: value.level, message: value.message };
    }
    if (value?.type === 'stdout' && typeof value.data === 'string') {
      return { type: 'stdout', data: value.data };
    }
    if (value?.type === 'stderr' && typeof value.data === 'string') {
      return { type: 'stderr', data: value.data };
    }
    if (value?.type === 'exit' && value.receipt && typeof value.receipt === 'object') {
      return { type: 'exit', receipt: value.receipt as ExecutionReceipt };
    }
    return null;
  } catch {
    return null;
  }
}

function appendTerminalMessage(stderr: string, message: string): string {
  return stderr.trimEnd() ? `${stderr.trimEnd()}\n${message}` : message;
}
