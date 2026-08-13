import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createSandboxExecutor } from '@/core/sandbox/executor';
import { detectSandboxBackend, type SandboxBackend } from '@/core/sandbox/platform';
import type {
  ExecutionBoundaryV1,
  ExecutionCapabilitySurfaceV1,
  ProductionExecutionEntrypointV1,
} from '@/core/sandbox/types';
import { type ShellExecutor, shellTool } from '@/core/tools/shell';
import type { ShellResult } from '@/core/types';

export interface AppSandboxCompositionConfigV1 {
  sandbox: { enabled: boolean };
  executionBoundary?: ExecutionBoundaryV1;
  executionCapabilitySurface?: ExecutionCapabilitySurfaceV1;
}

export type AppShellRuntimeModeV1 = 'sandbox' | 'host_shell' | 'denied';

export interface AppShellRuntimeDecisionV1 {
  mode: AppShellRuntimeModeV1;
  backend: SandboxBackend;
  reason?: string;
}

export interface AppSandboxBackendResolutionV1 {
  backend: SandboxBackend;
  /** Stable availability diagnostic used only when no backend was selected. */
  unavailableReason?: string;
}
export type AppShellExecutorV1 = ShellExecutor & {
  /** Resolve and cache one sandbox-or-host decision before any user script runs. */
  prepare(): Promise<AppShellRuntimeDecisionV1>;
  /**
   * Cancel an in-flight preparation (TUI exit while the silent startup
   * prewarm is still running). The aborted attempt is not cached; the next
   * prepare() starts a fresh startup probe. Native cleanup rides the probe's
   * cancel/EOF path, so no ACL or Job state is stranded.
   */
  abortPreparation?(): void;
};

/** Thrown by prepare() when the attempt was aborted by abortPreparation(). */
export const SANDBOX_PREPARATION_ABORTED_REASON = 'sandbox_preparation_aborted';

const APP_SANDBOX_PREFLIGHT_TIMEOUT_MS = 15_000;
const APP_SANDBOX_PREFLIGHT_DIRECTORY_PREFIX = 'kite-code-sandbox-preflight-';
/**
 * Startup sweep only removes preflight directories that are clearly orphaned.
 * A concurrently running TUI owns its live probe directory for seconds, so the
 * age bound must stay far above the probe's worst-case runtime.
 */
const APP_SANDBOX_PREFLIGHT_SWEEP_MIN_AGE_MS = 10 * 60_000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

function unavailableExecutor(reason: string): ShellExecutor {
  return async (input) => ({
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr: `Sandbox unavailable (${reason}); refusing unsandboxed shell execution.`,
  });
}

function isOwnedPreflightWorkspace(path: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedTempDirectory = resolve(tmpdir());
  const name = basename(resolvedPath);
  return (
    dirname(resolvedPath) === resolvedTempDirectory &&
    name.startsWith(APP_SANDBOX_PREFLIGHT_DIRECTORY_PREFIX) &&
    name.length > APP_SANDBOX_PREFLIGHT_DIRECTORY_PREFIX.length
  );
}

