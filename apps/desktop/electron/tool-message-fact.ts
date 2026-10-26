import { isDeepStrictEqual } from 'node:util';
import { ClientError, type Execution, type Message } from '@kite-ai/client';
import {
  type NativeShellInput,
  type NativeToolMessageFact,
  nativeShellCommandChunkBytes,
} from '../src/tool-messages-bridge';
import { nativeToolRequestTarget } from '../src/tool-request-target';
import { nativeToolImages } from './tool-images';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
  const operation = execution.definitionId.slice('shell.'.length);
  if (
    execution.definitionVersion !== '1' ||
    !execution.definitionId.startsWith('shell.') ||
    !['execute', 'launch', 'read', 'wait', 'stop'].includes(operation)
  ) {
    if (offset) throw new ClientError('tool_message_command_offset_invalid');
    return;
  }
  const original = object(execution.toolInput);
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
    (original && (original.command !== command || original.key !== shellId))
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

/** Pure presentation facts from the exact saved tool Execution and its receipt. */
export function nativeToolMessageFact({
  execution,
  message,
  messages,
  sessionId,
  commandOffset = 0,
}: {
  execution: Execution;
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
    result.content !== message.content
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
  const shell = shellInput(execution, call, commandOffset);
  let shellResultVerified = false;
  if (shell && details) {
    try {
      const ref = object(details.ref);
      shellResultVerified =
        isDeepStrictEqual(JSON.parse(message.content), details) &&
        !!shell.shellId &&
        ref?.key === shell.shellId &&
        ref.extensionId === 'builtin.shell' &&
        ref.sessionId === execution.sessionId &&
        ref.originStoreId === execution.originStoreId &&
        typeof ref.commandId === 'string' &&
        !!ref.commandId &&
        typeof ref.executionId === 'string' &&
        !!ref.executionId;
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
  return {
    messageId: message.id,
    executionId: execution.id,
    definitionId: execution.definitionId,
    definitionVersion: execution.definitionVersion,
    status: execution.status,
    resultRevision: execution.resultRevision,
    ...(result.modelImages !== undefined ? { images: nativeToolImages(execution) } : {}),
    ...(decisionRefresh ? { decisionRefresh } : {}),
    target: requestTarget,
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
    ...(!message.originMessage && execution.authorization
      ? { authorization: execution.authorization }
      : {}),
    ...(execution.definitionId === 'ask_user' &&
    execution.definitionVersion === '1' &&
    execution.status === 'succeeded'
      ? { ask: ask(call, message.content) }
      : {}),
  };
}
