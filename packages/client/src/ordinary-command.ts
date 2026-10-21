import type { Command, Run } from './generated/api';
import type { AgentClient } from './index';

export type OrdinaryCommandObservation = {
  runId: string;
  executionId: string;
  messageId: string;
  answer: string | null;
  clarification: string | null;
};
export type OrdinaryCommandApplication = {
  run: Run | null;
  sourceCommandId: string;
  observation: OrdinaryCommandObservation | null;
};
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Resolve saved ordinary input facts; this never submits or replays an input. */
export async function readOrdinaryCommandApplication(
  client: Pick<AgentClient, 'getCommand' | 'getRun' | 'getExecution'>,
  command: Command,
  options: { signal?: AbortSignal; targetRunId?: string } = {},
): Promise<OrdinaryCommandApplication | null> {
  if (!['run.start', 'input.follow_up', 'input.steer'].includes(command.kind))
    throw Error('ordinary_command_kind_mismatch');
  const receipt = object(command.receipt);
  const unresolved = command.status === 'accepted' && receipt?.outcome === 'human_input_unresolved';
  if (command.status !== 'applied' && !unresolved) return null;
  if (!receipt) throw Error('ordinary_command_receipt_unavailable');
  if (
    unresolved &&
    (receipt.runId !== null ||
      receipt.businessCommandId !== null ||
      !text(receipt.humanInputCommandId) ||
      !text(receipt.decisionCommandId))
  )
    throw Error('ordinary_command_observation_unavailable');
  const observed = unresolved || receipt.outcome === 'human_input_observed';
  const observation = observed ? object(receipt.observation) : null;
  if (observed && (unresolved || receipt.observation !== undefined) && !observation)
    throw Error('ordinary_command_observation_unavailable');
  if (observed && !observation)
    return { run: null, sourceCommandId: command.id, observation: null };
  const runId = observed ? observation?.runId : receipt.runId;
  if (!text(runId)) throw Error('ordinary_command_run_unavailable');
  const run = await client.getRun(runId, options);
  if (
    run.id !== runId ||
    run.originStoreId !== command.originStoreId ||
    run.sessionId !== command.sessionId
  )
    throw Error('ordinary_command_identity_mismatch');
  if (observed) {
    if (
      !observation ||
      !text(observation.executionId) ||
      !text(observation.messageId) ||
      !(observation.answer === null || typeof observation.answer === 'string') ||
      !(observation.clarification === null || typeof observation.clarification === 'string')
    )
      throw Error('ordinary_command_observation_unavailable');
    const execution = await client.getExecution(observation.executionId, options);
    if (
      execution.id !== observation.executionId ||
      execution.kind !== 'model' ||
      execution.status !== 'succeeded' ||
      execution.runId !== runId ||
      execution.sessionId !== command.sessionId ||
      execution.originStoreId !== command.originStoreId
    )
      throw Error('ordinary_command_observation_mismatch');
    return {
      run,
      sourceCommandId: run.originCommandId,
      observation: observation as OrdinaryCommandObservation,
    };
  }
  let sourceCommandId = command.id;
  if (receipt.outcome === 'human_input_applied') {
    if (!text(receipt.businessCommandId) || receipt.sourceCommandId !== receipt.businessCommandId)
      throw Error('ordinary_command_business_mismatch');
    const business = await client.getCommand(receipt.businessCommandId, options);
    const applied = object(business.receipt);
    if (
      business.id !== receipt.businessCommandId ||
      business.status !== 'applied' ||
      !['run.start', 'input.follow_up', 'input.steer'].includes(business.kind) ||
      business.originStoreId !== command.originStoreId ||
      business.sessionId !== command.sessionId ||
      business.subjectId !== command.subjectId ||
      applied?.runId !== runId
    )
      throw Error('ordinary_command_business_mismatch');
    sourceCommandId = business.id;
    // An active supplement belongs to the original Run; a new business Run owns its origin.
    if (business.kind !== 'input.steer' && run.originCommandId !== business.id)
      throw Error('ordinary_command_origin_mismatch');
  } else if (command.kind === 'input.steer') {
    if (options.targetRunId !== runId) throw Error('ordinary_command_origin_mismatch');
  } else if (run.originCommandId !== command.id) throw Error('ordinary_command_origin_mismatch');
  // A human decision may admit an independent work after the observed Run.
  // The original technical steer target stays in the public input; the sealed
  // business receipt, rather than that old target, binds the actual new Run.
  if (
    receipt.outcome !== 'human_input_applied' &&
    options.targetRunId &&
    options.targetRunId !== runId
  )
    throw Error('ordinary_command_target_mismatch');
  return { run, sourceCommandId, observation: null };
}