async function cleanupPreflightWorkspace(path: string): Promise<string | undefined> {
  if (!isOwnedPreflightWorkspace(path)) return 'sandbox_preflight_workspace_cleanup_refused';
  try {
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 50,
    });
    return undefined;
  } catch (error) {
    return `sandbox_preflight_workspace_cleanup_failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Best-effort removal of preflight workspaces orphaned by a TUI that exited
 * (or was killed) before its probe cleanup ran. Never throws: a sweep failure
 * is cosmetic garbage in the OS temp directory, not a sandbox error. The age
 * bound protects live probe directories owned by concurrently running TUI
 * instances.
 */
export async function sweepOwnedSandboxPreflightWorkspaces(
  now: number = Date.now(),
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(tmpdir());
  } catch {
    return;
  }
  const tempDirectory = resolve(tmpdir());
  await Promise.all(
    names
      .map((name) => join(tempDirectory, name))
      .filter((path) => isOwnedPreflightWorkspace(path))
      .map(async (path) => {
        try {
          const stats = await stat(path);
          if (!stats.isDirectory()) return;
          if (now - stats.mtimeMs < APP_SANDBOX_PREFLIGHT_SWEEP_MIN_AGE_MS) return;
          await rm(path, { recursive: true, force: true, maxRetries: 1 });
        } catch {
          // Owned-by-prefix but unreadable/locked directories stay for the
          // next sweep; deletion is strictly best effort.
        }
      }),
  );
}

export function createPreparedAppShellExecutorV1(input: {
  workspace: string;
  sandboxEnabled: boolean;
  fallbackAllowed: boolean;
  resolveBackend: () =>
    | SandboxBackend
    | AppSandboxBackendResolutionV1
    | Promise<SandboxBackend | AppSandboxBackendResolutionV1>;
  createNativeExecutor: (
    workspace: string,
    purpose: 'preflight' | 'execution',
    backend: Exclude<SandboxBackend, 'none'>,
  ) => ShellExecutor;
  hostExecutor?: ShellExecutor;
  deniedReason?: string;
  /** Test seam for proving backend discovery happens only after an event-loop turn. */
  yieldBeforeResolve?: () => Promise<void>;
}): AppShellExecutorV1 {
  let selectedExecutor: ShellExecutor | undefined;
  let preparation: Promise<AppShellRuntimeDecisionV1> | undefined;
  let warmAbort = new AbortController();

  const selectStartupFailure = (reason: string): AppShellRuntimeDecisionV1 => {
    if (input.fallbackAllowed) {
      selectedExecutor = input.hostExecutor ?? shellTool;
      return { mode: 'host_shell', backend: 'none', reason };
    }
    selectedExecutor = unavailableExecutor(reason);
    return { mode: 'denied', backend: 'none', reason };
  };

  const abortPreparation = (): void => {
    warmAbort.abort();
    // The aborted attempt must not be consumed by the next caller: rotation
    // gives the next prepare() a live controller and drops the cached
    // (about-to-reject) promise.
    warmAbort = new AbortController();
    preparation = undefined;
  };

  const prepare = (): Promise<AppShellRuntimeDecisionV1> => {
    preparation ??= (async () => {
      // Snapshot the controller for this attempt: abortPreparation() rotates
      // it, and the in-flight attempt must observe its own abort only.
      const attemptSignal = warmAbort.signal;
      const assertNotAborted = (): void => {
        if (attemptSignal.aborted) throw new Error(SANDBOX_PREPARATION_ABORTED_REASON);
      };

      if (input.deniedReason) {
        selectedExecutor = unavailableExecutor(input.deniedReason);
        return { mode: 'denied', backend: 'none', reason: input.deniedReason };
      }

      if (!input.sandboxEnabled) {
        selectedExecutor = input.hostExecutor ?? shellTool;
        return {
          mode: 'host_shell',
          backend: 'none',
          reason: 'sandbox_disabled',
        };
      }

      // Yield an event-loop turn before any synchronous backend discovery or
      // native executor initialization is attempted, so an early startup
      // prewarm never blocks the first render.
      await (input.yieldBeforeResolve ?? yieldToEventLoop)();
      assertNotAborted();

      let backend: SandboxBackend;
      try {
        const resolved = await input.resolveBackend();
        assertNotAborted();
        backend = typeof resolved === 'string' ? resolved : resolved.backend;
        if (backend === 'none') {
          return selectStartupFailure(
            typeof resolved === 'string'
              ? 'sandbox_backend_unavailable'
              : (resolved.unavailableReason ?? 'sandbox_backend_unavailable'),
          );
        }
      } catch (error) {
        assertNotAborted();
        return selectStartupFailure(
          `sandbox_backend_detection_failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      let probeWorkspace: string | undefined;
      let probe: ShellResult | undefined;
      let startupFailure: string | undefined;
      try {
        probeWorkspace = await mkdtemp(join(tmpdir(), APP_SANDBOX_PREFLIGHT_DIRECTORY_PREFIX));
        if (!isOwnedPreflightWorkspace(probeWorkspace)) {
          throw new Error('sandbox_preflight_workspace_validation_failed');
        }
        const probeExecutor = input.createNativeExecutor(probeWorkspace, 'preflight', backend);
        probe = await probeExecutor({
          workspace: probeWorkspace,
          command: ':',
          timeoutMs: APP_SANDBOX_PREFLIGHT_TIMEOUT_MS,
          signal: attemptSignal,
        });
        assertNotAborted();
        if (!probe.ok) startupFailure = probe.stderr.trim() || 'sandbox_startup_failed';
      } catch (error) {
        assertNotAborted();
        startupFailure = error instanceof Error ? error.message : String(error);
      } finally {
        if (probeWorkspace) {
          const cleanupFailure = await cleanupPreflightWorkspace(probeWorkspace);
          if (cleanupFailure && !attemptSignal.aborted) {
            startupFailure = startupFailure
              ? `${startupFailure}\n${cleanupFailure}`
              : cleanupFailure;
          }
        }
      }
      assertNotAborted();

      if (!probe?.ok || startupFailure) {
        return selectStartupFailure(startupFailure ?? 'sandbox_startup_failed');
      }

      try {
        // Construct the real-workspace executor only after the isolated probe
        // succeeds. User commands are never retried through the host executor.
        selectedExecutor = input.createNativeExecutor(input.workspace, 'execution', backend);
      } catch (error) {
        return selectStartupFailure(
          `sandbox_executor_initialization_failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return { mode: 'sandbox', backend };
    })();
    return preparation;
  };

  const executor = (async (shellInput) => {
    await prepare();
    return selectedExecutor!(shellInput);
  }) as AppShellExecutorV1;
  executor.prepare = prepare;
  executor.abortPreparation = abortPreparation;
  return executor;
}

/** Shared TUI/foreground-CLI composition for native qualification and runtime use. */
export function composeAppSandboxExecutorV1(input: {
  entrypoint: ProductionExecutionEntrypointV1;
  workspace: string;
  config: AppSandboxCompositionConfigV1;
  /** Effective App-level switch after CLI/config composition. */
  sandboxEnabled?: boolean;
  /** Optional diagnostic sink for non-TUI callers. */
  onDiagnostic?: (message: string) => void;
}): AppShellExecutorV1 {
  const boundary = input.config.executionBoundary;
  const surface = input.config.executionCapabilitySurface;
  const sandboxEnabled = input.sandboxEnabled ?? input.config.sandbox.enabled;
  const deniedReason =
    boundary && !surface?.shell
      ? 'execution_surface_denies_shell'
      : boundary?.filesystemScope === 'full_access'
        ? 'sandbox_does_not_admit_full_access'
        : boundary?.networkMode === 'allowlist'
          ? 'sandbox_does_not_admit_network_allowlist'
          : undefined;

  return createPreparedAppShellExecutorV1({
    workspace: input.workspace,
    sandboxEnabled,
    fallbackAllowed: deniedReason === undefined,
    deniedReason,
    resolveBackend: () => {
      // The normal Windows backend is the no-UAC restricted-token runner.
      // The managed projection status remains a stricter production profile,
      // not a prerequisite for interactive direct-workspace development.
      const backend = detectSandboxBackend();
      if (backend !== 'none' || process.platform !== 'win32') return backend;
      return {
        backend: 'none',
        unavailableReason: 'windows_restricted_token_runner_unavailable',
      };
    },
    createNativeExecutor: (workspace, purpose, backend) =>
      createSandboxExecutor({
        enabled: sandboxEnabled,
        workspace,
        // The App layer owns the startup downgrade after an isolated no-op probe.
        // The native executor itself stays fail closed after a user script begins.
        unavailableFallback: 'fail',
        selectedBackend: backend,
        brokeredGitFeatureRevision: surface?.brokeredGitFeatureRevision ?? undefined,
        onDiagnostic: input.onDiagnostic,
        // Direct restricted-token probes use an ephemeral capability and never
        // create a persistent Workspace ACL ledger.
        startupProbe: purpose === 'preflight',
        ...(boundary && boundary.filesystemScope !== 'full_access'
          ? {
              filesystemScope: boundary.filesystemScope,
              maxProcessTreeTasks: boundary.maxProcessTreeSizePerShellInvocation,
              network: { mode: 'disabled' as const },
            }
          : {}),
      }),
  });
}
