import { CapabilityArtifactStore } from '@kite-ai/builtin-runtime';
import {
  type BuiltinWorkspaceFilesystemRuntime,
  FilesystemPreimageArtifactStore,
  LocalWorkspaceFilesystemProvider,
  WorkspaceFilesystemGrantAuthority,
} from '@kite-ai/builtin-runtime/filesystem';
import {
  BuiltinModelEffectCoordinator,
  type BuiltinModelOperationExecutionPort,
  createLiveModelResponseSource,
  type ModelArtifactEvidenceAvailability,
  ModelArtifactStore,
  ModelInvocationGateway,
} from '@kite-ai/builtin-runtime/model';
import { PlanArtifactStore } from '@kite-ai/builtin-runtime/planning';
import {
  canonicalPathForComparison,
  SandboxPreparationArtifactStore,
} from '@kite-ai/builtin-runtime/sandbox';
import {
  BuiltinChildRuntimeDriver,
  createGovernedLocalSubagentComposition,
  type GovernedSubagentComposition,
  SubagentCheckpointArtifactStore,
  type SubagentContinuationArtifactAccess,
  SubagentContinuationArtifactStore,
  type SubagentLifecycleArtifactAccess,
  SubagentLifecycleArtifactStore,
  type SubagentResultArtifactAccess,
  SubagentResultArtifactStore,
  type SubagentTaskArtifactAccess,
  SubagentTaskArtifactStore,
  type SubagentTaskRequestArtifactAccess,
  SubagentTaskRequestArtifactStore,
} from '@kite-ai/builtin-runtime/subagent';
import { planModelInvocationResource } from '@kite-ai/runtime-host/kernel-adapter';
import { userKiteCodeDir } from '#kite-service/config/paths';
import type { KiteHomeBuiltinArtifactBackends } from './kite-home-artifact-backends';
import type { RuntimeState } from './runtime/state-runtime';
import {
  AfterTurnContinuationRuntime,
  type AfterTurnWakeScheduler,
} from './runtime/subagent/after-turn-continuation';
import {
  type BackgroundSubagentControlRuntime,
  BackgroundSubagentRuntime,
} from './runtime/subagent/background-runtime';
import {
  type AppSubagentRuntimeFactory,
  createPipelineSubagentRuntime,
} from './runtime/subagent/pipeline-runtime';
import { reconcilePendingSubagentProvidersAfterCrash } from './runtime/subagent-provider-recovery';

type InstalledSubagentComposition = GovernedSubagentComposition<
  SubagentLifecycleArtifactAccess,
  BuiltinChildRuntimeDriver,
  SubagentTaskArtifactAccess
>;

interface InstalledSubagentRuntime {
  readonly composition: InstalledSubagentComposition;
  readonly background: BackgroundSubagentRuntime;
  readonly resultArtifacts: SubagentResultArtifactAccess;
  readonly checkpointArtifacts?: SubagentCheckpointArtifactStore;
}

const installedSubagentCompositions = new Map<string, InstalledSubagentRuntime>();

function installedSubagentComposition(
  backends?: KiteHomeBuiltinArtifactBackends,
): InstalledSubagentRuntime {
  if (backends) {
    const checkpointArtifacts = new SubagentCheckpointArtifactStore({
      backend: backends.subagentCheckpoint,
    });
    const composition = createGovernedLocalSubagentComposition({
      driver: new BuiltinChildRuntimeDriver(),
      taskArtifacts: new SubagentTaskArtifactStore({
        backend: backends.subagentTask,
      }),
      lifecycleArtifacts: new SubagentLifecycleArtifactStore({
        backend: backends.subagentLifecycle,
      }),
    });
    const resultArtifacts = new SubagentResultArtifactStore({ backend: backends.subagentTask });
    return {
      composition,
      background: new BackgroundSubagentRuntime(resultArtifacts, checkpointArtifacts),
      resultArtifacts,
      checkpointArtifacts,
    };
  }
  const installation = userKiteCodeDir();
  const existing = installedSubagentCompositions.get(installation);
  if (existing) return existing;
  const taskArtifacts = new SubagentTaskArtifactStore();
  const lifecycleArtifacts = new SubagentLifecycleArtifactStore();
  const composition = createGovernedLocalSubagentComposition({
    driver: new BuiltinChildRuntimeDriver(),
    taskArtifacts,
    lifecycleArtifacts,
  });
  const resultArtifacts = new SubagentResultArtifactStore();
  const runtime: InstalledSubagentRuntime = {
    composition,
    background: new BackgroundSubagentRuntime(resultArtifacts),
    resultArtifacts,
  };
  installedSubagentCompositions.set(installation, runtime);
  return runtime;
}

