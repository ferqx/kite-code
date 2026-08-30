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
  type SubagentContinuationArtifactAccess,
  SubagentContinuationArtifactStore,
  type SubagentLifecycleArtifactAccess,
  SubagentLifecycleArtifactStore,
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
  type AppSubagentRuntimeFactory,
  createPipelineSubagentRuntime,
} from './runtime/subagent/pipeline-runtime';
import { reconcilePendingSubagentProvidersAfterCrash } from './runtime/subagent-provider-recovery';

type InstalledSubagentComposition = GovernedSubagentComposition<
  SubagentLifecycleArtifactAccess,
  BuiltinChildRuntimeDriver,
  SubagentTaskArtifactAccess
>;

const installedSubagentCompositions = new Map<string, InstalledSubagentComposition>();

function installedSubagentComposition(backends?: KiteHomeBuiltinArtifactBackends) {
  if (backends) {
    return createGovernedLocalSubagentComposition({
      driver: new BuiltinChildRuntimeDriver(),
      taskArtifacts: new SubagentTaskArtifactStore({
        backend: backends.subagentTask,
      }),
      lifecycleArtifacts: new SubagentLifecycleArtifactStore({
        backend: backends.subagentLifecycle,
      }),
    });
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
  installedSubagentCompositions.set(installation, composition);
  return composition;
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
  reconcilePendingSubagents: (
    persistence: Parameters<typeof reconcilePendingSubagentProvidersAfterCrash>[0]['persistence'],
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
): InstalledKiteRuntimeCompositionFactory {
  const installed = new Map<string, InstalledKiteRuntimeComposition>();
  const subagentComposition = installedSubagentComposition(artifactBackends);
  return (workspace) => {
    const canonicalWorkspace = canonicalPathForComparison(workspace);
    const existing = installed.get(canonicalWorkspace);
    if (existing) return existing;
    const created = resolveInstalledKiteRuntimeComposition(
      workspace,
      operationExecution,
      artifactBackends,
      subagentComposition,
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
  injectedSubagentComposition?: InstalledSubagentComposition,
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
  const subagentComposition =
    injectedSubagentComposition ?? installedSubagentComposition(artifactBackends);
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
    subagentRuntimeFactory: () => createPipelineSubagentRuntime(() => subagentComposition),
    reconcilePendingSubagents: (persistence) =>
      reconcilePendingSubagentProvidersAfterCrash({
        composition: subagentComposition,
        persistence,
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
