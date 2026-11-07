import { modelIdentifier, readModelIdentifier } from '../../model-identifier';
import { AgentError } from '../../storage/types';
import type { Json, OperationRef, ToolContext } from '../index';

export function agentWorkReference(ref: OperationRef): string {
  if (!ref.executionId) throw new AgentError('operation_unverifiable');
  return `aw_${modelIdentifier(ref.executionId)}`;
}
export async function readAgentWorkReference(
  value: Json,
  context: ToolContext,
): Promise<OperationRef> {
  try {
    context.signal.throwIfAborted();
    if (typeof value !== 'string' || !value.startsWith('aw_') || !context.operations.readAgent)
      throw new AgentError('invalid_agent_work_reference');
    const executionId = readModelIdentifier(value.slice(3));
    const execution = await context.getExecution(executionId);
    const ref = execution?.operationRef;
    if (
      !execution ||
      !ref ||
      execution.kind !== 'job' ||
      ref.sessionId !== context.sessionId ||
      ref.extensionId !== 'builtin.task' ||
      ref.executionId !== executionId ||
      !ref.childSessionId
    )
      throw new AgentError('invalid_agent_work_reference');
    const actual = await context.operations.readAgent(ref);
    if (actual.execution.id !== ref.executionId || actual.childSessionId !== ref.childSessionId)
      throw new AgentError('invalid_agent_work_reference');
    return ref;
  } catch {
    context.signal.throwIfAborted();
    // All validation above is read-only. A malformed locator never makes command acceptance unknown.
    throw new AgentError('invalid_agent_work_reference');
  }
}
