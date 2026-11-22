import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { frozenModelInputLimit } from '@kite-ai/agent/context-estimate';
import { ClientError, type Execution, type Message, type Run } from '@kite-ai/client';
import { desktopShell, desktopShellFailure } from '../src/native-shell-receipt';
import {
  type NativeShellInput,
  type NativeToolMessageFact,
  nativeAgentWaitErrors,
  nativeShellCommandChunkBytes,
} from '../src/tool-messages-bridge';
import { nativeToolRequestTarget } from '../src/tool-request-target';
import { nativeToolImages } from './tool-images';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const worktreeErrnos = new Set([
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOTDIR',
  'ENOEXEC',
  'EAGAIN',
  'ENOMEM',
  'EMFILE',
  'ENFILE',
  'E2BIG',
  'EINVAL',
  'EIO',
  'ENOSPC',
  'EROFS',
  'EBUSY',
  'EEXIST',
  'ENOTEMPTY',
  'ELOOP',
  'ENAMETOOLONG',
  'ETXTBSY',
  'ECANCELED',
]);

function worktreeFailure(
  execution: Execution,
  run: Run | undefined,
  details: Record<string, unknown> | undefined,
): NativeToolMessageFact['worktreeFailure'] {
  if (
    execution.definitionId !== 'git.worktree' ||
    execution.definitionVersion !== '1' ||
    !['failed', 'outcome_unknown'].includes(execution.status) ||
    !details ||
    run?.id !== execution.runId ||
    run.sessionId !== execution.sessionId ||
    run.originStoreId !== execution.originStoreId
  )
    return;
  const tools = object(run.configuration)?.tools;
  const registrations = Array.isArray(tools)
    ? tools.map(object).filter((tool) => tool?.id === 'git.worktree' && tool.version === '1')
    : [];
  if (registrations.length !== 1 || registrations[0]?.extensionId !== 'builtin.shell') return;
  const mutation =
    execution.status !== 'outcome_unknown' &&
    typeof details.mutation === 'string' &&
    ['not_started', 'completed', 'partial', 'unknown'].includes(details.mutation)
      ? (details.mutation as NonNullable<NativeToolMessageFact['worktreeFailure']>['mutation'])
      : 'unknown';
  if (details.failure === undefined && details.code === 'git_operation_failed')
    return { category: 'unclassified', mutation };
  if (
    details.failure === undefined &&
    details.code === 'permission_denied' &&
    execution.status === 'failed' &&
    details.adapterAttempted === false &&
    details.dispatchCommitted === false
  )
    return {
      category: 'authorization_denied',
      mutation: details.mutation === undefined ? 'not_started' : mutation,
    };
  const failure = object(details.failure);
  if (
    !failure ||
    Object.keys(failure).some(
      (key) => !['category', 'errno', 'exitCode', 'cleanupUnconfirmed'].includes(key),
    ) ||
    typeof failure.category !== 'string' ||
    !['process_start', 'permission_denied', 'git_command', 'verification'].includes(
      failure.category,
    ) ||
    (failure.errno !== undefined &&
      (typeof failure.errno !== 'string' || !worktreeErrnos.has(failure.errno))) ||
    (failure.exitCode !== undefined &&
      (!Number.isInteger(failure.exitCode) ||
        Number(failure.exitCode) < -2147483648 ||
        Number(failure.exitCode) > 2147483647 ||
        failure.exitCode === 0)) ||
    (failure.cleanupUnconfirmed !== undefined && failure.cleanupUnconfirmed !== true) ||
    (failure.category === 'git_command' && failure.exitCode === undefined)
  )
    return;
  return {
    category: failure.category as NonNullable<NativeToolMessageFact['worktreeFailure']>['category'],
    mutation,
    ...(failure.errno === undefined ? {} : { errno: failure.errno as string }),
    ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode as number }),
    ...(failure.cleanupUnconfirmed === true ? { cleanupUnconfirmed: true } : {}),
  };
}
const source = (message: Message) =>
  message.originMessage
    ? { sessionId: message.originMessage.sessionId, runId: message.originMessage.runId }
    : { sessionId: message.sessionId, runId: message.runId };

