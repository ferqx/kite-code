import {
  BuiltinChildRuntimeDriverV1,
  CapabilityArtifactStore,
  createGovernedLocalSubagentCompositionV1,
  type GovernedSubagentCompositionV1,
} from '@kite/builtin-runtime';
import {
  type BuiltinWorkspaceFilesystemRuntimeV1,
  FilesystemPreimageArtifactStoreV1,
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
} from '@kite/builtin-runtime/filesystem';
import {
  allPrivateArtifactEvidenceRootsV1,
  BuiltinModelEffectCoordinatorV1,
  type BuiltinModelOperationExecutionPortV1,
  createLiveModelResponseSourceV1,
  loadOrCreateModelArtifactIntegrityKeyV1,
  type ModelArtifactEvidenceAvailabilityV1,
  ModelArtifactIntegrityKeyError,
  ModelArtifactStoreV1,
  ModelInvocationGatewayV1,
} from '@kite/builtin-runtime/model';
import { PlanArtifactStore } from '@kite/builtin-runtime/planning';
import {
  canonicalPathForComparison,
  SandboxPreparationArtifactStoreV1,
} from '@kite/builtin-runtime/sandbox';
import { planModelInvocationResourceV1 } from '@kite/runtime-host';
import { userKiteCodeDir } from '#app/config/paths';
import {
  type SubagentContinuationArtifactAccessV1,
  SubagentContinuationArtifactStoreV1,
  type SubagentLifecycleArtifactAccessV1,
  SubagentLifecycleArtifactStoreV1,
  type SubagentTaskArtifactAccessV1,
  SubagentTaskArtifactStoreV1,
  type SubagentTaskRequestArtifactAccessV1,
  SubagentTaskRequestArtifactStoreV1,
} from '#builtin-runtime';
import type { RuntimeState } from './runtime/state26-runtime';
import {
  type AppSubagentRuntimeFactoryV1,
  createPipelineSubagentRuntimeV1,
} from './runtime/subagent/pipeline-runtime';
import { reconcilePendingSubagentProvidersAfterCrashV1 } from './runtime/subagent-provider-recovery';

type InstalledSubagentCompositionV1 = GovernedSubagentCompositionV1<
  SubagentLifecycleArtifactAccessV1,
  BuiltinChildRuntimeDriverV1,
  SubagentTaskArtifactAccessV1
>;

const installedSubagentCompositions = new Map<string, InstalledSubagentCompositionV1>();

function installedSubagentCompositionV1(integrityKey: Uint8Array) {
  const installation = userKiteCodeDir();
  const existing = installedSubagentCompositions.get(installation);
  if (existing) return existing;
  const taskArtifacts = new SubagentTaskArtifactStoreV1({ integrityKey });
  const lifecycleArtifacts = new SubagentLifecycleArtifactStoreV1({ integrityKey });
  const composition = createGovernedLocalSubagentCompositionV1({
    integrityKey,
    driver: new BuiltinChildRuntimeDriverV1(),
    taskArtifacts,
    lifecycleArtifacts,
  });
  installedSubagentCompositions.set(installation, composition);
  return composition;
}

export type InstalledKiteRuntimeCompositionV1 =
  | {
      status: 'available';
      artifacts: ModelArtifactStoreV1;
      /** The one App-owned immutable Plan Artifact writer for this runtime. */
      planArtifacts: PlanArtifactStore;
      capabilityArtifacts: CapabilityArtifactStore;
      evidence: ModelArtifactEvidenceAvailabilityV1;
      gateway: ModelInvocationGatewayV1;
      modelEffects: BuiltinModelEffectCoordinatorV1;
      workspaceFilesystem?: BuiltinWorkspaceFilesystemRuntimeV1;
      sandboxPreparationArtifacts: SandboxPreparationArtifactStoreV1;
      subagentRuntimeFactory: AppSubagentRuntimeFactoryV1;
      reconcilePendingSubagents: (
        persistence: Parameters<
          typeof reconcilePendingSubagentProvidersAfterCrashV1
        >[0]['persistence'],
      ) => Promise<boolean>;
      subagentContinuationArtifacts: SubagentContinuationArtifactAccessV1;
      subagentTaskRequests: SubagentTaskRequestArtifactAccessV1;
    }
  | {
      status: 'unavailable';
      evidence: ModelArtifactEvidenceAvailabilityV1;
      gateway: undefined;
      error: ModelArtifactIntegrityKeyError;
    };

export type InstalledKiteRuntimeCompositionFactoryV1 = (
  workspace: string,
) => InstalledKiteRuntimeCompositionV1;

/**
 * Creates one installed Runtime composition for one App/Host instance. A
 * second workspace is rejected instead of silently creating another Gateway,
 * operation port, artifact owner, or filesystem authority.
 */
