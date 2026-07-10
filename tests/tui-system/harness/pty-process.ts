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
  // cwd MUST be project root so `bun run src/app/tui/index.tsx` resolves.
  // Config is found via KITE_CODE_HOME env var → defaultConfigPath().
  const cwd = process.cwd();

  // If a mock server is provided, write config that points to it.
  // Config is written to BOTH the home-level (~/.kite-code/) AND the
  // workspace-level (.kite-code/) paths since the TUI merges both.
  // We set KITE_CODE_HOME env var so defaultConfigPath() resolves correctly.
  if (opts.mockServer && opts.workspace) {
    const mockConfig = {
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
      ...(opts.workspace.configOverrides ?? {}),
    };
    const configStr = JSON.stringify(mockConfig, null, 2);

    // User-level config at KITE_CODE_HOME/.kite-code/
    const homeDir = join(opts.workspace.home, '.kite-code');
    mkdirSync(homeDir, { recursive: true });
    const configFilePath = join(homeDir, 'kite-code.jsonc');
    writeFileSync(configFilePath, configStr);

    // Also write to workspace dir's .kite-code/ (project-level config,
    // resolved via projectConfigPath() if cwd is set to workspace)
    const wsDir = join(opts.workspace.workspace, '.kite-code');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'kite-code.jsonc'), configStr);
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
  childEnv['TERM'] = 'xterm-256color';

  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', 'src/app/tui/index.tsx'],
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
   * Kill the child process with SIGTERM, then SIGKILL if it doesn't exit.
   *
   * SIGTERM gives the process a chance to clean up. If the process ignores
   * SIGTERM (e.g. stuck in an Ink render loop or network retry), SIGKILL
   * guarantees termination — it cannot be caught, ignored, or blocked.
   * When the child dies, Bun closes the PTY, causing any grandchild processes
   * connected to the PTY slave to receive SIGHUP and exit.
   */
  const KILL_TIMEOUT_MS = 2000;

  async function killAndWaitImpl(): Promise<boolean> {
    if (exited) return false;

    // Graceful attempt first
    proc.kill();

    // Wait for graceful exit
    const start = Date.now();
    while (!exited && Date.now() - start < KILL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!exited) {
      // Force kill — cannot be caught or ignored
      proc.kill('SIGKILL');

      // Wait for exit confirmation
      const deadline = Date.now() + 5000;
      while (!exited && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
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

    waitForExit: () => exitPromise,

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
