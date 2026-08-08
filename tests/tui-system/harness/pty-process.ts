/**
 * PTY Process Harness — spawn and control a TUI subprocess with real PTY.
 *
 * Uses Bun.spawn({ terminal }) (verified working in Phase 0) to create
 * a TTY-connected child process running `bun run src/app/tui/index.tsx`.
 *
 * Output is collected via the terminal's `data` callback. Keystrokes are
 * sent via `terminal.write()`. Terminal resize via `terminal.resize()`.
 */

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trustWorkspace } from '@/core/config/workspace-trust';
import {
  currentTuiSystemStepSignal,
  throwIfTuiSystemStepAborted,
  tuiSystemDelay,
} from './cancellation';
import type { MockModelServer } from './fixtures';
import { activeInput } from './input-helpers';
import {
  createHeadlessTerminalScreen,
  screenContains,
  stripAnsi,
  type TerminalFrameMark,
  waitForCondition,
  waitForOutputQuiescence,
} from './terminal-screen';
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
  /** Launch an already-built standalone executable instead of the source entrypoint. */
  executablePath?: string;
  /** Launch a test-owned TypeScript composition root through Bun. */
  entryPath?: string;
}

export type TuiReadiness = 'main' | 'first-run-provider' | 'workspace-trust';

export interface PtyProcess {
  /** Write keystrokes and return the output checkpoint immediately before the action. */
  write(data: string): PtyOutputMark;
  /** Set raw mode on the terminal (disables line buffering) */
  setRawMode(enabled: boolean): PtyOutputMark;
  /** Resize the terminal (may not trigger resize event on Windows) */
  resize(cols: number, rows: number): PtyOutputMark;
  /** Get the current terminal viewport after VT/ANSI control sequences are applied. */
  viewport(): string;
  /** Get the end-cursor input projection used by harness-owned input actions. */
  inputViewport(): string;
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
    await tuiSystemDelay(pollIntervalMs);
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
  const signal = currentTuiSystemStepSignal();
  let onAbort: (() => void) | undefined;
  throwIfTuiSystemStepAborted();
  try {
    return await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`PTY child did not exit within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
      ...(signal
        ? [
            new Promise<never>((_, reject) => {
              onAbort = () =>
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error('TUI system step aborted'),
                );
              signal.addEventListener('abort', onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function processGroupExists(processGroupId: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Prove the owned detached child and its PID-named process group both exist. */
export function verifiedOwnedProcessGroupId(pid: number): number | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    process.kill(pid, 0);
    process.kill(-pid, 0);
  } catch (error) {
    throw new Error(`Detached test child ${pid} does not own its PID-named process group.`, {
      cause: error,
    });
  }
  return pid;
}

function signalOwnedProcessTree(
  proc: ReturnType<typeof Bun.spawn>,
  signal: 'SIGTERM' | 'SIGKILL',
  processGroupId: number | undefined,
): void {
  if (process.platform === 'win32') {
    // Bun's signal emulation only targets the direct process on Windows. The
    // TUI may own descendants, so taskkill is needed to terminate its tree.
    Bun.spawnSync(['taskkill.exe', '/pid', String(proc.pid), '/t', '/f'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return;
  }
  if (processGroupId === undefined) {
    throw new Error(`Missing verified process group for POSIX child ${proc.pid}.`);
  }
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForOwnedProcessTreeExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<void> {
  if (process.platform === 'win32') return;
  await waitForPtyExit(() => !processGroupExists(processGroupId), timeoutMs, 50);
}

/** Terminate a detached test child and all members of its verified owned group. */
export async function terminateOwnedProcessTree(
  proc: ReturnType<typeof Bun.spawn>,
  processGroupId: number | undefined,
  timeoutMs = 2_000,
): Promise<void> {
  signalOwnedProcessTree(proc, 'SIGTERM', processGroupId);
  try {
    await waitForPtyExitCode(proc.exited, timeoutMs);
  } catch {
    signalOwnedProcessTree(proc, 'SIGKILL', processGroupId);
    await waitForPtyExitCode(proc.exited, 5_000);
  }
  if (processGroupId !== undefined && processGroupExists(processGroupId)) {
    signalOwnedProcessTree(proc, 'SIGKILL', processGroupId);
    await waitForOwnedProcessTreeExit(processGroupId, 5_000);
  }
}

export function resolveTuiLaunchPaths(
  opts: Pick<
    PtyProcessOptions,
    'cwd' | 'workspace' | 'remoteMcpEgressPermitResolver' | 'executablePath' | 'entryPath'
  >,
  projectRoot = process.cwd(),
): { cwd: string; entryPath: string } {
  const explicitRoots = [
    opts.executablePath,
    opts.entryPath,
    opts.remoteMcpEgressPermitResolver,
  ].filter(Boolean);
  if (explicitRoots.length > 1) {
    throw new Error('A TUI launch can select only one explicit test composition root.');
  }
  return {
    cwd: opts.cwd ?? opts.workspace?.workspace ?? projectRoot,
    entryPath:
      opts.executablePath ??
      opts.entryPath ??
      (opts.remoteMcpEgressPermitResolver === 'allow-each-invocation'
        ? join(projectRoot, 'tests/tui-system/fixtures/remote-mcp-egress-tui.tsx')
        : join(projectRoot, 'src/app/tui/index.tsx')),
  };
}

export function shouldDetachTuiProcess(
  platform: NodeJS.Platform,
  faultSoakProcessNonce: string | undefined,
): boolean {
  return platform !== 'win32' && !faultSoakProcessNonce;
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

  // Build an allowlisted child environment. Test scenarios must never inherit
  // developer credentials, provider configuration, proxies, or feature flags.
  // Explicit KITE_CODE_HOME is critical — on Windows, homedir() defaults to
  // USERPROFILE, so KITE_CODE_HOME must be set for defaultConfigPath().
  const childEnv: Record<string, string> = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'CI',
    'GITHUB_ACTIONS',
    'KITE_FAULT_SOAK_PROCESS_NONCE',
  ]) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  // Test overrides
  if (opts.workspace?.env) {
    Object.assign(childEnv, opts.workspace.env);
  }
  childEnv.TERM = 'xterm-256color';
  const detachTuiProcess = shouldDetachTuiProcess(
    process.platform,
    childEnv.KITE_FAULT_SOAK_PROCESS_NONCE,
  );
  const inheritsFaultSoakProcessGroup = process.platform !== 'win32' && !detachTuiProcess;

  const proc = Bun.spawn({
    cmd: opts.executablePath ? [entryPath] : [process.execPath, 'run', entryPath],
    cwd,
    env: childEnv,
    detached: detachTuiProcess,
    terminal: {
      cols,
      rows,
      data(_terminal: unknown, chunk: Uint8Array) {
        const receivedThrough = outputBuffer.append(chunk);
        void terminalScreen.append(chunk).then(() => outputBuffer.publishThrough(receivedThrough));
      },
    },
  });
  let ownedProcessGroupId: number | undefined;
  if (!inheritsFaultSoakProcessGroup) {
    try {
      ownedProcessGroupId = verifiedOwnedProcessGroupId(proc.pid);
    } catch (error) {
      proc.kill('SIGKILL');
      throw error;
    }
  }

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

  function signalTui(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (inheritsFaultSoakProcessGroup) {
      try {
        proc.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      return;
    }
    signalOwnedProcessTree(proc, signal, ownedProcessGroupId);
  }

  async function disposeScreen(): Promise<void> {
    if (screenDisposed) return;
    await terminalScreen.settled();
    terminalScreen.dispose();
    screenDisposed = true;
  }

  async function killAndWaitImpl(): Promise<boolean> {
    const wasRunning = !exited;

    try {
      if (!exited) {
        signalTui('SIGTERM');
        try {
          await waitForPtyExit(() => exited, KILL_TIMEOUT_MS);
        } catch {
          signalTui('SIGKILL');
          await waitForPtyExit(() => exited, 5000);
        }
      }
      if (ownedProcessGroupId !== undefined && processGroupExists(ownedProcessGroupId)) {
        signalOwnedProcessTree(proc, 'SIGKILL', ownedProcessGroupId);
        await waitForOwnedProcessTreeExit(ownedProcessGroupId, 5000);
      }
      return wasRunning;
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

    inputViewport(): string {
      return terminalScreen.inputViewport();
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

/** Spawn one isolated TUI and return only after its selected semantic surface is stable. */
export async function spawnReadyTui(
  opts: PtyProcessOptions & { readiness?: TuiReadiness } = {},
): Promise<PtyProcess> {
  const readiness = opts.readiness ?? 'main';
  const tui = spawnTui(opts);
  tui.setRawMode(true);
  try {
    await waitForTuiReady(tui, readiness, opts.workspace);
    return tui;
  } catch (error) {
    await tui.killAndWait().catch(() => {});
    throw new Error(
      `TUI failed ${readiness} readiness. Last output:\n${stripAnsi(tui.transcript()).slice(-1_500)}`,
      { cause: error },
    );
  }
}

/** Wait for one already-running TUI to expose a complete, stable semantic surface. */
export async function waitForTuiReady(
  tui: PtyProcess,
  readiness: TuiReadiness = 'main',
  workspace?: TestWorkspace,
): Promise<void> {
  const workspacePath = workspace ? realpathSync(workspace.workspace) : undefined;
  await waitForCondition(
    () => {
      const viewport = tui.viewport();
      if (readiness === 'main') {
        const input = activeInput(tui.inputViewport());
        return (
          input?.kind === 'main' &&
          input.value === '' &&
          screenContains(viewport, 'Kite Code') &&
          screenContains(viewport, 'mock-model') &&
          !screenContains(viewport, 'Loading...') &&
          !screenContains(viewport, 'Open this workspace?') &&
          !screenContains(viewport, 'Setup 1 of 2')
        );
      }
      if (readiness === 'first-run-provider') {
        return (
          screenContains(viewport, 'Setup 1 of 2') &&
          screenContains(viewport, 'Choose a model provider') &&
          screenContains(viewport, '› DeepSeek') &&
          screenContains(viewport, 'OpenAI') &&
          screenContains(viewport, 'Custom endpoint')
        );
      }
      return (
        workspacePath !== undefined &&
        screenContains(viewport, 'Open this workspace?') &&
        screenContains(viewport, workspacePath) &&
        screenContains(viewport, 'Trust this workspace and continue') &&
        screenContains(viewport, '› Exit Kite Code') &&
        !screenContains(viewport, 'shortcuts')
      );
    },
    `${readiness} TUI readiness`,
    15_000,
  );
  await waitForOutputQuiescence(() => tui.viewport(), 5_000, 250, false);
  await tui.settleScreen();
}
