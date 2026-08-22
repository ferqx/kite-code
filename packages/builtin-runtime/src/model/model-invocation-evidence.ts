import type { PrivateArtifactRefV1 } from '@kite/runtime-spi';
import type { ModelArtifactStoreV1 } from './artifacts';
import { PrivateArtifactStorageError } from './private-immutable-artifacts';
import { canonicalModelJsonV1 } from './surface-canonicalizer';

export type ModelArtifactEvidenceAvailabilityV1 =
  | {
      readonly status: 'available';
      readonly reader: Pick<ModelArtifactStoreV1, 'readSurface' | 'readResponse'>;
    }
  | { readonly status: 'unavailable'; readonly reason: 'key_unavailable' };

export interface PendingModelInvocationEvidenceRecordV1 {
  readonly invocationId: string;
  readonly surfaceArtifact: PrivateArtifactRefV1 & { readonly kind: 'model_surface' };
  readonly surfaceIntegrityIdentifier: string;
  readonly routeFingerprint: string;
}

export interface CompletedModelInvocationEvidenceRecordV1
  extends PendingModelInvocationEvidenceRecordV1 {
  readonly responseArtifact?: PrivateArtifactRefV1 & { readonly kind: 'model_response' };
}

export type ModelInvocationEvidenceFailureReasonV1 =
  | 'artifact_missing'
  | 'artifact_corrupt'
  | 'key_unavailable';

/** Verify the immutable Model Surface evidence before retry/recovery decisions. */
export function verifyPendingModelInvocationEvidenceV1(
  invocation: PendingModelInvocationEvidenceRecordV1,
  evidence: ModelArtifactEvidenceAvailabilityV1 | undefined,
): ModelInvocationEvidenceFailureReasonV1 | undefined {
  if (!evidence) return undefined;
  if (evidence.status === 'unavailable') return evidence.reason;
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
    return modelArtifactEvidenceFailureReasonV1(error);
  }
}

/** Bind a completed Model response to the exact immutable Surface and route. */
export function verifyCompletedModelInvocationEvidenceV1(
  invocation: CompletedModelInvocationEvidenceRecordV1,
  evidence: ModelArtifactEvidenceAvailabilityV1 | undefined,
): ModelInvocationEvidenceFailureReasonV1 | undefined {
  if (!evidence) return undefined;
  const surfaceFailure = verifyPendingModelInvocationEvidenceV1(invocation, evidence);
  if (surfaceFailure) return surfaceFailure;
  if (evidence.status === 'unavailable') return evidence.reason;
  if (!invocation.responseArtifact) return 'artifact_corrupt';
  try {
    const response = evidence.reader.readResponse(invocation.responseArtifact);
    const surface = evidence.reader.readSurface(invocation.surfaceArtifact);
    if (
      response.invocationId !== invocation.invocationId ||
      response.surfaceIntegrityIdentifier !== invocation.surfaceIntegrityIdentifier ||
      canonicalModelJsonV1(response.route) !== canonicalModelJsonV1(surface.route)
    ) {
      return 'artifact_corrupt';
    }
    return undefined;
  } catch (error) {
    return modelArtifactEvidenceFailureReasonV1(error);
  }
}

export function modelArtifactEvidenceFailureReasonV1(
  error: unknown,
): ModelInvocationEvidenceFailureReasonV1 {
  if (error instanceof PrivateArtifactStorageError) {
    if (error.code === 'artifact_missing') return 'artifact_missing';
    if (error.code === 'key_unavailable') return 'key_unavailable';
  }
  return 'artifact_corrupt';
}
