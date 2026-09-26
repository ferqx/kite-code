import type { SubagentResultArtifactAccess } from '@kite-ai/builtin-runtime/subagent';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { RuntimeState } from '../state-runtime';

type Intent = NonNullable<ReturnType<KiteSessionAppServerStorageOwner['readChildSessionIntent']>>;
type Snapshot = Readonly<Record<string, unknown>>;

export interface ChildSessionTaskControlPort {
  /** The caller supplies the exact parent Session observed by this tool call. */
  readonly parentSessionId: string;
  readonly getParentState: () => Readonly<RuntimeState>;
  readonly readIntent: (childThreadId: string) => Intent | null;
  readonly readChildState: (childThreadId: string) => Readonly<RuntimeState> | null;
  readonly artifacts: Pick<SubagentResultArtifactAccess, 'lookup' | 'read'>;
  readonly parentArtifactOwnerKey: string;
  /** Waits for a changed parent revision, resolving immediately if it already changed. */
  readonly waitForParentRevisionChange: (revision: number, signal?: AbortSignal) => Promise<void>;
}

const MAX_WAIT_MS = 60_000;

function notFound(taskId: string): Snapshot {
  return Object.freeze({
    ok: false,
    task_id: taskId,
    status: 'not_found',
    cleanup_confirmed: false,
    error: 'Background sub-agent task is unavailable for this Runtime owner.',
  });
}

function unknown(taskId: string, reason: string): Snapshot {
  return Object.freeze({
    ok: false,
    task_id: taskId,
    status: 'unknown',
    cleanup_confirmed: false,
    error: reason,
  });
}

function sameRef(
  a: {
    readonly artifactId: string;
    readonly kind: string;
    readonly integrityIdentifier: string;
    readonly byteLength: number;
  },
  b: typeof a,
): boolean {
  return (
    a.artifactId === b.artifactId &&
    a.kind === b.kind &&
    a.integrityIdentifier === b.integrityIdentifier &&
    a.byteLength === b.byteLength
  );
}

function waitResult(
  tasks: readonly Snapshot[],
  status: string,
  ok: boolean,
  reason?: string,
): Snapshot {
  return Object.freeze({
    ok,
    status,
    tasks: Object.freeze([...tasks]),
    ...(reason ? { reason } : {}),
  });
}

