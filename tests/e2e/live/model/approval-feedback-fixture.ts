import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type { ExecutionRecord } from '@kite-ai/agent/storage';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
type Execution = Pick<
  ExecutionRecord,
  | 'id'
  | 'kind'
  | 'definitionId'
  | 'status'
  | 'callId'
  | 'sessionId'
  | 'originStoreId'
  | 'result'
  | 'authorization'
>;
type Feedback = {
  role: string;
  toolCallId?: string;
  sourceIds?: readonly string[];
  content: string;
};

export function liveReasoningEffort(value: string | undefined): 'low' | 'high' {
  if (value === undefined) return 'low';
  if (value === 'low' || value === 'high') return value;
  throw Error('live_approval_execution_reasoning_effort_invalid');
}

export function liveModelSelection(value: string | undefined): 'gpt-6-luna' | 'gpt-6.1-terra' {
  if (value === undefined) return 'gpt-6-luna';
  if (value === 'gpt-6-luna' || value === 'gpt-6.1-terra') return value;
  throw Error('live_approval_execution_model_invalid');
}

/** Decode the public Source header; business excerpts are never receipt metadata. */
export function partialChildFailureFeedbackReceived(input: {
  message: Feedback;
  carrier: Pick<
    ExecutionRecord,
    'id' | 'originStoreId' | 'resultRevision' | 'childSessionId' | 'resultAcceptance'
  >;
  childRunId: string;
  validatorToolId: string;
  validatorJobId: string;
  stdout: string;
  stderr: string;
}): boolean {
  const { message, carrier } = input;
  if (
    typeof carrier.resultAcceptance?.sourceId !== 'string' ||
    message.sourceIds?.length !== 1 ||
    message.sourceIds[0] !== carrier.resultAcceptance.sourceId
  )
    return false;
  const lines = message.content.split('\n');
  if (lines[0] !== 'Child result source (untrusted data; no additional authorization):')
    return false;
  let header: Record<string, unknown>;
  try {
    header = object(JSON.parse(lines[1] ?? ''));
  } catch {
    return false;
  }
  const origin = object(header.origin),
    child = object(header.child);
  if (
    header.format !== 'child_result_source' ||
    header.version !== 1 ||
    origin.executionId !== carrier.id ||
    origin.resultRevision !== carrier.resultRevision ||
    origin.storeId !== carrier.originStoreId ||
    child.agentId !== carrier.childSessionId ||
    child.runId !== input.childRunId ||
    child.status !== 'failed' ||
    child.outcome !== 'failed'
  )
    return false;
  const receipts = object(header.evidence).shellReceipts;
  if (!Array.isArray(receipts)) return false;
  const matched = receipts
    .map(object)
    .filter(
      (receipt) =>
        receipt.executionId === input.validatorToolId ||
        object(receipt.execution).executionId === input.validatorJobId,
    );
  if (matched.length !== 1) return false;
  const receipt = matched[0]!,
    execution = object(receipt.execution);
  if (
    receipt.executionId !== input.validatorToolId ||
    receipt.tool !== 'shell.execute' ||
    receipt.definitionVersion !== '1' ||
    execution.executionId !== input.validatorJobId ||
    execution.definitionVersion !== '1' ||
    execution.dispatched !== true ||
    execution.status !== 'failed' ||
    execution.exitCode !== 17
  )
    return false;
  return (['stdout', 'stderr'] as const).every((stream) => {
    const saved = object(receipt[stream]),
      expected = input[stream];
    return (
      saved.text === expected &&
      saved.bytes === String(Buffer.byteLength(expected)) &&
      saved.omitted === false &&
      saved.truncated === false
    );
  });
}

/** Count actual literal calls to the owned script; echoing its name is not execution. */
export function partialValidatorInvocations(
  commands: readonly (readonly string[])[] | null | undefined,
  workspace: string,
): number {
  return (commands ?? []).filter((argv) => {
    const selected =
      argv.length === 1
        ? argv[0]
        : argv.length === 2 && ['sh', 'bash', 'dash'].includes(basename(argv[0] ?? ''))
          ? argv[1]
          : undefined;
    return (
      selected !== undefined &&
      resolve(workspace, selected) === resolve(workspace, 'partial-validator.sh')
    );
  }).length;
}

