import type { PrivateArtifactRef } from '@kite/runtime-spi';
import type { ModelArtifactStore } from './artifacts';
import { PrivateArtifactStorageError } from './private-immutable-artifacts';
import { canonicalModelJson } from './surface-canonicalizer';

export interface ModelArtifactEvidenceAvailability {
  readonly status: 'available';
  readonly reader: Pick<ModelArtifactStore, 'readSurface' | 'readResponse'>;
}

export interface PendingModelInvocationEvidenceRecord {
  readonly invocationId: string;
  readonly surfaceArtifact: PrivateArtifactRef & { readonly kind: 'model_surface' };
  readonly surfaceIntegrityIdentifier: string;
  readonly routeFingerprint: string;
}

export interface CompletedModelInvocationEvidenceRecord
  extends PendingModelInvocationEvidenceRecord {
  readonly responseArtifact?: PrivateArtifactRef & { readonly kind: 'model_response' };
}

export type ModelInvocationEvidenceFailureReason = 'artifact_missing' | 'artifact_corrupt';

/** Verify the immutable Model Surface evidence before retry/recovery decisions. */
export function verifyPendingModelInvocationEvidence(
  invocation: PendingModelInvocationEvidenceRecord,
  evidence: ModelArtifactEvidenceAvailability | undefined,
): ModelInvocationEvidenceFailureReason | undefined {
  if (!evidence) return undefined;
  try {
    const surface = evidence.reader.readSurface(invocation.surfaceArtifact);
    if (
      invocation.surfaceArtifact.integrityIdentifier !== invocation.surfaceIntegrityIdentifier ||
      surface.route.routeFingerprint !== invocation.routeFingerprint
    ) {
      return 'artifact_corrupt';
    }
    return undefined;
  } catch (error) {
    return modelArtifactEvidenceFailureReason(error);
  }
}

/** Bind a completed Model response to the exact immutable Surface and route. */
export function verifyCompletedModelInvocationEvidence(
  invocation: CompletedModelInvocationEvidenceRecord,
  evidence: ModelArtifactEvidenceAvailability | undefined,
): ModelInvocationEvidenceFailureReason | undefined {
  if (!evidence) return undefined;
  const surfaceFailure = verifyPendingModelInvocationEvidence(invocation, evidence);
  if (surfaceFailure) return surfaceFailure;
  if (!invocation.responseArtifact) return 'artifact_corrupt';
  try {
    const response = evidence.reader.readResponse(invocation.responseArtifact);
    const surface = evidence.reader.readSurface(invocation.surfaceArtifact);
    if (
      response.invocationId !== invocation.invocationId ||
      response.surfaceIntegrityIdentifier !== invocation.surfaceIntegrityIdentifier ||
      canonicalModelJson(response.route) !== canonicalModelJson(surface.route)
    ) {
      return 'artifact_corrupt';
    }
    return undefined;
  } catch (error) {
    return modelArtifactEvidenceFailureReason(error);
  }
}

export function modelArtifactEvidenceFailureReason(
  error: unknown,
): ModelInvocationEvidenceFailureReason {
  if (error instanceof PrivateArtifactStorageError) {
    if (error.code === 'artifact_missing') return 'artifact_missing';
  }
  return 'artifact_corrupt';
}
