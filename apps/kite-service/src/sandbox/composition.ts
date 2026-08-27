import { resolveRegisteredGitMetadataReadOnlyRoots } from '@kite-ai/builtin-runtime/git';
import type {
  BuiltinPreparedShellExecutionInput,
  ExecutionBoundary,
  ExecutionCapabilitySurface,
  ProductionExecutionEntrypoint,
  ShellExecutor,
} from '@kite-ai/builtin-runtime/sandbox';
import {
  discoverSandboxBackendCandidate,
  type SandboxBackend,
} from '@kite-ai/builtin-runtime/sandbox';
import { computeExecutionBoundaryDigest } from '#kite-service/config/execution-boundary';
import { createAcknowledgedHostShellExecutor } from './acknowledged-host-shell';
import { createGovernedLocalSandboxExecutor } from './governed-local-sandbox';
import {
  APP_PREPARED_SHELL_EXECUTION_,
  type AppPreparedShellExecutionCarrier,
  type AppPreparedShellExecutionPort,
  appPreparedShellExecutionPort,
  projectAppHostShellResult,
} from './prepared-tool-pipeline';
import {
  hasPendingSandboxPreparationRecovery,
  SANDBOX_PREPARATION_RECOVERY_,
  type SandboxPreparationRecoveryConsumer,
} from './runtime-execution';

export interface AppSandboxCompositionConfig {
  sandbox: { enabled: boolean };
  executionBoundary?: ExecutionBoundary;
  executionCapabilitySurface?: ExecutionCapabilitySurface;
}

export type AppShellRuntimeMode = 'sandbox' | 'host_shell' | 'denied';

export interface AppShellRuntimeDecision {
  mode: AppShellRuntimeMode;
  backend: SandboxBackend;
  reason?: string;
}

export interface AppSandboxBackendResolution {
  backend: SandboxBackend;
  /** Stable availability diagnostic used only when no backend was selected. */
  unavailableReason?: string;
}
export type AppShellExecutor = AppPreparedShellExecutionCarrier & {
  /** Resolve and cache one allocation-free sandbox decision before Tool dispatch. */
  prepare(): Promise<AppShellRuntimeDecision>;
  /**
   * Cancel an in-flight preparation (TUI exit while the silent startup
   * discovery is still running). The aborted attempt is not cached; the next
   * prepare() starts fresh allocation-free discovery.
   */
  abortPreparation?(): void;
};

/** Thrown by prepare() when the attempt was aborted by abortPreparation(). */
export const SANDBOX_PREPARATION_ABORTED_REASON = 'sandbox_preparation_aborted';

/**
 * Discovery is allocation-free, but a platform resolver may still be waiting
 * on an OS probe.  Rotating the preparation controller must settle the
 * caller immediately; otherwise a Windows probe that does not observe the
 * signal can hold the Runtime shutdown path until the workflow timeout.
 * The resolver promise is still observed after abort so a late rejection
 * cannot become an unhandled rejection, while its result is never selected.
 */
function awaitPreparationAbortable<T>(
  operation: PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(SANDBOX_PREPARATION_ABORTED_REASON));

  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error(SANDBOX_PREPARATION_ABORTED_REASON));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal.aborted) {
          rejectPromise(new Error(SANDBOX_PREPARATION_ABORTED_REASON));
          return;
        }
        resolvePromise(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      },
    );
  });
}

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

