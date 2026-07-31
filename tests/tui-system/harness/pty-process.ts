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
import { createHeadlessTerminalScreen, type TerminalFrameMark } from './terminal-screen';
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
  /** Use the test-only composition root that issues one permit per remote MCP invocation. */
  remoteMcpEgressPermitResolver?: 'allow-each-invocation';
}

export interface PtyProcess {
  /** Write keystrokes and return the output checkpoint immediately before the action. */
  write(data: string): PtyOutputMark;
  /** Set raw mode on the terminal (disables line buffering) */
  setRawMode(enabled: boolean): PtyOutputMark;
  /** Resize the terminal (may not trigger resize event on Windows) */
  resize(cols: number, rows: number): PtyOutputMark;
  /** Get the current terminal viewport after VT/ANSI control sequences are applied. */
  viewport(): string;
  /** Get the terminal buffer retained above and within the current viewport. */
  scrollback(): string;
  /** Get all raw PTY output for diagnostics only (includes erased frames and ANSI). */
  transcript(): string;
  /** Wait until all PTY bytes already received by the harness are VT-parsed. */
  settleScreen(): Promise<void>;
  /** Capture a checkpoint in the sequence of VT-parsed viewport frames. */
  markScreen(): TerminalFrameMark;
  /** Read actual viewport frames parsed after a screen checkpoint. */
  screenFramesSince(mark: TerminalFrameMark): readonly string[];
  /** Capture a stable byte checkpoint in the PTY output stream. */
  markOutput(): PtyOutputMark;
  /** Read only output emitted after a captured checkpoint. */
  outputSince(mark: PtyOutputMark): string;
  /** Read only output emitted after the most recent write/resize/raw-mode action. */
  outputSinceLastAction(): string;
  /** Wait for the process to exit, returns exit code */
  waitForExit(): Promise<number>;
  /** Kill the process (SIGTERM → wait → SIGKILL fallback) */
  kill(): void;
  /** Kill the process and wait for it to exit (returns true if killed, false if already exited) */
  killAndWait(): Promise<boolean>;
  /** Check if the process has exited */
  readonly exited: boolean;
}

declare const PTY_OUTPUT_MARK: unique symbol;
export type PtyOutputMark = number & { readonly [PTY_OUTPUT_MARK]: true };

export interface PtyOutputBuffer {
  append(chunk: Uint8Array): PtyOutputMark;
  publishThrough(mark: PtyOutputMark): void;
  mark(): PtyOutputMark;
  output(): string;
  outputSince(mark: PtyOutputMark): string;
}

/**
 * Preserve raw PTY bytes so a checkpoint cannot accidentally claim a UTF-8
 * code point whose leading byte arrived before the checkpoint. Branded marks
 * prevent callers from inventing unsafe offsets.
 */
export function createPtyOutputBuffer(): PtyOutputBuffer {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let publishedByteLength = 0;

  const bytes = (): Uint8Array => {
    const merged = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  };

  const outputFrom = (mark: number): string => {
    if (!Number.isInteger(mark) || mark < 0 || mark > byteLength) {
      throw new Error(`Invalid PTY output mark ${mark}; current output length is ${byteLength}`);
    }
    const outputBytes = bytes().subarray(0, publishedByteLength);
    let start = mark;
    while (start < outputBytes.byteLength && (outputBytes[start]! & 0xc0) === 0x80) {
      start++;
    }
    return new TextDecoder().decode(outputBytes.subarray(start));
  };

  return {
    append(chunk) {
      chunks.push(chunk.slice());
      byteLength += chunk.byteLength;
      return byteLength as PtyOutputMark;
    },
    publishThrough(mark) {
      if (!Number.isInteger(mark) || mark < publishedByteLength || mark > byteLength) {
        throw new Error(
          `Invalid PTY publish mark ${mark}; published=${publishedByteLength}, received=${byteLength}`,
        );
      }
      publishedByteLength = mark;
    },
    mark() {
      return byteLength as PtyOutputMark;
    },
    output() {
      return new TextDecoder().decode(bytes());
    },
    outputSince(mark) {
      return outputFrom(mark);
    },
  };
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
  opts: Pick<PtyProcessOptions, 'cwd' | 'workspace' | 'remoteMcpEgressPermitResolver'>,
  projectRoot = process.cwd(),
): { cwd: string; entryPath: string } {
  return {
    cwd: opts.cwd ?? opts.workspace?.workspace ?? projectRoot,
    entryPath:
      opts.remoteMcpEgressPermitResolver === 'allow-each-invocation'
        ? join(projectRoot, 'tests/tui-system/fixtures/remote-mcp-egress-tui.tsx')
        : join(projectRoot, 'src/app/tui/index.tsx'),
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

  const outputBuffer = createPtyOutputBuffer();
  const terminalScreen = createHeadlessTerminalScreen(cols, rows);
  let screenDisposed = false;
  let lastActionMark = outputBuffer.mark();
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
      data(_terminal: unknown, chunk: Uint8Array) {
        const receivedThrough = outputBuffer.append(chunk);
        void terminalScreen.append(chunk).then(() => outputBuffer.publishThrough(receivedThrough));
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

  async function disposeScreen(): Promise<void> {
    if (screenDisposed) return;
    await terminalScreen.settled();
    terminalScreen.dispose();
    screenDisposed = true;
  }

  async function killAndWaitImpl(): Promise<boolean> {
    let killed = false;

    try {
      if (exited) return false;

      // Graceful attempt first
      proc.kill();
      killed = true;

      try {
        await waitForPtyExit(() => exited, KILL_TIMEOUT_MS);
      } catch {
        // Force kill — cannot be caught or ignored. On Windows this also kills
        // the process tree, which prevents orphaned bun.exe descendants.
        forceKillPtyChild(proc);
        await waitForPtyExit(() => exited, 5000);
      }

      return killed;
    } finally {
      await disposeScreen();
    }
  }

  let killPromise: Promise<boolean> | null = null;

  return {
    get exited() {
      return exited;
    },

    write(data: string) {
      lastActionMark = outputBuffer.mark();
      if (!exited && proc.terminal) {
        proc.terminal.write(data);
      }
      return lastActionMark;
    },

    setRawMode(enabled: boolean) {
      lastActionMark = outputBuffer.mark();
      if (!exited && proc.terminal && typeof proc.terminal.setRawMode === 'function') {
        proc.terminal.setRawMode(enabled);
      }
      return lastActionMark;
    },

    resize(newCols: number, newRows: number) {
      lastActionMark = outputBuffer.mark();
      void terminalScreen.resize(newCols, newRows);
      if (!exited && proc.terminal && typeof proc.terminal.resize === 'function') {
        proc.terminal.resize(newCols, newRows);
      }
      return lastActionMark;
    },

    viewport(): string {
      return terminalScreen.viewport();
    },

    scrollback(): string {
      return terminalScreen.scrollback();
    },

    transcript(): string {
      return outputBuffer.output();
    },

    settleScreen() {
      return terminalScreen.settled();
    },

    markScreen() {
      return terminalScreen.mark();
    },

    screenFramesSince(mark) {
      return terminalScreen.framesSince(mark);
    },

    markOutput() {
      return outputBuffer.mark();
    },

    outputSince(mark) {
      return outputBuffer.outputSince(mark);
    },

    outputSinceLastAction() {
      return outputBuffer.outputSince(lastActionMark);
    },

    waitForExit: async () => {
      const code = await waitForPtyExitCode(exitPromise, EXIT_TIMEOUT_MS);
      await disposeScreen();
      return code;
    },

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