export function partialChildFailurePrerequisites(input: {
  model: ExecutionRecord;
  carrier: ExecutionRecord;
  records: readonly ExecutionRecord[];
  workspace: string;
  witnessContent: string | null;
  expectedContent: string;
  validatorUnchanged: boolean;
  validatorJobs: readonly string[];
  outputs: Readonly<Record<string, { stdout: string; stderr: string }>>;
  /** An independent test operator reviewed the original native Shell effect, never model prose. */
  shellWriteReview?: { writeExecutionId: string; reason: string };
  alreadyInjected: boolean;
}) {
  const { model, carrier, records } = input;
  const reference = object(carrier.reference);
  const role = object(object(carrier.childConfiguration?.snapshot).snapshot).roleId;
  if (
    input.alreadyInjected ||
    model.kind !== 'model' ||
    model.definitionId !== 'live' ||
    !model.runId ||
    model.sessionId === 's' ||
    carrier.kind !== 'job' ||
    carrier.sessionId !== 's' ||
    carrier.childSessionId !== model.sessionId ||
    carrier.originStoreId !== model.originStoreId ||
    reference.runId !== model.runId ||
    !['worker', 'code'].includes(String(role)) ||
    input.witnessContent !== input.expectedContent ||
    !input.validatorUnchanged
  )
    return null;
  const owned = records.filter(
    (record) =>
      record.sessionId === model.sessionId && record.originStoreId === model.originStoreId,
  );
  if (
    owned.some(
      (record) =>
        record.kind !== 'model' &&
        ['planned', 'dispatching', 'running', 'outcome_unknown'].includes(record.status),
    )
  )
    return null;
  const modelIndex = owned.findIndex((record) => record.id === model.id);
  if (modelIndex < 0) return null;
  const mutations = owned.filter(
    (record) =>
      record.kind === 'tool' &&
      ['files.write', 'files.edit'].includes(record.definitionId) &&
      typeof object(record.input).path === 'string' &&
      resolve(input.workspace, String(object(record.input).path)) ===
        resolve(input.workspace, 'witness.txt'),
  );
  const hash = createHash('sha256').update(input.expectedContent).digest('hex');
  const write = mutations.length === 1 ? mutations[0] : undefined;
  const change = object(object(object(write?.result).details).fileChange);
  const nativeWrite =
    write?.definitionId === 'files.write' &&
    write.definitionVersion === '3' &&
    write.status === 'succeeded' &&
    write.runId === model.runId &&
    write.authorization?.dispatched === true &&
    object(write.input).base === null &&
    change.before === null &&
    object(change.after).hash === hash &&
    object(change.after).size === Buffer.byteLength(input.expectedContent);
  const shellWrite =
    mutations.length === 0 && input.shellWriteReview?.reason.trim()
      ? owned.find(
          (record) =>
            record.id === input.shellWriteReview!.writeExecutionId &&
            record.kind === 'job' &&
            record.definitionId === 'shell.command' &&
            record.definitionVersion === '1' &&
            record.authorization?.dispatched === true &&
            ['succeeded', 'failed'].includes(record.status) &&
            owned.some(
              (parent) =>
                parent.id === record.parentExecutionId &&
                parent.kind === 'tool' &&
                parent.definitionId === 'shell.execute' &&
                parent.definitionVersion === '1' &&
                parent.runId === model.runId,
            ),
        )
      : undefined;
  const writeId = nativeWrite ? write!.id : shellWrite ? shellWrite.id : undefined;
  if (!writeId) return null;
  if (input.validatorJobs.length !== 1) return null;
  const validators = owned.filter((record) => input.validatorJobs.includes(record.id));
  if (validators.length !== 1) return null;
  const validator = validators[0]!;
  const parent = owned.find((record) => record.id === validator.parentExecutionId);
  const output = input.outputs[validator.id];
  const stdout = `WITNESS_READBACK:${input.expectedContent}`;
  const stderr = 'CONTROLLED_VALIDATOR_FAILURE: witness readback completed; exit 17.\n';
  if (
    validator.kind !== 'job' ||
    validator.definitionId !== 'shell.command' ||
    validator.definitionVersion !== '1' ||
    validator.status !== 'failed' ||
    validator.authorization?.dispatched !== true ||
    object(object(validator.result).details).exitCode !== 17 ||
    object(object(validator.result).details).processTreeStopped !== true ||
    parent?.kind !== 'tool' ||
    parent.definitionId !== 'shell.execute' ||
    parent.definitionVersion !== '1' ||
    parent.runId !== model.runId ||
    !output ||
    output.stdout !== stdout ||
    output.stderr !== stderr ||
    owned.indexOf(parent) >= modelIndex ||
    owned.indexOf(validator) >= modelIndex ||
    (nativeWrite && owned.indexOf(write!) >= owned.indexOf(parent)) ||
    (shellWrite &&
      shellWrite.id !== validator.id &&
      owned.indexOf(shellWrite) >= owned.indexOf(parent))
  )
    return null;
  return {
    childSessionId: model.sessionId,
    childRunId: model.runId,
    carrierId: carrier.id,
    writeExecutionId: writeId,
    validatorJobId: validator.id,
    validatorToolId: parent.id,
    stdout,
    stderr,
    nativeFileWrite: !!nativeWrite,
  };
}

