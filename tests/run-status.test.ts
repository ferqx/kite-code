import { describe, expect, test } from 'bun:test';
import type { Action } from '../src/app/tui/App';
import { createInitialState, eventReducer } from '../src/app/tui/App';
import type { RunStatusTone } from '../src/app/tui/run-status';
import {
  deriveRunStatusSnapshot,
  formatRunStatusLine,
  phaseBaseTone,
  WORKING_GRADIENT,
} from '../src/app/tui/run-status';
import type { TuiState } from '../src/app/tui/types';

function dispatch(s: TuiState, a: Action): TuiState {
  return eventReducer(s, a);
}

function toolCall(callId: string, name: string, args: Record<string, unknown> = {}): Action {
  return {
    type: 'EVENT',
    event: { type: 'tool_call', data: { call_id: callId, name, args } },
  };
}

function toolDone(callId: string, name: string, summary = 'ok'): Action {
  return {
    type: 'EVENT',
    event: { type: 'tool_done', data: { call_id: callId, name, ok: true, summary } },
  };
}

// ── phase progression ──

describe('run phase progression', () => {
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

  test('transitions to finishing when text starts streaming', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, toolCall('c1', 'shell_execute', { command: 'bun test' }));
    state = dispatch(state, {
      type: 'EVENT',
      event: { type: 'text', data: { text: 'All tests passed.' } },
    });

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.phase).toBe('finishing');
    expect(snap.verb).toBe('Finishing');
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
      ['update_plan', { name: 'refactor' }, 'Planning', 'primary'],
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
    expect(line).toBe('Working · Running… (12s · +500 tokens)');
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
    expect(line).toBe('Working… (18s · +800 tokens)');
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
    expect(line).toBe('Finishing… (30s · +1,200 tokens)');
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

  test('uses compact token format at moderate width', () => {
    // At 38 columns wide form (43 chars) doesn't fit, falls back to narrow (no "tokens" suffix)
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
      38,
    );
    expect(line).toBe('Working · Running… (1m 2s · +1,530)');
  });

  test('formats token delta over 10k with k suffix', () => {
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
    expect(line).toContain('+19.2k tokens');
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
