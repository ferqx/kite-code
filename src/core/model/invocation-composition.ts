import { userKiteCodeDir } from '@/core/config/paths';
import { createPipelineSubagentRuntimeV1 } from '@/core/execution/tool-pipeline/subagent-runtime';
import type { WorkspaceFilesystemRuntimeV1 } from '@/core/execution/tool-pipeline/workspace-filesystem';
import {
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
} from '@/core/execution/workspace-filesystem';
import { CapabilityArtifactStore } from '@/core/persistence/capability-artifacts';
import { FilesystemPreimageArtifactStoreV1 } from '@/core/persistence/filesystem-preimage-artifacts';
import { SandboxPreparationArtifactStoreV1 } from '@/core/persistence/sandbox-preparation-artifacts';
import {
  type SubagentContinuationArtifactAccessV1,
  SubagentContinuationArtifactStoreV1,
} from '@/core/persistence/subagent-continuation-artifacts';
import { SubagentLifecycleArtifactStoreV1 } from '@/core/persistence/subagent-lifecycle-artifacts';
import {
  SubagentTaskArtifactStoreV1,
  type SubagentTaskRequestArtifactAccessV1,
  SubagentTaskRequestArtifactStoreV1,
} from '@/core/persistence/subagent-task-artifacts';
import type { ModelArtifactEvidenceAvailabilityV1 } from '@/core/runtime/kernel';
import { createGovernedLocalSubagentCompositionV1 } from '@/core/subagent/composition';
import { reconcilePendingSubagentProvidersAfterCrashV1 } from '@/core/subagent/recovery';
import { canonicalPathForComparison } from '@/core/tools/path-utils';
import { ModelInvocationGatewayV1 } from './invocation-gateway';
import {
  allPrivateArtifactEvidenceRootsV1,
  loadOrCreateModelArtifactIntegrityKeyV1,
  ModelArtifactIntegrityKeyError,
} from './model-artifact-key';
import { ModelArtifactStoreV1 } from './model-artifacts';
import { createLiveModelResponseSourceV1 } from './response-source';

const installedSubagentCompositions = new Map<
  string,
  import('@/core/subagent/composition').GovernedSubagentCompositionV1
>();

function installedSubagentCompositionV1(integrityKey: Uint8Array) {
  const installation = userKiteCodeDir();
  const existing = installedSubagentCompositions.get(installation);
  if (existing) return existing;
  const taskArtifacts = new SubagentTaskArtifactStoreV1({ integrityKey });
  const lifecycleArtifacts = new SubagentLifecycleArtifactStoreV1({ integrityKey });
  const composition = createGovernedLocalSubagentCompositionV1({
    integrityKey,
    taskArtifacts,
    lifecycleArtifacts,
  });
  installedSubagentCompositions.set(installation, composition);
  return composition;
}

export type InstalledModelInvocationRuntimeV1 =
  | {
      status: 'available';
      artifacts: ModelArtifactStoreV1;
      capabilityArtifacts: CapabilityArtifactStore;
      evidence: ModelArtifactEvidenceAvailabilityV1;
      gateway: ModelInvocationGatewayV1;
      workspaceFilesystem?: WorkspaceFilesystemRuntimeV1;
      sandboxPreparationArtifacts: SandboxPreparationArtifactStoreV1;
      subagentRuntimeFactory: import('@/core/execution/tool-pipeline/dispatch').ToolInvocationRecordContextV1['subagentRuntimeFactory'];
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

/** Resolve replay evidence without preventing transcript restore when the key is unavailable. */
export function resolveInstalledModelInvocationRuntimeV1(
  workspace?: string,
): InstalledModelInvocationRuntimeV1 {
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
  return {
    status: 'available',
    artifacts,
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
    gateway: new ModelInvocationGatewayV1({
      artifacts,
      source: createLiveModelResponseSourceV1(),
    }),
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

/** Production composition for the installation-private Model evidence domain. */
export function createInstalledModelInvocationGatewayV1(): ModelInvocationGatewayV1 {
  const runtime = resolveInstalledModelInvocationRuntimeV1();
  if (runtime.status === 'unavailable') throw runtime.error;
  return runtime.gateway;
}
