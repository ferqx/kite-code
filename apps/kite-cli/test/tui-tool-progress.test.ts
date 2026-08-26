import { describe, expect, test } from 'bun:test';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import { createInitialState } from '../src/tui/App';
import { handleClientEventAction } from '../src/tui/reducers/handleClientEvent';
import type { OutputBlock, TuiState } from '../src/tui/types';

function reduce(state: TuiState, event: RuntimeClientEvent): TuiState {
  return handleClientEventAction(state, event);
}

function startShell(state: TuiState, callId: string): TuiState {
  state = reduce(state, {
    type: 'tool.queued',
    toolId: callId,
    toolName: 'shell_execute',
    presentation: 'standalone',
    arguments: { command: 'echo progress' },
    summary: 'Shell task queued.',
  });
  return reduce(state, { type: 'tool.started', toolId: callId, summary: 'Running shell task.' });
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
  test('renders safe progress without inventing a missing tool identity', () => {
    const state = reduce(createInitialState(), {
      type: 'tool.progress',
      toolId: 'late-shell',
      summary: 'late-safe-output',
      stream: 'stdout',
    });

    const card = shellCard(state, 'late-shell');
    expect(card.liveOutput).toBe('late-safe-output');
    expect(card.name).toBe('other');
    expect(card.args).toEqual({});
  });

  test('uses batch lineCount while retaining only the safe summary', () => {
    let state = startShell(createInitialState(), 'shell-batch');
    state = reduce(state, {
      type: 'tool.progress',
      toolId: 'shell-batch',
      summary: 'Latest retained tool update.',
      stream: 'stdout',
      lineCount: 10_000,
    });

    const card = shellCard(state, 'shell-batch');
    expect(card.liveOutput).toBe('Latest retained tool update.');
    expect(card.liveTotalLines).toBe(10_000);
  });

  test('separates adjacent safe summaries', () => {
    let state = startShell(createInitialState(), 'shell-adjacent');
    state = reduce(state, {
      type: 'tool.progress',
      toolId: 'shell-adjacent',
      summary: 'first',
      stream: 'stdout',
    });
    state = reduce(state, {
      type: 'tool.progress',
      toolId: 'shell-adjacent',
      summary: 'next',
      stream: 'stdout',
    });

    const card = shellCard(state, 'shell-adjacent');
    expect(card.liveOutput).toBe('first\nnext');
    expect(card.liveTotalLines).toBe(2);
  });

  test('keeps only the five-line tail after a high-volume stream', () => {
    let state = startShell(createInitialState(), 'shell-high-volume');

    for (let line = 0; line < 10_000; line += 1) {
      state = reduce(state, {
        type: 'tool.progress',
        toolId: 'shell-high-volume',
        summary: `line-${line}`,
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
      { type: 'tool.progress', toolId: 'shell-a', summary: 'a-out', stream: 'stdout' },
      { type: 'tool.progress', toolId: 'shell-b', summary: 'b-err', stream: 'stderr' },
      { type: 'tool.progress', toolId: 'shell-a', summary: 'a-err', stream: 'stderr' },
    ] satisfies RuntimeClientEvent[]) {
      state = reduce(state, event);
    }

    expect(shellCard(state, 'shell-a').liveOutput).toBe('a-out\na-err');
    expect(shellCard(state, 'shell-b').liveOutput).toBe('b-err');

    state = reduce(state, {
      type: 'tool.finished',
      toolId: 'shell-a',
      toolName: 'shell_execute',
      presentation: 'standalone',
      result: { ok: true, exitCode: 0, stdout: 'Shell task completed.', stderr: '' },
      summary: 'Shell task completed.',
    });
    const completed = state;

    state = reduce(state, {
      type: 'tool.progress',
      toolId: 'shell-a',
      summary: 'late-line',
      stream: 'stdout',
    });

    expect(state).toBe(completed);
    expect(shellCard(state, 'shell-a').status).toBe('done');
    expect(shellCard(state, 'shell-a').liveOutput).not.toContain('late-line');
  });
});
