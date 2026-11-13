import { createHash } from 'node:crypto';
import type { Json, OperationRef, PublicExecution, ToolContext, ToolResult } from '../extensions';
import { canonicalJson } from '../json';
import { AgentError } from '../storage/types';

function assertOriginalShell(
  ref: OperationRef,
  execution: PublicExecution | null,
): asserts execution is PublicExecution {
  if (
    !execution ||
    execution.id !== ref.executionId ||
    execution.sessionId !== ref.sessionId ||
    execution.originStoreId !== ref.originStoreId ||
    execution.kind !== 'job' ||
    execution.definitionId !== 'shell.command'
  )
    throw new AgentError('shell_unverifiable');
}
const terminal = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'];

/** Read the original supervised Job after it is terminal. No receipt is promoted to completion. */
async function readForegroundShell(
  ref: OperationRef,
  context: ToolContext,
  timeoutMs: number | undefined,
  presentation: 'exploration' | 'standalone',
): Promise<ToolResult> {
  let deadline = Number.POSITIVE_INFINITY;
  let awaitingDispatch = timeoutMs !== undefined;
  let timedOut = false;
  let execution: PublicExecution;
  for (;;) {
    context.signal.throwIfAborted();
    if (awaitingDispatch) {
      const current = await context.operations.get(ref);
      assertOriginalShell(ref, current);
      if (terminal.includes(current.status)) {
        execution = current;
        break;
      }
      if (current.status === 'dispatching' || current.status === 'running') {
        // Observe only this exact Job. Approval and resource waits do not run the
        // clock; once dispatch is observed, subsequent waits never reset it.
        deadline = performance.now() + timeoutMs!;
        awaitingDispatch = false;
      }
    }
    const remaining = awaitingDispatch ? Number.POSITIVE_INFINITY : deadline - performance.now();
    if (!timedOut && remaining <= 0) {
      if (!context.operations.cancel) throw new AgentError('shell_stop_unavailable');
      await context.operations.cancel(ref, {
        commandId: `shell_timeout_${createHash('sha256')
          .update(canonicalJson(ref as unknown as Json))
          .digest('hex')}`,
      });
      timedOut = true;
    }
    try {
      execution = await context.operations.wait(ref, {
        signal: context.signal,
        timeoutMs: awaitingDispatch
          ? Math.min(25, Math.max(1, Math.floor(timeoutMs!)))
          : timedOut
            ? 30000
            : Math.min(30000, Math.max(1, Math.floor(remaining))),
      });
      break;
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'wait_timeout') throw error;
    }
  }
  assertOriginalShell(ref, execution);
  if (!terminal.includes(execution.status)) throw new AgentError('shell_unverifiable');
  const text: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
  const bytes = { stdout: 0, stderr: 0 };
  let cursor = '0',
    upper: string | undefined;
  let droppedBytes = 0n;
  let truncated = false;
  for (;;) {
    context.signal.throwIfAborted();
    const page = await context.operations.readOutput(ref, {
      afterSeq: cursor,
      ...(upper ? { upperSeq: upper } : {}),
      limit: 200,
    });
    upper ??= page.highWaterSeq;
    if (BigInt(page.highWaterSeq) < BigInt(upper)) throw new AgentError('shell_output_conflict');
    let next = BigInt(cursor);
    for (const item of page.items) {
      if (
        item.executionId !== ref.executionId ||
        BigInt(item.seq) <= BigInt(cursor) ||
        BigInt(item.seq) > BigInt(upper)
      )
        throw new AgentError('shell_output_conflict');
      if (BigInt(item.throughSeq) < BigInt(item.seq) || BigInt(item.throughSeq) > BigInt(upper))
        throw new AgentError('shell_output_conflict');
      const through = BigInt(item.throughSeq);
      if (through > next) next = through;
      if (item.droppedBytes === null || item.droppedBytes !== '0') truncated = true;
      if (item.droppedBytes) droppedBytes += BigInt(item.droppedBytes);
      if (item.stream !== 'stdout' && item.stream !== 'stderr') continue;
      bytes[item.stream] += Buffer.byteLength(item.content);
      text[item.stream].push(item.content);
    }
    if (next === BigInt(upper)) break;
    if (next === BigInt(cursor)) throw new AgentError('shell_output_conflict');
    cursor = String(next);
  }
  const details = {
    ref: ref as unknown as Json,
    presentation,
    timedOut,
    execution: execution as unknown as Json,
    stdout: text.stdout.join(''),
    stderr: text.stderr.join(''),
    stdoutBytes: String(bytes.stdout),
    stderrBytes: String(bytes.stderr),
    droppedBytes: String(droppedBytes),
    truncated,
  };
  return {
    outcome:
      timedOut && execution.status === 'cancelled'
        ? 'failed'
        : (execution.status as ToolResult['outcome']),
    content: canonicalJson(details),
    details,
  };
}

/** Cancellation does not end observation of the already accepted same-ref Job. */
export async function completeForegroundShell(
  ref: OperationRef,
  context: ToolContext,
  timeoutMs: number | undefined,
  presentation: 'exploration' | 'standalone',
): Promise<ToolResult> {
  try {
    return await readForegroundShell(ref, context, timeoutMs, presentation);
  } catch (error) {
    if (!context.signal.aborted) throw error;
    const deadline = performance.now() + 30000;
    for (;;) {
      let execution: PublicExecution | null;
      try {
        // The existing Runtime owns the attached stop. This is a pure same-ref
        // read, not a second cancellation or a signal-independent Job restart.
        execution = await context.operations.get(ref);
      } catch {
        return cancellationUnknown(ref, presentation);
      }
      if (execution) {
        if (
          execution.id !== ref.executionId ||
          execution.sessionId !== ref.sessionId ||
          execution.originStoreId !== ref.originStoreId ||
          execution.kind !== 'job' ||
          execution.definitionId !== 'shell.command'
        )
          return cancellationUnknown(ref, presentation);
        if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status)) {
          const result = execution.result;
          if (
            !result ||
            typeof result !== 'object' ||
            Array.isArray(result) ||
            result.outcome !== execution.status ||
            typeof result.content !== 'string'
          )
            return cancellationUnknown(ref, presentation);
          // Terminal Job status is published by the supervised Core path. Keep
          // an actual failed/succeeded/unknown outcome, even if abort raced it.
          const details = {
            ref: ref as unknown as Json,
            presentation,
            execution: execution as unknown as Json,
            cancellationObserved: true,
          };
          return {
            outcome: execution.status as ToolResult['outcome'],
            content: canonicalJson(details),
            details,
          };
        }
      }
      if (performance.now() >= deadline) return cancellationUnknown(ref, presentation);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
function cancellationUnknown(
  ref: OperationRef,
  presentation: 'exploration' | 'standalone',
): ToolResult {
  return {
    outcome: 'outcome_unknown',
    content:
      'Stopping the command could not be confirmed. It may still be running or have produced effects. Use its original shell_id to check its state; do not restart it.',
    details: {
      code: 'shell_cancellation_unconfirmed',
      ref: ref as unknown as Json,
      presentation,
      cancellationObserved: false,
    },
  };
}
