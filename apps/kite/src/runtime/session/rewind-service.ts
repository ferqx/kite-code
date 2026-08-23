import {
  previewFilesToCheckpoint,
  restoreFilesToCheckpoint,
} from '#app/bootstrap/runtime/file-checkpoints';
import { loadSession } from '#app/bootstrap/runtime/session-persistence';
import type { StateRuntimeStorage } from '#app/bootstrap/runtime/state-runtime';

export interface RewindServiceDependencies {
  readonly openStateRuntimeStorage: (threadId?: string) => StateRuntimeStorage;
  readonly resolveRecoveryIdentity: (threadId: string) => string;
  readonly allocateRecoveryIdentity: () => string;
}

export class RewindService {
  private readonly deps: RewindServiceDependencies;

  constructor(deps: RewindServiceDependencies) {
    this.deps = deps;
  }

  listCheckpoints(threadId: string) {
    const store = this.deps.openStateRuntimeStorage(threadId);
    try {
      return store.checkpoints.listNamedSnapshots(threadId);
    } finally {
      store.close();
    }
  }

  preview(threadId: string, snapshotId: string, workspace: string) {
    const store = this.deps.openStateRuntimeStorage(threadId);
    try {
      if (!this.hasCheckpoint(store, threadId, snapshotId)) return null;
      return previewFilesToCheckpoint(store, threadId, snapshotId, workspace);
    } finally {
      store.close();
    }
  }

  async execute(input: {
    sourceThreadId: string;
    snapshotId: string;
    scope: 'code_and_conversation' | 'code_only' | 'conversation_only';
    workspace: string;
  }) {
    const store = this.deps.openStateRuntimeStorage(input.sourceThreadId);
    try {
      if (!this.hasCheckpoint(store, input.sourceThreadId, input.snapshotId)) {
        throw new Error('Recovery point is unavailable or corrupted.');
      }
      const restoresConversation =
        input.scope === 'code_and_conversation' || input.scope === 'conversation_only';
      const restoresCode = input.scope === 'code_and_conversation' || input.scope === 'code_only';
      let targetThreadId = input.sourceThreadId;
      let recoveredData: Awaited<ReturnType<typeof loadSession>> = null;
      if (restoresConversation) {
        targetThreadId = `tui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        if (
          !store.checkpoints.forkSession(
            input.sourceThreadId,
            input.snapshotId,
            targetThreadId,
            this.deps.allocateRecoveryIdentity(),
          )
        ) {
          throw new Error('Recovery point is unavailable or corrupted.');
        }
        recoveredData = await loadSession(
          this.deps.openStateRuntimeStorage,
          targetThreadId,
          this.deps.resolveRecoveryIdentity(targetThreadId),
        );
        if (!recoveredData) throw new Error('Recovered session could not be loaded.');
      }
      const fileOutcome = restoresCode
        ? restoreFilesToCheckpoint(store, input.sourceThreadId, input.snapshotId, input.workspace)
        : null;
      return { targetThreadId, recoveredData, fileOutcome };
    } finally {
      store.close();
    }
  }

  private hasCheckpoint(store: StateRuntimeStorage, threadId: string, snapshotId: string): boolean {
    if (!store.checkpoints.getNamedSnapshotEntry(threadId, snapshotId)) return false;
    const snapshot = store.checkpoints.loadNamedSnapshot(threadId, snapshotId);
    return typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot);
  }
}
