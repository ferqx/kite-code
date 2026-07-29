import type { RuntimeState } from './state';

/**
 * Return the contiguous shell segment containing the anchor call.
 *
 * A non-shell call, another model response, or another task boundary ends the
 * segment so shell concurrency cannot jump across an interaction barrier.
 */
export function contiguousShellBatchIds(
  state: Pick<RuntimeState, 'activeTaskId' | 'tools'>,
  anchorId: string,
): string[] {
  const anchorIndex = state.tools.queue.indexOf(anchorId);
  const anchor = state.tools.calls[anchorId];
  if (anchorIndex < 0 || anchor?.name !== 'shell_execute' || !anchor.modelMessageId) return [];

  const anchorTaskId = anchor.taskId ?? state.activeTaskId ?? null;
  const belongsToSegment = (toolCallId: string): boolean => {
    const call = state.tools.calls[toolCallId];
    return (
      call?.name === 'shell_execute' &&
      call.modelMessageId === anchor.modelMessageId &&
      (call.taskId ?? state.activeTaskId ?? null) === anchorTaskId
    );
  };

  let start = anchorIndex;
  while (start > 0 && belongsToSegment(state.tools.queue[start - 1]!)) start -= 1;

  let end = anchorIndex + 1;
  while (end < state.tools.queue.length && belongsToSegment(state.tools.queue[end]!)) end += 1;

  return state.tools.queue.slice(start, end);
}