function callInput(
  message: Message,
  definitionId: string,
  messages: Iterable<Message>,
  sessionId: string,
) {
  if (!message.toolCallId) return undefined;
  const original = source(message);
  const calls = [...messages].flatMap((candidate) => {
    const origin = source(candidate);
    return candidate.role === 'assistant' &&
      candidate.sessionId === sessionId &&
      candidate.originMessage?.storeId === message.originMessage?.storeId &&
      origin.sessionId === original.sessionId &&
      origin.runId === original.runId &&
      BigInt(candidate.seq) < BigInt(message.seq)
      ? (candidate.toolCalls ?? [])
          .filter((call) => call.id === message.toolCallId)
          .map((call) => ({ candidate, call }))
      : [];
  });
  // Readiness cannot hide an observed duplicate of the original call.
  if (
    calls.length !== 1 ||
    calls[0]!.candidate.status !== 'complete' ||
    calls[0]!.candidate.contentFormat === 'unsupported' ||
    calls[0]!.call.name !== definitionId
  )
    return undefined;
  try {
    return object(JSON.parse(calls[0]!.call.arguments));
  } catch {
    return undefined;
  }
}
function shellInput(
  execution: Execution,
  input: Record<string, unknown> | undefined,
  offset: number,
): NativeShellInput | undefined {
  const declaredOperation = execution.definitionId.slice('shell.'.length);
  if (
    execution.definitionVersion !== '1' ||
    !execution.definitionId.startsWith('shell.') ||
    !['execute', 'launch', 'read', 'wait', 'stop'].includes(declaredOperation)
  ) {
    if (offset) throw new ClientError('tool_message_command_offset_invalid');
    return;
  }
  const original = object(execution.toolInput);
  const operation =
    declaredOperation === 'execute' &&
    input?.background === true &&
    (!original || original.background === true)
      ? 'launch'
      : declaredOperation;
  const commandOperation = operation === 'execute' || operation === 'launch';
  const shellId = input?.[commandOperation ? 'key' : 'shellId'];
  const fact: NativeShellInput = {
    operation: operation as NativeShellInput['operation'],
    ...(typeof shellId === 'string' &&
    (!original || original[commandOperation ? 'key' : 'shellId'] === shellId)
      ? { shellId }
      : {}),
  };
  const command = commandOperation ? input?.command : undefined;
  if (
    typeof command !== 'string' ||
    !command ||
    [...command].length > 262144 ||
    (original &&
      (original.command !== command ||
        original.key !== shellId ||
        original.background !== input?.background ||
        original.description !== input?.description))
  ) {
    if (offset) throw new ClientError('tool_message_command_offset_invalid');
    return fact;
  }
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > command.length ||
    (offset > 0 &&
      /[\uDC00-\uDFFF]/.test(command[offset] ?? '') &&
      /[\uD800-\uDBFF]/.test(command[offset - 1] ?? ''))
  )
    throw new ClientError('tool_message_command_offset_invalid');
  let fragment = '',
    bytes = 0;
  for (const point of command.slice(offset)) {
    // Bound both original UTF-8 and JSON escaping, so 32 fragments fit one IPC page.
    const size = Buffer.byteLength(JSON.stringify(point)) - 2;
    if (bytes + size > nativeShellCommandChunkBytes) break;
    fragment += point;
    bytes += size;
  }
  return {
    ...fact,
    command: fragment,
    commandOffset: offset,
    commandNextOffset: offset + fragment.length < command.length ? offset + fragment.length : null,
  };
}

