import {
  type KernelDoomLoopCheck,
  type KernelDoomLoopRequest,
  type KernelDoomLoopTrackerEntry,
  kernelCheckDoomLoopFingerprint,
  kernelToolDoomLoopFingerprint,
  kernelUpdateDoomLoopTracker,
} from '@kite-ai/agent-kernel';

export type StateDoomLoopCheck = KernelDoomLoopCheck;
export type StateDoomLoopRequest = KernelDoomLoopRequest;
export type StateDoomLoopTrackerEntry = KernelDoomLoopTrackerEntry;

export const runtimeHostStateToolDoomLoopFingerprint = kernelToolDoomLoopFingerprint;
export const runtimeHostStateCheckDoomLoopFingerprint = kernelCheckDoomLoopFingerprint;
export const runtimeHostStateUpdateDoomLoopTracker = kernelUpdateDoomLoopTracker;
