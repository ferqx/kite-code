/** Observe the original compatible protocol inside the current human turn; context tails are not Tool results. */
export type OriginalMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};
export function originalLastIndex(
  messages: readonly OriginalMessage[],
  matches: (message: OriginalMessage) => boolean,
): number {
  for (let index = messages.length - 1; index >= 0; index--)
    if (matches(messages[index]!)) return index;
  return -1;
}
export function originalToolResults(
  messages: readonly OriginalMessage[],
  human: string,
  expected: readonly { id: string; name: string }[],
): boolean {
  const humanIndex = originalLastIndex(
    messages,
    (message) => message.role === 'user' && message.content === human,
  );
  if (humanIndex < 0) throw Error('original_human_request_missing');
  const turn = messages.slice(humanIndex + 1);
  const assistantIndex = originalLastIndex(turn, (message) => message.role === 'assistant');
  if (assistantIndex < 0) {
    if (turn.some((message) => message.role === 'tool')) throw Error('original_tool_call_missing');
    return false;
  }
  const calls = turn[assistantIndex]!.tool_calls;
  if (
    !calls ||
    calls.length !== expected.length ||
    calls.some(
      (call, index) =>
        call.id !== expected[index]!.id || call.function.name !== expected[index]!.name,
    )
  )
    throw Error('original_tool_call_identity_changed');
  const results = turn.slice(assistantIndex + 1).filter((message) => message.role === 'tool');
  if (
    results.length !== expected.length ||
    expected.some(
      (call) => results.filter((result) => result.tool_call_id === call.id).length !== 1,
    )
  )
    throw Error('original_tool_result_identity_changed');
  return true;
}
