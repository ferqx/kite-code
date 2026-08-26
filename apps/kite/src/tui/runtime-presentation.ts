import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';

/** Closed current Runtime presentation vocabulary accepted by live and replay reducers. */
export type RuntimePresentationEvent = RuntimeClientEvent;

export type ContextCompactionProgressPhase = 'preparing' | 'summarizing' | 'validating';

export interface ContextCompactionResult {
  readonly events: RuntimePresentationEvent[];
  readonly text: string;
  readonly isError?: boolean;
}

export interface RuntimeCheckpointEntry {
  readonly snapshotId: string;
  readonly eventPosition: number;
  readonly createdAt: number;
  readonly targetMessage?: string;
  readonly targetMessageCreatedAt?: number;
  readonly affectedFileCount?: number;
}

export interface RewindFileOutcome {
  readonly restored: readonly string[];
  readonly deleted: readonly string[];
  readonly failed: readonly { readonly path: string; readonly error: string }[];
  readonly conflicts: readonly {
    readonly path: string;
    readonly reason: 'modified_after_kite_write' | 'unverified_postimage';
  }[];
}

export interface RewindFilePreview {
  readonly files: readonly {
    readonly path: string;
    readonly addedLines: number;
    readonly removedLines: number;
  }[];
  readonly lineStatsAvailable: boolean;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly conflictCount: number;
  readonly failureCount: number;
}
