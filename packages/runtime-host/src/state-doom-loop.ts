import {
  type KernelDoomLoopCheckV1,
  type KernelDoomLoopRequestV1,
  type KernelDoomLoopTrackerEntryV1,
  kernelCheckDoomLoopFingerprintV1,
  kernelToolDoomLoopFingerprintV1,
  kernelUpdateDoomLoopTrackerV1,
} from '@kite/agent-kernel';

export type StateDoomLoopCheckV1 = KernelDoomLoopCheckV1;
export type StateDoomLoopRequestV1 = KernelDoomLoopRequestV1;
export type StateDoomLoopTrackerEntryV1 = KernelDoomLoopTrackerEntryV1;

export const runtimeHostStateToolDoomLoopFingerprintV1 = kernelToolDoomLoopFingerprintV1;
export const runtimeHostStateCheckDoomLoopFingerprintV1 = kernelCheckDoomLoopFingerprintV1;
export const runtimeHostStateUpdateDoomLoopTrackerV1 = kernelUpdateDoomLoopTrackerV1;