/** Original live request facts only. This never projects a Tool or Job outcome. */
export function nativeLiveShellInputFact(
  execution: Execution,
  commandOffset = 0,
): NativeToolMessageFact | undefined {
  if (
    execution.kind !== 'tool' ||
    !execution.originStoreId ||
    !execution.runId ||
    !execution.toolCallId
  )
    return;
  const input = object(execution.toolInput);
  const shell = shellInput(execution, input, commandOffset);
  if (!shell) return;
  return {
    messageId: `native-execution:${execution.id}`,
    executionId: execution.id,
    definitionId: execution.definitionId,
    definitionVersion: execution.definitionVersion,
    status: execution.status,
    resultRevision: execution.resultRevision,
    target: nativeToolRequestTarget(input, execution.definitionId, execution.definitionVersion),
    shellInput: shell,
    inputSource: {
      storeId: execution.originStoreId,
      sessionId: execution.sessionId,
      runId: execution.runId,
      toolCallId: execution.toolCallId,
    },
  };
}

function savedToolInput(
  execution: Execution,
  message: Message,
  messages: readonly Message[],
  sessionId: string,
) {
  if (
    !message.toolCallId ||
    execution.toolCallId !== message.toolCallId ||
    (nativeToolRequestTarget(
      execution.toolInput,
      execution.definitionId,
      execution.definitionVersion,
    ) === undefined &&
      !(execution.definitionVersion === '1' && execution.definitionId.startsWith('shell.')))
  )
    return;
  const original = source(message);
  const scoped = messages.filter((candidate) => {
    const origin = source(candidate);
    return (
      candidate.role === 'assistant' &&
      candidate.sessionId === sessionId &&
      candidate.originMessage?.storeId === message.originMessage?.storeId &&
      origin.sessionId === original.sessionId &&
      origin.runId === original.runId &&
      BigInt(candidate.seq) < BigInt(message.seq)
    );
  });
  // A visible conflicting or ambiguous call is never an omission fallback.
  if (
    scoped.some((candidate) => candidate.toolCalls?.some((call) => call.id === message.toolCallId))
  )
    return;
  // Exact Tool input is already a public request fact. Independent Model history
  // may still be incomplete; it cannot hide this request or invent another one.
  return object(execution.toolInput);
}
function ask(input: Record<string, unknown> | undefined, content: string) {
  let result: Record<string, unknown> | undefined;
  try {
    result = object(JSON.parse(content));
  } catch {
    return;
  }
  if (!result) return;
  const questions =
    Array.isArray(input?.questions) && input.questions.length >= 1 && input.questions.length <= 3
      ? input.questions.flatMap((value, index) => {
          const question = object(value);
          return typeof question?.question === 'string' && question.question.trim()
            ? [{ id: `q${index + 1}`, question: question.question.trim() }]
            : [];
        })
      : [];
  if (result.cancelled === true && Object.keys(result).length === 1)
    return { questions, cancelled: true };
  const answers = object(result.answers);
  if (
    Object.keys(result).length !== 2 ||
    typeof result.answer !== 'string' ||
    !answers ||
    Object.entries(answers).some(
      ([key, value]) => !/^q[1-3]$/.test(key) || typeof value !== 'string',
    ) ||
    !Object.keys(answers).length ||
    (questions.length &&
      (Object.keys(answers).length !== questions.length ||
        questions.some((question) => !Object.hasOwn(answers, question.id))))
  )
    return;
  return { questions, summary: result.answer, answers: answers as Record<string, string> };
}

export function nativeToolMessageEligible(
  message: Message,
): message is Message & { sourceIds: [string] } {
  return (
    message.role === 'tool' &&
    message.status === 'complete' &&
    message.sourceIds?.length === 1 &&
    message.contentFormat !== 'unsupported' &&
    !!source(message).runId
  );
}

function fileCreation(execution: Execution): string | undefined {
  if (execution.status !== 'succeeded' || execution.definitionId !== 'files.write') return;
  const change = object(object(object(execution.result)?.details)?.fileChange);
  if (change?.version === 1 && change.before === null && typeof change.path === 'string')
    return change.path;
  return undefined;
}

