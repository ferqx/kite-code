import type { Dispatch } from 'react';
import { useCallback } from 'react';
import type { SandboxBackend } from '@/core/sandbox';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { AgentPhase } from '@/protocol/events';
import { admitInteractionModeTarget, resolveInteractionModeTarget } from '../interaction-mode';
import { parseSlashCommand } from '../public-surface';
import type { Action } from '../reducers/actions';

export type { SlashAction } from '../public-surface';
export { parseSlashCommand } from '../public-surface';

export function useSlashCommand(
  dispatch: Dispatch<Action>,
  onExit?: () => void,
  mcpPromptRegistry?: ReadonlyMap<
    string,
    {
      server: string;
      prompt: { name: string; description?: string; arguments?: readonly unknown[] };
    }
  >,
  skillManifests?: SkillManifest[],
  _skillOptions?: SkillScanOptions,
  onRunTask?: (
    task: string,
    requestedPhase?: AgentPhase,
    initialSkillActivations?: Array<{ skillId: string; input: Record<string, unknown> }>,
  ) => void,
  onEnterPlanMode?: () => void,
  onTheme?: (preset: string) => void,
  currentInteractionMode: 'accept_edits' | 'auto' | 'full' = 'accept_edits',
  sandboxBackend: SandboxBackend = 'none',
  onCompact?: (customInstructions?: string) => void,
  onContext?: () => void,
  onCompactReset?: () => void,
  executionStatusText?: string,
  releaseStatusText?: string,
  telemetryStatusText?: string,
) {
  return useCallback(
    (input: string): boolean => {
      const action = parseSlashCommand(input);
      if (!action) return false;

      switch (action.type) {
        case 'effort':
          dispatch({ type: 'SET_THINKING_LEVEL', level: action.level });
          break;
        case 'model':
          dispatch({ type: 'SHOW_MODEL_SELECTOR' });
          break;
        case 'theme':
          if (onTheme && action.preset) {
            onTheme(action.preset);
          }
          break;
        case 'sessions':
          dispatch({ type: 'SHOW_SESSIONS' });
          break;
        case 'new':
          dispatch({ type: 'NEW_SESSION', threadId: '' });
          break;
        case 'plan':
          dispatch({ type: 'SWITCH_AUTH', mode: 'default' });
          // The runtime persists planning.entered when this task starts.
          if (action.task && onRunTask) {
            onRunTask(action.task, 'planning');
          } else {
            onEnterPlanMode?.();
          }
          break;
        case 'permissions': {
          if (!action.mode && executionStatusText) {
            dispatch({ type: 'LOCAL_TEXT', text: executionStatusText });
            break;
          }
          const target = resolveInteractionModeTarget(
            action.mode,
            currentInteractionMode,
            sandboxBackend,
          );
          if (!target) break;
          const admission = admitInteractionModeTarget(target, sandboxBackend);
          if (!admission.allowed) {
            dispatch({ type: 'SET_INTERACTION_MODE', mode: admission.mode });
            dispatch({
              type: 'LOCAL_TEXT',
              text: admission.reason ?? 'Interaction mode is not available.',
              isError: true,
            });
            break;
          }
          dispatch({ type: 'SET_INTERACTION_MODE', mode: admission.mode });
          break;
        }
        case 'release':
          if (releaseStatusText) dispatch({ type: 'LOCAL_TEXT', text: releaseStatusText });
          break;
        case 'telemetry':
          if (telemetryStatusText) dispatch({ type: 'LOCAL_TEXT', text: telemetryStatusText });
          break;
        case 'clear':
          dispatch({ type: 'CLEAR_OUTPUT' });
          break;
        case 'help':
          dispatch({ type: 'SHOW_HELP' });
          break;
        case 'mcp':
          dispatch({ type: 'SHOW_MCP' });
          break;
        case 'rewind':
          dispatch({ type: 'SHOW_REWIND' });
          break;
        case 'export':
          dispatch({ type: 'EXPORT_SESSION' });
          break;
        case 'compact':
          onCompact?.(action.customInstructions);
          break;
        case 'compact_reset':
          onCompactReset?.();
          break;
        case 'context':
          onContext?.();
          break;
        case 'exit':
          if (onExit) onExit();
          else process.exit(0);
          break;
        default: {
          // Check MCP prompt registry for dynamic commands like /mcp__servername__promptname
          if (action.type === 'unknown' && mcpPromptRegistry) {
            const cmd = action.raw.slice(1).trim().split(/\s+/)[0]!;
            const entry = mcpPromptRegistry.get(cmd);
            if (entry) {
              dispatch({
                type: 'INJECT_MCP_PROMPT',
                server: entry.server,
                promptName: entry.prompt.name,
              });
              return true;
            }
          }
          // Check skills
          const raw = action.raw;
          if (action.type === 'unknown' && skillManifests && _skillOptions) {
            const parts = raw.slice(1).trim().split(/\s+/);
            const skillName = parts[0]!;
            const matched = skillManifests.find((s) => s.name === skillName);
            if (matched) {
              const taskPart = parts.slice(1).join(' ');
              onRunTask?.(taskPart || `Run the ${matched.name} Skill Workflow.`, undefined, [
                { skillId: `skill:${matched.name}`, input: {} },
              ]);
              return true;
            }
          }
          return false;
        }
      }
      return true;
    },
    [
      dispatch,
      onExit,
      mcpPromptRegistry,
      skillManifests,
      _skillOptions,
      onRunTask,
      onEnterPlanMode,
      onTheme,
      currentInteractionMode,
      sandboxBackend,
      onCompact,
      onContext,
      onCompactReset,
      executionStatusText,
      releaseStatusText,
      telemetryStatusText,
    ],
  );
}
