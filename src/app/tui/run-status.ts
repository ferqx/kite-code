import type { OutputBlock, RetryState, TuiState } from './types';

export type RunPhase = 'thinking' | 'working' | 'finishing';
export type RunStatusTone = 'primary' | 'success' | 'warning' | 'muted' | 'error';

/** Hex gradient cycle for the Working phase — blue → teal → green → gold → blue */
export const WORKING_GRADIENT = [
  '#569CD6', // blue (primary)
  '#4EC9B0', // teal
  '#6A9955', // green (success)
  '#CCA700', // gold (warning)
  '#569CD6', // back to blue — seamless loop
];

/** Base tone for static phases (Thinking / Finishing / overlays) */
export function phaseBaseTone(phase: RunPhase): RunStatusTone {
  switch (phase) {
    case 'thinking':
      return 'primary';
    case 'working':
      return 'primary';
    case 'finishing':
      return 'success';
  }
}

export interface RunStatusSnapshot {
  phase: RunPhase;
  verb: string;
  tone: RunStatusTone;
  note?: string;
  elapsedMs: number;
  runTokenDelta: number;
  retry: RetryState | null;
  waiting: 'approval' | 'input' | 'plan_review' | null;
}

// ── helpers ──

function findBlock(
  state: TuiState,
  predicate: (block: OutputBlock) => boolean,
): OutputBlock | undefined {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    for (const block of state.turns[i]!.blocks) {
      if (predicate(block)) return block;
    }
  }
  return undefined;
}

function firstLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// ── tool verb mapping ──

const TOOL_VERBS: Record<string, { verb: string; tone: RunStatusTone }> = {
  read_file: { verb: 'Inspecting', tone: 'muted' },
  read_mcp_resource: { verb: 'Inspecting', tone: 'muted' },
  search_content: { verb: 'Locating', tone: 'primary' },
  search_files: { verb: 'Locating', tone: 'primary' },
  edit_file: { verb: 'Changing', tone: 'warning' },
  write_file: { verb: 'Changing', tone: 'warning' },
  shell_execute: { verb: 'Running', tone: 'success' },
  update_plan: { verb: 'Planning', tone: 'primary' },
  ask_user: { verb: 'Asking', tone: 'warning' },
  task: { verb: 'Delegating', tone: 'success' },
};

function toolVerb(name: string): { verb: string; tone: RunStatusTone } {
  return TOOL_VERBS[name] ?? { verb: 'Running', tone: 'success' };
}

// ── phase derivation (monotonic, forward-only) ──

function derivePhase(state: TuiState): RunPhase {
  // Finishing: streaming text is the last stage of a run
  if (findBlock(state, (b) => b.kind === 'text' && b.streaming === true)) {
    return 'finishing';
  }

  // Working: at least one tool/subagent/file_change has appeared this run.
  // Once here, never goes back to Thinking.
  const last = state.turns.at(-1);
  if (last) {
    const hasActivity = last.blocks.some(
      (b) =>
        b.kind === 'tool_card' ||
        b.kind === 'tool_summary' ||
        b.kind === 'subagent' ||
        b.kind === 'file_change',
    );
    if (hasActivity) return 'working';
  }

  return 'thinking';
}

// ── verb within each phase ──

function activeBlockVerb(state: TuiState): { verb: string; tone: RunStatusTone } | null {
  // Subagent running
  const sub = findBlock(state, (b) => b.kind === 'subagent' && b.status === 'running');
  if (sub?.kind === 'subagent') {
    return { verb: 'Delegating', tone: 'success' };
  }

  // Tool card running
  const card = findBlock(state, (b) => b.kind === 'tool_card' && b.status === 'running');
  if (card?.kind === 'tool_card') {
    return toolVerb(card.name);
  }

  // Tool summary active
  const summary = findBlock(state, (b) => b.kind === 'tool_summary' && b.active);
  if (summary?.kind === 'tool_summary') {
    const act = summary.latestActivity;
    if (act?.kind === 'tool') {
      const tool = summary.tools.find((t) => t.callId === act.callId);
      if (tool) return toolVerb(tool.name);
    }
    // Still active but between tool events — thinking
    if (act?.kind === 'thinking') return null;
    const running = summary.tools.find((t) => t.status === 'running');
    if (running) return toolVerb(running.name);
    return null;
  }

  return null;
}

