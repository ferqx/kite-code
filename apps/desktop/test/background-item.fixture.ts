import type { BackgroundExecutionItem } from '@kite-ai/client';

export function backgroundItem(index = 1, child = false): BackgroundExecutionItem {
  const session = {
    id: 'root',
    workspaceId: 'w',
    parentSessionId: null,
    rootSessionId: 'root',
    title: 'Original',
    controlRevision: '1',
    contextSelectionId: 'context',
    nextSeq: '300',
    deletedAt: null,
    ownerInstanceId: 'instance',
    ownerGeneration: '1',
  };
  const run = {
    id: 'parent-run',
    sessionId: 'root',
    originStoreId: 'store',
    originCommandId: 'start',
    rootWorkCommandId: 'start',
    rootWorkSeq: '1',
    contextSelectionId: 'context',
    status: 'waiting_execution' as const,
    isActive: true,
    waitingForResults: child ? [`job-${index}`] : [],
    reason: 'required_results',
    createdAt: 1,
    finishedAt: null,
    deadlineAt: null,
  };
  return {
    seq: String(index),
    session,
    rootSession: session,
    run,
    childSession: child
      ? { ...session, id: 'child', parentSessionId: 'root', nextSeq: '210' }
      : null,
    childRun: child
      ? {
          ...run,
          id: 'original-child-run',
          sessionId: 'child',
          originCommandId: `child-start-job-${index}`,
          status: 'running',
        }
      : null,
    execution: {
      id: `job-${index}`,
      sessionId: 'root',
      rootSessionId: 'root',
      runId: null,
      originCommandId: `origin-${index}`,
      originStoreId: 'store',
      rootWorkCommandId: 'start',
      rootWorkSeq: '1',
      parentExecutionId: child ? 'parent-tool' : null,
      childSessionId: child ? 'child' : null,
      cancelWithParent: false,
      stepId: 'step',
      callId: `call-${index}`,
      attempt: 1,
      kind: 'job',
      definitionId: child ? 'child.agent' : 'shell.command',
      definitionVersion: '1',
      status: 'running',
      ownerGeneration: '1',
      cancelRequested: false,
      cancelRequestedAt: null,
      resultRevision: '0',
      delivery: null,
      deliveryReason: null,
      deliveryTargetSessionId: null,
      contextSelectionId: 'context',
    },
  };
}
