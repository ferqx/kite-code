// ── Skills 管理 ──

import type { Action } from "./actions";
import type { TuiState } from "../types";

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
      if (state.skillManifests.length === 0) {
        return {
          ...state,
          blocks: [...state.blocks, {
            id: Date.now(),
            kind: "text" as const,
            content: "No skills available.",
          }],
        };
      }
      const lines = state.skillManifests.map(
        (s) => `- **${s.name}**: ${s.description} (${s.source}/${s.origin})`,
      );
      return {
        ...state,
        blocks: [...state.blocks, {
          id: Date.now(),
          kind: "text" as const,
          content: "## Available Skills\n\n" + lines.join("\n"),
        }],
      };
    }
    default:
      return null;
  }
}
