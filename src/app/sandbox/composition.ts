import { createSandboxExecutor } from '@/core/sandbox/executor';
import type {
  ExecutionBoundaryV1,
  ExecutionCapabilitySurfaceV1,
  ProductionExecutionEntrypointV1,
} from '@/core/sandbox/types';

export interface AppSandboxCompositionConfigV1 {
  sandbox: { enabled: boolean };
  executionBoundary?: ExecutionBoundaryV1;
  executionCapabilitySurface?: ExecutionCapabilitySurfaceV1;
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
}) {
  const boundary = input.config.executionBoundary;
  const surface = input.config.executionCapabilitySurface;
  if (boundary && !surface?.shell) {
    return createSandboxExecutor({
      enabled: false,
      workspace: input.workspace,
      unavailableFallback: 'fail',
      onDiagnostic: input.onDiagnostic,
    });
  }
  if (boundary?.filesystemScope === 'full_access') {
    return createSandboxExecutor({
      enabled: false,
      workspace: input.workspace,
      unavailableFallback: 'fail',
      onDiagnostic: input.onDiagnostic,
    });
  }
  if (boundary?.networkMode === 'allowlist') {
    return createSandboxExecutor({
      enabled: false,
      workspace: input.workspace,
      unavailableFallback: 'fail',
      onDiagnostic: input.onDiagnostic,
    });
  }
  return createSandboxExecutor({
    enabled: input.sandboxEnabled ?? input.config.sandbox.enabled,
    workspace: input.workspace,
    onDiagnostic: input.onDiagnostic,
    ...(boundary
      ? {
          filesystemScope: boundary.filesystemScope,
          unavailableFallback: 'fail' as const,
          maxProcessTreeTasks: boundary.maxProcessTreeSizePerShellInvocation,
          network: { mode: 'disabled' as const },
        }
      : {}),
  });
}