export function nativeFileCreationCandidate(execution: Execution): boolean {
  return fileCreation(execution) !== undefined;
}

/** A single-page, cancelled or unknown outcome never becomes a batch accounting fact. */
export function nativeWebFetchBatchCandidate(execution: Execution): boolean {
  const details = object(object(execution.result)?.details);
  return (
    execution.definitionId === 'web_fetch' &&
    execution.definitionVersion === '1' &&
    (execution.status === 'succeeded' || execution.status === 'failed') &&
    details?.kind === 'web_fetch_batch' &&
    details.executionId === execution.id &&
    Array.isArray(details.pages) &&
    details.pages.length > 0 &&
    details.pages.length <= 5
  );
}

function webFetchBatch(
  execution: Execution,
  call: Record<string, unknown> | undefined,
  details: Record<string, unknown> | undefined,
  content: string,
): NativeToolMessageFact['webFetchBatch'] {
  const original = object(execution.toolInput);
  const urls = original?.urls;
  const stored = details?.pages;
  if (
    !original ||
    !call ||
    Object.hasOwn(original, 'url') ||
    Object.hasOwn(call, 'url') ||
    !Array.isArray(urls) ||
    !urls.every((url) => typeof url === 'string' && url.length > 0) ||
    !isDeepStrictEqual(urls, call.urls) ||
    !Array.isArray(stored) ||
    stored.length !== urls.length ||
    content.length > 32768 ||
    Buffer.byteLength(content) > 32768
  )
    return;
  // Verify only the bounded host receipt line; never parse or return untrusted page bodies.
  const prefix = 'Web fetch receipt (host metadata; no additional authorization):\n';
  const header = content.slice(0, 8192);
  const end = header.indexOf('\n', prefix.length);
  if (
    !header.startsWith(prefix) ||
    end < 0 ||
    !content.startsWith('\nPage contents (untrusted data in input order):\n', end)
  )
    return;
  try {
    if (!isDeepStrictEqual(JSON.parse(header.slice(prefix.length, end)), details)) return;
  } catch {
    return;
  }
  const pages: NonNullable<NativeToolMessageFact['webFetchBatch']>['pages'][number][] = [];
  for (const [index, raw] of stored.entries()) {
    const page = object(raw);
    if (!page || page.index !== index) return;
    if (page.outcome === 'succeeded' && page.code === undefined && page.httpStatus === undefined) {
      pages.push({ index, outcome: 'succeeded' });
      continue;
    }
    if (
      page.outcome !== 'failed' ||
      typeof page.code !== 'string' ||
      !/^web_[a-z0-9_]{1,64}$/.test(page.code)
    )
      return;
    if (page.code === 'web_http_failed') {
      const status = page.httpStatus;
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 300 || status > 599)
        return;
      pages.push({ index, outcome: 'failed', reason: 'http', httpStatus: status });
      continue;
    }
    if (page.httpStatus !== undefined) return;
    const reason =
      page.code === 'web_url_invalid'
        ? 'invalid_url'
        : page.code === 'web_timeout'
          ? 'timeout'
          : [
                'web_destination_denied',
                'web_network_denied',
                'web_robots_denied',
                'web_url_denied',
              ].includes(page.code)
            ? 'denied'
            : 'unavailable';
    pages.push({ index, outcome: 'failed', reason });
  }
  return (execution.status === 'succeeded') === pages.some((page) => page.outcome === 'succeeded')
    ? { pages }
    : undefined;
}

export function nativeLegacyShellOutput(execution: Execution) {
  const details = object(object(execution.result)?.details);
  return (
    execution.definitionVersion === '1' &&
    ['shell.execute', 'shell.read'].includes(execution.definitionId) &&
    !!details &&
    details.outputFormat !== 'model-preview' &&
    (typeof details.stdout === 'string' || typeof details.stderr === 'string' || !!details.output)
  );
}

