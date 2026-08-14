import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '@/protocol/events';
import type { Action } from '../src/app/tui/App';
import {
  createInitialState,
  eventReducer,
  shouldDisablePromptInput,
  shouldShowRunStatus,
} from '../src/app/tui/App';
import { formatElapsed, formatToolResultForDisplay } from '../src/app/tui/components/render-utils';
import { handleEventAction, type RenderEvent } from '../src/app/tui/reducers/handleEvent';
import type { RunStatusTone } from '../src/app/tui/run-status';
import {
  deriveRunStatusSnapshot,
  formatRunStatusLine,
  phaseBaseTone,
  WORKING_GRADIENT,
} from '../src/app/tui/run-status';
import type { OutputBlock, TuiState } from '../src/app/tui/types';

type LegacyRenderAction = { type: 'EVENT'; event: RenderEvent };
type TestAction = Action | LegacyRenderAction;

function dispatch(s: TuiState, a: TestAction): TuiState {
  if (a.type === 'EVENT') return handleEventAction(s, a.event);
  return eventReducer(s, a);
}

function toolCall(
  callId: string,
  name: string,
  args: Record<string, unknown> = {},
  status?: 'queued' | 'running',
): LegacyRenderAction {
  return {
    type: 'EVENT',
    event: { type: 'tool_call', data: { call_id: callId, name, args, status } },
  };
}

function toolStarted(callId: string): LegacyRenderAction {
  return {
    type: 'EVENT',
    event: { type: 'tool_started', data: { call_id: callId } },
  };
}

function toolDone(callId: string, name: string, summary = 'ok'): LegacyRenderAction {
  return {
    type: 'EVENT',
    event: { type: 'tool_done', data: { call_id: callId, name, ok: true, summary } },
  };
}

// ── phase progression ──

describe('run phase progression', () => {
  test.each([
    'manual',
    'automatic',
  ] as const)('keeps the prompt enabled while %s compaction is active', (source) => {
    const state = {
      ...createInitialState(),
      compactionProgress: { phase: 'summarizing' as const, source },
    };

    expect(shouldDisablePromptInput(state)).toBe(false);
  });

  test('enables the prompt once compaction progress has cleared', () => {
    expect(shouldDisablePromptInput(createInitialState())).toBe(false);
  });

  test('keeps the active agent run status during automatic compaction', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, {
      type: 'SET_COMPACTION_PROGRESS',
      phase: 'summarizing',
      source: 'automatic',
    });

    expect(deriveRunStatusSnapshot(state).verb).toBe('Thinking');
    expect(shouldShowRunStatus(state)).toBe(true);
  });

  test('hides agent run status during manual compaction', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, {
      type: 'SET_COMPACTION_PROGRESS',
      phase: 'preparing',
      source: 'manual',
    });
    expect(state.compactionProgress).toEqual({ phase: 'preparing', source: 'manual' });
    expect(shouldShowRunStatus(state)).toBe(false);
    state = dispatch(state, { type: 'SET_COMPACTION_PROGRESS' });
    expect(state.compactionProgress).toBeUndefined();
    expect(shouldShowRunStatus(state)).toBe(true);
  });

  test('starts in thinking phase', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, {
      type: 'EVENT',
      event: { type: 'step_begin', data: { node: 'agent', spanId: 's1' } },
    });

    const snap = deriveRunStatusSnapshot(state, state.runStartTime! + 2_000);
    expect(snap.phase).toBe('thinking');
    expect(snap.verb).toBe('Thinking');
    expect(snap.tone).toBe('primary');
  });

  test('transitions to working on first tool call and never goes back', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, toolCall('c1', 'shell_execute', { command: 'bun test' }));
    expect(deriveRunStatusSnapshot(state).phase).toBe('working');

    // Agent thinks again between tools — still working
    state = dispatch(state, {
      type: 'EVENT',
      event: { type: 'step_begin', data: { node: 'agent', spanId: 's2' } },
    });
    expect(deriveRunStatusSnapshot(state).phase).toBe('working');

    // Another tool — still working
    state = dispatch(state, toolCall('c2', 'search_content', { pattern: 'StatusBar' }));
    expect(deriveRunStatusSnapshot(state).phase).toBe('working');
  });

  test('stays in working while tools node is active before visible tool blocks arrive', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, {
      type: 'EVENT',
      event: { type: 'step_begin', data: { node: 'tools', spanId: 's-tools' } },
    });

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.phase).toBe('working');
    expect(snap.verb).toBe('Working');
  });

  test('stays working when text streams after tool activity', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, toolCall('c1', 'shell_execute', { command: 'bun test' }));
    state = dispatch(state, toolDone('c1', 'shell_execute', 'created'));
    state = dispatch(state, {
      type: 'EVENT',
      event: { type: 'text', data: { text: 'All tests passed.' } },
    });

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.phase).toBe('working');
    expect(snap.verb).toBe('Working');
  });

  test('skips working phase when run uses no tools', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    // thinking → text directly (no tools)
    state = dispatch(state, {
      type: 'EVENT',
      event: { type: 'text', data: { text: 'Hello!' } },
    });

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.phase).toBe('finishing');
  });
});

