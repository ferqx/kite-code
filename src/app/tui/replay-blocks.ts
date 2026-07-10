import type { SessionData } from '../../core/persistence/sessions.js';
import { createInitialState } from './initialState.js';
import { consolidateAllRuns } from './reducers/consolidateTools.js';
import { handleRuntimeEventAction } from './reducers/handleEvent.js';
import type { InterruptState, OutputBlock } from './types.js';

/** Replay is intentionally RuntimeEvent-only.  Graph checkpoint messages are
 * not a supported recovery format after the Kernel cutover. */
export function sessionDataToUI(data: SessionData): {
  blocks: OutputBlock[];
  interrupt: InterruptState | null;
} {
  let state = createInitialState();
  for (const event of data.runtimeEvents) state = handleRuntimeEventAction(state, event);
  const blocks = consolidateAllRuns(state.turns.flatMap((turn) => turn.blocks));
  const callIds = new Map(
    blocks.flatMap((block) =>
      'callId' in block && block.callId ? [[block.callId, block.id] as const] : [],
    ),
  );
  const interrupt: InterruptState | null =
    data.interrupt?.kind === 'approval'
      ? { kind: 'approval', blockId: callIds.get(data.interrupt.callId ?? '') ?? 0 }
      : data.interrupt?.kind === 'input'
        ? { kind: 'input', blockId: callIds.get(data.interrupt.callId ?? '') ?? 0 }
        : data.interrupt?.kind === 'plan_review'
          ? { kind: 'plan_review', plan: data.interrupt.plan }
          : null;
  return { blocks, interrupt };
}
