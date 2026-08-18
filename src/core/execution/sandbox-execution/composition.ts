import {
  SANDBOX_PREPARATION_RECOVERY_V1,
  type SandboxPreparationRecoveryConsumerV1,
} from '@/core/execution/sandbox-execution/recovery';
import { findUsableCgroupPidsRunnerV1 } from '@/core/sandbox/cgroup-pids';
import type { SandboxBackend } from '@/core/sandbox/platform';
import { findUsableBubblewrap } from '@/core/sandbox/platform';
import type { ResourceLimits } from '@/core/sandbox/types';
import type { ShellExecutor } from '@/core/tools/shell';
import { createSandboxExecutionConsumerV1 } from './consumer';
import { SandboxExecutionGrantAuthorityV1 } from './grant-authority';
import { LocalSandboxExecutionProviderV1 } from './local-provider';
import { reconcilePendingSandboxPreparationsAfterCrashV1 } from './recovery';

export interface GovernedLocalSandboxCompositionOptionsV1 {
  readonly backend: Exclude<SandboxBackend, 'none'>;
  readonly canonicalWorkspace: string;
  readonly executionBoundaryDigest: string;
  readonly protectedPathRevision: string;
  readonly filesystemScope?: 'read_only' | 'workspace_write';
  readonly runtimeReadOnlyRoots?: readonly string[];
  readonly brokeredGitFeatureRevision?: typeof import('@/protocol/git').BROKERED_GIT_FEATURE_REVISION_V1;
  readonly maxProcessTreeTasks?: number;
  readonly resourceLimits?: Partial<ResourceLimits>;
}

/** The sole production composition of a Local Provider with its governed Runtime consumer. */
export function createGovernedLocalSandboxExecutorV1(
  options: GovernedLocalSandboxCompositionOptionsV1,
): ShellExecutor & SandboxPreparationRecoveryConsumerV1 {
  let bound:
    | {
        grants: SandboxExecutionGrantAuthorityV1;
        resolveProviderAfterIntent: () => LocalSandboxExecutionProviderV1;
        consumer: ShellExecutor;
      }
    | undefined;
  const getBound = () => {
    if (bound) return bound;
    const grants = new SandboxExecutionGrantAuthorityV1();
    let provider: LocalSandboxExecutionProviderV1 | undefined;
    const resolveProviderAfterIntent = () => {
      if (provider) return provider;
      // These are real process/resource usability probes. The consumer calls
      // this resolver only after a durable allocating lifecycle intent ack.
      const bubblewrapPath =
        options.backend === 'bubblewrap' ? (findUsableBubblewrap() ?? undefined) : undefined;
      const cgroupPidsRunner =
        options.backend === 'bubblewrap' && options.maxProcessTreeTasks
          ? (findUsableCgroupPidsRunnerV1() ?? undefined)
          : undefined;
      provider = new LocalSandboxExecutionProviderV1(grants.verifier(), {
        backend: options.backend,
        canonicalWorkspace: options.canonicalWorkspace,
        filesystemScope: options.filesystemScope,
        runtimeReadOnlyRoots: options.runtimeReadOnlyRoots,
        brokeredGitFeatureRevision: options.brokeredGitFeatureRevision,
        bubblewrapPath,
        cgroupPidsRunner,
      });
      return provider;
    };
    const consumer = createSandboxExecutionConsumerV1({
      resolveProviderAfterIntent,
      resourceSemantics: 'allocating',
      backend: options.backend,
      grants,
      canonicalWorkspace: options.canonicalWorkspace,
      executionBoundaryDigest: options.executionBoundaryDigest,
      protectedPathRevision: options.protectedPathRevision,
      maxProcessTreeTasks: options.maxProcessTreeTasks,
      resourceLimits: options.resourceLimits,
    });
    bound = { grants, resolveProviderAfterIntent, consumer };
    return bound;
  };
  const governed = (async (input) => {
    if (!input.sandboxInvocationIdentity || !input.sandboxPreparationLifecycle) {
      return {
        ok: false,
        command: input.command,
        exitCode: -1,
        stdout: '',
        stderr: 'Sandbox execution requires an acknowledged Runtime lifecycle.',
        terminationReason: 'sandbox_denied' as const,
      };
    }
    return getBound().consumer(input);
  }) as ShellExecutor & SandboxPreparationRecoveryConsumerV1;
  Object.defineProperty(governed, SANDBOX_PREPARATION_RECOVERY_V1, {
    enumerable: false,
    value: async (
      input: Parameters<
        SandboxPreparationRecoveryConsumerV1[typeof SANDBOX_PREPARATION_RECOVERY_V1]
      >[0],
    ) => {
      const runtime = getBound();
      return reconcilePendingSandboxPreparationsAfterCrashV1({
        provider: runtime.resolveProviderAfterIntent(),
        grants: runtime.grants,
        ...input,
      });
    },
  });
  return governed;
}
