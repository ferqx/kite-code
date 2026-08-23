import type {
  BuiltinPreparedShellExecutionInput,
  ResourceLimits,
  SandboxBackend,
} from '@kite/builtin-runtime/sandbox';
import {
  createBuiltinPreparedShellExecutionConsumer,
  findUsableBubblewrap,
  findUsableCgroupPidsRunner,
  LocalSandboxExecutionProvider,
  SandboxExecutionGrantAuthority,
} from '@kite/builtin-runtime/sandbox';
import { createAppSandboxPreparedProcessExecutionPort } from './prepared-process-port';
import {
  APP_PREPARED_SHELL_EXECUTION_,
  type AppPreparedShellExecutionCarrier,
  projectBuiltinPreparedShellResult,
} from './prepared-tool-pipeline';
import {
  reconcilePendingSandboxPreparationsAfterCrash,
  SANDBOX_PREPARATION_RECOVERY_,
  type SandboxPreparationRecoveryConsumer,
} from './runtime-recovery';

export interface GovernedLocalSandboxCompositionOptions {
  readonly backend: Exclude<SandboxBackend, 'none'>;
  readonly canonicalWorkspace: string;
  readonly executionBoundaryDigest: string;
  readonly protectedPathRevision: string;
  readonly filesystemScope?: 'read_only' | 'workspace_write';
  readonly runtimeReadOnlyRoots?: readonly string[];
  readonly brokeredGitFeatureRevision?: typeof import('@kite/runtime-spi').BROKERED_GIT_FEATURE_REVISION_;
  readonly maxProcessTreeTasks?: number;
  readonly resourceLimits?: Partial<ResourceLimits>;
}

/** The sole production composition of a Local Provider with its governed Runtime consumer. */
export function createGovernedLocalSandboxExecutor(
  options: GovernedLocalSandboxCompositionOptions,
): AppPreparedShellExecutionCarrier & SandboxPreparationRecoveryConsumer {
  let bound:
    | {
        grants: SandboxExecutionGrantAuthority;
        resolveProviderAfterIntent: () => LocalSandboxExecutionProvider;
        preparedExecution: (
          input: Readonly<BuiltinPreparedShellExecutionInput>,
        ) => Promise<ReturnType<typeof projectBuiltinPreparedShellResult>>;
      }
    | undefined;
  const getBound = () => {
    if (bound) return bound;
    const grants = new SandboxExecutionGrantAuthority();
    let provider: LocalSandboxExecutionProvider | undefined;
    const resolveProviderAfterIntent = () => {
      if (provider) return provider;
      // These are real process/resource usability probes. The consumer calls
      // this resolver only after a durable allocating lifecycle intent ack.
      const bubblewrapPath =
        options.backend === 'bubblewrap' ? (findUsableBubblewrap() ?? undefined) : undefined;
      const cgroupPidsRunner =
        options.backend === 'bubblewrap' && options.maxProcessTreeTasks
          ? (findUsableCgroupPidsRunner() ?? undefined)
          : undefined;
      provider = new LocalSandboxExecutionProvider(grants.verifier(), {
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
    const preparedConsumer = createBuiltinPreparedShellExecutionConsumer({
      resolveProviderAfterIntent,
      resourceSemantics: 'allocating',
      backend: options.backend,
      grants,
      preparedProcess: createAppSandboxPreparedProcessExecutionPort(options.backend),
      canonicalWorkspace: options.canonicalWorkspace,
      executionBoundaryDigest: options.executionBoundaryDigest,
      protectedPathRevision: options.protectedPathRevision,
      maxProcessTreeTasks: options.maxProcessTreeTasks,
      resourceLimits: options.resourceLimits,
    });
    const preparedExecution = async (input: Readonly<BuiltinPreparedShellExecutionInput>) =>
      projectBuiltinPreparedShellResult(await preparedConsumer(input));
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
  })) as AppPreparedShellExecutionCarrier & SandboxPreparationRecoveryConsumer;
  Object.defineProperty(governed, APP_PREPARED_SHELL_EXECUTION_, {
    enumerable: false,
    value: Object.freeze({
      execute: (input: Readonly<BuiltinPreparedShellExecutionInput>) =>
        getBound().preparedExecution(input),
    }),
  });
  Object.defineProperty(governed, SANDBOX_PREPARATION_RECOVERY_, {
    enumerable: false,
    value: async (
      input: Parameters<
        SandboxPreparationRecoveryConsumer[typeof SANDBOX_PREPARATION_RECOVERY_]
      >[0],
    ) => {
      const runtime = getBound();
      return reconcilePendingSandboxPreparationsAfterCrash({
        provider: runtime.resolveProviderAfterIntent(),
        grants: runtime.grants,
        ...input,
      });
    },
  });
  return governed;
}
