export interface TuiExitSessionLifecycle {
  shutdownObservability(timeoutMs: number): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface TuiExitShellExecutor {
  abortPreparation?(): void;
}

export interface TuiExitCoordinator {
  requestExit(code?: number): Promise<void>;
}

/**
 * Creates one idempotent exit boundary shared by commands, Ctrl+C and signals.
 * Terminal teardown is immediate once exit is chosen. Observability and client
 * cleanup continue afterward so slow I/O cannot leave the TUI visibly frozen.
 */
export function createTuiExitCoordinator(input: {
  getSessionLifecycle: () => TuiExitSessionLifecycle | null;
  /** Optional App Shell executor whose in-flight startup prewarm is aborted. */
  getShellExecutor?: () => TuiExitShellExecutor | null;
  unmount: () => void;
  exit: (code: number) => void;
  observabilityTimeoutMs?: number;
}): TuiExitCoordinator {
  let exitPromise: Promise<void> | null = null;
  return Object.freeze({
    requestExit(code = 0): Promise<void> {
      if (exitPromise) return exitPromise;
      exitPromise = (async () => {
        let lifecycle: TuiExitSessionLifecycle | null = null;
        try {
          lifecycle = input.getSessionLifecycle();
        } catch {
          // A broken lifecycle lookup cannot strand terminal teardown.
        }
        try {
          // Exit during the silent startup prewarm must not leave the probe
          // running: the abort reaches the native runner through the cancel
          // frame/EOF path, which empties its Job and revokes the ephemeral
          // ACL before exit.
          input.getShellExecutor?.()?.abortPreparation?.();
        } catch {
          // Prewarm cancellation failure must not strand terminal teardown.
        }
        try {
          // Restore the user's terminal before any asynchronous cleanup. Ink
          // must not keep the last frame and cursor ownership visible while a
          // child connection or observability sink is closing.
          input.unmount();
        } catch {
          // Cleanup and process exit still proceed if terminal teardown faults.
        }
        try {
          if (lifecycle) await lifecycle.shutdownObservability(input.observabilityTimeoutMs ?? 250);
        } catch {
          // Telemetry cleanup cannot prevent terminal restoration.
        }
        try {
          await lifecycle?.dispose();
        } catch {
          // A local persistence cleanup failure must not strand the terminal.
        }
        input.exit(code);
      })();
      return exitPromise;
    },
  });
}
