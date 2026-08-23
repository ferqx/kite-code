import { CapabilityArtifactStore } from '@kite/builtin-runtime';
import {
  type BuiltinWorkspaceFilesystemRuntime,
  FilesystemPreimageArtifactStore,
  LocalWorkspaceFilesystemProvider,
  WorkspaceFilesystemGrantAuthority,
} from '@kite/builtin-runtime/filesystem';
import {
  BuiltinModelEffectCoordinator,
  type BuiltinModelOperationExecutionPort,
  createLiveModelResponseSource,
  type ModelArtifactEvidenceAvailability,
  ModelArtifactStore,
  ModelInvocationGateway,
} from '@kite/builtin-runtime/model';
import { PlanArtifactStore } from '@kite/builtin-runtime/planning';
import {
  canonicalPathForComparison,
  SandboxPreparationArtifactStore,
} from '@kite/builtin-runtime/sandbox';
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
} from '@kite/builtin-runtime/subagent';
import { planModelInvocationResource } from '@kite/runtime-host/kernel-adapter';
import { userKiteCodeDir } from '#app/config/paths';
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

function installedSubagentComposition() {
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
  artifacts: ModelArtifactStore;
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
): InstalledKiteRuntimeCompositionFactory {
  const installed = new Map<string, InstalledKiteRuntimeComposition>();
  return (workspace) => {
    const canonicalWorkspace = canonicalPathForComparison(workspace);
    const existing = installed.get(canonicalWorkspace);
    if (existing) return existing;
    const created = resolveInstalledKiteRuntimeComposition(workspace, operationExecution);
    installed.set(canonicalWorkspace, created);
    return created;
  };
}

/** App-owned composition for installation-private Model evidence and runtime mechanisms. */
export function resolveInstalledKiteRuntimeComposition(
  workspace?: string,
  operationExecution?: BuiltinModelOperationExecutionPort,
): InstalledKiteRuntimeComposition {
  if (!operationExecution) {
    throw new Error('Builtin Model operation execution port is unavailable.');
  }
  const artifacts = new ModelArtifactStore({});
  const planArtifacts = new PlanArtifactStore();
  const capabilityArtifacts = new CapabilityArtifactStore();
  const sandboxPreparationArtifacts = new SandboxPreparationArtifactStore({});
  const subagentComposition = installedSubagentComposition();
  const subagentContinuationStore = new SubagentContinuationArtifactStore();
  const subagentTaskRequestStore = new SubagentTaskRequestArtifactStore();
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
            preimageArtifacts: new FilesystemPreimageArtifactStore(),
            capabilityArtifacts,
          },
        }
      : {}),
  };
}
