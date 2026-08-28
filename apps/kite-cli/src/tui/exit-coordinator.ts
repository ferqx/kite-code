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
 * Observability is non-critical, but every exit path gives its bounded shutdown
 * a chance to settle before terminal teardown and process exit.
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
          if (lifecycle) await lifecycle.shutdownObservability(input.observabilityTimeoutMs ?? 250);
        } catch {
          // Telemetry cleanup cannot prevent terminal restoration.
        }
        try {
          await lifecycle?.dispose();
        } catch {
          // A local persistence cleanup failure must not strand the terminal.
        }
        try {
          input.unmount();
        } finally {
          input.exit(code);
        }
      })();
      return exitPromise;
    },
  });
}
