import type { Store } from '../storage/port';
import { AgentError, type ExecutionRecord, type RunRecord } from '../storage/types';

/** Resolve the actual owning Run without assigning a Run ID to a nested operation. */
export async function resolveExecutionRun(
  host: Pick<Store, 'getExecution' | 'getRun' | 'getCommand'>,
  origin: ExecutionRecord,
  signal?: AbortSignal,
): Promise<{ ancestor: ExecutionRecord; run: RunRecord | null }> {
  const visited = new Set<string>();
  let ancestor = origin;
  signal?.throwIfAborted();
  const originCommand = await host.getCommand(origin.originCommandId);
  for (let depth = 0; ; depth++) {
    signal?.throwIfAborted();
    if (visited.has(ancestor.id) || depth > 32) throw new AgentError('invalid_child_parent');
    visited.add(ancestor.id);
    const command = await host.getCommand(ancestor.originCommandId);
    signal?.throwIfAborted();
    if (
      !originCommand ||
      !command ||
      command.id !== ancestor.originCommandId ||
      command.subjectId !== originCommand.subjectId ||
      command.sessionId !== origin.sessionId ||
      command.originStoreId !== origin.originStoreId ||
      command.rootWorkCommandId !== origin.rootWorkCommandId ||
      command.rootWorkSeq !== origin.rootWorkSeq
    )
      throw new AgentError('invalid_child_parent');
    if (ancestor.runId !== null) {
      const run = await host.getRun(ancestor.runId);
      signal?.throwIfAborted();
      if (
        !run ||
        run.id !== ancestor.runId ||
        run.sessionId !== origin.sessionId ||
        run.originStoreId !== origin.originStoreId ||
        run.rootWorkCommandId !== origin.rootWorkCommandId ||
        run.rootWorkSeq !== origin.rootWorkSeq ||
        run.originCommandId !== ancestor.originCommandId
      )
        throw new AgentError('invalid_child_parent');
      return { ancestor, run };
    }
    if (!ancestor.parentExecutionId) return { ancestor, run: null };
    const previous = await host.getExecution(ancestor.parentExecutionId);
    signal?.throwIfAborted();
    if (
      !previous ||
      previous.id !== ancestor.parentExecutionId ||
      previous.sessionId !== origin.sessionId ||
      previous.originStoreId !== origin.originStoreId ||
      previous.rootWorkCommandId !== origin.rootWorkCommandId ||
      previous.rootWorkSeq !== origin.rootWorkSeq
    )
      throw new AgentError('invalid_child_parent');
    ancestor = previous;
  }
}