// ── verb within phases ──

describe('verb within working phase', () => {
  test('shows queued verb before a queued tool starts running', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, toolCall('c1', 'shell_execute', { command: 'ls' }, 'queued'));

    let snap = deriveRunStatusSnapshot(state, state.runStartTime! + 2_000);
    expect(snap.phase).toBe('working');
    expect(snap.verb).toBe('Queued');
    expect(snap.tone).toBe('muted');

    state = dispatch(state, toolStarted('c1'));
    snap = deriveRunStatusSnapshot(state, state.runStartTime! + 3_000);
    expect(snap.verb).toBe('Running');
  });

  test('shows tool verb when a tool is running', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, toolCall('c1', 'shell_execute', { command: 'ls' }));

    const snap = deriveRunStatusSnapshot(state, state.runStartTime! + 8_000);
    expect(snap.phase).toBe('working');
    expect(snap.verb).toBe('Running');
  });

  test('shows Working (no sub-verb) when between tool rounds', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, toolCall('c1', 'shell_execute', { command: 'ls' }));
    state = dispatch(state, toolDone('c1', 'shell_execute', 'ok'));
    state = dispatch(state, {
      type: 'EVENT',
      event: { type: 'step_begin', data: { node: 'agent', spanId: 's2' } },
    });

    const snap = deriveRunStatusSnapshot(state, state.runStartTime! + 15_000);
    expect(snap.phase).toBe('working');
    expect(snap.verb).toBe('Working');
  });

  test('classifies tool calls into distinct verbs', () => {
    const cases: [string, Record<string, unknown>, string, RunStatusTone][] = [
      ['read_file', { path: 'src/app.ts' }, 'Inspecting', 'muted'],
      ['search_content', { pattern: 'TODO' }, 'Locating', 'primary'],
      ['edit_file', { path: 'src/app.ts' }, 'Changing', 'warning'],
      ['shell_execute', { command: 'ls' }, 'Running', 'success'],
      ['write_plan', { title: 'Refactor' }, 'Planning', 'primary'],
      [
        'update_plan',
        { updates: [{ step_id: 's1', status: 'in_progress' }] },
        'Updating plan',
        'primary',
      ],
      ['ask_user', { question: 'Which?' }, 'Asking', 'warning'],
    ];

    for (const [name, args, verb, tone] of cases) {
      let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
      state = dispatch(state, toolCall('c1', name, args));
      const snap = deriveRunStatusSnapshot(state);
      expect(snap.verb).toBe(verb);
      expect(snap.tone).toBe(tone);
    }
  });

  test('shows Delegating when a subagent is running', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, {
      type: 'EVENT',
      event: { type: 'subagent_start', data: { id: 'sub-1', role: 'explore', task: 'scan UI' } },
    });

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.phase).toBe('working');
    expect(snap.verb).toBe('Delegating');
    expect(snap.tone).toBe('success');
  });

  test.each([
    ['queued', 'Review queued', 'primary'],
    ['auto_reviewing', 'Auto-reviewing', 'primary'],
    ['awaiting_user', 'Awaiting approval', 'warning'],
  ] as const)('shows %s child approval state without implying every child needs a user', (approvalState, verb, tone) => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, {
      type: 'EVENT',
      event: { type: 'subagent_start', data: { id: 'sub-1', role: 'review', task: 'review' } },
    });
    state = {
      ...state,
      turns: state.turns.map((turn) => ({
        ...turn,
        blocks: turn.blocks.map((block) =>
          block.kind === 'subagent'
            ? { ...block, status: 'suspended' as const, approvalState, awaitingApproval: true }
            : block,
        ),
      })),
    };

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.verb).toBe(verb);
    expect(snap.tone).toBe(tone);
  });
});

// ── overlays ──

describe('overlay states', () => {
  test('retry shows Retrying verb with warning tone', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, toolCall('c1', 'shell_execute', { command: 'ls' }));
    state = {
      ...state,
      status: {
        ...state.status,
        retryState: { attempt: 2, maxAttempts: 3, error: 'rate limit', delayMs: 5000 },
      },
    };

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.verb).toBe('Retrying');
    expect(snap.tone).toBe('warning');
    expect(snap.note).toContain('attempt 2');
    expect(snap.retry).not.toBeNull();
  });

  test('approval interrupt shows Waiting with muted tone', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = {
      ...state,
      interrupt: { kind: 'approval', blockId: 1 },
    };

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.verb).toBe('Waiting');
    expect(snap.tone).toBe('muted');
    expect(snap.waiting).toBe('approval');
  });

  test('input interrupt shows Asking with warning tone', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = {
      ...state,
      interrupt: { kind: 'input', blockId: 1 },
    };

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.verb).toBe('Asking');
    expect(snap.tone).toBe('warning');
    expect(snap.waiting).toBe('input');
  });
});

