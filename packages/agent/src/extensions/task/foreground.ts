import { AgentError } from '../../storage/types';
import type { Json, OperationRef, PublicExecution, ToolContext, ToolResult } from '../index';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'outcome_unknown']);
function checked(ref: OperationRef, execution: PublicExecution | null): PublicExecution {
  if (
    !execution ||
    execution.id !== ref.executionId ||
    execution.sessionId !== ref.sessionId ||
    execution.originStoreId !== ref.originStoreId ||
    !terminal.has(execution.status)
  )
    throw new AgentError('task_result_unverifiable');
  return execution;
}
/** Wait for the actual same-ref carrier. Creation/acceptance never becomes a child summary. */
export async function completeForegroundTask(
  ref: OperationRef,
  context: ToolContext,
): Promise<ToolResult> {
  let execution: PublicExecution;
  try {
    for (;;) {
      context.signal.throwIfAborted();
      try {
        execution = checked(
          ref,
          await context.operations.wait(ref, { signal: context.signal, timeoutMs: 30000 }),
        );
        break;
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== 'wait_timeout') throw error;
      }
    }
  } catch (error) {
    if (!context.signal.aborted) throw error;
    // Attached child cancellation already belongs to the original Runtime domain.
    // Its wait combines that signal, so observe only the exact accepted ref until the
    // carrier is terminal. A timeout remains unknown rather than fabricating stopped.
    const deadline = performance.now() + 30000;
    for (;;) {
      const observed = await context.operations.get(ref);
      if (observed && terminal.has(observed.status)) {
        execution = checked(ref, observed);
        const body = execution.result;
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          body.outcome !== execution.status ||
          typeof body.content !== 'string'
        )
          return {
            outcome: 'outcome_unknown',
            content: 'task_cancellation_unconfirmed',
            details: { ref: ref as unknown as Json, childTerminal: false },
          };
        return {
          // Preserve the exact carrier terminal outcome if abort races completion.
          outcome: execution.status as ToolResult['outcome'],
          content: execution.status === 'cancelled' ? 'foreground_task_cancelled' : body.content,
          details: {
            ref: ref as unknown as Json,
            execution: execution as unknown as Json,
            childTerminal: true,
          },
        };
      }
      if (performance.now() >= deadline)
        return {
          outcome: 'outcome_unknown',
          content: 'task_cancellation_unconfirmed',
          details: { ref: ref as unknown as Json, childTerminal: false },
        };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const body = execution.result;
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    typeof body.content !== 'string' ||
    body.outcome !== execution.status
  )
    throw new AgentError('task_result_unverifiable');
  const result = body as unknown as ToolResult;
  const details = {
    ref: ref as unknown as Json,
    execution: execution as unknown as Json,
    childTerminal: true,
  };
  if (['failed', 'cancelled'].includes(result.outcome) && result.content === 'approval_denied') {
    const source = result.details;
    const agent = await context.operations.readAgent(ref);
    const childRun = agent.run;
    if (
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      source.reason !== 'approval_denied' ||
      !['failed', 'cancelled'].includes(String(source.status)) ||
      source.childSessionId !== ref.childSessionId ||
      agent.childSessionId !== ref.childSessionId ||
      !childRun ||
      source.runId !== childRun.id ||
      source.status !== childRun.status ||
      childRun.isActive ||
      agent.execution.id !== execution.id ||
      agent.execution.resultRevision !== execution.resultRevision
    )
      return { outcome: 'failed', content: 'child_failure_unverified', details };
    return {
      outcome: 'failed',
      content: 'approval_denied',
      details: {
        ...details,
        childFailure: {
          reason: source.reason,
          childSessionId: agent.childSessionId,
          runId: childRun.id,
          status: childRun.status,
        },
      },
    };
  }
  if (!result.modelContent) return { outcome: result.outcome, content: result.content, details };
  const source = result.modelContent;
  if (
    !context.artifacts ||
    source.kind !== 'artifact' ||
    source.encoding !== 'utf-8' ||
    source.reference.scope?.kind !== 'execution' ||
    source.reference.scope.id !== execution.id
  )
    throw new AgentError('task_result_unverifiable');
  const bytes = await context.artifacts.read(source.reference);
  if (String(bytes.byteLength) !== source.reference.size)
    throw new AgentError('task_result_unverifiable');
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AgentError('task_result_encoding_invalid');
  }
  context.signal.throwIfAborted();
  const reference = await context.artifacts.publish({
    key: 'task.execute.body',
    content: bytes,
    mediaType: source.reference.mediaType,
  });
  return {
    outcome: result.outcome,
    content: result.content,
    details,
    artifactRefs: [reference],
    modelContent: { kind: 'artifact', reference, encoding: 'utf-8' },
  };
}
