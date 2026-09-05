// ── Skills 管理 ──

import type { OutputBlock, TuiState } from '../types';
import type { Action } from './actions';

export function skillReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case 'SET_SKILL_MANIFESTS':
      return { ...state, skillManifests: action.manifests };
    case 'LIST_SKILLS': {
      const block: OutputBlock =
        state.skillManifests.length === 0
          ? {
              id: state.nextBlockId,
              kind: 'text',
              content: 'No skills available.',
              presentationState: 'sealed',
            }
          : {
              id: state.nextBlockId,
              kind: 'text',
              presentationState: 'sealed',
              content:
                '## Available Skills\n\n' +
                state.skillManifests
                  .map((s) => `- **${s.name}**: ${s.description} (${s.source}/${s.origin})`)
                  .join('\n'),
            };
      const last = state.turns.at(-1);
      if (last) {
        const turns = state.turns.slice();
        turns[turns.length - 1] = { blocks: [...last.blocks, block] };
        return { ...state, turns, nextBlockId: block.id + 1 };
      }
      return { ...state, turns: [{ blocks: [block] }], nextBlockId: block.id + 1 };
    }
    default:
      return null;
  }
}
