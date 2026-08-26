import {
  previewFilesToCheckpoint,
  restoreFilesToCheckpoint,
} from '#app/bootstrap/runtime/file-checkpoints';
import { loadSession } from '#app/bootstrap/runtime/session-persistence';
import type {
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from '#app/bootstrap/runtime/state-runtime';

export type RewindRequestedEvent = Extract<RuntimeEvent, { type: 'session.rewind_requested' }>;
export type RewindTerminalEvent = Extract<
  RuntimeEvent,
  { type: 'session.rewind_completed' | 'session.rewind_failed' }
>;

export interface RewindExecutionResult {
  readonly targetThreadId: string;
  readonly recoveredData: Awaited<ReturnType<typeof loadSession>>;
  readonly fileOutcome: ReturnType<typeof restoreFilesToCheckpoint> | null;
}

export interface RewindRecoveryResult {
  readonly executed: number;
  readonly completed: number;
  readonly failed: number;
  readonly results: readonly RewindExecutionResult[];
}

export type RewindSettlement =
  | {
      readonly status: 'completed';
      readonly result: RewindExecutionResult;
      readonly terminal: Extract<RewindTerminalEvent, { type: 'session.rewind_completed' }>;
    }
  | {
      readonly status: 'failed';
      readonly terminal: Extract<RewindTerminalEvent, { type: 'session.rewind_failed' }>;
    };

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

  /** Checkpoint admission is separate from command planning and effect replay. */
  isCheckpointAvailable(threadId: string, snapshotId: string): boolean {
    const store = this.deps.openStateRuntimeStorage(threadId);
    try {
      return this.hasCheckpoint(store, threadId, snapshotId);
    } finally {
      store.close();
    }
  }

  /**
   * Find the exact unmatched requests in strict durable history. Receipt
   * replay never calls this; only the post-commit/restart owner does.
   */
  pendingIntents(threadId: string): readonly RewindRequestedEvent[] {
    const store = this.deps.openStateRuntimeStorage(threadId);
    try {
      return findPendingRewindIntents(
        store.sessions.loadEventsStrict(threadId).map((entry) => entry.event),
      );
    } finally {
      store.close();
    }
  }

  /**
   * Execute one already-persisted request. File restoration intentionally
   * computes its desired state before writing, so a crash retry does zero
   * writes once the workspace already matches the checkpoint. Conversation
   * forks use the command-derived target and only allocate a private recovery
   * identity in this effect, immediately before the atomic Store fork.
   */
  async executeIntent(input: {
    readonly intent: RewindRequestedEvent;
    readonly workspace: string;
  }): Promise<RewindExecutionResult> {
    const { intent } = input;
    const store = this.deps.openStateRuntimeStorage(intent.sourceSessionId);
    try {
      if (!this.hasCheckpoint(store, intent.sourceSessionId, intent.checkpointId)) {
        throw new Error('Recovery point is unavailable or corrupted.');
      }
      const restoresConversation =
        intent.scope === 'conversation_and_workspace' || intent.scope === 'conversation_only';
      const restoresCode =
        intent.scope === 'conversation_and_workspace' || intent.scope === 'code_only';
      let recoveredData: Awaited<ReturnType<typeof loadSession>> = null;
      if (restoresConversation) {
        if (!this.targetExists(store, intent.targetSessionId)) {
          const recoveryIdentity = this.deps.allocateRecoveryIdentity();
          if (
            !store.checkpoints.forkSession(
              intent.sourceSessionId,
              intent.checkpointId,
              intent.targetSessionId,
              recoveryIdentity,
            )
          ) {
            throw new Error('Recovery point is unavailable or corrupted.');
          }
        }
        recoveredData = await loadSession(
          this.deps.openStateRuntimeStorage,
          intent.targetSessionId,
          this.deps.resolveRecoveryIdentity(intent.targetSessionId),
        );
        if (!recoveredData) throw new Error('Recovered session could not be loaded.');
      }
      const fileOutcome = restoresCode
        ? restoreFilesToCheckpoint(
            store,
            intent.sourceSessionId,
            intent.checkpointId,
            input.workspace,
          )
        : null;
      return { targetThreadId: intent.targetSessionId, recoveredData, fileOutcome };
    } finally {
      store.close();
    }
  }

  /** Execute all unmatched history requests and append exactly one terminal per request. */
  async recoverPendingIntents(input: {
    readonly sourceThreadId: string;
    readonly workspace: string;
    readonly persistTerminal: (event: RewindTerminalEvent) => Promise<void> | void;
  }): Promise<RewindRecoveryResult> {
    const results: RewindExecutionResult[] = [];
    let completed = 0;
    let failed = 0;
    const intents = this.pendingIntents(input.sourceThreadId);
    for (const intent of intents) {
      const settled = await this.executeCommittedIntent({
        intent,
        workspace: input.workspace,
        persistTerminal: input.persistTerminal,
      });
      if (settled.status === 'completed') {
        results.push(settled.result);
        completed++;
      } else {
        failed++;
      }
    }
    return Object.freeze({
      executed: intents.length,
      completed,
      failed,
      results: Object.freeze(results),
    });
  }

  /** Settle one committed request; a terminal persist failure remains unmatched for restart retry. */
  async executeCommittedIntent(input: {
    readonly intent: RewindRequestedEvent;
    readonly workspace: string;
    readonly persistTerminal: (event: RewindTerminalEvent) => Promise<void> | void;
  }): Promise<RewindSettlement> {
    let result: RewindExecutionResult;
    try {
      result = await this.executeIntent({ intent: input.intent, workspace: input.workspace });
    } catch (error) {
      const terminal = failedRewindEvent(input.intent, error);
      await input.persistTerminal(terminal);
      return Object.freeze({ status: 'failed', terminal });
    }
    const terminal = completedRewindEvent(input.intent);
    await input.persistTerminal(terminal);
    return Object.freeze({ status: 'completed', result, terminal });
  }

  private hasCheckpoint(store: StateRuntimeStorage, threadId: string, snapshotId: string): boolean {
    try {
      if (!store.checkpoints.getNamedSnapshotEntry(threadId, snapshotId)) return false;
      const snapshot = store.checkpoints.loadNamedSnapshot(threadId, snapshotId);
      return typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot);
    } catch {
      return false;
    }
  }

  private targetExists(store: StateRuntimeStorage, targetSessionId: string): boolean {
    const snapshot = store.sessions.loadSnapshotRecord<RuntimeState>(targetSessionId);
    const eventPosition = store.sessions.getLastEventPosition(targetSessionId);
    if (!snapshot && eventPosition === 0) return false;
    const recoveryIdentity = store.recoveryIdentities.read(targetSessionId);
    if (
      !snapshot ||
      snapshot.state.session.threadId !== targetSessionId ||
      !/^[a-f0-9]{64}$/u.test(recoveryIdentity ?? '')
    ) {
      throw new Error('Recovered rewind target exists but has invalid durable identity.');
    }
    return true;
  }
}

