import type { SubagentResultArtifactAccess } from '@kite-ai/builtin-runtime/subagent';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { RuntimeEvent, RuntimeState } from '../state-runtime';

type Intent = NonNullable<ReturnType<KiteSessionAppServerStorageOwner['readChildSessionIntent']>>;
type Snapshot = Readonly<Record<string, unknown>>;

export interface ChildSessionTaskControlPort {
  /** The caller supplies the exact parent Session observed by this tool call. */
  readonly parentSessionId: string;
  readonly getParentState: () => Readonly<RuntimeState>;
  readonly readIntent: (childThreadId: string) => Intent | null;
  readonly readChildState: (childThreadId: string) => Readonly<RuntimeState> | null;
  readonly readAuthority: KiteSessionAppServerStorageOwner['readChildExecutionAuthority'];
  readonly nowMs?: () => number;
  /** Committed child events; the control projects only bounded model retry facts. */
  readonly readChildEvents: (childThreadId: string) => readonly Readonly<{ event: RuntimeEvent }>[];
  readonly artifacts: Pick<SubagentResultArtifactAccess, 'lookup' | 'read'>;
  readonly parentArtifactOwnerKey: string;
  /** Exact independent followup Task proof, including historical settled Runs. */
  readonly readFollowupTask?: (taskId: string) => ChildSessionTaskRead | null;
  readonly ownsFollowupTask?: (taskId: string) => boolean;
  /** Waits for a changed parent revision, resolving immediately if it already changed. */
  readonly waitForParentRevisionChange: (revision: number, signal?: AbortSignal) => Promise<void>;
  /** Returns null if the child has no live local coordinator. */
  readonly waitForChildRevisionChange: (
    childThreadId: string,
    revision: number,
    signal?: AbortSignal,
  ) => Promise<void> | null;
}

export type ChildSessionTaskRead = Readonly<{
  snapshot: Snapshot;
  childThreadId?: string;
  childRevision?: number;
  leaseUntilMs?: number;
}>;
type TaskRead = ChildSessionTaskRead;

function activeRetry(
  child: Readonly<RuntimeState>,
  events: readonly Readonly<{ event: RuntimeEvent }>[],
): Snapshot | undefined {
  const active = Object.values(child.modelInvocations ?? {})
    .filter((model) => model.status === 'dispatching')
    .sort((a, b) => b.preparedStateRevision - a.preparedStateRevision)[0];
  if (!active) return undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!.event;
    if (event.type === 'model.responded' && event.invocationId === active.invocationId)
      return undefined;
    if (event.type === 'model.invocation_interrupted' && event.invocationId === active.invocationId)
      return undefined;
    if (event.type !== 'model.retry' || event.invocationId !== active.invocationId) continue;
    return Object.freeze({
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      ...(event.failureClassification
        ? { failureClassification: event.failureClassification }
        : {}),
    });
  }
  return undefined;
}

