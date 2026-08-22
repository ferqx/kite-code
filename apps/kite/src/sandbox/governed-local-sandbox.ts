import type {
  BuiltinPreparedShellExecutionInputV1,
  ResourceLimits,
  SandboxBackend,
} from '@kite/builtin-runtime/sandbox';
import {
  createBuiltinPreparedShellExecutionConsumerV1,
  findUsableBubblewrap,
  findUsableCgroupPidsRunnerV1,
  LocalSandboxExecutionProviderV1,
  SandboxExecutionGrantAuthorityV1,
} from '@kite/builtin-runtime/sandbox';
import { createAppSandboxPreparedProcessExecutionPortV1 } from './prepared-process-port';
import {
  APP_PREPARED_SHELL_EXECUTION_V1,
  type AppPreparedShellExecutionCarrierV1,
  projectBuiltinPreparedShellResultV1,
} from './prepared-tool-pipeline';
import {
  reconcilePendingSandboxPreparationsAfterCrashV1,
  SANDBOX_PREPARATION_RECOVERY_V1,
  type SandboxPreparationRecoveryConsumerV1,
} from './runtime-recovery';

export interface GovernedLocalSandboxCompositionOptionsV1 {
  readonly backend: Exclude<SandboxBackend, 'none'>;
  readonly canonicalWorkspace: string;
  readonly executionBoundaryDigest: string;
  readonly protectedPathRevision: string;
  readonly filesystemScope?: 'read_only' | 'workspace_write';
  readonly runtimeReadOnlyRoots?: readonly string[];
  readonly brokeredGitFeatureRevision?: typeof import('@kite/runtime-spi').BROKERED_GIT_FEATURE_REVISION_V1;
  readonly maxProcessTreeTasks?: number;
  readonly resourceLimits?: Partial<ResourceLimits>;
}

/** The sole production composition of a Local Provider with its governed Runtime consumer. */
export function createGovernedLocalSandboxExecutorV1(
  options: GovernedLocalSandboxCompositionOptionsV1,
): AppPreparedShellExecutionCarrierV1 & SandboxPreparationRecoveryConsumerV1 {
  let bound:
    | {
        grants: SandboxExecutionGrantAuthorityV1;
        resolveProviderAfterIntent: () => LocalSandboxExecutionProviderV1;
        preparedExecution: (
          input: Readonly<BuiltinPreparedShellExecutionInputV1>,
        ) => Promise<ReturnType<typeof projectBuiltinPreparedShellResultV1>>;
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
    const preparedConsumer = createBuiltinPreparedShellExecutionConsumerV1({
      resolveProviderAfterIntent,
      resourceSemantics: 'allocating',
      backend: options.backend,
      grants,
      preparedProcess: createAppSandboxPreparedProcessExecutionPortV1(options.backend),
      canonicalWorkspace: options.canonicalWorkspace,
      executionBoundaryDigest: options.executionBoundaryDigest,
      protectedPathRevision: options.protectedPathRevision,
      maxProcessTreeTasks: options.maxProcessTreeTasks,
      resourceLimits: options.resourceLimits,
    });
    const preparedExecution = async (input: Readonly<BuiltinPreparedShellExecutionInputV1>) =>
      projectBuiltinPreparedShellResultV1(await preparedConsumer(input));
    bound = { grants, resolveProviderAfterIntent, preparedExecution };
    return bound;
  };
  const governed = (async (input) => ({
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr: 'Sandbox execution requires the App prepared Shell execution port.',
    terminationReason: 'sandbox_denied' as const,
  })) as AppPreparedShellExecutionCarrierV1 & SandboxPreparationRecoveryConsumerV1;
  Object.defineProperty(governed, APP_PREPARED_SHELL_EXECUTION_V1, {
    enumerable: false,
    value: Object.freeze({
      execute: (input: Readonly<BuiltinPreparedShellExecutionInputV1>) =>
        getBound().preparedExecution(input),
    }),
  });
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
