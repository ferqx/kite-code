import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@/core/runtime/events';
import { assertRuntimeStateInvariants } from '@/core/runtime/invariants';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';

function queuedEvent(index: number): RuntimeEvent {
  return {
    type: 'tool.queued',
    toolCallId: `read-${index}`,
    name: 'read_file',
    args: { path: `file-${index}.ts` },
  };
}

describe('Runtime long-replay qualification lifecycle', () => {
  test('replays a long deterministic event stream without violating invariants', () => {
    let state = createInitialRuntimeState({ threadId: 'stress', userId: 'u', workspace: '/' });
    for (let index = 0; index < 10_000; index++) {
      state = reduceRuntimeState(state, queuedEvent(index));
      if (index % 100 === 0) assertRuntimeStateInvariants(state);
    }
    expect(Object.keys(state.tools.calls)).toHaveLength(10_000);
    expect(state.tools.queue).toHaveLength(10_000);
  }, 15_000);
});
