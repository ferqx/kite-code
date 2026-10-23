import type { BackgroundExecutionItem, Message } from '@kite-ai/client';
import type { ToolActivity } from '@kite-ai/ui/desktop';
import type { ComponentProps } from 'react';
import type { NativeToolMessageFact } from './tool-messages-bridge';

type ChildAgent = NonNullable<ComponentProps<typeof ToolActivity>['childAgent']>;
export type NativeAgentActivity = {
  sourceTool: NonNullable<BackgroundExecutionItem['sourceTool']>;
  parentRunId: string;
  executionId: string;
  sessionId: string;
  parentSessionId: string;
  storeId: string;
  childAgent: ChildAgent;
};

/** Reuse the environment's verified directory; these facts grant no execution authority. */
export function nativeAgentActivities(
  items: readonly BackgroundExecutionItem[],
  storeId: string | undefined,
  parentSessionId: string | undefined,
): NativeAgentActivity[] {
  if (!storeId || !parentSessionId) return [];
  return items.flatMap((item) => {
    const { execution, sourceTool, childSession, childRun, run, session, rootSession } = item;
    if (
      !sourceTool ||
      !['task.spawn', 'task.follow_up'].includes(sourceTool.definitionId) ||
      sourceTool.definitionVersion !== '1' ||
      sourceTool.id !== execution.parentExecutionId ||
      execution.originStoreId !== storeId ||
      execution.sessionId !== parentSessionId ||
      session.id !== parentSessionId ||
      execution.rootSessionId !== rootSession.id ||
      session.rootSessionId !== rootSession.id ||
      !childSession ||
      childSession.deletedAt !== null ||
      childSession.id !== execution.childSessionId ||
      childSession.parentSessionId !== parentSessionId ||
      childSession.rootSessionId !== rootSession.id ||
      childSession.workspaceId !== session.workspaceId ||
      !run ||
      run.sessionId !== parentSessionId ||
      run.originStoreId !== storeId ||
      run.rootWorkCommandId !== execution.rootWorkCommandId ||
      run.rootWorkSeq !== execution.rootWorkSeq ||
      (childRun &&
        (childRun.sessionId !== childSession.id ||
          childRun.originStoreId !== storeId ||
          childRun.originCommandId !== `child-start-${execution.id}` ||
          childRun.rootWorkCommandId !== execution.rootWorkCommandId ||
          childRun.rootWorkSeq !== execution.rootWorkSeq))
    )
      return [];
    return [
      {
        sourceTool,
        parentRunId: run.id,
        executionId: execution.id,
        sessionId: childSession.id,
        parentSessionId,
        storeId,
        childAgent: {
          identity: JSON.stringify([storeId, childSession.id]),
          name: childSession.title || '子 Agent',
        },
      },
    ];
  });
}

/** A successful Tool admission and its exact carrier must agree before changing the row. */
export function nativeAgentActivityForTool(
  activities: readonly NativeAgentActivity[],
  message: Message | undefined,
  fact: NativeToolMessageFact | undefined,
): NativeAgentActivity | undefined {
  if (
    !message ||
    !fact ||
    fact.status !== 'succeeded' ||
    message.role !== 'tool' ||
    message.status !== 'complete' ||
    message.originMessage ||
    message.id !== fact.messageId ||
    message.sourceIds?.length !== 1 ||
    message.sourceIds[0] !== fact.executionId
  )
    return;
  const matches = activities.filter(
    (activity) =>
      activity.sourceTool.id === fact.executionId &&
      activity.sourceTool.definitionId === fact.definitionId &&
      activity.sourceTool.definitionVersion === fact.definitionVersion &&
      activity.parentSessionId === message.sessionId &&
      activity.parentRunId === message.runId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
