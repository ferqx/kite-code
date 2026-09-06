import type { RuntimeClientInteraction } from '@kite-ai/runtime-contract';
import { Box, render, Text } from 'ink';
import { useEffect, useState } from 'react';
import App from '../../../apps/kite-cli/src/tui/App';
import { createInitialState } from '../../../apps/kite-cli/src/tui/initialState';
import { projectOutputBlockTimeline } from '../../../apps/kite-cli/src/tui/presentation/timeline';
import { TuiUserInputProvider } from '../../../apps/kite-cli/src/tui/provider';
import type { OutputBlock } from '../../../apps/kite-cli/src/tui/types';

const provider = new TuiUserInputProvider();
const startedAt = Date.now();
const mode = process.env.KITE_LIVE_SCROLL_CASE ?? 'mixed';
const history: OutputBlock[] = Array.from({ length: 70 }, (_, i) => ({
  id: i + 1,
  kind: 'text',
  content: `HISTORY_${i} immutable line`,
  presentationState: 'sealed',
}));
function Fixture() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let next = 0;
    const t = setInterval(() => {
      next += 1;
      setTick(next);
      if (next === 8) clearInterval(t);
    }, 600);
    return () => clearInterval(t);
  }, []);
  const settled = tick === 8;
  const children: OutputBlock[] = Array.from({ length: 4 }, (_, i) => ({
    id: 100 + i,
    kind: 'subagent',
    subagentId: `child-${i}`,
    role: 'explore',
    task: `Child ${i}`,
    status: settled ? 'done' : 'running',
    summary: '',
    toolCallCount: tick,
    durationMs: 0,
    startedAt,
    concurrencyGroupId: 'group',
    presentationState: settled ? 'sealed' : 'live',
    steps: [
      {
        stepId: `step-${i}`,
        toolCallId: `tool-${i}`,
        toolName: 'read_file',
        toolArgs: { path: `file-${tick}.ts` },
        status: settled ? 'success' : 'pending',
      },
    ],
  }));
  const shell: OutputBlock = {
    id: 90,
    kind: 'tool_card',
    callId: 'shell',
    name: 'shell_execute',
    args: { command: 'fixture' },
    status: settled ? 'done' : 'running',
    summary: settled ? 'Shell completed' : '',
    startedAt,
    liveOutput: Array.from({ length: tick % 2 === 0 ? 8 : 1 }, (_, i) => `LIVE_${tick}_${i}`).join(
      '\n',
    ),
    presentationState: settled ? 'sealed' : 'live',
  };
  const thinking: OutputBlock = {
    id: 80,
    kind: 'tool_summary',
    createdAt: startedAt,
    active: !settled,
    hasThought: mode !== 'tools',
    hasThinking: mode !== 'tools',
    summaryLine: `read ${tick + 1} files`,
    totalElapsedMs: Math.floor(tick / 2) * 600,
    liveModelStartedAt: !settled && tick % 2 === 0 ? startedAt + tick * 600 : undefined,
    latestActivity:
      mode !== 'tools' && tick % 2 === 0
        ? {
            kind: 'thinking',
            text: Array.from({ length: 7 }, (_, i) => `THINKING_${tick}_${i}`).join('\n'),
          }
        : { kind: 'tool', callId: 'read-0' },
    tools: Array.from({ length: tick % 2 === 0 ? 1 : 7 }, (_, i) => ({
      callId: `read-${i}`,
      name: 'read_file',
      args: { path: `read-${tick}-${i}.ts` },
      ok: settled,
      status: settled ? 'done' : 'running',
      summary: '',
    })),
    result: settled ? 'done' : undefined,
    presentationState: settled ? 'sealed' : 'live',
  };
  const approvedShells: OutputBlock[] = Array.from({ length: 3 }, (_, i) => {
    const started = tick >= i * 2;
    const done = settled || (i === 0 && tick >= 6);
    return {
      id: 90 + i,
      kind: 'tool_card',
      callId: `shell-${i}`,
      name: 'shell_execute',
      args: { command: `Shell ${i}` },
      preview: `SHELL_${i}`,
      status: done ? 'done' : started ? 'running' : 'queued',
      summary: done ? 'Completed' : '',
      startedAt: started ? startedAt + i * 1_200 : undefined,
      elapsedMs: done ? 3_600 : undefined,
      liveOutput: started ? `OUTPUT_${i}_${tick}` : undefined,
      presentationState: done ? 'sealed' : 'live',
    };
  });
  const blocks =
    mode === 'approved-shells'
      ? approvedShells
      : mode === 'shell'
        ? [shell]
        : mode === 'thinking' || mode === 'tools'
          ? [thinking]
          : mode === 'subagents'
            ? children
            : [thinking, shell, ...children];
  if (settled)
    blocks.push({ id: 200, kind: 'text', content: 'SETTLED_DONE', presentationState: 'sealed' });
  const state = {
    ...createInitialState(),
    activeSessionId: 'fixture',
    exited: settled,
    runStartTime: startedAt,
    queuedPrompts: Array.from({ length: settled ? 0 : tick % 4 }, (_, i) => ({
      id: i,
      sessionId: 'fixture',
      text: `Queued ${i}`,
    })),
    turns: [{ blocks: history }, { blocks }],
  };
  if (mode === 'approved-shells' && tick < 4) {
    const id = tick < 2 ? 'shell-1' : 'shell-2';
    const interaction: Extract<RuntimeClientInteraction, { kind: 'approval' }> = {
      kind: 'approval',
      interactionId: id,
      sessionRevision: tick,
      generation: 0,
      grants: ['approve_once'],
      owner: { kind: 'root_tool', toolCallId: id },
      command: `Approve ${id}`,
      title: 'shell_execute',
      summary: 'Approve this command',
    };
    state.activeApprovalId = id;
    state.pendingApprovals = new Map([
      [
        id,
        {
          interactionId: id,
          toolCallId: id,
          owner: interaction.owner,
          route: 'user',
          status: 'awaiting_user',
          sequence: tick,
          generation: 0,
          clientInteraction: interaction,
        },
      ],
    ]);
  }
  state.presentationTimeline = projectOutputBlockTimeline(
    state.turns.flatMap((turn) => turn.blocks),
  );
  return (
    <App state={state} dispatch={() => {}} onToggleReason={() => {}} provider={provider}>
      <Box flexDirection="column" flexShrink={0}>
        <Text>────────────────────────</Text>
        <Text>❯ input</Text>
        <Text>────────────────────────</Text>
      </Box>
    </App>
  );
}
render(<Fixture />, { interactive: true, incrementalRendering: true, exitOnCtrlC: true });