function currentVerb(
  state: TuiState,
  phase: RunPhase,
): { verb: string; tone: RunStatusTone; note?: string } {
  const thinkingNote = (): string | undefined => {
    const mode = firstLine(state.status.thinkingMode || '');
    return mode ? `thinking with ${mode} effort` : 'thinking';
  };

  switch (phase) {
    case 'thinking': {
      const planActive =
        state.status.phase === 'planning' &&
        state.status.plan &&
        state.status.plan.status !== 'completed';
      return {
        verb: planActive ? 'Planning' : 'Thinking',
        tone: 'primary',
        note: thinkingNote(),
      };
    }

    case 'working': {
      const active = activeBlockVerb(state);
      if (active) return { ...active };
      // Between tool rounds — just "Working" with no sub-verb
      return { verb: 'Working', tone: 'primary' };
    }

    case 'finishing':
      return { verb: 'Finishing', tone: 'success' };
  }
}

function waitingState(state: TuiState): RunStatusSnapshot['waiting'] {
  if (state.interrupt?.kind === 'approval') return 'approval';
  if (state.interrupt?.kind === 'input') return 'input';
  if (state.interrupt?.kind === 'plan_review') return 'plan_review';
  return null;
}

// ── main derivation ──

export function deriveRunStatusSnapshot(state: TuiState, now = Date.now()): RunStatusSnapshot {
  const elapsedMs = state.runStartTime ? now - state.runStartTime : 0;
  const runTokenDelta = Math.max(0, state.status.totalTokens - (state.runTokenBaseline ?? 0));
  const waiting = waitingState(state);
  const phase = derivePhase(state);

  // Special: retry overlay
  if (state.status.retryState) {
    return {
      phase,
      verb: 'Retrying',
      tone: 'warning',
      note: `attempt ${state.status.retryState.attempt}`,
      elapsedMs,
      runTokenDelta,
      retry: state.status.retryState,
      waiting,
    };
  }

  // Special: waiting for user
  if (waiting) {
    return {
      phase,
      verb: waiting === 'input' ? 'Asking' : 'Waiting',
      tone: waiting === 'input' ? 'warning' : 'muted',
      elapsedMs,
      runTokenDelta,
      retry: null,
      waiting,
    };
  }

  const { verb, tone, note } = currentVerb(state, phase);
  return { phase, verb, tone, note, elapsedMs, runTokenDelta, retry: null, waiting: null };
}

// ── formatting ──

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function formatTokenDelta(tokens: number): string {
  if (tokens >= 10_000) return `+${(tokens / 1000).toFixed(1)}k tokens`;
  return `+${tokens.toLocaleString()} tokens`;
}

export function formatRunStatusLine(snapshot: RunStatusSnapshot, columns: number): string {
  const elapsed = formatDuration(snapshot.elapsedMs);
  const tokens = snapshot.runTokenDelta > 0 ? ` · ${formatTokenDelta(snapshot.runTokenDelta)}` : '';
  const note = snapshot.note ? ` · ${snapshot.note}` : '';

  // Prefix: explicit "Working · " for working-phase sub-verbs
  const prefix =
    snapshot.phase === 'working' && snapshot.verb !== 'Working'
      ? `Working · ${snapshot.verb}…`
      : `${snapshot.verb}…`;

  const wide = `${prefix} (${elapsed}${tokens}${note})`;
  if (wide.length <= columns) return wide;

  // Compact: drop note
  const medium = `${prefix} (${elapsed}${tokens})`;
  if (medium.length <= columns) return medium;

  // Narrow: shorten token format
  const narrowTokens =
    snapshot.runTokenDelta > 0 ? ` · +${snapshot.runTokenDelta.toLocaleString()}` : '';
  const narrow = `${prefix} (${elapsed}${narrowTokens})`;
  if (narrow.length <= columns) return narrow;

  // Minimal
  return `${prefix} ${elapsed}`;
}