export type InstalledKiteRuntimeComposition = {
  status: 'available';
  artifacts: Pick<
    ModelArtifactStore,
    | 'writeSurface'
    | 'readSurface'
    | 'writeResponse'
    | 'readResponse'
    | 'writeProviderOptions'
    | 'readProviderOptions'
    | 'collectGarbage'
  >;
  /** The one App-owned immutable Plan Artifact writer for this runtime. */
  planArtifacts: PlanArtifactStore;
  capabilityArtifacts: CapabilityArtifactStore;
  evidence: ModelArtifactEvidenceAvailability;
  gateway: ModelInvocationGateway;
  modelEffects: BuiltinModelEffectCoordinator;
  workspaceFilesystem?: BuiltinWorkspaceFilesystemRuntime;
  sandboxPreparationArtifacts: SandboxPreparationArtifactStore;
  subagentRuntimeFactory: AppSubagentRuntimeFactory;
  /** Private readback for an independently executing child Session's delegated task. */
  delegatedTaskArtifacts: Pick<SubagentTaskArtifactAccess, 'read'>;
  childResultArtifacts: SubagentResultArtifactAccess;
  inspectChildStartGrant: InstalledSubagentComposition['grants']['inspectStart'];
  consumeChildStartGrant: ReturnType<
    InstalledSubagentComposition['grants']['verifier']
  >['verifyAndConsumeStart'];
  backgroundSubagentRuntime: BackgroundSubagentControlRuntime;
  checkpointArtifacts?: Pick<SubagentCheckpointArtifactStore, 'write'>;
  afterTurnContinuationRuntime?: AfterTurnContinuationRuntime;
  reconcilePendingSubagents: (
    persistence: Parameters<typeof reconcilePendingSubagentProvidersAfterCrash>[0]['persistence'],
    options?: Readonly<{
      terminalDisposition?: 'unknown' | 'preserve_user_cancellation';
    }>,
  ) => Promise<boolean>;
  subagentContinuationArtifacts: SubagentContinuationArtifactAccess;
  subagentTaskRequests: SubagentTaskRequestArtifactAccess;
};

export type InstalledKiteRuntimeCompositionFactory = (
  workspace: string,
) => InstalledKiteRuntimeComposition;

/** Reuse one composition per canonical Workspace without a process-global fence. */
export function createInstalledKiteRuntimeCompositionFactory(
  operationExecution: BuiltinModelOperationExecutionPort,
  artifactBackends?: KiteHomeBuiltinArtifactBackends,
  afterTurnScheduler?: AfterTurnWakeScheduler,
): InstalledKiteRuntimeCompositionFactory {
  const installed = new Map<string, InstalledKiteRuntimeComposition>();
  const subagentComposition = installedSubagentComposition(artifactBackends);
  const afterTurnContinuationRuntime = afterTurnScheduler
    ? new AfterTurnContinuationRuntime(afterTurnScheduler)
    : undefined;
  return (workspace) => {
    const canonicalWorkspace = canonicalPathForComparison(workspace);
    const existing = installed.get(canonicalWorkspace);
    if (existing) return existing;
    const created = resolveInstalledKiteRuntimeComposition(
      workspace,
      operationExecution,
      artifactBackends,
      subagentComposition,
      afterTurnContinuationRuntime,
    );
    installed.set(canonicalWorkspace, created);
    return created;
  };
}

