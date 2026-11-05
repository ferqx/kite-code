import { isDeepStrictEqual } from 'node:util';

export interface ShellModelFeedback {
  shellId: string;
  status:
    | 'accepted'
    | 'planned'
    | 'dispatching'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'outcome_unknown';
  exitCode?: number;
}
const statuses: Readonly<Record<string, ShellModelFeedback['status']>> = {
  'The command was accepted for background execution. Completion has not been confirmed.':
    'accepted',
  'Recorded command status: queued.': 'planned',
  'Recorded command status: starting.': 'dispatching',
  'Recorded command status: running.': 'running',
  'The command finished.': 'succeeded',
  'The command failed.': 'failed',
  'The command was cancelled. Earlier changes are not rolled back by cancellation.': 'cancelled',
  'The command result could not be confirmed. It may still be running or have produced effects. Do not restart it to recover its result.':
    'outcome_unknown',
  'The user denied this command. It was not executed. Do not resubmit it or bypass the refusal.':
    'failed',
  'Approval was denied for this command. It was not executed. Do not bypass the refusal.': 'failed',
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A known zero-effect refresh remains a failure receipt, not Shell acceptance. */
export function preDispatchRefreshFeedbackMatches(content: string, result: unknown): boolean {
  const saved = object(result),
    details = object(saved.details);
  if (
    saved.outcome !== 'failed' ||
    !['input_pending', 'context_refresh_required', 'capability_refresh_required'].includes(
      String(saved.content),
    ) ||
    details.code !== saved.content ||
    details.adapterAttempted !== false ||
    details.dispatchCommitted !== false
  )
    return false;
  const explanation =
    saved.content === 'context_refresh_required'
      ? 'The context used to prepare this operation changed. Read the current task and relevant state before making a new decision.'
      : 'No more specific public explanation is available. Check the declared arguments and the original result before deciding how to continue.';
  return (
    content ===
    [
      'The operation failed.',
      'This request was not executed and produced no effects. Earlier operations keep their own results.',
      explanation,
    ].join('\n')
  );
}

/** Test Provider consumption of the public header, never control-looking stdout. */
export function parseShellModelFeedback(content: string): ShellModelFeedback {
  const lines = content.split('\n');
  const status = statuses[lines[0]!];
  if (!status) throw Error('fixture_shell_feedback_status_invalid');
  const boundary = lines.findIndex((line) => line === 'stdout:' || line === 'stderr:');
  const header = boundary < 0 ? lines : lines.slice(0, boundary);
  const handles = header.filter((line) => line.startsWith('shell_id: '));
  if (handles.length !== 1) throw Error('fixture_shell_feedback_handle_invalid');
  let shellId: unknown;
  try {
    shellId = JSON.parse(handles[0]!.slice('shell_id: '.length));
  } catch {
    throw Error('fixture_shell_feedback_handle_invalid');
  }
  if (typeof shellId !== 'string' || !shellId || /[\r\n]/u.test(shellId))
    throw Error('fixture_shell_feedback_handle_invalid');
  const exits = header.filter((line) => line.startsWith('Exit code: '));
  if (exits.length > 1 || (exits.length && !/^Exit code: -?\d+\.$/u.test(exits[0]!)))
    throw Error('fixture_shell_feedback_exit_invalid');
  const exitCode = exits.length ? Number(exits[0]!.slice(11, -1)) : undefined;
  if (exitCode !== undefined && !Number.isSafeInteger(exitCode))
    throw Error('fixture_shell_feedback_exit_invalid');
  return { shellId, status, ...(exitCode === undefined ? {} : { exitCode }) };
}

/** Compare parsed public facts with the original saved result; do not rewrite either. */
export function shellModelFeedbackMatchesResult(
  feedback: ShellModelFeedback,
  result: unknown,
): boolean {
  const saved = object(result),
    details = object(saved.details),
    ref = object(details.ref);
  if (
    ref.key !== feedback.shellId ||
    (details.shell_id !== undefined && details.shell_id !== feedback.shellId) ||
    typeof saved.content !== 'string'
  )
    return false;
  try {
    if (!isDeepStrictEqual(JSON.parse(saved.content), details)) return false;
  } catch {
    return false;
  }
  const execution = object(details.execution);
  if (feedback.status === 'accepted')
    return (
      saved.outcome === 'succeeded' && details.accepted === true && details.execution === undefined
    );
  return (
    execution.status === feedback.status &&
    object(object(execution.result).details).exitCode === feedback.exitCode
  );
}

/** Read a runtime-owned handle from the exact saved starter and its one original Job. */
export function originalShellJobHandle(starter: unknown, operation: unknown): string | undefined {
  const tool = object(starter),
    job = object(operation),
    result = object(tool.result),
    details = object(result.details),
    ref = object(details.ref);
  if (
    tool.kind !== 'tool' ||
    tool.definitionId !== 'shell.execute' ||
    tool.definitionVersion !== '1' ||
    tool.status !== 'succeeded' ||
    object(tool.input ?? tool.toolInput).background !== true ||
    job.kind !== 'job' ||
    job.definitionId !== 'shell.command' ||
    job.definitionVersion !== '1' ||
    job.parentExecutionId !== tool.id ||
    job.sessionId !== tool.sessionId ||
    job.originStoreId !== tool.originStoreId ||
    ref.extensionId !== 'builtin.shell' ||
    ref.executionId !== job.id ||
    ref.sessionId !== tool.sessionId ||
    ref.originStoreId !== tool.originStoreId ||
    typeof ref.commandId !== 'string' ||
    !ref.commandId ||
    (job.originCommandId !== undefined && ref.commandId !== job.originCommandId) ||
    typeof details.shell_id !== 'string' ||
    !details.shell_id ||
    details.shell_id !== ref.key ||
    details.accepted !== true
  )
    return;
  try {
    if (!isDeepStrictEqual(JSON.parse(String(result.content)), details)) return;
  } catch {
    return;
  }
  return details.shell_id;
}
