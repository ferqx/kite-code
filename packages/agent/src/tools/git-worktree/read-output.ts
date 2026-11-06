import type { OperationRef, PublicExecution, ToolContext } from '../../extensions';
import { AgentError } from '../../storage/types';
import {
  jsonObject,
  limits,
  validateFrame,
  type WorktreeFrame,
  type WorktreeRequest,
} from './protocol';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'outcome_unknown']);
const decimal = /^(0|[1-9][0-9]{0,18})$/;
export function assertOriginalWorktreeJob(
  ref: OperationRef,
  context: Pick<ToolContext, 'sessionId'>,
  execution: PublicExecution | null,
): asserts execution is PublicExecution {
  if (
    !ref.executionId ||
    ref.extensionId !== 'builtin.shell' ||
    ref.sessionId !== context.sessionId ||
    !execution ||
    execution.id !== ref.executionId ||
    execution.sessionId !== ref.sessionId ||
    execution.originStoreId !== ref.originStoreId ||
    execution.kind !== 'job' ||
    execution.definitionId !== 'shell.command' ||
    execution.definitionVersion !== '1'
  )
    throw new AgentError('worktree_operation_unverifiable');
}
/** Strict original durable output, never the foreground Shell preview. */
export async function readWorktreeOutput(
  ref: OperationRef,
  context: Pick<ToolContext, 'sessionId' | 'operations'>,
  request: Pick<WorktreeRequest, 'operationToken' | 'phase'>,
): Promise<{ execution: PublicExecution; frame: WorktreeFrame | null }> {
  const execution = await context.operations.get(ref);
  assertOriginalWorktreeJob(ref, context, execution);
  if (
    !terminal.has(execution.status) ||
    !jsonObject(execution.result) ||
    execution.result.outcome !== execution.status ||
    typeof execution.result.content !== 'string'
  )
    throw new AgentError('worktree_operation_unverifiable');
  // A failure to start has no worker frame; only the Runtime owns that fact.
  if (execution.status !== 'succeeded') return { execution, frame: null };
  let cursor = 0n,
    upper: bigint | undefined,
    stdout = '',
    stderrBytes = 0;
  for (;;) {
    const page = await context.operations.readOutput(ref, {
      afterSeq: String(cursor),
      ...(upper === undefined ? {} : { upperSeq: String(upper) }),
      limit: 200,
    });
    if (!decimal.test(page.highWaterSeq)) throw new AgentError('worktree_output_incomplete');
    const highWater = BigInt(page.highWaterSeq);
    upper ??= highWater;
    if (highWater !== upper || page.items.length > 200)
      throw new AgentError('worktree_output_incomplete');
    for (const item of page.items) {
      if (
        item.executionId !== ref.executionId ||
        !decimal.test(item.seq) ||
        !decimal.test(item.throughSeq) ||
        BigInt(item.seq) !== cursor + 1n ||
        BigInt(item.throughSeq) < BigInt(item.seq) ||
        BigInt(item.throughSeq) > upper ||
        item.droppedBytes !== '0'
      )
        throw new AgentError('worktree_output_incomplete');
      // Coalesced ranges must explicitly represent a gap; zero-drop content is one original record.
      if (
        item.throughSeq !== item.seq ||
        Buffer.from(item.content).toString('utf8') !== item.content
      )
        throw new AgentError('worktree_output_incomplete');
      cursor = BigInt(item.throughSeq);
      if (item.stream === 'stdout') {
        stdout += item.content;
        if (Buffer.byteLength(stdout) > limits.frameBytes) throw new AgentError('inspection_limit');
      } else if (item.stream === 'stderr') {
        stderrBytes += Buffer.byteLength(item.content);
        if (stderrBytes > limits.gitStderrBytes) throw new AgentError('inspection_limit');
      } else throw new AgentError('worktree_output_incomplete');
    }
    if (cursor === upper) break;
    if (!page.items.length) throw new AgentError('worktree_output_incomplete');
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new AgentError('worktree_protocol_error');
  }
  if (!validateFrame(value, request)) throw new AgentError('worktree_protocol_error');
  return { execution, frame: value };
}