// ── token tracking ──

describe('token delta', () => {
  test('tracks tokens consumed since run started', () => {
    let state = createInitialState();
    state = { ...state, status: { ...state.status, totalTokens: 1000 } };

    state = dispatch(state, { type: 'SET_RUNNING' });
    state = { ...state, status: { ...state.status, totalTokens: 1189 } };

    const snap = deriveRunStatusSnapshot(state, state.runStartTime! + 28_000);
    expect(snap.runTokenDelta).toBe(189);
  });

  test('clamps to zero when baseline is ahead', () => {
    let state = createInitialState();
    state = { ...state, status: { ...state.status, totalTokens: 500 } };
    state = dispatch(state, { type: 'SET_RUNNING' });

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.runTokenDelta).toBe(0);
  });
});

// ── formatting ──

describe('formatRunStatusLine', () => {
  test('advances elapsed seconds only after a full second has passed', () => {
    const lineBeforeOneSecond = formatRunStatusLine(
      {
        phase: 'working',
        verb: 'Running',
        tone: 'success',
        elapsedMs: 999,
        runTokenDelta: 0,
        retry: null,
        waiting: null,
      },
      120,
    );
    const lineAtOneSecond = formatRunStatusLine(
      {
        phase: 'working',
        verb: 'Running',
        tone: 'success',
        elapsedMs: 1_000,
        runTokenDelta: 0,
        retry: null,
        waiting: null,
      },
      120,
    );

    expect(lineBeforeOneSecond).toBe('Working · Running… (1s)');
    expect(lineAtOneSecond).toBe('Working · Running… (1s)');
  });

  test('working phase prefixes verb with Working ·', () => {
    const line = formatRunStatusLine(
      {
        phase: 'working',
        verb: 'Running',
        tone: 'success',
        elapsedMs: 12_000,
        runTokenDelta: 500,
        retry: null,
        waiting: null,
      },
      120,
    );
    expect(line).toBe('Working · Running… (12s)');
  });

  test('working phase without sub-verb omits prefix', () => {
    const line = formatRunStatusLine(
      {
        phase: 'working',
        verb: 'Working',
        tone: 'primary',
        elapsedMs: 18_000,
        runTokenDelta: 800,
        retry: null,
        waiting: null,
      },
      120,
    );
    expect(line).toBe('Working… (18s)');
  });

  test('thinking phase includes note', () => {
    const line = formatRunStatusLine(
      {
        phase: 'thinking',
        verb: 'Thinking',
        tone: 'primary',
        note: 'thinking with max effort',
        elapsedMs: 3_000,
        runTokenDelta: 0,
        retry: null,
        waiting: null,
      },
      120,
    );
    expect(line).toBe('Thinking… (3s · thinking with max effort)');
  });

  test('finishing phase shows verb without prefix', () => {
    const line = formatRunStatusLine(
      {
        phase: 'finishing',
        verb: 'Finishing',
        tone: 'success',
        elapsedMs: 30_000,
        runTokenDelta: 1_200,
        retry: null,
        waiting: null,
      },
      120,
    );
    expect(line).toBe('Finishing… (30s)');
  });

  test('compacts to minimal form for very narrow terminals', () => {
    // At 24 columns, even the compact form with parens doesn't fit
    const line = formatRunStatusLine(
      {
        phase: 'working',
        verb: 'Running',
        tone: 'success',
        elapsedMs: 62_000,
        runTokenDelta: 1_530,
        retry: null,
        waiting: null,
      },
      24,
    );
    expect(line).toBe('Working · Running… 1m 2s');
  });

  test('drops note at moderate width when line overflows', () => {
    // At 38 columns wide form (43 chars) doesn't fit, falls back to medium (drop note)
    const line = formatRunStatusLine(
      {
        phase: 'working',
        verb: 'Running',
        tone: 'success',
        note: 'extra details',
        elapsedMs: 62_000,
        runTokenDelta: 0,
        retry: null,
        waiting: null,
      },
      38,
    );
    expect(line).toBe('Working · Running… (1m 2s)');
  });

  test('does not show token delta in status line', () => {
    const line = formatRunStatusLine(
      {
        phase: 'working',
        verb: 'Running',
        tone: 'success',
        elapsedMs: 120_000,
        runTokenDelta: 19_200,
        retry: null,
        waiting: null,
      },
      120,
    );
    expect(line).toBe('Working · Running… (2m)');
  });

  test('omits token part when delta is zero', () => {
    const line = formatRunStatusLine(
      {
        phase: 'thinking',
        verb: 'Thinking',
        tone: 'primary',
        note: 'thinking with max effort',
        elapsedMs: 2_000,
        runTokenDelta: 0,
        retry: null,
        waiting: null,
      },
      120,
    );
    expect(line).toBe('Thinking… (2s · thinking with max effort)');
    expect(line).not.toContain('+0');
  });
});

