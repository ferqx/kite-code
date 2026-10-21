import { ClientError, type Execution, type Message } from '@kite-ai/client';
import type { NativeToolMessageFact } from '../src/tool-messages-bridge';

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
      candidate.status === 'complete' &&
      candidate.contentFormat !== 'unsupported' &&
      candidate.sessionId === sessionId &&
      candidate.originMessage?.storeId === message.originMessage?.storeId &&
      origin.sessionId === original.sessionId &&
      origin.runId === original.runId &&
      BigInt(candidate.seq) < BigInt(message.seq)
      ? (candidate.toolCalls ?? []).filter((call) => call.id === message.toolCallId)
      : [];
  });
  if (calls.length !== 1 || calls[0]!.name !== definitionId) return undefined;
  try {
    return object(JSON.parse(calls[0]!.arguments));
  } catch {
    return undefined;
  }
}
function target(
  input: Record<string, unknown> | undefined,
  definitionId: string,
  definitionVersion: string,
) {
  if (
    input &&
    definitionId === 'files.list' &&
    definitionVersion === '1' &&
    (input.path === undefined || input.path === '')
  )
    return '.';
  const key =
    definitionId === 'shell.launch'
      ? 'command'
      : definitionId.startsWith('shell.')
        ? 'shellId'
        : definitionId === 'files.glob'
          ? 'pattern'
          : definitionId === 'files.search'
            ? 'text'
            : definitionId.startsWith('files.')
              ? 'path'
              : undefined;
  const target = key ? input?.[key] : undefined;
  // A request target remains text; even a known Files request does not grant a file action.
  if (typeof target !== 'string') return undefined;
  const points = [...target];
  return points.slice(0, 4096).join('') + (points.length > 4096 ? '…' : '');
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
}: {
  execution: Execution;
  message: Message;
  messages: Iterable<Message>;
  sessionId: string;
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
  const call = callInput(message, execution.definitionId, messages, sessionId);
  const details = object(result.details);
  const decisionRefresh =
    execution.status === 'failed' &&
    execution.authorization?.dispatched === false &&
    details?.adapterAttempted === false &&
    details.dispatchCommitted === false &&
    ['context_refresh_required', 'capability_refresh_required'].includes(String(details.code)) &&
    result.content === details.code
      ? (details.code as 'context_refresh_required' | 'capability_refresh_required')
      : undefined;
  return {
    messageId: message.id,
    executionId: execution.id,
    definitionId: execution.definitionId,
    definitionVersion: execution.definitionVersion,
    status: execution.status,
    resultRevision: execution.resultRevision,
    ...(decisionRefresh ? { decisionRefresh } : {}),
    target: target(call, execution.definitionId, execution.definitionVersion),
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
