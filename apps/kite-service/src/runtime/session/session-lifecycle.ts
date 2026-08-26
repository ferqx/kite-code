import {
  generateSessionName,
  listSessions,
  loadSession,
  persistSessionName,
  searchSessions,
} from '#kite-service/bootstrap/runtime/session-persistence';
import type { StateRuntimeStorage } from '#kite-service/bootstrap/runtime/state-runtime';

export interface SessionLifecycleServiceDependencies {
  readonly openStateRuntimeStorage: (threadId?: string) => StateRuntimeStorage;
  readonly resolveRecoveryIdentity: (threadId: string) => string;
}

export class SessionLifecycleService {
  private readonly deps: SessionLifecycleServiceDependencies;

  constructor(deps: SessionLifecycleServiceDependencies) {
    this.deps = deps;
  }

  listPersistedSessions(query = '') {
    return query
      ? searchSessions(this.deps.openStateRuntimeStorage, query)
      : listSessions(this.deps.openStateRuntimeStorage);
  }

  loadPersistedSession(threadId: string) {
    return loadSession(this.deps.openStateRuntimeStorage, threadId, () =>
      this.deps.resolveRecoveryIdentity(threadId),
    );
  }

  async generateAndPersistSessionName(threadId: string, task: string) {
    const name = await generateSessionName(task);
    if (name) await persistSessionName(this.deps.openStateRuntimeStorage, threadId, name);
    return name;
  }
}
