import { isAbsolute, relative, resolve, sep } from 'node:path';
import { normalizeMsys2PathsInText } from './path-utils';
import { findBashBinary, findSystemBash } from './shell-bash-path';
import type {
  ShellExecutor,
  ShellInput,
  ShellProcessPort,
  ShellProcessTermination,
  ShellResult,
} from './shell-contract';
import {
  buildPolicyProvenReadOnlyEnv,
  isCanonicalPathOutsideWorkspace,
  POLICY_PROVEN_READ_ONLY_EXECUTION,
} from './trusted-readonly-environment';

type BuiltinShellProcessHandle = ReturnType<ShellProcessPort['spawn']>;
type BuiltinShellProcessTermination = Awaited<
  ReturnType<BuiltinShellProcessHandle['processTree']['terminate']>
>;

/** Default hard limit for shell commands when the caller omits timeout_ms. */
export const DEFAULT_SHELL_TIMEOUT_MS = 10 * 60 * 1000;

/** Resolve every shell execution to a finite positive timeout. */
export function resolveShellTimeoutMs(timeoutMs?: number): number {
  return timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_SHELL_TIMEOUT_MS;
}

export type HostShellKind = 'bash' | 'cmd' | 'powershell' | 'posix';

export interface HostShellInvocation {
  kind: HostShellKind;
  argv: string[];
}

export interface HostShellResolutionDeps {
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
export function buildPolicyProvenReadOnlyHostShellInvocations(
  command: string,
  workspace: string,
  deps: Pick<HostShellResolutionDeps, 'platform' | 'systemRoot'> & {
    systemBash?: string | null;
    vendoredBash?: string | null;
    canonicalPathOutsideWorkspace?: (path: string) => boolean;
  } = {
    platform: process.platform,
    systemRoot: process.env.SystemRoot || 'C:\\Windows',
    systemBash: process.platform === 'win32' ? findSystemBash() : null,
    vendoredBash: process.platform === 'win32' ? findBashBinary() : null,
  },
): HostShellInvocation[] {
  if (deps.platform !== 'win32') {
    return [{ kind: 'posix', argv: ['/bin/sh', '-c', command] }];
  }

  const outsideWorkspace =
    deps.canonicalPathOutsideWorkspace ??
    ((path: string) => isCanonicalPathOutsideWorkspace(workspace, path));
  const candidates: HostShellInvocation[] = [];
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
export function buildHostShellInvocations(
  command: string,
  deps: HostShellResolutionDeps = {
    platform: process.platform,
    systemRoot: process.env.SystemRoot || 'C:\\Windows',
    configuredShell: process.env.SHELL,
    systemBash: process.platform === 'win32' ? findSystemBash() : null,
    vendoredBash: process.platform === 'win32' ? findBashBinary() : null,
    which: (name) => Bun.which(name),
  },
): HostShellInvocation[] {
  const candidates: HostShellInvocation[] = [];
  const seen = new Set<string>();
  const add = (kind: HostShellKind, argv: string[]) => {
    const executable = argv[0];
    if (!executable) return;
    const key = deps.platform === 'win32' ? executable.toLowerCase() : executable;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ kind, argv });
  };

  if (deps.platform === 'win32') {
    for (const bash of [deps.systemBash, deps.vendoredBash]) {
      if (bash) add('bash', [bash, '-c', `export PATH="/usr/bin:$PATH" && ${command}`]);
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

/** Assert a target path is inside the Workspace. */
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

/**
 * Build the Builtin Shell executor over one injected generic Host process
 * port. This keeps invocation, timeout, trusted-read-only environment, and
 * result semantics in Builtin while Host owns spawn/output/tree mechanics.
 */
export function createBuiltinShellExecutor(port: ShellProcessPort): ShellExecutor {
  return async function executeBuiltinShell(input: ShellInput): Promise<ShellResult> {
    const timeoutMs = resolveShellTimeoutMs(input.timeoutMs);
    let timedOut = false;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let termination: Promise<BuiltinShellProcessTermination> | undefined;
    let terminationResult: BuiltinShellProcessTermination | undefined;
    const outputStop = new AbortController();
    const terminate = (reason: 'timeout' | 'cancelled') => {
      if (timedOut || cancelled) return;
      timedOut = reason === 'timeout';
      cancelled = reason === 'cancelled';
      outputStop.abort();
      termination = processTree?.processTree.terminate();
    };
    const cancel = () => {
      if (timeoutId) clearTimeout(timeoutId);
      terminate('cancelled');
    };
    let processTree: ReturnType<ShellProcessPort['spawn']> | undefined;
    try {
      let proc: ReturnType<ShellProcessPort['spawn']> | undefined;
      let lastSpawnError: unknown;
      const policyProvenReadOnly = input.executionTrust === POLICY_PROVEN_READ_ONLY_EXECUTION;
      const candidates = policyProvenReadOnly
        ? buildPolicyProvenReadOnlyHostShellInvocations(input.command, input.workspace)
        : buildHostShellInvocations(input.command);
      const trustedEnv = policyProvenReadOnly
        ? buildPolicyProvenReadOnlyEnv(input.workspace)
        : undefined;
      for (const candidate of candidates) {
        try {
          proc = port.spawn({
            argv: candidate.argv,
            cwd: input.workspace,
            ...(trustedEnv ? { env: trustedEnv } : {}),
          });
          processTree = proc;
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

      timeoutId = setTimeout(() => terminate('timeout'), timeoutMs);
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (input.signal?.aborted) cancel();

      // Always consume both streams through the cancellable reader. This keeps
      // the no-progress path from hanging on inherited pipes as well.
      const [stdout, rawStderr] = await Promise.all([
        port.readOutput(
          proc.stdout,
          input.onProgress ? (line) => input.onProgress!(line, 'stdout') : undefined,
          outputStop.signal,
        ),
        port.readOutput(
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
        ...(timedOut
          ? { terminationReason: 'timed_out' as const }
          : cancelled
            ? { terminationReason: 'cancelled' as const }
            : {}),
        ...(terminationResult ? { processCleanup: processCleanupResult(terminationResult) } : {}),
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
        ...(terminationResult ? { processCleanup: processCleanupResult(terminationResult) } : {}),
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      input.signal?.removeEventListener('abort', cancel);
      processTree?.processTree.dispose();
    }
  };
}

/** Filter MSYS2 startup noise that is not a command result. */
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

function processCleanupResult(
  result: ShellProcessTermination,
): NonNullable<ShellResult['processCleanup']> {
  return {
    confirmedExited: result.confirmedExited,
    gracefulRequested: result.gracefulRequested,
    forced: result.forced,
    unconfirmedDescendantCount: result.unconfirmedProcessCount,
  };
}
