import { shellOutputPreview } from '@kite-ai/trajectory';
import type { Message as DesktopMessage } from '@kite-ai/ui/desktop';
import type { NativeToolMessageFact } from './tool-messages-bridge';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const decimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);

/** Use the public result of the already verified original Shell Job. */
export function desktopShellFailure(status: unknown, result: unknown): string | undefined {
  if (status !== 'failed' && status !== 'outcome_unknown') return;
  const saved = record(result);
  const detail = record(saved?.details);
  const content = saved?.content;
  const reason = detail?.reason ?? detail?.supervisorFailure;
  if (typeof reason === 'string' && reason.trim()) return reason;
  if (typeof content === 'string' && !['Shell failed', 'Shell completed'].includes(content))
    return content || undefined;
  return undefined;
}

/** Display only: a Tool receipt never promotes acceptance to a completed Shell Job. */
export function desktopShell(
  fact: Pick<NativeToolMessageFact, 'definitionId' | 'definitionVersion' | 'status'> &
    Pick<
      Partial<NativeToolMessageFact>,
      | 'shellInput'
      | 'shellDisplay'
      | 'shellOutputLimit'
      | 'shellOutputReceipt'
      | 'shellResultVerified'
      | 'shellJobExecutionId'
      | 'shellJobSettlement'
      | 'target'
    >,
  text: string,
): DesktopMessage['shell'] {
  const declaredOperation = fact.definitionId.slice('shell.'.length);
  if (
    fact.definitionVersion !== '1' ||
    !fact.definitionId.startsWith('shell.') ||
    !['execute', 'launch', 'read', 'wait', 'stop'].includes(declaredOperation)
  )
    return;
  const input = fact.shellInput;
  const operation =
    declaredOperation === 'execute' && input?.operation === 'launch' ? 'launch' : declaredOperation;
  const shell: NonNullable<DesktopMessage['shell']> = {
    operation: operation as NonNullable<DesktopMessage['shell']>['operation'],
    ...(input?.shellId ? { shellId: input.shellId } : {}),
    ...(fact.shellJobExecutionId ? { jobExecutionId: fact.shellJobExecutionId } : {}),
    ...(input?.command === undefined && fact.target && ['execute', 'launch'].includes(operation)
      ? { commandPreview: fact.target }
      : {}),
    ...(input?.command !== undefined &&
    input.commandOffset === 0 &&
    input.commandNextOffset === null
      ? { command: input.command }
      : {}),
  };
  if (fact.shellDisplay) return { ...shell, ...fact.shellDisplay, ...fact.shellJobSettlement };
  if (!fact.shellResultVerified) return shell;
  if (fact.shellOutputReceipt) return { ...shell, ...fact.shellOutputReceipt, output: text };
  let result: Record<string, unknown> | undefined;
  try {
    result = record(JSON.parse(text));
  } catch {
    return shell;
  }
  if (!result) return shell;
  const ref = record(result.ref);
  if (ref?.extensionId !== 'builtin.shell' || ref.key !== shell.shellId) return shell;
  if (operation === 'launch')
    return result.accepted === true && result.shellId === shell.shellId
      ? { ...shell, accepted: true, ...fact.shellJobSettlement }
      : shell;
  const job = record(result.execution);
  if (
    !job ||
    job.id !== ref.executionId ||
    job.sessionId !== ref.sessionId ||
    job.originStoreId !== ref.originStoreId ||
    job.kind !== 'job' ||
    job.definitionId !== 'shell.command' ||
    job.definitionVersion !== '1' ||
    ![
      'planned',
      'dispatching',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'outcome_unknown',
    ].includes(String(job.status))
  )
    return shell;
  const terminal = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
    String(job.status),
  );
  const jobResult = record(job.result);
  if (
    terminal &&
    (!jobResult || jobResult.outcome !== job.status || typeof jobResult.content !== 'string')
  )
    return shell;
  if (
    operation === 'execute' &&
    (!terminal ||
      fact.status !==
        (result.timedOut === true && job.status === 'cancelled' ? 'failed' : job.status))
  )
    return shell;
  const details = record(jobResult?.details);
  const status = job.status as NonNullable<DesktopMessage['shell']>['jobStatus'];
  const verified = {
    ...shell,
    jobStatus: status,
    ...(status === 'failed' || status === 'outcome_unknown'
      ? { failureReason: desktopShellFailure(status, jobResult) }
      : {}),
    ...(Number.isSafeInteger(details?.exitCode) ? { exitCode: details!.exitCode as number } : {}),
    ...(typeof result.timedOut === 'boolean' ? { timedOut: result.timedOut } : {}),
    ...(operation === 'stop' && result.cancelRequested === true ? { cancelRequested: true } : {}),
  };
  if (operation === 'execute') {
    if (
      typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string' ||
      typeof result.truncated !== 'boolean' ||
      !decimal(result.droppedBytes) ||
      !decimal(result.stdoutBytes) ||
      !decimal(result.stderrBytes) ||
      (!result.truncated &&
        (BigInt(result.stdoutBytes) !== BigInt(new TextEncoder().encode(result.stdout).length) ||
          BigInt(result.stderrBytes) !== BigInt(new TextEncoder().encode(result.stderr).length)))
    )
      return result.cancellationObserved === true ? { ...verified, outputComplete: false } : shell;
    const preview = shellOutputPreview(
      result,
      String(ref.executionId),
      fact.shellOutputLimit?.requestedTokens,
      fact.shellOutputLimit?.modelTokenLimit,
    );
    return {
      ...verified,
      output: preview?.text,
      outputComplete: !result.truncated && BigInt(result.droppedBytes) === 0n && !preview?.limited,
    };
  }
  if (operation !== 'read') return { ...verified, outputComplete: false };
  const output = record(result.output);
  if (!output || !decimal(output.highWaterSeq) || !Array.isArray(output.items)) return shell;
  let cursor = -1n;
  for (const value of output.items) {
    const item = record(value);
    if (
      !item ||
      item.executionId !== ref.executionId ||
      !decimal(item.seq) ||
      !decimal(item.throughSeq) ||
      BigInt(item.seq) <= cursor ||
      BigInt(item.throughSeq) < BigInt(item.seq) ||
      BigInt(item.throughSeq) > BigInt(output.highWaterSeq) ||
      !['stdout', 'stderr', 'progress'].includes(String(item.stream)) ||
      typeof item.content !== 'string' ||
      (item.droppedBytes !== null && !decimal(item.droppedBytes))
    )
      return shell;
    cursor = BigInt(item.throughSeq);
  }
  const preview = shellOutputPreview(
    result,
    String(ref.executionId),
    fact.shellOutputLimit?.requestedTokens,
    fact.shellOutputLimit?.modelTokenLimit,
  );
  if (!preview) return shell;
  return {
    ...verified,
    output: preview.text,
    outputComplete: false,
  };
}
