import type {
  TrajectoryEvidenceChunk,
  TrajectoryEvidenceDescriptor,
  TrajectoryEvidenceOpen,
  TrajectoryPage,
  TrajectoryReadRequest,
  TrajectorySnapshot,
} from '@kite-ai/trajectory';

export const nativeTrajectoryFileChannel = 'kite:trajectory-file:request';
export const nativeTrajectoryOfflineFileChannel = 'kite:trajectory-offline-file:request';
export type NativeTrajectoryFileRequest =
  | { method: 'pick' }
  | { method: 'events'; bundleId: string; request: TrajectoryReadRequest }
  | { method: 'evidence.open'; bundleId: string; request: TrajectoryEvidenceOpen }
  | { method: 'evidence.read'; bundleId: string; readId: string; offset: string; limit?: number }
  | { method: 'evidence.close'; bundleId: string; readId: string }
  | { method: 'close'; bundleId: string }
  | {
      method: 'export';
      generation: number;
      snapshot: TrajectorySnapshot;
      includeEvidence: boolean;
    };
export type NativeTrajectoryFileResult =
  | {
      kind: 'trajectory.bundle.opened';
      bundleId: string;
      snapshot: TrajectorySnapshot;
      minimumCursor: string;
    }
  | { kind: 'trajectory.bundle.exported' }
  | { kind: 'trajectory.page'; trajectory: TrajectoryPage }
  | { kind: 'trajectory.evidence.opened'; trajectory: TrajectoryEvidenceDescriptor }
  | { kind: 'trajectory.evidence.chunk'; trajectory: TrajectoryEvidenceChunk }
  | null;
export interface NativeTrajectoryFileBridge {
  request(input: NativeTrajectoryFileRequest): Promise<NativeTrajectoryFileResult>;
}
export type NativeTrajectoryFileReply =
  | { ok: true; value: NativeTrajectoryFileResult }
  | { ok: false; code: string };
