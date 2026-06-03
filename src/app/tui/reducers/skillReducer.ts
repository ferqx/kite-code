// ── Skills 管理 ──

import type { Action } from "./actions";
import type { TuiState, OutputBlock } from "../types";

export function skillReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case "SET_SKILL_MANIFESTS":
      return { ...state, skillManifests: action.manifests };
    case "ACTIVATE_SKILL": {
      const content = `[SKILL: ${action.name}]\n\n${action.content}\n\n---\n\n`;
      return { ...state, pendingSkills: [...state.pendingSkills, content] };
    }
    case "DEACTIVATE_SKILL":
      return { ...state, pendingSkills: [] };
    case "LIST_SKILLS": {
      const block: OutputBlock = state.skillManifests.length === 0
        ? { id: state.nextBlockId, kind: "text", content: "No skills available." }
        : {
            id: state.nextBlockId, kind: "text",
            content: "## Available Skills\n\n" + state.skillManifests.map(
              (s) => `- **${s.name}**: ${s.description} (${s.source}/${s.origin})`,
            ).join("\n"),
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