export function createInstalledKiteRuntimeCompositionFactoryV1(
  operationExecution: BuiltinModelOperationExecutionPortV1,
): InstalledKiteRuntimeCompositionFactoryV1 {
  let installedWorkspace: string | undefined;
  let installed: InstalledKiteRuntimeCompositionV1 | undefined;
  return (workspace) => {
    const canonicalWorkspace = canonicalPathForComparison(workspace);
    if (installed && installedWorkspace !== canonicalWorkspace) {
      throw new Error('One Kite Runtime composition cannot span multiple workspaces.');
    }
    if (!installed) {
      installedWorkspace = canonicalWorkspace;
      installed = resolveInstalledKiteRuntimeCompositionV1(workspace, operationExecution);
    }
    return installed;
  };
}

/** App-owned composition for installation-private Model evidence and runtime mechanisms. */
export function resolveInstalledKiteRuntimeCompositionV1(
  workspace?: string,
  operationExecution?: BuiltinModelOperationExecutionPortV1,
): InstalledKiteRuntimeCompositionV1 {
  if (!operationExecution) {
    throw new Error('Builtin Model operation execution port is unavailable.');
  }
  let integrityKey: Uint8Array;
  try {
    integrityKey = loadOrCreateModelArtifactIntegrityKeyV1({
      additionalArtifactRoots: allPrivateArtifactEvidenceRootsV1(),
    });
  } catch (error) {
    if (!(error instanceof ModelArtifactIntegrityKeyError)) throw error;
    return {
      status: 'unavailable',
      evidence: { status: 'unavailable', reason: 'key_unavailable' },
      gateway: undefined,
      error,
    };
  }
  const artifacts = new ModelArtifactStoreV1({ integrityKey });
  const planArtifacts = new PlanArtifactStore();
  const capabilityArtifacts = new CapabilityArtifactStore({ integrityKey });
  const sandboxPreparationArtifacts = new SandboxPreparationArtifactStoreV1({ integrityKey });
  const subagentComposition = installedSubagentCompositionV1(integrityKey);
  const subagentContinuationStore = new SubagentContinuationArtifactStoreV1({ integrityKey });
  const subagentTaskRequestStore = new SubagentTaskRequestArtifactStoreV1({ integrityKey });
  const subagentContinuationArtifacts: SubagentContinuationArtifactAccessV1 = Object.freeze({
    write: (input: Parameters<SubagentContinuationArtifactAccessV1['write']>[0]) =>
      subagentContinuationStore.write(input),
    read: (
      ref: Parameters<SubagentContinuationArtifactAccessV1['read']>[0],
      expected: Parameters<SubagentContinuationArtifactAccessV1['read']>[1],
    ) => subagentContinuationStore.read(ref, expected),
  });
  const subagentTaskRequests: SubagentTaskRequestArtifactAccessV1 = Object.freeze({
    write: (input: Parameters<SubagentTaskRequestArtifactAccessV1['write']>[0]) =>
      subagentTaskRequestStore.write(input),
    read: (
      ref: Parameters<SubagentTaskRequestArtifactAccessV1['read']>[0],
      expected: Parameters<SubagentTaskRequestArtifactAccessV1['read']>[1],
    ) => subagentTaskRequestStore.read(ref, expected),
  });
  const filesystemGrants = workspace ? new WorkspaceFilesystemGrantAuthorityV1() : undefined;
  const gateway = new ModelInvocationGatewayV1({
    artifacts,
    source: createLiveModelResponseSourceV1(),
    operationExecution,
    planResource: (state, request) => planModelInvocationResourceV1(state as RuntimeState, request),
  });
  return {
    status: 'available',
    artifacts,
    planArtifacts,
    capabilityArtifacts,
    sandboxPreparationArtifacts,
    subagentRuntimeFactory: () => createPipelineSubagentRuntimeV1(() => subagentComposition),
    reconcilePendingSubagents: (persistence) =>
      reconcilePendingSubagentProvidersAfterCrashV1({
        composition: subagentComposition,
        persistence,
      }),
    subagentContinuationArtifacts,
    subagentTaskRequests,
    evidence: { status: 'available', reader: artifacts },
    gateway,
    modelEffects: new BuiltinModelEffectCoordinatorV1(gateway),
    ...(workspace && filesystemGrants
      ? {
          workspaceFilesystem: {
            canonicalWorkspace: canonicalPathForComparison(workspace),
            grants: filesystemGrants,
            provider: new LocalWorkspaceFilesystemProviderV1(filesystemGrants.verifier()),
            preimageArtifacts: new FilesystemPreimageArtifactStoreV1({ integrityKey }),
            capabilityArtifacts,
          },
        }
      : {}),
  };
}
