import type { AgentClient, ModelOutputSnapshot, SessionView } from '@kite-ai/client';

/** One finite current Model prefix. AgentClient verifies the public body hash before returning it. */
export async function readTuiLiveOutput(
  client: Pick<AgentClient, 'getModelOutput'>,
  view: SessionView,
  storeId: string,
  signal: AbortSignal,
): Promise<ModelOutputSnapshot | undefined> {
  signal.throwIfAborted();
  if (view.storeId !== storeId) throw Error('tui_live_output_store_mismatch');
  const active = view.runs.filter(
    (run) => run.isActive && run.sessionId === view.session.id && run.originStoreId === storeId,
  );
  if (active.length !== 1) return undefined;
  const run = active[0]!;
  const models = view.executions.filter(
    (execution) =>
      execution.kind === 'model' &&
      execution.originStoreId === storeId &&
      execution.sessionId === view.session.id &&
      execution.runId === run.id &&
      ['dispatching', 'running'].includes(execution.status),
  );
  // Ambiguity is unavailable, never a guess at the most recent same-name model.
  if (models.length !== 1) return undefined;
  const execution = models[0]!;
  const output = await client.getModelOutput(view.session.id, execution.id, {
    expectedStoreId: storeId,
    signal,
  });
  signal.throwIfAborted();
  if (
    output.storeId !== storeId ||
    output.sessionId !== execution.sessionId ||
    output.runId !== run.id ||
    output.rootSessionId !== (view.session.rootSessionId ?? view.session.id) ||
    output.executionId !== execution.id ||
    output.originCommandId !== run.originCommandId ||
    output.status === 'succeeded' ||
    output.output.complete ||
    output.output.toolCalls.length !== 0 ||
    !['dispatching', 'running'].includes(output.status)
  )
    throw Error('tui_live_output_identity_mismatch');
  return output;
}
