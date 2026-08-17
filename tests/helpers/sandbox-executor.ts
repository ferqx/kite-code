import { randomUUID } from 'node:crypto';
import { sandboxPreparationIntentDigestV1 } from '@/core/capabilities/sandbox-preparation-evidence';
import {
  createSandboxExecutionConsumerV1,
  SandboxExecutionGrantAuthorityV1,
  sandboxPreparationDigestV1,
} from '@/core/execution/sandbox-execution';
import { LocalSandboxExecutionProviderV1 } from '@/core/execution/sandbox-execution/local-provider';
import { findUsableCgroupPidsRunnerV1 } from '@/core/sandbox/cgroup-pids';
import type { SandboxBackend } from '@/core/sandbox/platform';
import { detectSandboxBackend, findUsableBubblewrap } from '@/core/sandbox/platform';
import type { ResourceLimits } from '@/core/sandbox/types';
import { type ShellExecutor, shellTool } from '@/core/tools/shell';

/** Native test oracle only. Production has no direct or in-memory lifecycle entry. */
export function createSandboxExecutor(
  options: {
    enabled: boolean;
    workspace: string;
    filesystemScope?: 'read_only' | 'workspace_write';
    unavailableFallback?: 'bare_shell' | 'fail';
    runtimeReadOnlyRoots?: readonly string[];
    resourceLimits?: Partial<ResourceLimits>;
    maxProcessTreeTasks?: number;
    startupProbe?: boolean;
    selectedBackend?: SandboxBackend;
    brokeredGitFeatureRevision?: typeof import('@/protocol/git').BROKERED_GIT_FEATURE_REVISION_V1;
    executionBoundaryDigest?: string;
    protectedPathRevision?: string;
  },
  bareShellFallback: ShellExecutor = shellTool,
): ShellExecutor {
  if (!options.enabled) {
    return options.unavailableFallback === 'fail'
      ? deniedExecutor('sandbox_disabled')
      : bareShellFallback;
  }
  const backend = options.selectedBackend ?? detectSandboxBackend();
  if (backend === 'none') {
    return options.unavailableFallback === 'fail'
      ? deniedExecutor('sandbox_backend_unavailable')
      : bareShellFallback;
  }
  const grants = new SandboxExecutionGrantAuthorityV1();
  const provider = new LocalSandboxExecutionProviderV1(grants.verifier(), {
    backend,
    canonicalWorkspace: options.workspace,
    filesystemScope: options.filesystemScope,
    runtimeReadOnlyRoots: options.runtimeReadOnlyRoots,
    brokeredGitFeatureRevision: options.brokeredGitFeatureRevision,
    startupProbe: options.startupProbe,
    bubblewrapPath: backend === 'bubblewrap' ? (findUsableBubblewrap() ?? undefined) : undefined,
    cgroupPidsRunner:
      backend === 'bubblewrap' && options.maxProcessTreeTasks
        ? (findUsableCgroupPidsRunnerV1() ?? undefined)
        : undefined,
  });
  const consumer = createSandboxExecutionConsumerV1({
    provider,
    backend,
    grants,
    canonicalWorkspace: options.workspace,
    executionBoundaryDigest: options.executionBoundaryDigest ?? 'test-sandbox-boundary-v1',
    protectedPathRevision: options.protectedPathRevision ?? 'test-protected-path-boundary-v1',
    maxProcessTreeTasks: options.maxProcessTreeTasks,
    resourceLimits: options.resourceLimits,
  });
  return async (input) => {
    const invocationId = `test:${randomUUID()}`;
    return consumer({
      ...input,
      sandboxInvocationIdentity: {
        toolCallId: `test-tool:${invocationId}`,
        capabilityId: 'builtin:shell_execute',
        capabilityRevision: 'builtin-shell-execute-r1',
        invocationId,
        attempt: 1,
        effectiveEffectsDigest: 'test-effects',
        admissionDigest: 'test-admission',
        cancellationCorrelation: randomUUID(),
      },
      sandboxPreparationLifecycle: {
        async recordPreparationIntent(preparation) {
          return {
            intentDigest: sandboxPreparationIntentDigestV1({
              attempt: preparation.attempt,
              toolCallId: preparation.toolCallId,
              capabilityId: preparation.capabilityId,
              capabilityRevision: preparation.capabilityRevision,
              canonicalWorkspace: preparation.canonicalWorkspace,
              effectiveEffectsDigest: preparation.effectiveEffectsDigest,
              admissionDigest: preparation.admissionDigest,
              preparationDigest: sandboxPreparationDigestV1(preparation),
              commandDigest: preparation.commandDigest,
              executionBoundaryDigest: preparation.executionBoundaryDigest,
              resourceSemantics: 'allocating',
            }),
          };
        },
        async recordPreparationReady() {
          return true;
        },
        async recordExecutionDispatchIntent(_prepared, dispatch) {
          return { dispatchIntentDigest: `test-dispatch:${dispatch.dispatchId}` };
        },
        async recordExecutionSupervisorStarted() {
          return true;
        },
        async recordDisposalIntent() {
          return {
            purpose: 'dispose' as const,
            lifecycleIntentDigest: 'test-disposal-intent',
            cleanupAttempt: 1,
          };
        },
        async recordDisposalReceipt() {
          return true;
        },
      },
    });
  };
}

function deniedExecutor(reason: string): ShellExecutor {
  return async (input) => ({
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr: `Sandbox unavailable (${reason}); refusing unsandboxed shell execution.`,
    terminationReason: 'sandbox_denied',
  });
}
