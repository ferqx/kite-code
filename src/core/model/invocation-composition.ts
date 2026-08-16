import { capabilityArtifactRoot } from '@/core/config/paths';
import { CapabilityArtifactStore } from '@/core/persistence/capability-artifacts';
import type { ModelArtifactEvidenceAvailabilityV1 } from '@/core/runtime/kernel';
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
    }
  | {
      status: 'unavailable';
      evidence: ModelArtifactEvidenceAvailabilityV1;
      gateway: undefined;
      error: ModelArtifactIntegrityKeyError;
    };

/** Resolve replay evidence without preventing transcript restore when the key is unavailable. */
export function resolveInstalledModelInvocationRuntimeV1(): InstalledModelInvocationRuntimeV1 {
  let integrityKey: Uint8Array;
  try {
    integrityKey = loadOrCreateModelArtifactIntegrityKeyV1({
      additionalArtifactRoots: [capabilityArtifactRoot()],
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
  return {
    status: 'available',
    artifacts,
    capabilityArtifacts,
    evidence: { status: 'available', reader: artifacts },
    gateway: new ModelInvocationGatewayV1({
      artifacts,
      source: createLiveModelResponseSourceV1(),
    }),
  };
}

/** Production composition for the installation-private Model evidence domain. */
export function createInstalledModelInvocationGatewayV1(): ModelInvocationGatewayV1 {
  const runtime = resolveInstalledModelInvocationRuntimeV1();
  if (runtime.status === 'unavailable') throw runtime.error;
  return runtime.gateway;
}
