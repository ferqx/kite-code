import { describe, expect, test } from 'bun:test';
import type {
  RuntimeClientEvent,
  RuntimeToolDisplayName,
  RuntimeToolPresentation,
} from '@kite-ai/runtime-contract';
import type { Action } from '../src/tui/App';
import {
  createInitialState,
  eventReducer,
  shouldDisablePromptInput,
  shouldShowRunStatus,
} from '../src/tui/App';
import { formatElapsed, formatToolResultForDisplay } from '../src/tui/components/render-utils';
import { isTuiRunActive } from '../src/tui/presentation/selectors';
import { handleClientEventAction } from '../src/tui/reducers/handleClientEvent';
import type { RunStatusTone } from '../src/tui/run-status';
import { deriveRunStatusSnapshot, formatRunStatusLine, phaseBaseTone } from '../src/tui/run-status';
import type { OutputBlock, TuiState } from '../src/tui/types';
import { acceptedEnvelope } from './helpers/accepted-envelope';

function projectRuntimeEvent(state: TuiState, event: RuntimeClientEvent): TuiState {
  return handleClientEventAction(state, acceptedEnvelope(event));
}

function dispatch(s: TuiState, a: Action | readonly Action[]): TuiState {
  const actions = Array.isArray(a) ? a : [a];
  return actions.reduce((state, action) => eventReducer(state, action), s);
}

function presentationFor(name: string): RuntimeToolPresentation {
  return name === 'read_file' ||
    name === 'search_content' ||
    name === 'search_files' ||
    name === 'read_mcp_resource'
    ? 'exploration'
    : 'standalone';
}

function accepted(event: RuntimeClientEvent): Action {
  return {
    type: 'ACCEPT_PRESENTATION_ENVELOPE',
    event: acceptedEnvelope(event),
  };
}

function toolCall(
  callId: string,
  name: string,
  args: Record<string, unknown> = {},
  status?: 'queued' | 'running',
): Action | readonly Action[] {
  const queuedEvent: Action = accepted({
    type: 'tool.queued',
    toolId: callId,
    toolName: name as RuntimeToolDisplayName,
    presentation: presentationFor(name),
    arguments: args,
    summary: 'Queued.',
  });
  return status === 'queued'
    ? queuedEvent
    : [queuedEvent, accepted({ type: 'tool.started', toolId: callId })];
}

function toolStarted(callId: string): Action {
  return accepted({ type: 'tool.started', toolId: callId, summary: 'Running tool.' });
}

