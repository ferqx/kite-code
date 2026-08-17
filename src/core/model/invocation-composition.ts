import {
  capabilityArtifactRoot,
  filesystemPreimageArtifactRoot,
  sandboxPreparationArtifactRoot,
} from '@/core/config/paths';
import type { WorkspaceFilesystemRuntimeV1 } from '@/core/execution/tool-pipeline/workspace-filesystem';
import {
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
} from '@/core/execution/workspace-filesystem';
import { CapabilityArtifactStore } from '@/core/persistence/capability-artifacts';
import { FilesystemPreimageArtifactStoreV1 } from '@/core/persistence/filesystem-preimage-artifacts';
import { SandboxPreparationArtifactStoreV1 } from '@/core/persistence/sandbox-preparation-artifacts';
import type { ModelArtifactEvidenceAvailabilityV1 } from '@/core/runtime/kernel';
import { canonicalPathForComparison } from '@/core/tools/path-utils';
import { ModelInvocationGatewayV1 } from './invocation-gateway';
import {
  loadOrCreateModelArtifactIntegrityKeyV1,
  ModelArtifactIntegrityKeyError,
} from './model-artifact-key';
import { ModelArtifactStoreV1 } from './model-artifacts';
import { createLiveModelResponseSourceV1 } from './response-source';

export type InstalledModelInvocationRuntimeV1 =
  | {
      status: 'available';
      artifacts: ModelArtifactStoreV1;
      capabilityArtifacts: CapabilityArtifactStore;
      evidence: ModelArtifactEvidenceAvailabilityV1;
      gateway: ModelInvocationGatewayV1;
      workspaceFilesystem?: WorkspaceFilesystemRuntimeV1;
      sandboxPreparationArtifacts: SandboxPreparationArtifactStoreV1;
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
      additionalArtifactRoots: [
        capabilityArtifactRoot(),
        filesystemPreimageArtifactRoot(),
        sandboxPreparationArtifactRoot(),
      ],
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
  const filesystemGrants = workspace ? new WorkspaceFilesystemGrantAuthorityV1() : undefined;
  return {
    status: 'available',
    artifacts,
    capabilityArtifacts,
    sandboxPreparationArtifacts,
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
