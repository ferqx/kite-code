import type { SessionData } from '../../core/persistence/sessions.js';
import { createInitialState } from './initialState.js';
import { handleRuntimeEventAction } from './reducers/handleEvent.js';
import type { InterruptState, OutputBlock } from './types.js';

/** Replay is intentionally RuntimeEvent-only.  Graph checkpoint messages are
 * not a supported recovery format after the Kernel cutover. */
export function sessionDataToUI(data: SessionData): {
  blocks: OutputBlock[];
  interrupt: InterruptState | null;
  pendingToolCalls: import('./types.js').TuiState['pendingToolCalls'];
} {
  let state = createInitialState();
  for (const event of data.runtimeEvents) state = handleRuntimeEventAction(state, event);
  // Replay uses the same event reducer as the live stream. Do not run a
  // replay-only consolidation pass, or static output can diverge from live UI.
  const blocks = state.turns.flatMap((turn) => turn.blocks);
  const callIds = new Map(
    blocks.flatMap((block) =>
      'callId' in block && block.callId ? [[block.callId, block.id] as const] : [],
    ),
  );
  const interrupt: InterruptState | null =
    state.interrupt ??
    (data.interrupt?.kind === 'approval'
      ? (() => {
          const blockId = callIds.get(data.interrupt?.callId ?? '');
          const block =
            blockId == null ? undefined : blocks.find((candidate) => candidate.id === blockId);
          return block?.kind === 'approval'
            ? { kind: 'approval' as const, approval: block.approval, blockId }
            : null;
        })()
      : data.interrupt?.kind === 'input'
        ? { kind: 'input', blockId: callIds.get(data.interrupt.callId ?? '') ?? 0 }
        : data.interrupt?.kind === 'plan_review'
          ? {
              kind: 'plan_review',
              plan: data.interrupt.plan,
              ...(data.interrupt.artifact ? { artifact: data.interrupt.artifact } : {}),
            }
          : null);
  return { blocks, interrupt, pendingToolCalls: state.pendingToolCalls };
}