function toolDone(callId: string, name: string, summary = 'ok'): Action {
  return accepted({
    type: 'tool.finished',
    toolId: callId,
    toolName: name as RuntimeToolDisplayName,
    presentation: presentationFor(name),
    result: { ok: true, exitCode: 0, stdout: '', stderr: '' },
    summary,
  });
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

  test('shows Working as soon as an idle prompt enters the submission path', () => {
    let state: TuiState = {
      ...createInitialState(),
      activeSessionId: 'session-1',
      runtimeAuthority: {
        revision: 7,
        interactionQueue: { revision: 7, interactions: [] },
        currentRun: {
          runId: 'settled-predecessor',
          initialTurnId: 'settled-turn',
          status: 'completed' as const,
          revision: 7,
        },
      },
    };
    state = dispatch(state, { type: 'SET_RUNNING' });
    expect(shouldShowRunStatus(state)).toBe(false);

    state = dispatch(state, { type: 'LOCAL_USER_PROMPT', text: 'Inspect the project.' });
    expect(shouldShowRunStatus(state)).toBe(true);
    expect(state.turns.at(-1)?.blocks.at(-1)).toMatchObject({
      kind: 'user',
      content: 'Inspect the project.',
      pendingEcho: true,
    });
  });

  test('keeps the active agent run status during automatic compaction', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = projectRuntimeEvent(state, {
      type: 'user.message',
      messageId: 'message-1',
      kind: 'task',
      text: 'Continue.',
    });
    state = dispatch(state, {
      type: 'SET_COMPACTION_PROGRESS',
      phase: 'summarizing',
      source: 'automatic',
    });

    expect(deriveRunStatusSnapshot(state).verb).toBe('Thinking');
    expect(shouldShowRunStatus(state)).toBe(true);
  });

  test('keeps the active agent run status during manual compaction', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = projectRuntimeEvent(state, {
      type: 'user.message',
      messageId: 'message-1',
      kind: 'task',
      text: 'Continue.',
    });
    state = dispatch(state, {
      type: 'SET_COMPACTION_PROGRESS',
      phase: 'preparing',
      source: 'manual',
    });
    expect(state.compactionProgress).toEqual({ phase: 'preparing', source: 'manual' });
    expect(shouldShowRunStatus(state)).toBe(true);
    state = dispatch(state, { type: 'SET_COMPACTION_PROGRESS' });
    expect(state.compactionProgress).toBeUndefined();
    expect(shouldShowRunStatus(state)).toBe(true);
  });

  test('keeps the animated run status until the final response becomes terminal', () => {
    const state = {
      ...dispatch(createInitialState(), { type: 'SET_RUNNING' }),
      runPromptPresented: true,
    };

    expect(shouldShowRunStatus(state)).toBe(true);
    expect(
      shouldShowRunStatus({
        ...state,
        status: {
          ...state.status,
          retryState: { attempt: 2, maxAttempts: 3, error: 'temporary', delayMs: 500 },
        },
      }),
    ).toBe(true);
  });

  test('acknowledges cancellation immediately and clears it only at a terminal boundary', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = {
      ...state,
      runtimeAuthority: {
        revision: 1,
        interactionQueue: { revision: 1, interactions: [] },
        currentRun: {
          runId: 'run-cancelled',
          initialTurnId: 'turn-cancelled',
          activeTurnId: 'turn-cancelled',
          status: 'running',
          revision: 1,
        },
      },
    };
    state = dispatch(state, { type: 'ESCAPE' });

    expect(isTuiRunActive(state)).toBe(true);
    expect(state.cancelRequestedRunId).toBe('run-cancelled');
    expect(deriveRunStatusSnapshot(state).verb).toBe('Cancelling');

    state = projectRuntimeEvent(state, {
      type: 'turn.terminal',
      turnId: 'turn-cancelled',
      status: 'cancelled',
      cause: 'user',
    });
    expect(isTuiRunActive(state)).toBe(true);
    expect(state.cancelRequestedRunId).toBeUndefined();
    state = projectRuntimeEvent(state, {
      type: 'run.terminal',
      runId: 'run-cancelled',
      status: 'cancelled',
    });
    state = eventReducer(state, {
      type: 'RECONCILE_RUNTIME_PROJECTION',
      projection: {
        revision: 2,
        interactionQueue: { revision: 2, interactions: [] },
        currentRun: {
          runId: 'run-cancelled',
          initialTurnId: 'turn-cancelled',
          status: 'cancelled',
          revision: 2,
        },
      },
    });
    expect(isTuiRunActive(state)).toBe(false);
  });

  test('enters finishing after a completed model answer while the Run remains active', () => {
    const state = {
      ...createInitialState(),
      runPromptPresented: false,
      turns: [
        {
          blocks: [
            {
              id: 1,
              kind: 'text' as const,
              content: 'Done.',
              modelRequestId: 'request-final',
            },
          ],
        },
      ],
    };

    expect(deriveRunStatusSnapshot(state).phase).toBe('finishing');
  });

  test('does not finish completed narration that owns a pending tool batch', () => {
    const state = {
      ...createInitialState(),
      runPromptPresented: false,
      toolBearingModelRequestId: 'request-tools',
      turns: [
        {
          blocks: [
            {
              id: 1,
              kind: 'text' as const,
              content: 'I will inspect that next.',
              modelRequestId: 'request-tools',
            },
          ],
        },
      ],
    };

    expect(deriveRunStatusSnapshot(state).phase).not.toBe('finishing');
  });

  test('starts in thinking phase', () => {
    const state = dispatch(createInitialState(), { type: 'SET_RUNNING' });

    const snap = deriveRunStatusSnapshot(state, state.runStartTime! + 2_000);
    expect(snap.phase).toBe('thinking');
    expect(snap.verb).toBe('Thinking');
    expect(snap.tone).toBe('primary');
  });

  test('transitions to working on first tool call and never goes back', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, toolCall('c1', 'shell_execute', { command: 'bun test' }));
    expect(deriveRunStatusSnapshot(state).phase).toBe('working');

    // Agent thinks again between tools — still working.
    expect(deriveRunStatusSnapshot(state).phase).toBe('working');

    // Another tool — still working
    state = dispatch(state, toolCall('c2', 'search_content', { pattern: 'StatusBar' }));
    expect(deriveRunStatusSnapshot(state).phase).toBe('working');
  });

  test('stays in working while tools node is active before visible tool blocks arrive', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = {
      ...state,
      status: { ...state.status, currentNode: 'tools' },
    };

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.phase).toBe('working');
    expect(snap.verb).toBe('Working');
  });

  test('stays working when text streams after tool activity', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, toolCall('c1', 'shell_execute', { command: 'bun test' }));
    state = dispatch(state, toolDone('c1', 'shell_execute', 'created'));
    state = dispatch(
      state,
      accepted({
        type: 'model.text_delta',
        requestId: 'status-after-tool',
        text: 'All tests passed.',
      }),
    );

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.phase).toBe('working');
    expect(snap.verb).toBe('Working');
  });

  test('skips working phase when run uses no tools', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    // Admit and complete a model request directly (no tools). The model
    // terminal marks the answer as finishing while the Run terminal is still
    // pending.
    state = dispatch(state, [
      accepted({ type: 'model.requested', requestId: 'status-no-tool' }),
      accepted({ type: 'model.text_delta', requestId: 'status-no-tool', text: 'Hello!' }),
      accepted({
        type: 'model.responded',
        requestId: 'status-no-tool',
        messageId: 'status-no-tool-message',
        toolCallCount: 0,
        summary: 'Hello!',
      }),
    ]);

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.phase).toBe('finishing');
  });
});

