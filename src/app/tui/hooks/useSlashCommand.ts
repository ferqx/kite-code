import type { Dispatch } from 'react';
import { useCallback } from 'react';
import { listAvailableModels } from '@/core/config';
import type { SandboxBackend } from '@/core/sandbox';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { AgentPhase } from '@/protocol/events';
import { admitInteractionModeTarget, resolveInteractionModeTarget } from '../interaction-mode';
import type { Action } from '../reducers/actions';

export type SlashAction =
  | { type: 'effort'; level: string }
  | { type: 'model'; name?: string }
  | { type: 'theme'; preset?: string }
  | { type: 'sessions'; id?: string }
  | { type: 'plan'; task?: string }
  | { type: 'permissions'; mode?: string }
  | { type: 'clear' }
  | { type: 'help' }
  | { type: 'new' }
  | { type: 'exit' }
  | { type: 'mcp'; command: 'open' | 'retry'; server?: string }
  | { type: 'rewind' }
  | { type: 'export' }
  | { type: 'unknown'; raw: string };

export function parseSlashCommand(input: string): SlashAction | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  const [cmd, ...args] = trimmed.split(/\s+/);
  const arg = args.join(' ');

  switch (cmd) {
    case 'effort':
      return { type: 'effort', level: arg || 'max' };
    case 'model':
      return { type: 'model', name: arg || undefined };
    case 'theme':
      return { type: 'theme', preset: arg || undefined };
    case 'sessions':
      return { type: 'sessions' };
    case 'plan':
      return { type: 'plan', task: arg || undefined };
    case 'permissions':
      return { type: 'permissions', mode: arg || undefined };
    case 'clear':
    case 'c':
      return { type: 'clear' };
    case 'help':
    case 'h':
      return { type: 'help' };
    case 'new':
      return { type: 'new' };
    case 'mcp':
      return args[0] === 'retry'
        ? { type: 'mcp', command: 'retry', server: args[1] || undefined }
        : { type: 'mcp', command: 'open', server: arg || undefined };
    case 'rewind':
      return { type: 'rewind' };
    case 'export':
      return { type: 'export' };
    case 'exit':
    case 'quit':
    case 'q':
      return { type: 'exit' };
    default:
      return { type: 'unknown', raw: input };
  }
}

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
  onMcpCommand?: (command: 'open' | 'retry', server?: string) => void,
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
          if (action.name) {
            const available = listAvailableModels();
            const matched = available.find(
              (m) => m.name.toLowerCase() === action.name?.toLowerCase(),
            );
            if (matched) {
              dispatch({ type: 'SELECT_MODEL', modelId: matched.name });
            } else {
              dispatch({ type: 'SHOW_MODEL_SELECTOR' });
            }
          } else {
            dispatch({ type: 'SHOW_MODEL_SELECTOR' });
          }
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
        case 'clear':
          dispatch({ type: 'CLEAR_OUTPUT' });
          break;
        case 'help':
          dispatch({ type: 'SHOW_HELP' });
          break;
        case 'mcp':
          onMcpCommand?.(action.command, action.server);
          dispatch({ type: 'SHOW_MCP' });
          break;
        case 'rewind':
          dispatch({ type: 'SHOW_REWIND' });
          break;
        case 'export':
          dispatch({ type: 'EXPORT_SESSION' });
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
      onMcpCommand,
    ],
  );
}
