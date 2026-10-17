/** Local Responses SSE shapes follow https://developers.openai.com/api/reference/resources/responses/streaming-events .
 * No fixed ModelAdapter, remote Provider, credentials or opaque-state decryption.
 * partial_completed is deliberately inconsistent adversarial input.
 */
export interface WireCall {
  id: string;
  name: string;
  arguments: string;
}
export interface WireTurn {
  id: string;
  model?: string;
  calls?: WireCall[];
  text?: string[];
  encrypted?: string;
  inputTokens?: number;
  outputTokens?: number;
  ending?:
    | 'completed'
    | 'failed'
    | 'eof'
    | 'partial_call'
    | 'partial_completed'
    | 'error'
    | 'incomplete'
    | 'partial_incomplete';
}
export function responseFrames(
  turn: WireTurn,
  request: Record<string, unknown> = {},
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const output: Record<string, unknown>[] = [];
  const emit = (type: string, data: Record<string, unknown>) =>
    events.push({ type, sequence_number: events.length, ...data });
  const response = (status: string) => ({
    id: turn.id,
    object: 'response',
    created_at: 1_760_601_600,
    status,
    error: status === 'failed' ? { code: 'server_error', message: 'local fixture failed' } : null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    access_programs: null,
    completed_at: status === 'completed' ? 1_760_601_601 : null,
    model: turn.model ?? 'gpt-5',
    output: structuredClone(output),
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: request.reasoning ?? { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: request.tools ?? [],
    top_p: 1,
    truncation: 'disabled',
    usage: ['completed', 'incomplete'].includes(status)
      ? {
          input_tokens: turn.inputTokens ?? 10,
          output_tokens: turn.outputTokens ?? 4,
          total_tokens: (turn.inputTokens ?? 10) + (turn.outputTokens ?? 4),
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        }
      : null,
    user: null,
    metadata: {},
  });
  emit('response.created', { response: response('in_progress') });
  emit('response.in_progress', { response: response('in_progress') });
  if (turn.encrypted) {
    const item = {
      id: `rs_${turn.id}`,
      type: 'reasoning',
      summary: [],
      encrypted_content: turn.encrypted,
    };
    emit('response.output_item.added', {
      output_index: output.length,
      item: { ...item, encrypted_content: null },
    });
    emit('response.output_item.done', { output_index: output.length, item });
    output.push(item);
  }
  // Interleave the two halves of each argument to exercise call-index demultiplexing.
  const calls = (turn.calls ?? []).map((call, i) => ({
    index: output.length + i,
    item: {
      type: 'function_call',
      id: `fc_${call.id}`,
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: 'completed',
    },
  }));
  for (const { index, item } of calls)
    emit('response.output_item.added', {
      output_index: index,
      item: { ...item, arguments: '', status: 'in_progress' },
    });
  for (const half of [0, 1]) {
    for (const { index, item } of calls) {
      const midpoint = Math.max(1, Math.floor(item.arguments.length / 2));
      emit('response.function_call_arguments.delta', {
        output_index: index,
        item_id: item.id,
        delta: half === 0 ? item.arguments.slice(0, midpoint) : item.arguments.slice(midpoint),
      });
    }
    if (
      half === 0 &&
      ['partial_call', 'partial_completed', 'partial_incomplete'].includes(turn.ending ?? '')
    ) {
      if (turn.ending === 'partial_completed')
        emit('response.completed', { response: response('completed') });
      if (turn.ending === 'partial_incomplete') {
        for (const { item } of calls)
          output.push({
            ...item,
            status: 'incomplete',
            arguments: item.arguments.slice(0, Math.max(1, Math.floor(item.arguments.length / 2))),
          });
        emit('response.incomplete', { response: response('incomplete') });
      }
      return events;
    }
  }
  for (const { index, item } of calls) {
    emit('response.function_call_arguments.done', {
      output_index: index,
      item_id: item.id,
      arguments: item.arguments,
    });
    emit('response.output_item.done', { output_index: index, item });
    output.push(item);
  }
  if (turn.text) {
    const index = output.length;
    const item = {
      id: `msg_${turn.id}`,
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [] as Record<string, unknown>[],
    };
    emit('response.output_item.added', { output_index: index, item });
    emit('response.content_part.added', {
      output_index: index,
      item_id: item.id,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    });
    for (const delta of turn.text)
      emit('response.output_text.delta', {
        output_index: index,
        item_id: item.id,
        content_index: 0,
        delta,
        logprobs: [],
      });
    const part = { type: 'output_text', text: turn.text.join(''), annotations: [], logprobs: [] };
    emit('response.output_text.done', {
      output_index: index,
      item_id: item.id,
      content_index: 0,
      text: part.text,
      logprobs: [],
    });
    emit('response.content_part.done', {
      output_index: index,
      item_id: item.id,
      content_index: 0,
      part,
    });
    const completed = { ...item, status: 'completed', content: [part] };
    emit('response.output_item.done', { output_index: index, item: completed });
    output.push(completed);
  }
  if (turn.ending === 'error')
    emit('error', { code: 'server_error', message: 'local fixture error', param: null });
  else if (turn.ending !== 'eof') {
    const status =
      turn.ending === 'failed'
        ? 'failed'
        : turn.ending === 'incomplete'
          ? 'incomplete'
          : 'completed';
    emit(`response.${status}`, { response: response(status) });
  }
  return events;
}
export function encodeFrames(frames: Record<string, unknown>[]) {
  return frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
}