// ── verb within phases ──

describe('verb within working phase', () => {
  test('keeps queued tool metadata hidden until the tool starts running', () => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = dispatch(state, toolCall('c1', 'shell_execute', { command: 'ls' }, 'queued'));

    let snap = deriveRunStatusSnapshot(state, state.runStartTime! + 2_000);
    expect(snap.phase).toBe('thinking');
    expect(snap.verb).toBe('Thinking');

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
    state = projectRuntimeEvent(state, {
      type: 'subagent.started',
      subagentId: 'sub-1',
      role: 'explore',
      name: 'scan UI',
    });

    const snap = deriveRunStatusSnapshot(state);
    expect(snap.phase).toBe('working');
    expect(snap.verb).toBe('Delegating');
    expect(snap.tone).toBe('success');
  });

  test.each([
    ['queued', 'Review queued', 'primary'],
    ['queued_auto_review', 'Review queued', 'primary'],
    ['queued_user_approval', 'Review queued', 'primary'],
    ['auto_reviewing', 'Auto-reviewing', 'primary'],
    ['awaiting_user', 'Awaiting approval', 'warning'],
  ] as const)('shows %s child approval state without implying every child needs a user', (approvalState, verb, tone) => {
    let state = dispatch(createInitialState(), { type: 'SET_RUNNING' });
    state = projectRuntimeEvent(state, {
      type: 'subagent.started',
      subagentId: 'sub-1',
      role: 'review',
      name: 'review',
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
  test('hides elapsed time during the working phase', () => {
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

    expect(lineBeforeOneSecond).toBe('Working');
    expect(lineAtOneSecond).toBe('Working');
  });

  test('working phase hides its tool sub-verb', () => {
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
    expect(line).toBe('Working');
  });

  test('working phase stays Working without a sub-verb', () => {
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
    expect(line).toBe('Working');
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

  test('finishing phase keeps the same visible Working label', () => {
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
    expect(line).toBe('Working');
  });

  test('working phase remains minimal on narrow terminals', () => {
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
    expect(line).toBe('Working');
  });

  test('working phase hides notes as well as tool details', () => {
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
    expect(line).toBe('Working');
  });

  test('does not show token delta in the minimal working status', () => {
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
    expect(line).toBe('Working');
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

  test('working phase base maps to primary', () => {
    expect(phaseBaseTone('working')).toBe('primary');
  });
});

// ── reducer integration: tool_progress → liveOutput ──

describe('tool_progress liveOutput', () => {
  test('sets liveOutput on running tool_card via accepted event dispatch', () => {
    const initial = createInitialState();
    let state = eventReducer(initial, { type: 'SET_RUNNING' });

    const callId = 'call-123';
    state = dispatch(state, toolCall(callId, 'shell_execute', { command: 'echo hello' }));

    const last = state.turns.at(-1)?.blocks.at(-1);
    expect(last?.kind).toBe('tool_card');
    expect((last as Extract<OutputBlock, { kind: 'tool_card' }>).status).toBe('running');
    expect((last as Extract<OutputBlock, { kind: 'tool_card' }>).liveOutput).toBeUndefined();

    state = dispatch(
      state,
      accepted({
        type: 'tool.progress',
        toolId: callId,
        summary: 'hello',
        stream: 'stdout',
      }),
    );

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
