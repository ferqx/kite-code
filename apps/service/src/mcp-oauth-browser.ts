import { spawn as spawnNode } from 'node:child_process';
import {
  observeOwnedProcessIdentity,
  ownedProcessKernelState,
} from '@kite-ai/agent/process-observation';
import {
  decodeMcpOAuthLauncherObservation,
  type McpOAuthLauncherObservation,
} from './mcp-oauth-launcher-evidence';
import { McpOAuthSessionError } from './mcp-oauth-session';

/** Explicit Login only. The authorization URL is an argv element, never shell text or output. */
export type McpOAuthLauncherObserver = (evidence: McpOAuthLauncherObservation) => void;
/** Trusted host seam only. Raw source configuration cannot select an executable or spawner. */
export interface McpOAuthLauncherChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | number | null;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}
export type McpOAuthLauncherSpawner = (
  argv: string[],
  options: { stdin: 'ignore'; stdout: 'ignore'; stderr: 'ignore' },
) => McpOAuthLauncherChild;
export function createMcpOAuthBrowser(
  spawn: McpOAuthLauncherSpawner = (argv) => {
    const child = spawnNode(argv[0]!, argv.slice(1), { stdio: 'ignore', windowsHide: true });
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    void exited.catch(() => {});
    if (child.pid === undefined) throw Error('mcp_oauth_launcher_spawn_failed');
    return {
      pid: child.pid,
      exited,
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill(signal) {
        child.kill(signal);
      },
    };
  },
) {
  return async function openBrowser(
    url: URL,
    signal: AbortSignal,
    observe?: McpOAuthLauncherObserver,
  ): Promise<void> {
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new McpOAuthSessionError('mcp_oauth_authorization_url_invalid');
    signal.throwIfAborted();
    const argv =
      process.platform === 'darwin'
        ? ['/usr/bin/open', url.href]
        : process.platform === 'win32'
          ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url.href]
          : ['xdg-open', url.href];
    let child: McpOAuthLauncherChild;
    try {
      child = spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    } catch {
      throw new McpOAuthSessionError('mcp_oauth_browser_unavailable');
    }
    const evidence: McpOAuthLauncherObservation = {
      version: 1,
      coverage: 'oauth-launcher-only',
      browserOwnership: 'external',
      ownerPid: process.pid,
      launcher: {
        ...observeOwnedProcessIdentity(child.pid),
        exit: null,
        kernelState: 'unavailable',
      },
    };
    const publish = () => {
      try {
        evidence.launcher.kernelState = ownedProcessKernelState(evidence.launcher);
        const decoded = decodeMcpOAuthLauncherObservation(evidence, process.pid);
        if (decoded) observe?.(decoded);
      } catch {
        /* Metadata cannot alter the admitted authentication effect. */
      }
    };
    publish();
    let exitConfirmed = false;
    void child.exited.then(
      (code) => {
        exitConfirmed = true;
        const signal = child.signalCode;
        // The existing evidence format accepts only named signals or null.
        // Other native forms remain unreported rather than broadening admission.
        if (signal === null || typeof signal === 'string') {
          evidence.launcher.exit = { code, signal, reaped: true };
          publish();
        }
      },
      () => {},
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted!: () => void;
    let failed = false;
    let failure: unknown;
    try {
      const exit = await Promise.race([
        child.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new McpOAuthSessionError('mcp_oauth_browser_unavailable')),
            5000,
          );
          aborted = () => reject(new McpOAuthSessionError('mcp_oauth_cancelled'));
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        }),
      ]);
      signal.throwIfAborted();
      if (exit !== 0) throw new McpOAuthSessionError('mcp_oauth_browser_unavailable');
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (timer) clearTimeout(timer);
      if (aborted) signal.removeEventListener('abort', aborted);
      if (!exitConfirmed) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* A signal failure is unknown unless the original exit is observed below. */
        }
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const exited = await Promise.race([
          child.exited.then(
            () => true,
            () => false,
          ),
          new Promise<false>((resolve) => {
            deadline = setTimeout(() => resolve(false), 250);
          }),
        ]);
        if (deadline) clearTimeout(deadline);
        if (!exited) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* An ESRCH/exit race is resolved only by the original exit promise. */
          }
        }
        const confirmed = await Promise.race([
          child.exited.then(
            () => true,
            () => false,
          ),
          new Promise<false>((resolve) => {
            deadline = setTimeout(() => resolve(false), 1000);
          }),
        ]);
        if (deadline) clearTimeout(deadline);
        if (!confirmed) {
          failed = true;
          failure = new McpOAuthSessionError('mcp_oauth_cleanup_unknown');
        }
      }
    }
    publish();
    if (failed) throw failure;
  };
}
export const openMcpOAuthBrowser = createMcpOAuthBrowser();