// ── phase color config ──

describe('phaseBaseTone', () => {
  test('thinking phase maps to primary (calm, neutral)', () => {
    expect(phaseBaseTone('thinking')).toBe('primary');
  });

  test('finishing phase maps to success (completion)', () => {
    expect(phaseBaseTone('finishing')).toBe('success');
  });

  test('working phase base maps to primary (overridden by animation)', () => {
    expect(phaseBaseTone('working')).toBe('primary');
  });
});

describe('WORKING_GRADIENT', () => {
  test('has at least 4 color stops for a visible cycle', () => {
    expect(WORKING_GRADIENT.length).toBeGreaterThanOrEqual(4);
  });

  test('loops seamlessly — first color equals last', () => {
    expect(WORKING_GRADIENT[0]).toBe(WORKING_GRADIENT[WORKING_GRADIENT.length - 1]);
  });

  test('all entries are valid hex colors', () => {
    for (const color of WORKING_GRADIENT) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

// ── reducer integration: tool_progress → liveOutput ──

describe('tool_progress liveOutput', () => {
  test('sets liveOutput on running tool_card via EVENT dispatch', () => {
    const initial = createInitialState();
    const runStart = { type: 'RUN_START', agentId: 'a1', name: '' };
    let state = eventReducer(initial, runStart as unknown as Action);

    const callId = 'call-123';
    state = dispatch(state, {
      type: 'EVENT',
      event: {
        type: 'tool_call',
        data: { call_id: callId, name: 'shell_execute', args: { command: 'echo hello' } },
      } satisfies AgentEvent,
    });

    const last = state.turns.at(-1)?.blocks.at(-1);
    expect(last?.kind).toBe('tool_card');
    expect((last as Extract<OutputBlock, { kind: 'tool_card' }>).status).toBe('running');
    expect((last as Extract<OutputBlock, { kind: 'tool_card' }>).liveOutput).toBeUndefined();

    state = dispatch(state, {
      type: 'EVENT',
      event: {
        type: 'tool_progress',
        data: { call_id: callId, name: 'shell_execute', chunk: 'hello', stream: 'stdout' },
      } satisfies AgentEvent,
    });

    const updated = state.turns.at(-1)?.blocks.at(-1);
    expect(updated?.kind).toBe('tool_card');
    expect((updated as Extract<OutputBlock, { kind: 'tool_card' }>).liveOutput).toBe('hello');
  });
});

// ── formatElapsed (from render-utils) ──

describe('formatElapsed', () => {
  test('clamps to minimum 1s for sub-second durations', () => {
    expect(formatElapsed(0)).toBe('1s');
    expect(formatElapsed(100)).toBe('1s');
    expect(formatElapsed(499)).toBe('1s');
  });

  test('shows 1s for exactly 1s', () => {
    expect(formatElapsed(500)).toBe('1s');
    expect(formatElapsed(1000)).toBe('1s');
  });

  test('shows seconds for sub-minute durations', () => {
    expect(formatElapsed(5000)).toBe('5s');
    expect(formatElapsed(30000)).toBe('30s');
    expect(formatElapsed(59500)).toBe('1m 0s');
  });

  test('shows minutes and seconds', () => {
    expect(formatElapsed(65000)).toBe('1m 5s');
    expect(formatElapsed(120000)).toBe('2m 0s');
    expect(formatElapsed(125000)).toBe('2m 5s');
  });
});

describe('formatToolResultForDisplay', () => {
  test('keeps the complete file edit diff instead of applying the generic summary cap', () => {
    const diff = [
      'Added 3 lines, removed 3 lines',
      ' 1 -old line',
      ' 1 +new line',
      ' 2 +another line',
    ].join('\n');

    expect(formatToolResultForDisplay('edit_file', diff, '')).toBe(diff);
    expect(formatToolResultForDisplay('write_file', diff, '')).toBe(diff);
  });

  test('continues to cap non-file tool summaries', () => {
    const output = 'x'.repeat(250);

    expect(formatToolResultForDisplay('shell_execute', output, '')).toBe('x'.repeat(200));
  });
});
