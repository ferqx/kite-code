import { isDeepStrictEqual } from 'node:util';
import { limitShellOutput, shellOutputGapMessage, shellOutputPreview } from '@kite-ai/trajectory';
import { modelExecutionId } from './model-identifier';
import { parseShellCommandInput, shellOperationKey } from './shell-input';
import type { ExecutionRecord, Json } from './storage/types';
import { failureOutcomeExplanation, toolFailurePresentation } from './tool-failure-presentation';

const object = (value: unknown): Record<string, Json> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : undefined;
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'outcome_unknown']);
const commandCandidateSources = new Map([
  ['path', 'Job PATH'],
  ['user_app_paths', 'user Windows App Paths'],
  ['machine_app_paths', 'machine Windows App Paths'],
  ['configured_directory', 'configured tool directory'],
]);

function appendCommandLookup(lines: string[], value: Json | undefined) {
  const lookup = object(value);
  if (typeof lookup?.name !== 'string' || lookup.name.length > 128) return;
  lines.push(`A command lookup in this Shell call did not resolve ${JSON.stringify(lookup.name)}.`);
  const candidates = Array.isArray(lookup.candidates) ? lookup.candidates : [];
  for (const value of candidates.slice(0, 8)) {
    const item = object(value);
    const source = typeof item?.source === 'string' && commandCandidateSources.get(item.source);
    if (source && typeof item?.path === 'string' && item.path.length <= 1024)
      lines.push(`Candidate from ${source}: ${JSON.stringify(item.path)}.`);
  }
  lines.push(
    'If the program is still required, check the executable and its runtime in a separate Shell call before considering installation. Use the absolute path for any candidate you check.',
  );
}

/** Model presentation only. Callers must verify the frozen builtin registration.
 * Match the exact original operation before using its authorization observations.
 * The native receipt remains durable; only the model's copy is bounded here.
 */
export function formatShellResult(input: {
  execution: ExecutionRecord;
  result: Record<string, Json>;
  operation: ExecutionRecord;
  starter: ExecutionRecord;
  modelTokenLimit?: number;
}): string | undefined {
  const { execution, result, operation, starter } = input;
  const details = object(result.details);
  const ref = object(details?.ref);
  if (
    !details ||
    !ref ||
    (details.execution_id !== undefined && details.execution_id !== starter.id) ||
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
    started.workdir !== operated.workdir ||
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
  const savedPreview = details.outputFormat === 'model-preview';
  if (savedPreview) {
    if (
      !['shell.execute', 'shell.read'].includes(execution.definitionId) ||
      typeof result.content !== 'string' ||
      typeof details.outputLimited !== 'boolean' ||
      ['stdout', 'stderr', 'output'].some((key) => details[key] !== undefined)
    )
      return;
  } else {
    try {
      if (!isDeepStrictEqual(object(JSON.parse(String(result.content))), details)) return;
    } catch {
      return;
    }
  }
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
  const lines: string[] = [];
  const handle = `shell_id: ${JSON.stringify(ref.key)}`;
  if (details.accepted === true && !observed) {
    lines.push(
      'The command was accepted for background execution. Completion has not been confirmed.',
      'Inspect the original recorded execution for its later status and retained output. Do not start another command to change how it is observed.',
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
    const confinement = object(object(operation.reference)?.confinement);
    if (
      sameTerminal &&
      status === 'failed' &&
      !denied &&
      Number.isSafeInteger(originalDetails?.exitCode) &&
      originalDetails?.cleanupConfirmed === true &&
      originalDetails.processTreeStopped === true &&
      confinement?.backend === 'windows-restricted-token-job' &&
      confinement.filesystem === 'workspace_write' &&
      (confinement.network === 'none' || confinement.network === 'internet')
    )
      lines.push(
        `The command ran with filesystem:"workspace_write" and network:"${confinement.network}". If the diagnostics confirm that this scope blocked a required local helper or IPC, check saved effects before explicitly requesting filesystem:"full_access" for the necessary step. Keep network:"none" for local-only work.`,
      );
    if (sameTerminal && (status === 'succeeded' || status === 'failed'))
      appendCommandLookup(lines, originalDetails?.commandLookup);
    if (sameTerminal && originalDetails?.processTreeStopped === true)
      lines.push('The command and its supervised processes have stopped.');
    if (
      sameTerminal &&
      originalDetails?.cleanupConfirmed === true &&
      originalDetails.processTreeStopped === true
    )
      lines.push(
        'This command’s process scope has ended. Any state held only in those processes is no longer available. Complete each dependent edit, save and close sequence within one running command. Reopen the saved workspace file from disk in the next call before further edits or delivery.',
      );
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
  lines.push(`execution_id: ${JSON.stringify(modelExecutionId(starter.id))}`, handle);
  const missingBytes =
    typeof details.droppedBytes === 'string' && /^[1-9]\d*$/.test(details.droppedBytes)
      ? details.droppedBytes
      : undefined;
  let cursorLine: string | undefined;
  if (details.output !== undefined || (execution.definitionId === 'shell.read' && savedPreview)) {
    if (
      typeof details.next_cursor !== 'string' ||
      typeof details.caught_up !== 'boolean' ||
      typeof details.terminal !== 'boolean'
    )
      return;
    cursorLine = `Output cursor: ${JSON.stringify({ cursor: details.next_cursor, caught_up: details.caught_up, terminal: details.terminal })}`;
  }
  const gaps: string[] = [];
  if (savedPreview && details.outputGaps !== undefined) {
    if (!Array.isArray(details.outputGaps)) return;
    for (const raw of details.outputGaps) {
      const gap = object(raw);
      if (
        !gap ||
        (gap.stream !== 'stdout' && gap.stream !== 'stderr') ||
        !(
          gap.droppedBytes === null ||
          (typeof gap.droppedBytes === 'string' && /^[1-9]\d*$/.test(gap.droppedBytes))
        )
      )
        return;
      gaps.push(shellOutputGapMessage({ stream: gap.stream, droppedBytes: gap.droppedBytes }));
    }
  }
  const preview = savedPreview
    ? limitShellOutput(
        String(result.content),
        input.modelTokenLimit ?? Number.POSITIVE_INFINITY,
        gaps,
      )
    : shellOutputPreview(
        details,
        operation.id,
        object(execution.input)?.max_output_tokens,
        input.modelTokenLimit,
      );
  if (!preview) return;
  if (preview.text) {
    lines.push('', preview.text);
    if (preview.limited || details.outputLimited === true)
      lines.push('Inspect the original execution for its retained output.');
  }
  if (cursorLine) lines.push(cursorLine);
  if (execution.definitionId === 'shell.stop' && details.cancellation_execution_id === execution.id)
    lines.push(`cancellation_execution_id: ${JSON.stringify(modelExecutionId(execution.id))}`);
  if (missingBytes) lines.push(`Collection omitted ${missingBytes} output bytes.`);
  if (
    details.truncated === true ||
    (typeof details.droppedBytes === 'string' && details.droppedBytes !== '0')
  )
    lines.push(
      'This output is incomplete. Inspect the original execution for retained output; do not rerun the command.',
    );
  if (result.outcome === 'outcome_unknown' && observed?.status !== 'outcome_unknown')
    lines.push(failureOutcomeExplanation('outcome_unknown')!);
  return lines.join('\n');
}