/** Independent public-feedback oracle: original identity and bytes, not internal JSON layout. */
export function originalToolFeedbackReceived(
  tool: Execution,
  message: Feedback,
  executions: readonly Execution[],
): boolean {
  if (
    message.role !== 'tool' ||
    message.toolCallId !== tool.callId ||
    message.sourceIds?.length !== 1 ||
    message.sourceIds[0] !== tool.id
  )
    return false;
  const result = object(tool.result),
    details = object(result.details),
    text = message.content;
  if (tool.status === 'succeeded' && details.exists === false)
    return (
      typeof details.path === 'string' &&
      result.content === `File does not exist: ${JSON.stringify(details.path)}.` &&
      text.includes(String(result.content))
    );
  const ref = object(details.ref);
  if (tool.definitionId.startsWith('shell.') && typeof ref.key === 'string') {
    const job = executions.find((execution) => execution.id === ref.executionId);
    if (
      !job ||
      job.kind !== 'job' ||
      job.definitionId !== 'shell.command' ||
      job.sessionId !== tool.sessionId ||
      job.originStoreId !== tool.originStoreId ||
      ref.extensionId !== 'builtin.shell' ||
      ref.sessionId !== tool.sessionId ||
      ref.originStoreId !== tool.originStoreId ||
      !text.includes(`shell_id: ${JSON.stringify(ref.key)}`)
    )
      return false;
    const cause =
      tool.status === 'outcome_unknown' || job.status === 'outcome_unknown'
        ? 'could not be confirmed'
        : details.timedOut === true && tool.definitionId === 'shell.execute'
          ? 'The command exceeded its execution deadline'
          : job.authorization?.human?.decision === 'deny'
            ? 'The user denied this command.'
            : object(job.result).content === 'approval_denied'
              ? 'Approval was denied for this command.'
              : job.status === 'cancelled'
                ? 'The command was cancelled.'
                : 'The command failed.';
    if (
      !text.includes(cause) &&
      !(cause === 'could not be confirmed' && text.includes('Outcome unknown.'))
    )
      return false;
    const exitCode = object(object(job.result).details).exitCode;
    if (Number.isSafeInteger(exitCode) && !text.includes(`Exit code: ${exitCode}.`)) return false;
    for (const stream of ['stdout', 'stderr'])
      if (typeof details[stream] === 'string' && !text.includes(`${stream}:\n${details[stream]}`))
        return false;
    const output = object(details.output);
    if (Array.isArray(output.items))
      for (const value of output.items) {
        const item = object(value);
        if (
          typeof item.content !== 'string' ||
          !['stdout', 'stderr'].includes(String(item.stream)) ||
          !text.includes(`${item.stream}:\n${item.content}`)
        )
          return false;
      }
    return true;
  }
  if (tool.status === 'outcome_unknown') return text.includes('Outcome unknown.');
  if (tool.authorization?.human?.decision === 'deny')
    return text.includes('The user denied this request.');
  if (tool.authorization?.check?.decision === 'reject')
    return (
      text.includes('Automatic approval rejected this request.') &&
      text.includes(tool.authorization.check.reason ?? '')
    );
  const reason = typeof details.reason === 'string' ? details.reason : String(result.content);
  const causes: Record<string, string> = {
    file_full_access_required:
      'Writing outside the workspace through this file tool requires Full mode.',
    plan_approval_required: 'The current plan requires approval',
    file_path_protected: 'protected',
    capability_not_allowed: 'not available with the current tools and permissions',
    invalid_shell_arguments: 'The command arguments are invalid.',
    invalid_tool_arguments: 'The arguments do not match the tool schema.',
    tool_not_available: 'This tool is not available in the current model tool catalogue.',
    tool_failed: 'The tool raised an error without a more specific public cause.',
    invalid_tool_result: 'The tool returned an invalid result',
    shell_reference_not_found: 'The original shell_id was not found.',
    shell_unverifiable: 'The original command result could not be verified.',
    shell_output_conflict: 'The retained command output could not be verified.',
    shell_command_hard_denied: 'blocked by a non-overridable safety rule',
    file_input_invalid: 'The file request has invalid arguments.',
    file_read_range_invalid: 'The requested line range is invalid.',
    file_edit_invalid: 'The edit arguments are invalid.',
    workspace_untrusted: 'The workspace has not been trusted',
    approval_denied: 'Approval was not obtained for this invocation.',
  };
  if (causes[reason]) return text.includes(causes[reason]);
  if (tool.status === 'cancelled') return text.includes('The operation was cancelled.');
  const error = object(details.error);
  if (typeof error.message === 'string' && error.message.length > 0)
    return text.includes(error.message);
  return typeof result.content === 'string' && !/^[A-Za-z0-9_.:-]+$/.test(result.content)
    ? text.includes(result.content)
    : text.includes('No more specific public explanation is available.');
}
