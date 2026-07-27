/**
 * PTY Process Harness — spawn and control a TUI subprocess with real PTY.
 *
 * Uses Bun.spawn({ terminal }) (verified working in Phase 0) to create
 * a TTY-connected child process running `bun run src/app/tui/index.tsx`.
 *
 * Output is collected via the terminal's `data` callback. Keystrokes are
 * sent via `terminal.write()`. Terminal resize via `terminal.resize()`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trustWorkspace } from '@/core/config/workspace-trust';
import type { MockModelServer } from './fixtures';
import type { TestWorkspace } from './test-workspace';

export interface PtyProcessOptions {
  /** Terminal columns (default 120) */
  cols?: number;
  /** Terminal rows (default 40) */
  rows?: number;
  /** Working directory for the child process */
  cwd?: string;
  /** Mock model server for the TUI to connect to */
  mockServer?: MockModelServer;
  /** Test workspace (creates config pointing to mock server) */
  workspace?: TestWorkspace;
  /** Skip writing mock config — use for first-run/setup tests */
  noPreConfig?: boolean;
}

export interface PtyProcess {
  /** Write keystrokes to the child's stdin (simulates user typing) */
  write(data: string): void;
  /** Set raw mode on the terminal (disables line buffering) */
  setRawMode(enabled: boolean): void;
  /** Resize the terminal (may not trigger resize event on Windows) */
  resize(cols: number, rows: number): void;
  /** Get all raw PTY output received so far (includes ANSI escapes) */
  output(): string;
  /** Wait for the process to exit, returns exit code */
  waitForExit(): Promise<number>;
  /** Kill the process (SIGTERM → wait → SIGKILL fallback) */
  kill(): void;
  /** Kill the process and wait for it to exit (returns true if killed, false if already exited) */
  killAndWait(): Promise<boolean>;
  /** Check if the process has exited */
  readonly exited: boolean;
}

/** Wait until a PTY child has exited, or fail its cleanup instead of hiding a leak. */
export async function waitForPtyExit(
  hasExited: () => boolean,
  timeoutMs: number,
  pollIntervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!hasExited() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  if (!hasExited()) {
    throw new Error(`PTY child did not exit within ${timeoutMs}ms`);
  }
}