/** Read-only Task controls for one exact parent/child lineage. No Provider observation occurs. */
export function createChildSessionTaskControl(input: ChildSessionTaskControlPort): Readonly<{
  readTask(taskId: string): Promise<Snapshot>;
  waitTasks(taskIds: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<Snapshot>;
}> {
  const readAt = (parent: Readonly<RuntimeState>, taskId: string): Snapshot => {
    if (!taskId || parent.session.threadId !== input.parentSessionId) return notFound(taskId);
    const matches = Object.entries(parent.capabilities.invocations).filter(
      ([, invocation]) =>
        invocation.subagentProviderLifecycle?.childInvocationId === taskId &&
        invocation.subagentProviderLifecycle.childSession,
    );
    if (matches.length !== 1) return notFound(taskId);
    const [parentInvocationId, invocation] = matches[0]!;
    const lifecycle = invocation.subagentProviderLifecycle!;
    const link = lifecycle.childSession!;
    const intent = input.readIntent(link.childThreadId);
    if (
      !intent ||
      intent.parentSessionId !== input.parentSessionId ||
      intent.parentInvocationId !== parentInvocationId ||
      intent.childInvocationId !== taskId ||
      intent.childThreadId !== link.childThreadId ||
      intent.originRunId !== link.originRunId ||
      intent.originTurnId !== link.originTurnId ||
      intent.originToolCallId !== link.originToolCallId ||
      intent.grantDigest !== link.grantDigest
    )
      return notFound(taskId);
    if (intent.failureReceiptDigest) {
      const failure = link.terminalImport;
      if (
        (failure?.status !== 'failed' && failure?.status !== 'cancelled') ||
        failure.terminalRevision !== 0 ||
        failure.resultRef.integrityIdentifier !== intent.failureReceiptDigest ||
        lifecycle.backgroundResult?.artifactIntegrityIdentifier !== intent.failureReceiptDigest ||
        parent.revision < (lifecycle.backgroundResult?.admissionRevision ?? Number.MAX_SAFE_INTEGER)
      )
        return unknown(taskId, 'Background sub-agent creation failure requires recovery.');
      const owned = input.artifacts.lookup(input.parentArtifactOwnerKey, taskId);
      if (!owned || !sameRef(owned.ref, failure.resultRef))
        return unknown(taskId, 'Background sub-agent failure Artifact is unavailable.');
      try {
        const result = input.artifacts.read(failure.resultRef, taskId);
        if (result.terminalStatus !== failure.status || result.ok !== false)
          return unknown(taskId, 'Background sub-agent failure Artifact conflicts.');
        return Object.freeze({
          ok: false,
          task_id: taskId,
          status: failure.status,
          cancel_requested: failure.status === 'cancelled',
          cleanup_confirmed: true,
          artifact: failure.resultRef,
          result,
        });
      } catch {
        return unknown(taskId, 'Background sub-agent failure Artifact is unavailable.');
      }
    }
    if (!link.terminalImport && link.recoveryDiagnostic)
      return unknown(taskId, 'Background sub-agent requires explicit recovery.');
    if (!link.terminalImport)
      return Object.freeze({
        ok: true,
        task_id: taskId,
        status: 'running',
        cancel_requested: false,
        cleanup_confirmed: false,
      });
    if (
      !intent.parentClaimSettledEventId ||
      !intent.parentClaimSettledRevision ||
      parent.revision < intent.parentClaimSettledRevision
    ) {
      // The Store receipt and Kernel result must both exist before a terminal is public.
      return unknown(taskId, 'Background sub-agent settlement requires recovery.');
    }
    const child = input.readChildState(link.childThreadId);
    const origin = child?.childSessionOrigin;
    const seal = origin?.terminal;
    const imported = link.terminalImport;
    if (
      !child ||
      !origin ||
      !seal ||
      child.session.threadId !== link.childThreadId ||
      origin.parentSessionId !== input.parentSessionId ||
      origin.parentInvocationId !== parentInvocationId ||
      origin.childInvocationId !== taskId ||
      origin.grantDigest !== link.grantDigest ||
      seal.status !== imported.status ||
      seal.sealedRevision !== imported.terminalRevision ||
      !sameRef(seal.resultRef, imported.resultRef)
    )
      return unknown(taskId, 'Background sub-agent terminal proof is unavailable.');
    const owned = input.artifacts.lookup(input.parentArtifactOwnerKey, taskId);
    if (!owned || !sameRef(owned.ref, imported.resultRef))
      return unknown(taskId, 'Background sub-agent result Artifact is unavailable.');
    let result: Readonly<Record<string, unknown>>;
    try {
      result = input.artifacts.read(imported.resultRef, taskId);
    } catch {
      return unknown(taskId, 'Background sub-agent result Artifact is unavailable.');
    }
    if (
      result.terminalStatus !== imported.status ||
      (imported.status === 'completed') !== (result.ok === true)
    )
      return unknown(taskId, 'Background sub-agent result Artifact conflicts with terminal proof.');
    return Object.freeze({
      ok: imported.status !== 'unknown',
      task_id: taskId,
      status: imported.status,
      cancel_requested: seal.cancelRequested,
      cleanup_confirmed: seal.cleanupConfirmed,
      artifact: imported.resultRef,
      result,
    });
  };
  const readTask = async (taskId: string): Promise<Snapshot> =>
    readAt(input.getParentState(), taskId);
  const waitTasks = async (
    taskIds: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Snapshot> => {
    if (
      taskIds.length < 1 ||
      taskIds.length > 8 ||
      new Set(taskIds).size !== taskIds.length ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > MAX_WAIT_MS
    )
      throw new Error('task_wait requires 1–8 distinct task IDs and a timeout within 0–60000 ms.');
    const deadline = Date.now() + timeoutMs;
    const initialParent = input.getParentState();
    const turnId = initialParent.turn?.turnId;
    const initialUserMessages = new Set(
      (initialParent.transcript?.messages ?? [])
        .filter((message) => message.kind === 'user' && message.turnId === turnId)
        .map((message) => message.messageId),
    );
    while (true) {
      const parent = input.getParentState();
      const tasks = taskIds.map((id) => readAt(parent, id));
      const actionable = tasks.find(
        (task) => task.status !== 'running' && task.status !== 'cancelling',
      );
      if (actionable) return waitResult(tasks, String(actionable.status), actionable.ok !== false);
      if (signal?.aborted) return waitResult(tasks, 'cancelled', false, 'run_cancelled');
      if (
        (parent.transcript?.messages ?? []).some(
          (message) =>
            message.kind === 'user' &&
            message.turnId === turnId &&
            !initialUserMessages.has(message.messageId),
        )
      )
        return waitResult(tasks, 'running', true, 'user_input');
      const remaining = deadline - Date.now();
      if (remaining <= 0) return waitResult(tasks, 'timeout', true);
      const waitController = new AbortController();
      const onAbort = () => waitController.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => waitController.abort(), remaining);
      try {
        await input.waitForParentRevisionChange(parent.revision, waitController.signal);
      } catch (error) {
        if (!waitController.signal.aborted) throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  };
  return Object.freeze({ readTask, waitTasks });
}
