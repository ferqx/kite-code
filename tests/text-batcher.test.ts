import { describe, expect, test } from 'bun:test';
import { createInitialState, eventReducer } from '../src/app/tui/App';
import type { Action } from '../src/app/tui/reducers/actions';
import { TextBatcher } from '../src/app/tui/text-batcher';
import type { OutputBlock, TuiState } from '../src/app/tui/types';

function dispatch(s: TuiState, a: Action): TuiState {
  return eventReducer(s, a);
}

function flatBlocks(s: TuiState) {
  return s.turns.flatMap((t) => t.blocks);
}

describe('TextBatcher', () => {
  test('dispatches the first running text event immediately', () => {
    const actions: Action[] = [];
    const batcher = new TextBatcher((action) => actions.push(action), 1000);
    batcher.setRunning(true);

    batcher.push({ type: 'text', data: { text: 'first token' } });

    expect(actions).toEqual([
      { type: 'EVENT', event: { type: 'text', data: { text: 'first token' } } },
    ]);
  });

  test('first running text event immediately settles the active Thought summary', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, {
      type: 'EVENT',
      event: { type: 'reason', data: { text: 'checking files' } },
    });
    state = dispatch(state, {
      type: 'EVENT',
      event: {
        type: 'tool_call',
        data: { call_id: 'read-1', name: 'read_file', args: { path: 'package.json' } },
      },
    });
    state = dispatch(state, {
      type: 'EVENT',
      event: {
        type: 'tool_done',
        data: { call_id: 'read-1', name: 'read_file', ok: true, summary: 'ok' },
      },
    });

    const batcher = new TextBatcher((action) => {
      state = dispatch(state, action);
    }, 1000);
    batcher.setRunning(true);

    batcher.push({ type: 'text', data: { text: 'Here is the answer' } });

    const summary = flatBlocks(state).find(
      (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
        block.kind === 'tool_summary',
    );
    expect(summary).toBeDefined();
    expect(summary!.active).toBe(false);
    expect(summary!.result).toBe('done');
    expect(state.currentThoughtSummaryId).toBeUndefined();
  });
});