/** Wait for an exit code without allowing a failed TUI exit to stall cleanup forever. */
export async function waitForPtyExitCode(
  exitPromise: Promise<number>,
  timeoutMs: number,
): Promise<number> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`PTY child did not exit within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function forceKillPtyChild(proc: ReturnType<typeof Bun.spawn>): void {
  if (process.platform === 'win32') {
    // Bun's signal emulation only targets the direct process on Windows. The
    // TUI may own descendants, so taskkill is needed to terminate its tree.
    Bun.spawnSync(['taskkill.exe', '/pid', String(proc.pid), '/t', '/f'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return;
  }
  proc.kill('SIGKILL');
}

export function resolveTuiLaunchPaths(
  opts: Pick<PtyProcessOptions, 'cwd' | 'workspace'>,
  projectRoot = process.cwd(),
): { cwd: string; entryPath: string } {
  return {
    cwd: opts.cwd ?? opts.workspace?.workspace ?? projectRoot,
    entryPath: join(projectRoot, 'src/app/tui/index.tsx'),
  };
}

/**
 * Spawn the TUI subprocess with a real PTY.
 *
 * The TUI connects to the mock model server (if provided) via its config.
 * Keystrokes are sent via terminal.write() — use \r for Enter, \x03 for Ctrl+C,
 * \x1b for Escape, etc.
 */
export function spawnTui(opts: PtyProcessOptions = {}): PtyProcess {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;
  // Execute the project entrypoint by absolute path while keeping relative
  // tool paths inside the isolated test workspace.
  const { cwd, entryPath } = resolveTuiLaunchPaths(opts);

  // Pre-trust the launch directory (source:'test') so the startup gate does not
  // block every PTY scenario. This exercises the exact production "already
  // trusted" fast path; no env bypass exists because Bun auto-injects
  // `<cwd>/.env*` and an env switch could be forged by workspace files.
  // Scenarios testing the gate itself pass enforceWorkspaceTrust: true.
  if (opts.workspace && !opts.workspace.enforceWorkspaceTrust) {
    trustWorkspace({
      workspace: cwd,
      source: 'test',
      storePath: join(opts.workspace.home, '.kite-code', 'workspace-trust.jsonc'),
    });
  }

  // If a mock server is provided, write config that points to it.
  // Config is written to BOTH the home-level (~/.kite-code/) AND the
  // workspace-level (.kite-code/) paths since the TUI merges both.
  // We set KITE_CODE_HOME env var so defaultConfigPath() resolves correctly.
  // Skip when noPreConfig is set — used for first-run/setup tests.
  if (opts.mockServer && opts.workspace && !opts.noPreConfig) {
    const baseMockConfig = {
      provider: {
        mock: {
          type: 'openai-compatible' as const,
          apiKey: 'test-key',
          baseURL: opts.mockServer.baseURL,
          model: 'mock-model',
          models: ['mock-model'],
        },
      },
      model: {
        default: { provider: 'mock' as const, name: 'mock-model' },
      },
    };
    const userConfigStr = JSON.stringify(
      { ...baseMockConfig, ...(opts.workspace.configOverrides ?? {}) },
      null,
      2,
    );
    const projectConfigStr = JSON.stringify(
      {
        ...baseMockConfig,
        ...(opts.workspace.projectConfigOverrides ?? opts.workspace.configOverrides ?? {}),
      },
      null,
      2,
    );

    // User-level config at KITE_CODE_HOME/.kite-code/
    const homeDir = join(opts.workspace.home, '.kite-code');
    mkdirSync(homeDir, { recursive: true });
    const configFilePath = join(homeDir, 'kite-code.jsonc');
    writeFileSync(configFilePath, userConfigStr);

    // Also write to workspace dir's .kite-code/ (project-level config,
    // resolved via projectConfigPath() if cwd is set to workspace)
    const wsDir = join(opts.workspace.workspace, '.kite-code');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'kite-code.jsonc'), projectConfigStr);
  }

  const chunks: Uint8Array[] = [];
  let exited = false;
  let exitResolver: ((code: number) => void) | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    exitResolver = resolve;
  });

  // Build env: merge parent env with test overrides.
  // Explicit KITE_CODE_HOME is critical — on Windows, homedir() defaults to
  // USERPROFILE, so KITE_CODE_HOME must be set for defaultConfigPath().
  const childEnv: Record<string, string> = {};
  // Copy only defined parent env vars (process.env can have undefined values)
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  // Test overrides
  if (opts.workspace?.env) {
    Object.assign(childEnv, opts.workspace.env);
  }
  childEnv.TERM = 'xterm-256color';

  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', entryPath],
    cwd,
    env: childEnv,
    terminal: {
      cols,
      rows,
      data(_terminal: any, chunk: Uint8Array) {
        chunks.push(chunk);
      },
    },
  });

  proc.exited.then((code) => {
    exited = true;
    exitResolver?.(code);
  });

  /**
   * Kill the child process with SIGTERM, then force-kill it if it doesn't exit.
   *
   * SIGTERM gives the process a chance to clean up. If the process ignores
   * SIGTERM (e.g. stuck in an Ink render loop or network retry), SIGKILL
   * guarantees termination — it cannot be caught, ignored, or blocked.
   * On Windows, force-kill uses taskkill /T because Bun's signal emulation
   * cannot guarantee that descendant bun.exe processes are terminated.
   */
  const KILL_TIMEOUT_MS = 2000;
  const EXIT_TIMEOUT_MS = 15_000;

  async function killAndWaitImpl(): Promise<boolean> {
    if (exited) return false;

    // Graceful attempt first
    proc.kill();

    try {
      await waitForPtyExit(() => exited, KILL_TIMEOUT_MS);
    } catch {
      // Force kill — cannot be caught or ignored. On Windows this also kills
      // the process tree, which prevents orphaned bun.exe descendants.
      forceKillPtyChild(proc);
      await waitForPtyExit(() => exited, 5000);
    }

    return true;
  }

  let killPromise: Promise<boolean> | null = null;

  return {
    get exited() {
      return exited;
    },

    write(data: string) {
      if (!exited && proc.terminal) {
        proc.terminal.write(data);
      }
    },

    setRawMode(enabled: boolean) {
      if (!exited && proc.terminal && typeof proc.terminal.setRawMode === 'function') {
        proc.terminal.setRawMode(enabled);
      }
    },

    resize(newCols: number, newRows: number) {
      if (!exited && proc.terminal && typeof proc.terminal.resize === 'function') {
        proc.terminal.resize(newCols, newRows);
      }
    },

    output(): string {
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      return new TextDecoder().decode(merged);
    },

    waitForExit: () => waitForPtyExitCode(exitPromise, EXIT_TIMEOUT_MS),

    kill() {
      // Fire-and-forget: initiate kill without waiting
      if (!killPromise) {
        killPromise = killAndWaitImpl();
      }
      killPromise.catch(() => {
        /* best effort */
      });
    },

    killAndWait: () => {
      if (!killPromise) {
        killPromise = killAndWaitImpl();
      }
      return killPromise;
    },
  };
}
