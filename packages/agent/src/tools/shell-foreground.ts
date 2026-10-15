import { createHash } from 'node:crypto';
import type { Json, OperationRef, PublicExecution, ToolContext, ToolResult } from '../extensions';
import { canonicalJson } from '../json';
import { AgentError } from '../storage/types';

/** Read the original supervised Job after it is terminal. No receipt is promoted to completion. */
async function readForegroundShell(
  ref: OperationRef,
  context: ToolContext,
  timeoutMs: number,
  presentation: 'exploration' | 'standalone',
): Promise<ToolResult> {
  const deadline = performance.now() + timeoutMs;
  let timedOut = false;
  let execution: PublicExecution;
  for (;;) {
    context.signal.throwIfAborted();
    const remaining = deadline - performance.now();
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
        timeoutMs: timedOut ? 30000 : Math.min(30000, Math.max(1, remaining)),
      });
      break;
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'wait_timeout') throw error;
    }
  }
  if (
    execution.id !== ref.executionId ||
    execution.sessionId !== ref.sessionId ||
    execution.originStoreId !== ref.originStoreId ||
    !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status)
  )
    throw new AgentError('shell_unverifiable');
  const text = { stdout: '', stderr: '' };
  const bytes = { stdout: 0, stderr: 0 };
  let cursor = '0',
    upper: string | undefined;
  let droppedBytes = 0n;
  for (;;) {
    context.signal.throwIfAborted();
    const page = await context.operations.readOutput(ref, {
      afterSeq: cursor,
      ...(upper ? { upperSeq: upper } : {}),
      limit: 200,
    });
    upper ??= page.highWaterSeq;
    if (BigInt(page.highWaterSeq) < BigInt(upper)) throw new AgentError('shell_output_conflict');
    for (const item of page.items) {
      if (
        item.executionId !== ref.executionId ||
        BigInt(item.seq) <= BigInt(cursor) ||
        BigInt(item.seq) > BigInt(upper)
      )
        throw new AgentError('shell_output_conflict');
      if (BigInt(item.throughSeq) < BigInt(item.seq) || BigInt(item.throughSeq) > BigInt(upper))
        throw new AgentError('shell_output_conflict');
      cursor = item.throughSeq;
      if (item.droppedBytes) droppedBytes += BigInt(item.droppedBytes);
      if (item.stream !== 'stdout' && item.stream !== 'stderr') continue;
      bytes[item.stream] += Buffer.byteLength(item.content);
      // The original complete output stays in the Job reader; the Model gets a bounded preview.
      const remaining = 512 * 1024 - Buffer.byteLength(text[item.stream]);
      if (remaining > 0)
        text[item.stream] += Buffer.from(item.content).subarray(0, remaining).toString('utf8');
    }
    if (BigInt(cursor) === BigInt(upper)) break;
    if (!page.items.length) throw new AgentError('shell_output_conflict');
  }
  const details = {
    ref: ref as unknown as Json,
    presentation,
    timedOut,
    execution: execution as unknown as Json,
    ...text,
    stdoutBytes: String(bytes.stdout),
    stderrBytes: String(bytes.stderr),
    droppedBytes: String(droppedBytes),
    truncated: bytes.stdout > 512 * 1024 || bytes.stderr > 512 * 1024,
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
  timeoutMs: number,
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
    content: 'shell_cancellation_unconfirmed',
    details: { ref: ref as unknown as Json, presentation, cancellationObserved: false },
  };
}
