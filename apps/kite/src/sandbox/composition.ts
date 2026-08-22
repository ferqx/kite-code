import type {
  BuiltinPreparedShellExecutionInputV1,
  ExecutionBoundaryV1,
  ExecutionCapabilitySurfaceV1,
  ProductionExecutionEntrypointV1,
  ShellExecutor,
} from '@kite/builtin-runtime/sandbox';
import {
  discoverSandboxBackendCandidateV1,
  type SandboxBackend,
} from '@kite/builtin-runtime/sandbox';
import { computeExecutionBoundaryDigestV1 } from '#app/config/execution-boundary';
import { createAcknowledgedHostShellExecutorV1 } from './acknowledged-host-shell';
import { createGovernedLocalSandboxExecutorV1 } from './governed-local-sandbox';
import {
  APP_PREPARED_SHELL_EXECUTION_V1,
  type AppPreparedShellExecutionCarrierV1,
  type AppPreparedShellExecutionPortV1,
  appPreparedShellExecutionPortV1,
  projectAppHostShellResultV1,
} from './prepared-tool-pipeline';
import {
  hasPendingSandboxPreparationRecoveryV1,
  SANDBOX_PREPARATION_RECOVERY_V1,
  type SandboxPreparationRecoveryConsumerV1,
} from './runtime-execution';

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
export type AppShellExecutorV1 = AppPreparedShellExecutionCarrierV1 & {
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
  /**
   * Explicit App-only availability fallback. It is selected only before a
   * user command starts, or after a typed pre-dispatch backend-unavailable
   * result whose allocating cleanup was durably confirmed.
   */
  createHostExecutor?: (workspace: string) => ShellExecutor;
  deniedReason?: string;
  /** Test seam for proving backend discovery happens only after an event-loop turn. */
  yieldBeforeResolve?: () => Promise<void>;
}): AppShellExecutorV1 {
  let selectedExecutor: ShellExecutor | undefined;
  let preparation: Promise<AppShellRuntimeDecisionV1> | undefined;
  let warmAbort = new AbortController();
  let hostExecutor: ShellExecutor | undefined;
  let rawHostExecutor: ShellExecutor | undefined;
  let preparedExecutionPort: AppPreparedShellExecutionPortV1 | undefined;

  const selectStartupFailure = (reason: string): AppShellRuntimeDecisionV1 => {
    selectedExecutor = unavailableExecutor(reason);
    return { mode: 'denied', backend: 'none', reason };
  };

  const selectHostFallback = (reason: string): AppShellRuntimeDecisionV1 => {
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

  const withPreDispatchHostFallback = (nativeExecutor: ShellExecutor): ShellExecutor => {
    if (!input.createHostExecutor) return nativeExecutor;
    return async (shellInput) => {
      const result = await nativeExecutor(shellInput);
      const failure = result.sandboxFailure;
      if (
        shellInput.signal?.aborted ||
        failure?.code !== 'backend_unavailable' ||
        failure.stage !== 'pre_dispatch' ||
        !failure.cleanupConfirmed
      ) {
        return result;
      }
      if (!hostExecutor) {
        const decision = selectHostFallback('sandbox_backend_unavailable');
        if (!hostExecutor)
          return unavailableExecutor(decision.reason ?? 'host_shell_unavailable')(shellInput);
      }
      return hostExecutor(shellInput);
    };
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
        return selectHostFallback('sandbox_disabled');
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
        preparedExecutionPort = appPreparedShellExecutionPortV1(nativeExecutor);
        selectedExecutor = withPreDispatchHostFallback(nativeExecutor);
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
  }) as AppShellExecutorV1;
  executor.prepare = prepare;
  executor.abortPreparation = abortPreparation;
  Object.defineProperty(executor, APP_PREPARED_SHELL_EXECUTION_V1, {
    enumerable: false,
    value: Object.freeze({
      execute: async (preparedInput: Readonly<BuiltinPreparedShellExecutionInputV1>) => {
        const decision = await prepare();
        if (decision.mode === 'sandbox' && preparedExecutionPort) {
          const result = await preparedExecutionPort.execute(preparedInput);
          if (
            !preparedInput.signal?.aborted &&
            result.sandboxFailure?.code === 'backend_unavailable' &&
            result.sandboxFailure.stage === 'pre_dispatch' &&
            result.sandboxFailure.cleanupConfirmed
          ) {
            const fallback = selectHostFallback('sandbox_backend_unavailable');
            if (fallback.mode === 'host_shell' && rawHostExecutor) {
              return projectAppHostShellResultV1(
                await rawHostExecutor(shellInputFromPreparedV1(preparedInput)),
              );
            }
          }
          return result;
        }
        if (decision.mode === 'host_shell' && rawHostExecutor) {
          return projectAppHostShellResultV1(
            await rawHostExecutor(shellInputFromPreparedV1(preparedInput)),
          );
        }
        return projectAppHostShellResultV1(
          await unavailableExecutor(decision.reason ?? 'prepared_shell_execution_unavailable')(
            shellInputFromPreparedV1(preparedInput),
          ),
        );
      },
    } satisfies AppPreparedShellExecutionPortV1),
  });
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

function shellInputFromPreparedV1(
  input: Readonly<BuiltinPreparedShellExecutionInputV1>,
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
export function composeAppSandboxExecutorV1(input: {
  entrypoint: ProductionExecutionEntrypointV1;
  workspace: string;
  config: AppSandboxCompositionConfigV1;
  /** Effective App-level switch after CLI/config composition. */
  sandboxEnabled?: boolean;
  /** Optional diagnostic sink for non-TUI callers. */
  onDiagnostic?: (message: string) => void;
  /** Native conformance seam; production callers must keep the acknowledged default. */
  hostFallbackPolicy?: 'acknowledged' | 'deny';
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
    ...(input.hostFallbackPolicy === 'deny'
      ? {}
      : { createHostExecutor: createAcknowledgedHostShellExecutorV1 }),
  });
}
