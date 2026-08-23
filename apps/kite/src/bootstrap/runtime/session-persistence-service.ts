import { previewFilesToCheckpoint, restoreFilesToCheckpoint } from './file-checkpoints';
import {
  deleteSession,
  generateSessionName,
  listSessions,
  loadSession,
  persistSessionName,
  searchSessions,
} from './session-persistence';
import type { StateSessionStorageV1 } from './state-runtime';

export interface SessionPersistenceServiceDependencies {
  readonly openStateSessionStorage: (threadId?: string) => StateSessionStorageV1;
  readonly resolveRecoveryIdentity: (threadId: string) => string;
  readonly allocateRecoveryIdentity: () => string;
}

export class SessionPersistenceService {
  private readonly deps: SessionPersistenceServiceDependencies;

  constructor(deps: SessionPersistenceServiceDependencies) {
    this.deps = deps;
  }

  listRewindCheckpoints(threadId: string) {
    const store = this.deps.openStateSessionStorage(threadId);
    try {
      return store.listNamedSnapshots(threadId);
    } finally {
      store.close();
    }
  }

  listPersistedSessions(query = '') {
    return query
      ? searchSessions(this.deps.openStateSessionStorage, query)
      : listSessions(this.deps.openStateSessionStorage);
  }

  loadPersistedSession(threadId: string) {
    return loadSession(
      this.deps.openStateSessionStorage,
      threadId,
      this.deps.resolveRecoveryIdentity(threadId),
    );
  }

  deletePersistedSession(threadId: string) {
    return deleteSession(this.deps.openStateSessionStorage, threadId);
  }

  async generateAndPersistSessionName(threadId: string, task: string) {
    const name = await generateSessionName(task);
    if (name) await persistSessionName(this.deps.openStateSessionStorage, threadId, name);
    return name;
  }

  previewRewind(threadId: string, snapshotId: string, workspace: string) {
    const store = this.deps.openStateSessionStorage(threadId);
    try {
      if (!this.hasCheckpoint(store, threadId, snapshotId)) return null;
      return previewFilesToCheckpoint(store, threadId, snapshotId, workspace);
    } finally {
      store.close();
    }
  }

  async executeRewind(input: {
    sourceThreadId: string;
    snapshotId: string;
    scope: 'code_and_conversation' | 'code_only' | 'conversation_only';
    workspace: string;
  }) {
    const store = this.deps.openStateSessionStorage(input.sourceThreadId);
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
          !store.forkSession(
            input.sourceThreadId,
            input.snapshotId,
            targetThreadId,
            this.deps.allocateRecoveryIdentity(),
          )
        ) {
          throw new Error('Recovery point is unavailable or corrupted.');
        }
        recoveredData = await loadSession(
          this.deps.openStateSessionStorage,
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

  private hasCheckpoint(
    store: StateSessionStorageV1,
    threadId: string,
    snapshotId: string,
  ): boolean {
    if (!store.getNamedSnapshotEntry(threadId, snapshotId)) return false;
    const snapshot = store.loadNamedSnapshot(threadId, snapshotId);
    return typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot);
  }
}
