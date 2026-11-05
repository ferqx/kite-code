import { isDeepStrictEqual } from 'node:util';
import { parseShellCommandInput, shellOperationKey } from './shell-input';
import type { ExecutionRecord, Json } from './storage/types';
import { failureOutcomeExplanation, toolFailurePresentation } from './tool-failure-presentation';

const object = (value: unknown): Record<string, Json> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : undefined;
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'outcome_unknown']);

/** Model presentation only. Callers must verify the frozen builtin registration.
 * Match the exact original operation before using its authorization observations.
 * The complete native receipt remains durable; stdout and stderr are never rewritten.
 */
export function formatShellResult(input: {
  execution: ExecutionRecord;
  result: Record<string, Json>;
  operation: ExecutionRecord;
  starter: ExecutionRecord;
}): string | undefined {
  const { execution, result, operation, starter } = input;
  const details = object(result.details);
  const ref = object(details?.ref);
  if (
    !details ||
    !ref ||
    operation.kind !== 'job' ||
    operation.definitionId !== 'shell.command' ||
    operation.definitionVersion !== '1' ||
    starter.kind !== 'tool' ||
    starter.definitionVersion !== '1' ||
    !['shell.execute', 'shell.launch'].includes(starter.definitionId) ||
    operation.parentExecutionId !== starter.id ||
    operation.originStoreId !== execution.originStoreId ||
    operation.sessionId !== execution.sessionId ||
    starter.originStoreId !== execution.originStoreId ||
    starter.sessionId !== execution.sessionId ||
    ref.executionId !== operation.id ||
    ref.commandId !== operation.originCommandId ||
    ref.extensionId !== 'builtin.shell' ||
    ref.sessionId !== execution.sessionId ||
    ref.originStoreId !== execution.originStoreId ||
    ref.key !== shellOperationKey(object(starter.input)?.key, starter.id)
  )
    return;
  const started = parseShellCommandInput(
    starter.input,
    starter.definitionId === 'shell.execute' ? 'execute' : 'launch',
    true,
  );
  const operated = parseShellCommandInput(operation.input, 'job', true);
  if (
    !started ||
    !operated ||
    started.command !== operated.command ||
    !isDeepStrictEqual(started.permissions ?? null, operated.permissions ?? null)
  )
    return;
  if (['shell.execute', 'shell.launch'].includes(execution.definitionId)) {
    if (starter.id !== execution.id) return;
  } else if (
    !['shell.read', 'shell.wait', 'shell.stop'].includes(execution.definitionId) ||
    object(execution.input)?.shellId !== ref.key
  )
    return;
  let saved: Record<string, Json> | undefined;
  try {
    saved = object(JSON.parse(String(result.content)));
  } catch {
    return;
  }
  if (!isDeepStrictEqual(saved, details)) return;
  const observed = object(details.execution);
  if (
    observed &&
    (observed.id !== operation.id ||
      observed.kind !== 'job' ||
      observed.definitionId !== 'shell.command' ||
      observed.sessionId !== operation.sessionId ||
      observed.originStoreId !== operation.originStoreId)
  )
    return;
  const output = object(details.output);
  const lines: string[] = [];
  const handle = `shell_id: ${JSON.stringify(ref.key)}`;
  if (details.accepted === true && !observed) {
    lines.push(
      'The command was accepted for background execution. Completion has not been confirmed.',
    );
  } else if (observed) {
    const status = String(observed.status);
    if (!['planned', 'dispatching', 'running', ...terminal].includes(status)) return;
    const originalResult = object(observed.result);
    const originalDetails = object(originalResult?.details);
    const sameTerminal =
      terminal.has(status) &&
      operation.status === status &&
      isDeepStrictEqual(operation.result, observed.result);
    const denied =
      sameTerminal &&
      operation.authorization?.dispatched === false &&
      originalResult?.content === 'approval_denied' &&
      originalDetails?.adapterAttempted === false;
    if (
      denied &&
      operation.authorization?.human?.state === 'answered' &&
      operation.authorization.human.decision === 'deny'
    ) {
      lines.push(
        'The user denied this command. It was not executed. Do not resubmit it or bypass the refusal.',
      );
    } else if (denied) {
      lines.push(
        'Approval was denied for this command. It was not executed. Do not bypass the refusal.',
      );
    } else if (status === 'outcome_unknown') {
      lines.push(
        'The command result could not be confirmed. It may still be running or have produced effects. Do not restart it to recover its result.',
      );
    } else if (details.timedOut === true && execution.definitionId === 'shell.execute') {
      lines.push('The command exceeded its execution deadline and cancellation was requested.');
    } else if (status === 'failed') {
      lines.push('The command failed.');
    } else if (status === 'cancelled') {
      lines.push('The command was cancelled. Earlier changes are not rolled back by cancellation.');
    } else if (status === 'succeeded') {
      lines.push('The command finished.');
    } else
      lines.push(
        `Recorded command status: ${status === 'planned' ? 'queued' : status === 'dispatching' ? 'starting' : status}.`,
      );
    if (details.cancelRequested === true)
      lines.push(
        'A stop was requested; this request alone does not confirm that the command stopped.',
      );
    if (details.timedOut === true && execution.definitionId === 'shell.wait')
      lines.push('The wait timed out. This wait did not stop the command.');
    if (Number.isSafeInteger(originalDetails?.exitCode))
      lines.push(`Exit code: ${originalDetails!.exitCode}.`);
    if (sameTerminal && originalDetails?.processTreeStopped === true)
      lines.push('The command and its supervised processes have stopped.');
    const policy = operation.authorization?.policy;
    if (sameTerminal && policy?.reason === 'timeout_continue')
      lines.push(
        'The approval check timed out. Execution continued under the current policy without a review decision.',
      );
    else if (sameTerminal && policy?.reason === 'reused_approval')
      lines.push('An existing approval was reused for this command.');
    else if (
      sameTerminal &&
      !denied &&
      [operation, starter].some(
        (record) =>
          record.authorization?.human?.state === 'answered' &&
          record.authorization.human.accepted === true &&
          record.authorization.human.decision === 'approve',
      )
    )
      lines.push('The user approved this command.');
    else if (
      sameTerminal &&
      !denied &&
      [operation, starter].some(
        (record) =>
          record.authorization?.check?.status === 'succeeded' &&
          record.authorization.check.decision === 'approve_once',
      )
    )
      lines.push('The risk review allowed this command.');
    if (
      status === 'failed' &&
      !denied &&
      originalResult &&
      originalResult.content !== 'Shell failed'
    ) {
      const explanation = toolFailurePresentation({
        result: originalResult,
        notDispatched:
          sameTerminal &&
          operation.authorization?.dispatched === false &&
          originalDetails?.adapterAttempted === false,
        ...(sameTerminal && typeof originalDetails?.reason === 'string'
          ? { reason: originalDetails.reason }
          : {}),
        ...(sameTerminal &&
        operation.authorization?.check?.status === 'succeeded' &&
        operation.authorization.check.decision === 'reject' &&
        operation.authorization.check.reason === originalDetails?.reason
          ? { reviewRejection: operation.authorization.check.reason }
          : {}),
      });
      if (explanation) lines.push(explanation);
    }
  } else return;
  lines.push(handle);
  for (const stream of ['stdout', 'stderr']) {
    if (typeof details[stream] === 'string') lines.push(`${stream}:\n${details[stream]}`);
  }
  if (output) {
    if (!Array.isArray(output.items)) return;
    for (const raw of output.items) {
      const item = object(raw);
      if (
        !item ||
        item.executionId !== operation.id ||
        typeof item.content !== 'string' ||
        !['stdout', 'stderr'].includes(String(item.stream))
      )
        return;
      lines.push(`${item.stream}:\n${item.content}`);
      if (item.droppedBytes && item.droppedBytes !== '0')
        lines.push(`Output bytes unavailable: ${item.droppedBytes}.`);
    }
    lines.push(
      `Output cursor: ${JSON.stringify({ after_seq: output.items.length ? object(output.items.at(-1))?.throughSeq : (object(execution.input)?.afterSeq ?? '0'), upper_seq: output.highWaterSeq })}`,
    );
  }
  if (
    details.truncated === true ||
    (typeof details.droppedBytes === 'string' && details.droppedBytes !== '0')
  )
    lines.push(
      'This output is incomplete. Use shell_read with the original shell_id to read retained output; do not rerun the command.',
    );
  if (result.outcome === 'outcome_unknown' && observed?.status !== 'outcome_unknown')
    lines.push(failureOutcomeExplanation('outcome_unknown')!);
  return lines.join('\n');
}
