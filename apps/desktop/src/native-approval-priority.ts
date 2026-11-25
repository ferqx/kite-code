import type { Execution, Interaction, Run } from '@kite-ai/client';

/** MCP source decisions retain their own form and scope. */
export function isOrdinaryNativeApproval(interaction: Interaction): boolean {
  if (interaction.kind !== 'approval') return false;
  const request = interaction.request;
  const kind =
    request && typeof request === 'object' && !Array.isArray(request) ? request.kind : undefined;
  return kind !== 'mcp_source_approval' && kind !== 'mcp_credential_binding';
}

/** A runless Shell approval belongs to a Run only with its original attached parent. */
export function nativeApprovalPriority({
  storeId,
  session,
  runs,
  executions,
}: {
  storeId: string;
  session: { id: string };
  runs: readonly Run[];
  executions: readonly Execution[];
}) {
  const ownRuns = runs.filter(
    (run) => run.originStoreId === storeId && run.sessionId === session.id,
  );
  const active = ownRuns.find((run) => run.isActive);
  if (!active) return undefined;
  const runById = new Map(ownRuns.map((run) => [run.id, run]));
  const executionById = new Map(executions.map((execution) => [execution.id, execution]));
  const pendingExecutions = executions.filter(
    (execution) =>
      execution.kind !== 'model' &&
      execution.status === 'planned' &&
      execution.authorization?.dispatched !== true &&
      execution.cancelRequestedAt === null &&
      execution.originStoreId === storeId &&
      execution.sessionId === session.id,
  );
  const shellJobs = new Map<string, { execution: Execution; run: Run }>();
  for (const execution of pendingExecutions) {
    if (
      execution.kind !== 'job' ||
      execution.definitionId !== 'shell.command' ||
      execution.runId !== null ||
      execution.cancelWithParent !== true ||
      !execution.parentExecutionId ||
      !execution.rootWorkCommandId ||
      !execution.rootWorkSeq
    )
      continue;
    const parent = executionById.get(execution.parentExecutionId);
    const run = parent?.runId ? runById.get(parent.runId) : undefined;
    if (
      run &&
      parent?.kind === 'tool' &&
      ['shell.execute', 'shell.launch'].includes(parent.definitionId) &&
      parent.originStoreId === storeId &&
      parent.sessionId === session.id &&
      run.rootWorkCommandId === execution.rootWorkCommandId &&
      run.rootWorkSeq === execution.rootWorkSeq &&
      parent.rootWorkCommandId === execution.rootWorkCommandId &&
      parent.rootWorkSeq === execution.rootWorkSeq
    )
      shellJobs.set(execution.id, { execution, run });
  }
  const owner = (card: Interaction) => {
    if (
      card.state !== 'pending' ||
      !isOrdinaryNativeApproval(card) ||
      card.originStoreId !== storeId ||
      card.sessionId !== session.id ||
      card.presentationSessionId !== session.id
    )
      return undefined;
    if (card.runId !== null) return runById.get(card.runId);
    const job = shellJobs.get(card.executionId);
    if (
      job &&
      job.execution.definitionId === card.definitionId &&
      job.execution.definitionVersion === card.definitionVersion
    )
      return job.run;
    return undefined;
  };
  return {
    awaitingApproval:
      (active.status === 'waiting_interaction' &&
        pendingExecutions.some((execution) => execution.runId === active.id)) ||
      Array.from(shellJobs.values()).some(({ run }) => run.id === active.id),
    current: (card: Interaction) => owner(card)?.id === active.id,
    earlier: (card: Interaction) => {
      const run = owner(card);
      return !!run && !run.isActive && run.createdAt <= active.createdAt;
    },
  };
}
