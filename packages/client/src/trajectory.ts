import {
  canonicalSerialize,
  type TrajectoryPage,
  type TrajectoryReadRequest,
  type TrajectoryScope,
  type TrajectorySnapshot,
  trajectorySnapshotSchema,
} from '@kite-ai/trajectory';
import { ClientError } from './decode';

export interface TrajectorySource {
  open(scope: TrajectoryScope, options?: { signal?: AbortSignal }): Promise<TrajectorySnapshot>;
  readEvents(
    request: TrajectoryReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<TrajectoryPage>;
}
export function verifyTrajectorySnapshot(
  value: unknown,
  scope: TrajectoryScope,
): TrajectorySnapshot {
  const snapshot = trajectorySnapshotSchema.parse(value);
  if (
    snapshot.storeId !== scope.storeId ||
    snapshot.sessionId !== scope.sessionId ||
    snapshot.runId !== scope.runId ||
    snapshot.executionId !== scope.executionId ||
    canonicalSerialize(snapshot.eventKinds ?? []) !== canonicalSerialize(scope.eventKinds ?? []) ||
    snapshot.historyCoverage.upperCursor !== snapshot.upperCursor
  )
    throw new ClientError('trajectory_identity_mismatch');
  return snapshot;
}
