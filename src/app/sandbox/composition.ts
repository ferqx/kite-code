import { computeExecutionBoundaryDigestV1 } from '@/core/config/execution-boundary';
import {
  createGovernedLocalSandboxExecutorV1,
  hasPendingSandboxPreparationRecoveryV1,
  SANDBOX_PREPARATION_RECOVERY_V1,
  type SandboxPreparationRecoveryConsumerV1,
} from '@/core/execution/sandbox-execution';
import { discoverSandboxBackendCandidateV1, type SandboxBackend } from '@/core/sandbox/platform';
import type {
  ExecutionBoundaryV1,
  ExecutionCapabilitySurfaceV1,
  ProductionExecutionEntrypointV1,
} from '@/core/sandbox/types';
import type { ShellExecutor } from '@/core/tools/shell';

export interface AppSandboxCompositionConfigV1 {
  sandbox: { enabled: boolean };
  executionBoundary?: ExecutionBoundaryV1;
  executionCapabilitySurface?: ExecutionCapabilitySurfaceV1;
}

export type AppShellRuntimeModeV1 = 'sandbox' | 'denied';

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
  /** Resolve and cache one allocation-free sandbox decision before Tool dispatch. */
  prepare(): Promise<AppShellRuntimeDecisionV1>;
  /**
   * Cancel an in-flight preparation (TUI exit while the silent startup
   * discovery is still running). The aborted attempt is not cached; the next
   * prepare() starts fresh allocation-free discovery.
   */
  abortPreparation?(): void;
};

/** Thrown by prepare() when the attempt was aborted by abortPreparation(). */
export const SANDBOX_PREPARATION_ABORTED_REASON = 'sandbox_preparation_aborted';

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

export function createPreparedAppShellExecutorV1(input: {
  workspace: string;
  sandboxEnabled: boolean;
  resolveBackend: () =>
    | SandboxBackend
    | AppSandboxBackendResolutionV1
    | Promise<SandboxBackend | AppSandboxBackendResolutionV1>;
  createNativeExecutor: (
    workspace: string,
    backend: Exclude<SandboxBackend, 'none'>,
  ) => ShellExecutor;
  deniedReason?: string;
  /** Test seam for proving backend discovery happens only after an event-loop turn. */
  yieldBeforeResolve?: () => Promise<void>;
}): AppShellExecutorV1 {
  let selectedExecutor: ShellExecutor | undefined;
  let preparation: Promise<AppShellRuntimeDecisionV1> | undefined;
  let warmAbort = new AbortController();

  const selectStartupFailure = (reason: string): AppShellRuntimeDecisionV1 => {
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
        return selectStartupFailure('sandbox_disabled');
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

      try {
        // Construction is allocation-free. Native usability checks and any
        // allocating Provider prepare are deferred to an acknowledged Tool attempt.
        selectedExecutor = input.createNativeExecutor(input.workspace, backend);
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
  Object.defineProperty(executor, SANDBOX_PREPARATION_RECOVERY_V1, {
    enumerable: false,
    value: async (
      recoveryInput: Parameters<
        SandboxPreparationRecoveryConsumerV1[typeof SANDBOX_PREPARATION_RECOVERY_V1]
      >[0],
    ) => {
      if (!hasPendingSandboxPreparationRecoveryV1(recoveryInput.persistence.getState())) {
        return true;
      }
      await prepare();
      const recovery = (
        selectedExecutor as ShellExecutor & Partial<SandboxPreparationRecoveryConsumerV1>
      )?.[SANDBOX_PREPARATION_RECOVERY_V1];
      return recovery ? recovery.call(selectedExecutor, recoveryInput) : false;
    },
  });
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
    deniedReason,
    resolveBackend: () => {
      // The normal Windows backend is the no-UAC restricted-token runner.
      // The managed projection status remains a stricter production profile,
      // not a prerequisite for interactive direct-workspace development.
      const backend = discoverSandboxBackendCandidateV1();
      if (backend !== 'none' || process.platform !== 'win32') return backend;
      return {
        backend: 'none',
        unavailableReason: 'windows_restricted_token_runner_unavailable',
      };
    },
    createNativeExecutor: (workspace, backend) =>
      createGovernedLocalSandboxExecutorV1({
        backend,
        canonicalWorkspace: workspace,
        brokeredGitFeatureRevision: surface?.brokeredGitFeatureRevision ?? undefined,
        executionBoundaryDigest: boundary
          ? computeExecutionBoundaryDigestV1(boundary)
          : 'development-sandbox-boundary-v1',
        protectedPathRevision: boundary
          ? computeExecutionBoundaryDigestV1(boundary)
          : 'development-protected-path-boundary-v1',
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
