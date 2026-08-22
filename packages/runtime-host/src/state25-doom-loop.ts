import {
  type KernelDoomLoopCheckV1,
  type KernelDoomLoopRequestV1,
  type KernelDoomLoopTrackerEntryV1,
  kernelCheckDoomLoopFingerprintV1,
  kernelToolDoomLoopFingerprintV1,
  kernelUpdateDoomLoopTrackerV1,
} from '@kite/agent-kernel';

export type State25DoomLoopCheckV1 = KernelDoomLoopCheckV1;
export type State25DoomLoopRequestV1 = KernelDoomLoopRequestV1;
export type State25DoomLoopTrackerEntryV1 = KernelDoomLoopTrackerEntryV1;

export const runtimeHostState25ToolDoomLoopFingerprintV1 = kernelToolDoomLoopFingerprintV1;
export const runtimeHostState25CheckDoomLoopFingerprintV1 = kernelCheckDoomLoopFingerprintV1;
export const runtimeHostState25UpdateDoomLoopTrackerV1 = kernelUpdateDoomLoopTrackerV1;