export function createPreparedAppShellExecutor(input: {
  workspace: string;
  sandboxEnabled: boolean;
  resolveBackend: () =>
    | SandboxBackend
    | AppSandboxBackendResolution
    | Promise<SandboxBackend | AppSandboxBackendResolution>;
  createNativeExecutor: (
    workspace: string,
    backend: Exclude<SandboxBackend, 'none'>,
  ) => ShellExecutor;
  /**
   * Explicit App-only host environment. It may be selected before approval;
   * an already-selected native environment never falls back after approval.
   */
  createHostExecutor?: (workspace: string) => ShellExecutor;
  deniedReason?: string;
  /** Test seam for proving backend discovery happens only after an event-loop turn. */
  yieldBeforeResolve?: () => Promise<void>;
}): AppShellExecutor {
  let selectedExecutor: ShellExecutor | undefined;
  let preparation: Promise<AppShellRuntimeDecision> | undefined;
  let warmAbort = new AbortController();
  let hostExecutor: ShellExecutor | undefined;
  let rawHostExecutor: ShellExecutor | undefined;
  let preparedExecutionPort: AppPreparedShellExecutionPort | undefined;

  const selectStartupFailure = (reason: string): AppShellRuntimeDecision => {
    selectedExecutor = unavailableExecutor(reason);
    return { mode: 'denied', backend: 'none', reason };
  };

  const selectHostFallback = (reason: string): AppShellRuntimeDecision => {
    if (!input.createHostExecutor) return selectStartupFailure(reason);
    try {
      if (!hostExecutor) {
        rawHostExecutor = input.createHostExecutor(input.workspace);
        hostExecutor = async (shellInput) => {
          if (!shellInput.sandboxInvocationIdentity || !shellInput.sandboxPreparationLifecycle) {
            return unavailableExecutor('host_shell_requires_acknowledged_runtime_invocation')(
              shellInput,
            );
          }
          return rawHostExecutor!(shellInput);
        };
      }
      selectedExecutor = hostExecutor;
      return { mode: 'host_shell', backend: 'none', reason };
    } catch (error) {
      return selectStartupFailure(
        `host_shell_initialization_failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const abortPreparation = (): void => {
    warmAbort.abort();
    // The aborted attempt must not be consumed by the next caller: rotation
    // gives the next prepare() a live controller and drops the cached
    // (about-to-reject) promise.
    warmAbort = new AbortController();
    preparation = undefined;
  };

  const prepare = (): Promise<AppShellRuntimeDecision> => {
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
        return selectHostFallback('sandbox_disabled');
      }

      // Yield an event-loop turn before any synchronous backend discovery or
      // native executor initialization is attempted, so an early startup
      // prewarm never blocks the first render.
      await awaitPreparationAbortable(
        (input.yieldBeforeResolve ?? yieldToEventLoop)(),
        attemptSignal,
      );
      assertNotAborted();

      let backend: SandboxBackend;
      try {
        const resolved = await awaitPreparationAbortable(input.resolveBackend(), attemptSignal);
        assertNotAborted();
        backend = typeof resolved === 'string' ? resolved : resolved.backend;
        if (backend === 'none') {
          return selectHostFallback(
            typeof resolved === 'string'
              ? 'sandbox_backend_unavailable'
              : (resolved.unavailableReason ?? 'sandbox_backend_unavailable'),
          );
        }
      } catch (error) {
        assertNotAborted();
        return selectHostFallback(
          `sandbox_backend_detection_failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      try {
        // Construction is allocation-free. Native usability checks and any
        // allocating Provider prepare are deferred to an acknowledged Tool attempt.
        const nativeExecutor = input.createNativeExecutor(input.workspace, backend);
        preparedExecutionPort = appPreparedShellExecutionPort(nativeExecutor);
        selectedExecutor = nativeExecutor;
      } catch (error) {
        return selectHostFallback(
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
  }) as AppShellExecutor;
  executor.prepare = prepare;
  executor.abortPreparation = abortPreparation;
  Object.defineProperty(executor, APP_PREPARED_SHELL_EXECUTION_, {
    enumerable: false,
    value: Object.freeze({
      execute: async (preparedInput: Readonly<BuiltinPreparedShellExecutionInput>) => {
        const decision = await prepare();
        if (decision.mode === 'sandbox' && preparedExecutionPort) {
          return preparedExecutionPort.execute(preparedInput);
        }
        if (decision.mode === 'host_shell' && rawHostExecutor) {
          return projectAppHostShellResult(
            await rawHostExecutor(shellInputFromPrepared(preparedInput)),
          );
        }
        return projectAppHostShellResult(
          await unavailableExecutor(decision.reason ?? 'prepared_shell_execution_unavailable')(
            shellInputFromPrepared(preparedInput),
          ),
        );
      },
    } satisfies AppPreparedShellExecutionPort),
  });
  Object.defineProperty(executor, SANDBOX_PREPARATION_RECOVERY_, {
    enumerable: false,
    value: async (
      recoveryInput: Parameters<
        SandboxPreparationRecoveryConsumer[typeof SANDBOX_PREPARATION_RECOVERY_]
      >[0],
    ) => {
      if (!hasPendingSandboxPreparationRecovery(recoveryInput.persistence.getState())) {
        return true;
      }
      await prepare();
      const recovery = (
        selectedExecutor as ShellExecutor & Partial<SandboxPreparationRecoveryConsumer>
      )?.[SANDBOX_PREPARATION_RECOVERY_];
      return recovery ? recovery.call(selectedExecutor, recoveryInput) : false;
    },
  });
  return executor;
}

function shellInputFromPrepared(
  input: Readonly<BuiltinPreparedShellExecutionInput>,
): Parameters<ShellExecutor>[0] {
  return {
    workspace: input.workspace,
    command: input.command,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.networkMode ? { networkMode: input.networkMode } : {}),
    ...(input.filesystemMode ? { filesystemMode: input.filesystemMode } : {}),
    ...(input.executionTrust ? { executionTrust: input.executionTrust } : {}),
  };
}

/** Shared TUI/foreground-CLI composition for native qualification and runtime use. */
export function composeAppSandboxExecutor(input: {
  entrypoint: ProductionExecutionEntrypoint;
  workspace: string;
  config: AppSandboxCompositionConfig;
  /** Effective App-level switch after CLI/config composition. */
  sandboxEnabled?: boolean;
  /** Optional diagnostic sink for non-TUI callers. */
  onDiagnostic?: (message: string) => void;
  /** Native conformance seam; production callers must keep the acknowledged default. */
  hostFallbackPolicy?: 'acknowledged' | 'deny';
}): AppShellExecutor {
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

  return createPreparedAppShellExecutor({
    workspace: input.workspace,
    sandboxEnabled,
    deniedReason,
    resolveBackend: () => {
      // The normal Windows backend is the no-UAC restricted-token runner.
      // The managed projection status remains a stricter production profile,
      // not a prerequisite for interactive direct-workspace development.
      const backend = discoverSandboxBackendCandidate();
      if (backend !== 'none' || process.platform !== 'win32') return backend;
      return {
        backend: 'none',
        unavailableReason: 'windows_restricted_token_runner_unavailable',
      };
    },
    createNativeExecutor: (workspace, backend) =>
      createGovernedLocalSandboxExecutor({
        backend,
        canonicalWorkspace: workspace,
        runtimeReadOnlyRoots: resolveRegisteredGitMetadataReadOnlyRoots(workspace),
        brokeredGitFeatureRevision: surface?.brokeredGitFeatureRevision ?? undefined,
        executionBoundaryDigest: boundary
          ? computeExecutionBoundaryDigest(boundary)
          : 'development-sandbox-boundary-v1',
        protectedPathRevision: boundary
          ? computeExecutionBoundaryDigest(boundary)
          : 'development-protected-path-boundary-v1',
        ...(boundary && boundary.filesystemScope !== 'full_access'
          ? {
              filesystemScope: boundary.filesystemScope,
              maxProcessTreeTasks: boundary.maxProcessTreeSizePerShellInvocation,
              network: { mode: 'disabled' as const },
            }
          : {}),
      }),
    ...(input.hostFallbackPolicy === 'deny'
      ? {}
      : { createHostExecutor: createAcknowledgedHostShellExecutor }),
  });
}
