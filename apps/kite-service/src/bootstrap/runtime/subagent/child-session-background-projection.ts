import { createHash } from 'node:crypto';
import type { RuntimeBackgroundExecutionProjection } from '@kite-ai/runtime-contract';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { RuntimeState } from '../state-runtime';

type Intent = NonNullable<ReturnType<KiteSessionAppServerStorageOwner['readChildSessionIntent']>>;

/** Parent-scoped child cards derived only from Store intent, State and execution authority. */
export function projectIndependentChildExecutions(input: {
  readonly parentState: Readonly<RuntimeState>;
  readonly readIntent: (childThreadId: string) => Intent | null;
  readonly readChildState: (childThreadId: string) => Readonly<RuntimeState> | null;
  readonly readAuthority: KiteSessionAppServerStorageOwner['readChildExecutionAuthority'];
  readonly nowMs: number;
}): Readonly<{
  aggregateGeneration: string;
  watermark: number;
  executions: readonly RuntimeBackgroundExecutionProjection[];
}> {
  const parentSessionId = input.parentState.session.threadId;
  const executions: RuntimeBackgroundExecutionProjection[] = [];
  const generations: string[] = [];
  let watermark = 0;
  for (const [invocationId, invocation] of Object.entries(
    input.parentState.capabilities.invocations,
  )) {
    const lifecycle = invocation.subagentProviderLifecycle;
    const link = lifecycle?.childSession;
    if (!link || !lifecycle) continue;
    const intent = input.readIntent(link.childThreadId);
    if (
      !intent ||
      intent.parentSessionId !== parentSessionId ||
      intent.parentInvocationId !== invocationId ||
      intent.childInvocationId !== lifecycle.childInvocationId ||
      intent.childThreadId !== link.childThreadId ||
      intent.originToolCallId !== link.originToolCallId ||
      intent.grantDigest !== link.grantDigest
    )
      continue;
    const child = input.readChildState(link.childThreadId);
    const authority = child ? input.readAuthority(parentSessionId, link.childThreadId) : null;
    const imported = link.terminalImport;
    const status: RuntimeBackgroundExecutionProjection['status'] = imported
      ? imported.status === 'completed'
        ? 'completed'
        : imported.status === 'cancelled'
          ? 'cancelled'
          : imported.status === 'unknown' ||
              imported.status === 'interrupted' ||
              imported.status === 'suspended'
            ? 'unavailable'
            : 'failed'
      : intent.failureReceiptDigest
        ? 'failed'
        : link.recoveryDiagnostic ||
            authority?.status === 'recovery_required' ||
            (authority?.leaseUntilMs !== null &&
              authority?.leaseUntilMs !== undefined &&
              authority.leaseUntilMs <= input.nowMs)
          ? 'unavailable'
          : 'running';
    const ownerGeneration = authority
      ? `child:${authority.controllerGeneration}`
      : `accepted:${intent.toolEventId}`;
    const revision = child?.revision ?? intent.toolEventRevision;
    const args = input.parentState.tools.calls[link.originToolCallId]?.args;
    const displayName = args && typeof args === 'object' && 'name' in args ? args.name : undefined;
    const item: RuntimeBackgroundExecutionProjection = Object.freeze({
      executionId: lifecycle.childInvocationId,
      ...(typeof displayName === 'string' && displayName.length > 0
        ? { displayName: displayName.slice(0, 120) }
        : {}),
      sessionId: parentSessionId,
      sessionRevision: input.parentState.revision,
      kind: 'subagent',
      status,
      ownerGeneration,
      revision,
      cleanupConfirmed: imported
        ? (child?.childSessionOrigin?.terminal?.cleanupConfirmed ?? !!intent.failureReceiptDigest)
        : !!intent.failureReceiptDigest,
    });
    executions.push(item);
    generations.push(`${item.executionId}:${ownerGeneration}`);
    watermark = Math.min(
      Number.MAX_SAFE_INTEGER,
      watermark + revision + (authority?.revision ?? 0),
    );
  }
  executions.sort((a, b) => a.executionId.localeCompare(b.executionId));
  generations.sort();
  return Object.freeze({
    aggregateGeneration: `independent:${createHash('sha256').update(JSON.stringify(generations)).digest('hex')}`,
    watermark,
    executions: Object.freeze(executions),
  });
}