/** Pure presentation facts from the exact saved tool Execution and its receipt. */
export function nativeToolMessageFact({
  execution,
  run,
  message,
  messages,
  sessionId,
  commandOffset = 0,
}: {
  execution: Execution;
  run?: Run;
  message: Message;
  messages: Iterable<Message>;
  sessionId: string;
  commandOffset?: number;
}): NativeToolMessageFact | undefined {
  if (!nativeToolMessageEligible(message)) return undefined;
  const origin = source(message);
  if (
    execution.id !== message.sourceIds[0] ||
    !execution.originStoreId ||
    (message.originMessage && execution.originStoreId !== message.originMessage.storeId) ||
    execution.sessionId !== origin.sessionId ||
    execution.runId !== origin.runId
  )
    throw new ClientError('tool_message_identity_mismatch');
  const result = object(execution.result);
  if (
    execution.kind !== 'tool' ||
    !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status) ||
    result?.outcome !== execution.status ||
    typeof result.content !== 'string' ||
    (message.deferredText
      ? Buffer.byteLength(result.content) !== Number(message.deferredText.bytes) ||
        createHash('sha256').update(result.content).digest('hex') !== message.deferredText.sha256
      : result.content !== message.content)
  )
    return undefined;
  const history = [...messages];
  let call =
    callInput(message, execution.definitionId, history, sessionId) ??
    savedToolInput(execution, message, history, sessionId);
  if (execution.toolCallId !== undefined && execution.toolCallId !== message.toolCallId)
    call = undefined;
  if (
    call &&
    execution.toolInput !== undefined &&
    !execution.definitionId.startsWith('shell.') &&
    nativeToolRequestTarget(call, execution.definitionId, execution.definitionVersion) !==
      nativeToolRequestTarget(
        execution.toolInput,
        execution.definitionId,
        execution.definitionVersion,
      )
  )
    call = undefined;
  const details = object(result.details);
  const worktreeIssue = worktreeFailure(execution, run, details);
  const configuration = object(run?.configuration);
  const registered = Array.isArray(configuration?.tools)
    ? configuration.tools
        .map(object)
        .filter(
          (tool) =>
            tool?.id === execution.definitionId && tool.version === execution.definitionVersion,
        )
    : [];
  const webBatch =
    nativeWebFetchBatchCandidate(execution) &&
    execution.toolCallId &&
    execution.toolCallId === message.toolCallId &&
    run?.id === execution.runId &&
    run.sessionId === execution.sessionId &&
    run.originStoreId === execution.originStoreId &&
    registered.length === 1 &&
    registered[0]?.extensionId === 'builtin.web'
      ? webFetchBatch(execution, call, details, result.content)
      : undefined;
  const fileMissing =
    execution.definitionId === 'files.read' &&
    ['4', '5'].includes(execution.definitionVersion) &&
    execution.status === 'succeeded' &&
    run?.id === execution.runId &&
    run.sessionId === execution.sessionId &&
    run.originStoreId === execution.originStoreId &&
    registered.length === 1 &&
    registered[0]?.extensionId === 'builtin.files' &&
    typeof call?.path === 'string' &&
    details?.path === call.path &&
    details.exists === false &&
    Object.keys(details).every((key) =>
      ['path', 'exists', 'fileScope', 'workspaceCheckpoint'].includes(key),
    ) &&
    Object.keys(result).every((key) => ['outcome', 'content', 'details'].includes(key)) &&
    result.content === `File does not exist: ${JSON.stringify(call.path)}.`;
  const createdPath = fileCreation(execution);
  const fileCreated =
    createdPath !== undefined &&
    run?.id === execution.runId &&
    run.sessionId === execution.sessionId &&
    run.originStoreId === execution.originStoreId &&
    registered.length === 1 &&
    registered[0]?.extensionId === 'builtin.files' &&
    createdPath === call?.path;
  const agentMessageAccepted =
    execution.definitionId === 'task.message' &&
    execution.definitionVersion === '1' &&
    execution.status === 'succeeded' &&
    run?.id === execution.runId &&
    run.sessionId === execution.sessionId &&
    run.originStoreId === execution.originStoreId &&
    registered.length === 1 &&
    registered[0]?.extensionId === 'builtin.task' &&
    isDeepStrictEqual(details, { accepted: true, delivery: 'queued' }) &&
    Object.keys(result).every((key) => ['outcome', 'content', 'details'].includes(key)) &&
    result.content === '{"accepted":true,"delivery":"queued"}';
  const registeredAgentWait =
    execution.definitionId === 'task.events' &&
    execution.definitionVersion === '1' &&
    run?.id === execution.runId &&
    run.sessionId === execution.sessionId &&
    run.originStoreId === execution.originStoreId &&
    registered.length === 1 &&
    registered[0]?.extensionId === 'builtin.task';
  let agentWait: NativeToolMessageFact['agentWait'];
  if (registeredAgentWait && execution.status === 'succeeded') {
    const reason = details?.reason;
    if (
      (reason === 'events' ||
        reason === 'completed' ||
        reason === 'input' ||
        reason === 'timeout') &&
      Array.isArray(details?.events) &&
      details.events.length <= 200
    )
      agentWait = {
        reason,
        events: details.events.length,
        ...(details.history_gap === true ? { historyGap: true } : {}),
      };
  } else if (registeredAgentWait && execution.status === 'failed') {
    const error = object(details?.error);
    const code = nativeAgentWaitErrors.find((candidate) => candidate === error?.code);
    if (code && typeof error?.message === 'string' && typeof error.next_action === 'string') {
      try {
        if (isDeepStrictEqual(object(JSON.parse(result.content))?.error, error))
          agentWait = { reason: 'failed', code };
      } catch {
        // Keep the original result when the receipt does not have the recognized envelope.
      }
    }
  }
  let shell = shellInput(execution, call, commandOffset);
  let shellResultVerified = false;
  let shellJobExecutionId: string | undefined;
  let shellOutputReceipt: NativeToolMessageFact['shellOutputReceipt'];
  if (shell && details) {
    try {
      const ref = object(details.ref);
      // New calls do not supply a key. Only the exact saved builtin receipt can
      // supply its returned handle; live inputs never invent the internal key.
      const returnedShellId =
        execution.definitionId === 'shell.execute' &&
        call &&
        !Object.hasOwn(call, 'key') &&
        shell.command !== undefined &&
        typeof details.shell_id === 'string'
          ? details.shell_id
          : undefined;
      const shellId = shell.shellId ?? returnedShellId;
      const savedPreview = details.outputFormat === 'model-preview';
      shellResultVerified =
        !!shellId &&
        ref?.key === shellId &&
        ref.extensionId === 'builtin.shell' &&
        ref.sessionId === execution.sessionId &&
        ref.originStoreId === execution.originStoreId &&
        typeof ref.commandId === 'string' &&
        !!ref.commandId &&
        typeof ref.executionId === 'string' &&
        !!ref.executionId &&
        (savedPreview || isDeepStrictEqual(JSON.parse(result.content), details));
      if (savedPreview && shellResultVerified) {
        const job = object(details.execution);
        const jobResult = object(job?.result);
        const jobDetails = object(jobResult?.details);
        const status = job?.status as NonNullable<
          NativeToolMessageFact['shellOutputReceipt']
        >['jobStatus'];
        const isTerminal = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
          String(status),
        );
        shellResultVerified =
          ['execute', 'read'].includes(shell.operation) &&
          [
            'planned',
            'dispatching',
            'running',
            'succeeded',
            'failed',
            'cancelled',
            'outcome_unknown',
          ].includes(String(status)) &&
          job?.id === ref?.executionId &&
          job?.sessionId === ref?.sessionId &&
          job?.originStoreId === ref?.originStoreId &&
          job?.kind === 'job' &&
          job.definitionId === 'shell.command' &&
          job.definitionVersion === '1' &&
          (!isTerminal ||
            (jobResult?.outcome === status && typeof jobResult?.content === 'string')) &&
          typeof details.outputLimited === 'boolean' &&
          ['stdout', 'stderr', 'output'].every((key) => details[key] === undefined) &&
          (shell.operation === 'execute'
            ? isTerminal &&
              execution.status ===
                (details.timedOut === true && status === 'cancelled' ? 'failed' : status)
            : typeof details.next_cursor === 'string' &&
              typeof details.caught_up === 'boolean' &&
              typeof details.terminal === 'boolean');
        if (shellResultVerified)
          shellOutputReceipt = {
            jobStatus: status,
            failureReason: desktopShellFailure(status, jobResult),
            ...(Number.isSafeInteger(jobDetails?.exitCode)
              ? { exitCode: Number(jobDetails?.exitCode) }
              : {}),
            ...(typeof details.timedOut === 'boolean' ? { timedOut: details.timedOut } : {}),
            outputComplete:
              shell.operation === 'execute' &&
              details.truncated === false &&
              details.outputLimited === false,
          };
      }
      if (shellResultVerified && !shell.shellId) shell = { ...shell, shellId };
      if (
        shellResultVerified &&
        shell.operation === 'launch' &&
        execution.status === 'succeeded' &&
        details.accepted === true &&
        details.shellId === shellId &&
        typeof ref?.executionId === 'string'
      )
        shellJobExecutionId = ref.executionId;
    } catch {
      // Original non-JSON failures retain their existing body reader and error text.
    }
  }
  const decisionRefresh =
    execution.status === 'failed' &&
    execution.authorization?.dispatched === false &&
    details?.adapterAttempted === false &&
    details.dispatchCommitted === false &&
    ['context_refresh_required', 'capability_refresh_required'].includes(String(details.code)) &&
    result.content === details.code
      ? (details.code as 'context_refresh_required' | 'capability_refresh_required')
      : undefined;
  const requestedTokens = (object(execution.toolInput) ?? call)?.max_output_tokens;
  const modelTokenLimit =
    run?.id === execution.runId &&
    run.sessionId === execution.sessionId &&
    run.originStoreId === execution.originStoreId
      ? frozenModelInputLimit(run.configuration)
      : undefined;
  const legacyShellOutput = shellResultVerified && nativeLegacyShellOutput(execution);
  const requestTarget = nativeToolRequestTarget(
    shell && ['execute', 'launch'].includes(shell.operation) && shell.command === undefined
      ? undefined
      : call,
    execution.definitionId,
    execution.definitionVersion,
  );
  const expectedTarget = nativeToolRequestTarget(
    execution.toolInput,
    execution.definitionId,
    execution.definitionVersion,
  );
  const planPath = details?.filePath;
  const planLocation =
    typeof planPath === 'string' &&
    planPath.trim() &&
    planPath.length <= 4096 &&
    !/\p{Cc}/u.test(planPath)
      ? planPath
      : undefined;
  const planReadTarget =
    execution.definitionId === 'planning.read' &&
    execution.definitionVersion === '1' &&
    execution.status === 'succeeded'
      ? (planLocation ??
        (details?.current === null && details.plan === null ? '暂无计划' : undefined))
      : undefined;
  const reinspection =
    execution.definitionId === 'files.reinspect_images' &&
    execution.definitionVersion === '1' &&
    execution.status === 'succeeded'
      ? nativeImageReinspection(execution, result, call)
      : undefined;
  const fact: NativeToolMessageFact = {
    messageId: message.id,
    executionId: execution.id,
    definitionId: execution.definitionId,
    definitionVersion: execution.definitionVersion,
    status: execution.status,
    resultRevision: execution.resultRevision,
    ...(result.modelImages !== undefined ? { images: nativeToolImages(execution) } : {}),
    ...reinspection,
    ...(decisionRefresh ? { decisionRefresh } : {}),
    ...(fileMissing ? { fileMissing: true } : {}),
    ...(fileCreated ? { fileCreated: true } : {}),
    ...(agentMessageAccepted ? { agentMessageAccepted: true } : {}),
    ...(agentWait ? { agentWait } : {}),
    ...(webBatch ? { webFetchBatch: webBatch } : {}),
    target: planReadTarget ?? requestTarget,
    ...(expectedTarget !== undefined && requestTarget === undefined ? { inputPending: true } : {}),
    ...(shell ? { shellInput: shell } : {}),
    ...(shell?.shellId &&
    call &&
    execution.toolCallId === message.toolCallId &&
    execution.toolCallId
      ? {
          inputSource: {
            storeId: execution.originStoreId!,
            sessionId: execution.sessionId,
            runId: execution.runId!,
            toolCallId: execution.toolCallId,
          },
        }
      : {}),
    ...(shellResultVerified ? { shellResultVerified: true } : {}),
    ...(shellJobExecutionId ? { shellJobExecutionId } : {}),
    ...(shellOutputReceipt ? { shellOutputReceipt } : {}),
    ...(legacyShellOutput
      ? {
          shellOutputLimit: {
            ...(typeof requestedTokens === 'number' ? { requestedTokens } : {}),
            ...(modelTokenLimit === undefined ? {} : { modelTokenLimit }),
          },
        }
      : {}),
    ...(worktreeIssue ? { worktreeFailure: worktreeIssue } : {}),
    ...(!message.originMessage && execution.authorization
      ? { authorization: execution.authorization }
      : {}),
    ...(execution.definitionId === 'ask_user' &&
    execution.definitionVersion === '1' &&
    execution.status === 'succeeded'
      ? { ask: ask(call, message.content) }
      : {}),
  };
  if (message.deferredText && shell && commandOffset === 0) {
    const projected = desktopShell(fact, result.content);
    if (
      projected &&
      (projected.output !== undefined || projected.jobStatus || projected.accepted)
    ) {
      fact.shellDisplay = {
        output: projected.output ?? '',
        failureReason: projected.failureReason,
        jobStatus: projected.jobStatus,
        exitCode: projected.exitCode,
        timedOut: projected.timedOut,
        outputComplete: projected.outputComplete,
        accepted: projected.accepted,
        cancelRequested: projected.cancelRequested,
      };
    } else if (
      !shellResultVerified &&
      execution.status !== 'succeeded' &&
      !/^[\s\uFEFF]*[[{]/u.test(result.content)
    ) {
      fact.shellDisplay = { output: '', failureReason: result.content };
    } else {
      fact.shellOutputError = true;
    }
  }
  return fact;
}

/** These summary facts carry no image handles or preview authority. */
function nativeImageReinspection(
  execution: Execution,
  result: Record<string, unknown>,
  call: Record<string, unknown> | undefined,
): Pick<NativeToolMessageFact, 'reinspectedImages' | 'imageSourcesListed'> | undefined {
  let content: Record<string, unknown> | undefined;
  try {
    content = object(JSON.parse(String(result.content)));
  } catch {
    return;
  }
  if (
    call?.list === true &&
    Array.isArray(content?.sources) &&
    (content.nextBeforeSeq === null || typeof content.nextBeforeSeq === 'string')
  )
    return { imageSourcesListed: true };
  const images = result.modelImages;
  if (
    content?.kind === 'selected_original_images' &&
    Array.isArray(content.ordinals) &&
    Array.isArray(images) &&
    images.length > 0 &&
    images.length <= 4 &&
    images.length === content.ordinals.length &&
    isDeepStrictEqual(images, result.artifactRefs) &&
    images.every((image) => {
      const ref = object(image),
        scope = object(ref?.scope);
      return (
        ref?.mediaType === 'image/png' && scope?.kind === 'execution' && scope.id === execution.id
      );
    })
  )
    return { reinspectedImages: images.length };
  return undefined;
}