/** App-owned composition for installation-private Model evidence and runtime mechanisms. */
export function resolveInstalledKiteRuntimeComposition(
  workspace?: string,
  operationExecution?: BuiltinModelOperationExecutionPort,
  artifactBackends?: KiteHomeBuiltinArtifactBackends,
  injectedSubagentRuntime?: InstalledSubagentRuntime,
  afterTurnContinuationRuntime?: AfterTurnContinuationRuntime,
): InstalledKiteRuntimeComposition {
  if (!operationExecution) {
    throw new Error('Builtin Model operation execution port is unavailable.');
  }
  const artifacts = new ModelArtifactStore(
    artifactBackends ? { backend: artifactBackends.model } : {},
  );
  const planArtifacts = new PlanArtifactStore(
    artifactBackends ? { backend: artifactBackends.plan } : {},
  );
  const capabilityArtifacts = new CapabilityArtifactStore(
    artifactBackends ? { backend: artifactBackends.capability } : {},
  );
  const sandboxPreparationArtifacts = new SandboxPreparationArtifactStore(
    artifactBackends ? { backend: artifactBackends.sandboxPreparation } : {},
  );
  const installedSubagents = injectedSubagentRuntime
    ? injectedSubagentRuntime
    : installedSubagentComposition(artifactBackends);
  const subagentComposition = installedSubagents.composition;
  const subagentContinuationStore = new SubagentContinuationArtifactStore(
    artifactBackends ? { backend: artifactBackends.subagentContinuation } : {},
  );
  const subagentTaskRequestStore = new SubagentTaskRequestArtifactStore(
    artifactBackends ? { backend: artifactBackends.subagentTask } : {},
  );
  const subagentContinuationArtifacts: SubagentContinuationArtifactAccess = Object.freeze({
    write: (input: Parameters<SubagentContinuationArtifactAccess['write']>[0]) =>
      subagentContinuationStore.write(input),
    read: (
      ref: Parameters<SubagentContinuationArtifactAccess['read']>[0],
      expected: Parameters<SubagentContinuationArtifactAccess['read']>[1],
    ) => subagentContinuationStore.read(ref, expected),
  });
  const subagentTaskRequests: SubagentTaskRequestArtifactAccess = Object.freeze({
    write: (input: Parameters<SubagentTaskRequestArtifactAccess['write']>[0]) =>
      subagentTaskRequestStore.write(input),
    read: (
      ref: Parameters<SubagentTaskRequestArtifactAccess['read']>[0],
      expected: Parameters<SubagentTaskRequestArtifactAccess['read']>[1],
    ) => subagentTaskRequestStore.read(ref, expected),
  });
  const filesystemGrants = workspace ? new WorkspaceFilesystemGrantAuthority() : undefined;
  const gateway = new ModelInvocationGateway({
    artifacts,
    source: createLiveModelResponseSource(),
    operationExecution,
    planResource: (state, request) => planModelInvocationResource(state as RuntimeState, request),
  });
  return {
    status: 'available',
    artifacts,
    planArtifacts,
    capabilityArtifacts,
    sandboxPreparationArtifacts,
    subagentRuntimeFactory: () =>
      createPipelineSubagentRuntime(() => subagentComposition, installedSubagents.background),
    delegatedTaskArtifacts: subagentComposition.taskArtifacts,
    childResultArtifacts: installedSubagents.resultArtifacts,
    inspectChildStartGrant: (grant) => subagentComposition.grants.inspectStart(grant),
    consumeChildStartGrant: (grant) =>
      subagentComposition.grants.verifier().verifyAndConsumeStart(grant),
    backgroundSubagentRuntime: installedSubagents.background,
    ...(installedSubagents.checkpointArtifacts
      ? { checkpointArtifacts: installedSubagents.checkpointArtifacts }
      : {}),
    ...(afterTurnContinuationRuntime ? { afterTurnContinuationRuntime } : {}),
    reconcilePendingSubagents: (persistence, options) =>
      reconcilePendingSubagentProvidersAfterCrash({
        composition: subagentComposition,
        persistence,
        isLiveBackgroundTask: (taskId) => installedSubagents.background.hasLiveTask(taskId),
        ...(options?.terminalDisposition
          ? { terminalDisposition: options.terminalDisposition }
          : {}),
      }),
    subagentContinuationArtifacts,
    subagentTaskRequests,
    evidence: { status: 'available', reader: artifacts },
    gateway,
    modelEffects: new BuiltinModelEffectCoordinator(gateway),
    ...(workspace && filesystemGrants
      ? {
          workspaceFilesystem: {
            canonicalWorkspace: canonicalPathForComparison(workspace),
            grants: filesystemGrants,
            provider: new LocalWorkspaceFilesystemProvider(filesystemGrants.verifier()),
            preimageArtifacts: new FilesystemPreimageArtifactStore(
              artifactBackends ? { backend: artifactBackends.filesystemPreimage } : {},
            ),
            capabilityArtifacts,
          },
        }
      : {}),
  };
}