function terminalOutcome(child: Readonly<RuntimeState>): Snapshot | undefined {
  const outcome = child.terminalOutcome;
  if (!outcome) return undefined;
  return Object.freeze({
    reasonCode: outcome.reasonCode,
    safeRetry: outcome.safeRetry,
    recoveryEntry: outcome.recoveryEntry,
    knownExternalEffects: outcome.knownExternalEffects,
  });
}

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
  ownsTask(taskId: string): boolean;
  readTask(taskId: string): Promise<Snapshot>;
  waitTasks(
    taskIds: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    options?: Readonly<{ wakeOnModelRetry?: boolean }>,
  ): Promise<Snapshot>;
}> {
  const readAt = (parent: Readonly<RuntimeState>, taskId: string): TaskRead => {
    if (!taskId || parent.session.threadId !== input.parentSessionId)
      return { snapshot: notFound(taskId) };
    const matches = Object.entries(parent.capabilities.invocations).filter(
      ([, invocation]) =>
        invocation.subagentProviderLifecycle?.childInvocationId === taskId &&
        invocation.subagentProviderLifecycle.childSession,
    );
    if (matches.length !== 1)
      return input.readFollowupTask?.(taskId) ?? { snapshot: notFound(taskId) };
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
      return { snapshot: notFound(taskId) };
    if (intent.failureReceiptDigest) {
      const failure = link.terminalImport;
      if (
        (failure?.status !== 'failed' && failure?.status !== 'cancelled') ||
        failure.terminalRevision !== 0 ||
        failure.resultRef.integrityIdentifier !== intent.failureReceiptDigest ||
        lifecycle.backgroundResult?.artifactIntegrityIdentifier !== intent.failureReceiptDigest ||
        parent.revision < (lifecycle.backgroundResult?.admissionRevision ?? Number.MAX_SAFE_INTEGER)
      )
        return {
          snapshot: unknown(taskId, 'Background sub-agent creation failure requires recovery.'),
        };
      const owned = input.artifacts.lookup(input.parentArtifactOwnerKey, taskId);
      if (!owned || !sameRef(owned.ref, failure.resultRef))
        return {
          snapshot: unknown(taskId, 'Background sub-agent failure Artifact is unavailable.'),
        };
      try {
        const result = input.artifacts.read(failure.resultRef, taskId);
        if (result.terminalStatus !== failure.status || result.ok !== false)
          return { snapshot: unknown(taskId, 'Background sub-agent failure Artifact conflicts.') };
        return {
          snapshot: Object.freeze({
            ok: false,
            task_id: taskId,
            status: failure.status,
            cancel_requested: failure.status === 'cancelled',
            cleanup_confirmed: true,
            artifact: failure.resultRef,
            result,
          }),
        };
      } catch {
        return {
          snapshot: unknown(taskId, 'Background sub-agent failure Artifact is unavailable.'),
        };
      }
    }
    if (!link.terminalImport && link.recoveryDiagnostic)
      return { snapshot: unknown(taskId, 'Background sub-agent requires explicit recovery.') };
    const child = input.readChildState(link.childThreadId);
    const origin = child?.childSessionOrigin;
    if (
      child &&
      (child.session.threadId !== link.childThreadId ||
        !origin ||
        origin.parentSessionId !== input.parentSessionId ||
        origin.parentInvocationId !== parentInvocationId ||
        origin.childInvocationId !== taskId ||
        origin.grantDigest !== link.grantDigest)
    )
      return { snapshot: unknown(taskId, 'Background sub-agent child identity conflicts.') };
    if (!link.terminalImport) {
      const authority = child
        ? input.readAuthority(input.parentSessionId, link.childThreadId)
        : null;
      const nowMs = input.nowMs?.() ?? Date.now();
      if (
        authority?.status === 'recovery_required' ||
        (authority?.leaseUntilMs !== null &&
          authority?.leaseUntilMs !== undefined &&
          authority.leaseUntilMs <= nowMs)
      )
        return {
          snapshot: unknown(taskId, 'Background sub-agent execution requires recovery.'),
        };
      const retry = child
        ? activeRetry(child, input.readChildEvents(link.childThreadId))
        : undefined;
      return {
        snapshot: Object.freeze({
          ok: true,
          task_id: taskId,
          status: 'running',
          cancel_requested: false,
          cleanup_confirmed: false,
          ...(retry ? { retry } : {}),
        }),
        ...(child ? { childThreadId: link.childThreadId, childRevision: child.revision } : {}),
        ...(authority?.leaseUntilMs !== null && authority?.leaseUntilMs !== undefined
          ? { leaseUntilMs: authority.leaseUntilMs }
          : {}),
      };
    }
    if (
      !intent.parentClaimSettledEventId ||
      !intent.parentClaimSettledRevision ||
      parent.revision < intent.parentClaimSettledRevision
    ) {
      // The Store receipt and Kernel result must both exist before a terminal is public.
      return { snapshot: unknown(taskId, 'Background sub-agent settlement requires recovery.') };
    }
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
      return { snapshot: unknown(taskId, 'Background sub-agent terminal proof is unavailable.') };
    const owned = input.artifacts.lookup(input.parentArtifactOwnerKey, taskId);
    if (!owned || !sameRef(owned.ref, imported.resultRef))
      return { snapshot: unknown(taskId, 'Background sub-agent result Artifact is unavailable.') };
    let result: Readonly<Record<string, unknown>>;
    try {
      result = input.artifacts.read(imported.resultRef, taskId);
    } catch {
      return { snapshot: unknown(taskId, 'Background sub-agent result Artifact is unavailable.') };
    }
    if (
      result.terminalStatus !== imported.status ||
      (imported.status === 'completed') !== (result.ok === true)
    )
      return {
        snapshot: unknown(
          taskId,
          'Background sub-agent result Artifact conflicts with terminal proof.',
        ),
      };
    const outcome = terminalOutcome(child);
    return {
      snapshot: Object.freeze({
        ok: imported.status === 'completed',
        task_id: taskId,
        status: imported.status,
        cancel_requested: seal.cancelRequested,
        cleanup_confirmed: seal.cleanupConfirmed,
        artifact: imported.resultRef,
        result,
        ...(outcome ? { outcome } : {}),
      }),
    };
  };
  const readTask = async (taskId: string): Promise<Snapshot> =>
    readAt(input.getParentState(), taskId).snapshot;
  const waitTasks = async (
    taskIds: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    options?: Readonly<{ wakeOnModelRetry?: boolean }>,
  ): Promise<Snapshot> => {
    if (
      taskIds.length < 1 ||
      new Set(taskIds).size !== taskIds.length ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 0
    )
      throw new Error('task_wait requires distinct task IDs and a non-negative timeout.');
    const nowMs = input.nowMs ?? Date.now;
    const deadline = nowMs() + timeoutMs;
    const initialParent = input.getParentState();
    const turnId = initialParent.turn?.turnId;
    const initialUserMessages = new Set(
      (initialParent.transcript?.messages ?? [])
        .filter((message) => message.kind === 'user' && message.turnId === turnId)
        .map((message) => message.messageId),
    );
    while (true) {
      const parent = input.getParentState();
      const reads = taskIds.map((id) => readAt(parent, id));
      const tasks = reads.map((read) => read.snapshot);
      const actionable = tasks.find(
        (task) => task.status !== 'running' && task.status !== 'cancelling',
      );
      if (actionable)
        return waitResult(tasks, String(actionable.status), actionable.status !== 'not_found');
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
      if (options?.wakeOnModelRetry !== false && tasks.some((task) => task.retry))
        return waitResult(tasks, 'running', true, 'model_retry');
      const now = nowMs();
      const remaining = deadline - now;
      if (remaining <= 0) return waitResult(tasks, 'timeout', true);
      const nextLeaseExpiry = Math.min(...reads.map((read) => read.leaseUntilMs ?? Infinity));
      const waitMs = Math.max(1, Math.min(remaining, nextLeaseExpiry - now));
      const waitController = new AbortController();
      const onAbort = () => waitController.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => waitController.abort(), waitMs);
      try {
        const waits = [input.waitForParentRevisionChange(parent.revision, waitController.signal)];
        for (const read of reads) {
          if (!read.childThreadId || read.childRevision === undefined) continue;
          const childWait = input.waitForChildRevisionChange(
            read.childThreadId,
            read.childRevision,
            waitController.signal,
          );
          if (childWait) waits.push(childWait);
        }
        await Promise.race(waits);
      } catch (error) {
        if (!waitController.signal.aborted) throw error;
      } finally {
        waitController.abort();
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  };
  return Object.freeze({
    ownsTask: (taskId: string) => {
      const parent = input.getParentState();
      return (
        !!taskId &&
        parent.session.threadId === input.parentSessionId &&
        (Object.values(parent.capabilities.invocations).some(
          (invocation) =>
            invocation.subagentProviderLifecycle?.childInvocationId === taskId &&
            !!invocation.subagentProviderLifecycle.childSession,
        ) ||
          input.ownsFollowupTask?.(taskId) === true)
      );
    },
    readTask,
    waitTasks,
  });
}