/** Strict history reducer: terminal facts end only their exact matching intent. */
export function findPendingRewindIntents(
  events: readonly RuntimeEvent[],
): readonly RewindRequestedEvent[] {
  const pending = new Map<string, RewindRequestedEvent>();
  for (const event of events) {
    if (event.type === 'session.rewind_requested') {
      if (!pending.has(event.rewindId)) pending.set(event.rewindId, event);
      continue;
    }
    if (event.type !== 'session.rewind_completed' && event.type !== 'session.rewind_failed')
      continue;
    const request = pending.get(event.rewindId);
    if (request && sameRewindIdentity(request, event)) pending.delete(event.rewindId);
  }
  return Object.freeze([...pending.values()]);
}

function completedRewindEvent(
  intent: RewindRequestedEvent,
): Extract<RewindTerminalEvent, { type: 'session.rewind_completed' }> {
  return { ...intent, type: 'session.rewind_completed' };
}

function failedRewindEvent(
  intent: RewindRequestedEvent,
  error: unknown,
): Extract<RewindTerminalEvent, { type: 'session.rewind_failed' }> {
  return {
    ...intent,
    type: 'session.rewind_failed',
    failureCode:
      error instanceof Error && error.message === 'Recovery point is unavailable or corrupted.'
        ? 'checkpoint_unavailable'
        : 'execution_failed',
  };
}

function sameRewindIdentity(
  requested: RewindRequestedEvent,
  terminal: RewindTerminalEvent,
): boolean {
  return (
    requested.commandId === terminal.commandId &&
    requested.sourceSessionId === terminal.sourceSessionId &&
    requested.targetSessionId === terminal.targetSessionId &&
    requested.checkpointId === terminal.checkpointId &&
    requested.scope === terminal.scope
  );
}
