import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { createInitialState } from '../apps/kite/src/tui/App';
import { handleRuntimeEventAction } from '../apps/kite/src/tui/reducers/handleEvent';
import type { OutputBlock, TuiState } from '../apps/kite/src/tui/types';
import { currentRuntimeEvent } from './helpers/current-runtime-event';

function reduce(state: TuiState, event: RuntimeEvent): TuiState {
  return handleRuntimeEventAction(state, currentRuntimeEvent(event));
}

function startShell(state: TuiState, callId: string): TuiState {
  state = reduce(state, {
    type: 'tool.queued',
    toolCallId: callId,
    name: 'shell_execute',
    args: { command: `echo ${callId}` },
  });
  return reduce(state, { type: 'tool.started', toolCallId: callId });
}

function shellCard(state: TuiState, callId: string): Extract<OutputBlock, { kind: 'tool_card' }> {
  const block = state.turns
    .flatMap((turn) => turn.blocks)
    .find(
      (candidate): candidate is Extract<OutputBlock, { kind: 'tool_card' }> =>
        candidate.kind === 'tool_card' && candidate.callId === callId,
    );
  if (!block) throw new Error(`Missing shell card ${callId}`);
  return block;
}

describe('TUI shell progress projection', () => {
  test('uses batch lineCount when the chunk contains only the retained tail', () => {
    let state = startShell(createInitialState(), 'shell-batch');
    state = reduce(state, {
      type: 'tool.progress',
      toolCallId: 'shell-batch',
      chunk: 'line-9995\nline-9996\nline-9997\nline-9998\nline-9999',
      stream: 'stdout',
      lineCount: 10_000,
    });

    const card = shellCard(state, 'shell-batch');
    expect(card.liveOutput).toBe('line-9995\nline-9996\nline-9997\nline-9998\nline-9999');
    expect(card.liveTotalLines).toBe(10_000);
  });

  test('preserves an initial blank line before later output', () => {
    let state = startShell(createInitialState(), 'shell-blank-first');
    state = reduce(state, {
      type: 'tool.progress',
      toolCallId: 'shell-blank-first',
      chunk: '',
      stream: 'stdout',
    });
    state = reduce(state, {
      type: 'tool.progress',
      toolCallId: 'shell-blank-first',
      chunk: 'next',
      stream: 'stdout',
    });

    const card = shellCard(state, 'shell-blank-first');
    expect(card.liveOutput).toBe('\nnext');
    expect(card.liveTotalLines).toBe(2);
  });

  test('keeps only the five-line tail after a high-volume stream', () => {
    let state = startShell(createInitialState(), 'shell-high-volume');

    for (let line = 0; line < 10_000; line += 1) {
      state = reduce(state, {
        type: 'tool.progress',
        toolCallId: 'shell-high-volume',
        chunk: `line-${line}`,
        stream: line % 2 === 0 ? 'stdout' : 'stderr',
      });
    }

    const card = shellCard(state, 'shell-high-volume');
    expect(card.liveOutput).toBe('line-9995\nline-9996\nline-9997\nline-9998\nline-9999');
    expect(card.liveTotalLines).toBe(10_000);
    expect(card.liveOutput?.split('\n')).toHaveLength(5);
  });

  test('isolates interleaved calls and ignores progress after terminal completion', () => {
    let state = startShell(createInitialState(), 'shell-a');
    state = startShell(state, 'shell-b');

    for (const event of [
      { type: 'tool.progress', toolCallId: 'shell-a', chunk: 'a-out', stream: 'stdout' },
      { type: 'tool.progress', toolCallId: 'shell-b', chunk: 'b-err', stream: 'stderr' },
      { type: 'tool.progress', toolCallId: 'shell-a', chunk: 'a-err', stream: 'stderr' },
    ] satisfies RuntimeEvent[]) {
      state = reduce(state, event);
    }

    expect(shellCard(state, 'shell-a').liveOutput).toBe('a-out\na-err');
    expect(shellCard(state, 'shell-b').liveOutput).toBe('b-err');

    state = reduce(state, {
      type: 'tool.finished',
      toolCallId: 'shell-a',
      name: 'shell_execute',
      result: {
        ok: true,
        command: 'echo shell-a',
        exitCode: 0,
        stdout: 'done',
        stderr: '',
      },
    });
    const completed = state;

    state = reduce(state, {
      type: 'tool.progress',
      toolCallId: 'shell-a',
      chunk: 'late-line',
      stream: 'stdout',
    });

    expect(state).toBe(completed);
    expect(shellCard(state, 'shell-a').status).toBe('done');
    expect(shellCard(state, 'shell-a').liveOutput).not.toContain('late-line');
  });
});
