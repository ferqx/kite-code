import type { OutputBlock, RetryState, TuiState } from './types';

export type RunPhase = 'thinking' | 'working' | 'finishing';
export type RunStatusTone = 'primary' | 'success' | 'warning' | 'muted' | 'error';

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

// ── tool verb mapping ──

const TOOL_VERBS: Record<string, { verb: string; tone: RunStatusTone }> = {
  read_file: { verb: 'Inspecting', tone: 'muted' },
  read_mcp_resource: { verb: 'Inspecting', tone: 'muted' },
  search_content: { verb: 'Locating', tone: 'primary' },
  search_files: { verb: 'Locating', tone: 'primary' },
  edit_file: { verb: 'Changing', tone: 'warning' },
  write_file: { verb: 'Changing', tone: 'warning' },
  shell_execute: { verb: 'Running', tone: 'success' },
  write_plan: { verb: 'Planning', tone: 'primary' },
  update_plan: { verb: 'Updating plan', tone: 'primary' },
  ask_user: { verb: 'Asking', tone: 'warning' },
  task: { verb: 'Delegating', tone: 'success' },
};

function toolVerb(name: string): { verb: string; tone: RunStatusTone } {
  return TOOL_VERBS[name] ?? { verb: 'Running', tone: 'success' };
}

// ── phase derivation (monotonic, forward-only) ──

function derivePhase(state: TuiState): RunPhase {
  const last = state.turns.at(-1);
  const hasActivity =
    last?.blocks.some(
      (b) =>
        b.kind === 'tool_card' ||
        b.kind === 'tool_summary' ||
        b.kind === 'subagent' ||
        b.kind === 'file_change',
    ) ?? false;

  // Streaming text after tool activity is often interstitial narration before
  // the next tool batch. Keep the run visibly in Working until the run idles.
  if (findBlock(state, (b) => b.kind === 'text' && b.streaming === true)) {
    return hasActivity ? 'working' : 'finishing';
  }

  // The tools node can be active before a visible tool block exists. This
  // happens for hidden progress-only tools (for example post-approval
  // update_plan) and in the small window before tool lifecycle events render.
  if (state.status.currentNode === 'tools') {
    return 'working';
  }

  // Working: at least one tool/subagent/file_change has appeared this run.
  // Once here, never goes back to Thinking.
  if (hasActivity) return 'working';

  return 'thinking';
}

// ── verb within each phase ──

function activeBlockVerb(state: TuiState): { verb: string; tone: RunStatusTone } | null {
  const humanApproval = findBlock(
    state,
    (b) =>
      b.kind === 'subagent' &&
      b.status === 'suspended' &&
      (b.approvalState === 'awaiting_user' || (!b.approvalState && b.awaitingApproval === true)),
  );
  if (humanApproval?.kind === 'subagent') {
    return { verb: 'Awaiting approval', tone: 'warning' };
  }
  const autoReview = findBlock(
    state,
    (b) =>
      b.kind === 'subagent' && b.status === 'suspended' && b.approvalState === 'auto_reviewing',
  );
  if (autoReview?.kind === 'subagent') return { verb: 'Auto-reviewing', tone: 'primary' };
  const queuedReview = findBlock(
    state,
    (b) =>
      b.kind === 'subagent' &&
      b.status === 'suspended' &&
      (b.approvalState === 'queued' ||
        b.approvalState === 'queued_auto_review' ||
        b.approvalState === 'queued_user_approval'),
  );
  if (queuedReview?.kind === 'subagent') return { verb: 'Review queued', tone: 'primary' };
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
  const queuedCard = findBlock(state, (b) => b.kind === 'tool_card' && b.status === 'queued');
  if (queuedCard?.kind === 'tool_card') {
    return { verb: 'Queued', tone: 'muted' };
  }

  // Tool summary active
  const summary = findBlock(state, (b) => b.kind === 'tool_summary' && b.active);
  if (summary?.kind === 'tool_summary') {
    const act = summary.latestActivity;
    if (act?.kind === 'tool') {
      const tool = summary.tools.find((t) => t.callId === act.callId);
      if (tool?.status === 'queued') return { verb: 'Queued', tone: 'muted' };
      if (tool) return toolVerb(tool.name);
    }
    // Still active but between tool events — thinking
    if (act?.kind === 'thinking') return null;
    const running = summary.tools.find((t) => t.status === 'running');
    if (running) return toolVerb(running.name);
    const queued = summary.tools.find((t) => t.status === 'queued');
    if (queued) return { verb: 'Queued', tone: 'muted' };
    return null;
  }

  return null;
}

function currentVerb(
  state: TuiState,
  phase: RunPhase,
): { verb: string; tone: RunStatusTone; note?: string } {
  const compactionVerb = {
    context_preparing: 'Preparing context',
    context_summarizing: 'Summarizing context',
    context_validating: 'Validating context',
  }[state.status.currentNode ?? ''];
  if (compactionVerb) return { verb: compactionVerb, tone: 'primary' };

  switch (phase) {
    case 'thinking': {
      const planActive =
        state.status.phase === 'planning' &&
        state.status.plan &&
        state.status.plan.status !== 'completed';
      return {
        verb: planActive ? 'Planning' : 'Thinking',
        tone: 'primary',
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
  const seconds = Math.max(1, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function formatRunStatusLine(
  snapshot: RunStatusSnapshot,
  columns: number,
  workingLabel = 'Working',
): string {
  // Detailed tool state already lives in the activity blocks. Keep the footer's
  // Working phase deliberately stable and minimal.
  if (snapshot.phase === 'working') return workingLabel;

  const elapsed = formatDuration(snapshot.elapsedMs);
  const note = snapshot.note ? ` · ${snapshot.note}` : '';

  const prefix = `${snapshot.verb}…`;

  const wide = `${prefix} (${elapsed}${note})`;
  if (wide.length <= columns) return wide;

  // Compact: drop note
  const medium = `${prefix} (${elapsed})`;
  if (medium.length <= columns) return medium;

  // Minimal
  return `${prefix} ${elapsed}`;
}
