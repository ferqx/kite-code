import { isAbsolute } from 'node:path';
import type { OperationRef, ToolContext, ToolResult } from '../../extensions';
import { canonicalJson } from '../../json';
import { jsonObject } from './protocol';

export type WorktreeCreationNotification =
  | { readonly status: 'queued'; readonly accepted: true }
  | { readonly status: 'not_applicable' }
  | {
      readonly status: 'failed';
      readonly accepted: false;
      readonly code: 'worktree_notification_unavailable';
    }
  | {
      readonly status: 'outcome_unknown';
      readonly accepted: null;
      readonly code: 'worktree_notification_unavailable';
    };

const notApplicable = { status: 'not_applicable' } as const;
const unavailable = {
  status: 'failed',
  accepted: false,
  code: 'worktree_notification_unavailable',
} as const;
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Notify from the original persisted success only. Delivery never changes the Git outcome.
 * The existing mail identity is bound to this Tool Execution, so an original resume can
 * observe/retry this same body; a different Execution replaying its result cannot send it.
 */
export async function notifyWorktreeCreated(
  context: ToolContext,
  result: ToolResult,
): Promise<WorktreeCreationNotification> {
  const details = result.details;
  if (
    result.outcome !== 'succeeded' ||
    !jsonObject(details) ||
    details.action !== 'create' ||
    details.mutation !== 'completed' ||
    details.cwdChanged !== false ||
    !jsonObject(details.operation) ||
    details.operation.ownerExecutionId !== context.executionId
  )
    return notApplicable;
  const ref = details.operation.ref;
  if (
    typeof details.key !== 'string' ||
    !details.key ||
    typeof details.path !== 'string' ||
    !isAbsolute(details.path) ||
    typeof details.head !== 'string' ||
    !oid.test(details.head) ||
    typeof details.baseCommit !== 'string' ||
    !oid.test(details.baseCommit) ||
    (details.branch !== null &&
      (typeof details.branch !== 'string' || !details.branch.startsWith('refs/heads/'))) ||
    details.detached !== (details.branch === null) ||
    typeof details.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(details.observedAt)) ||
    !jsonObject(ref) ||
    ref.extensionId !== 'builtin.shell' ||
    ref.sessionId !== context.sessionId ||
    typeof ref.originStoreId !== 'string' ||
    !ref.originStoreId ||
    typeof ref.executionId !== 'string' ||
    !ref.executionId ||
    typeof ref.commandId !== 'string' ||
    !ref.commandId ||
    typeof ref.key !== 'string' ||
    !ref.key
  )
    return unavailable;
  try {
    const owner = await context.getExecution(context.executionId);
    const job = await context.operations.get(ref as unknown as OperationRef);
    if (
      owner?.id !== context.executionId ||
      owner.sessionId !== context.sessionId ||
      owner.kind !== 'tool' ||
      owner.definitionId !== 'git.worktree' ||
      owner.definitionVersion !== '1' ||
      owner.originStoreId !== ref.originStoreId ||
      job?.id !== ref.executionId ||
      job.sessionId !== context.sessionId ||
      job.parentExecutionId !== context.executionId ||
      job.originStoreId !== owner.originStoreId ||
      job.kind !== 'job' ||
      job.definitionId !== 'shell.command' ||
      job.definitionVersion !== '1' ||
      job.status !== 'succeeded' ||
      !context.readExecutionGroupSafety ||
      !context.operations.readAgentMessageTarget ||
      !context.operations.sendStableAgentMessage
    )
      return unavailable;
    const group = await context.readExecutionGroupSafety();
    if (
      group.originStoreId !== owner.originStoreId ||
      group.sessionId !== context.sessionId ||
      typeof group.rootSessionId !== 'string' ||
      !group.rootSessionId
    )
      return unavailable;
    if (group.rootSessionId === context.sessionId) return notApplicable;
    // Read only the actual root relation; quiescence is not a delivery condition.
    // A broken child carrier is unavailable, rather than being mistaken for a root.
    await context.operations.readAgentMessageTarget('parent');
    const content =
      'Git worktree created (verified tool result; no additional authorization).\n' +
      canonicalJson({
        kind: 'git_worktree_created',
        action: 'create',
        key: details.key,
        path: details.path,
        head: details.head,
        branch: details.branch,
        detached: details.detached,
        baseCommit: details.baseCommit,
        cwdChanged: false,
        observedAt: details.observedAt,
        source: {
          sessionId: context.sessionId,
          executionId: context.executionId,
          operationRef: ref,
        },
      });
    try {
      await context.operations.sendStableAgentMessage('parent', content);
      return { status: 'queued', accepted: true };
    } catch {
      // A queue failure can follow acceptance. Only the original mail identity may recover it.
      return {
        status: 'outcome_unknown',
        accepted: null,
        code: 'worktree_notification_unavailable',
      };
    }
  } catch {
    // Verification/target preflight failed before invoking the queue. Git remains successful.
    return unavailable;
  }
}
