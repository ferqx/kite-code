import type { AgentPhase, SkillManifest, SkillScanOptions } from '@kite-ai/runtime-contract';
import type { Dispatch } from 'react';
import { useCallback } from 'react';
import type { Action } from '../reducers/actions';
import { SLASH_COMMAND_DEFS } from './useSlashSuggestions';

export type SlashAction =
  | { type: 'effort' }
  | { type: 'effort_invalid_args' }
  | { type: 'model' }
  | { type: 'theme' }
  | { type: 'theme_invalid_args' }
  | { type: 'language' }
  | { type: 'sessions'; id?: string }
  | { type: 'plan'; task?: string }
  | { type: 'permissions' }
  | { type: 'permissions_invalid_args' }
  | { type: 'clear' }
  | { type: 'help' }
  | { type: 'new' }
  | { type: 'exit' }
  | { type: 'mcp' }
  | { type: 'rewind' }
  | { type: 'export' }
  | { type: 'context' }
  | { type: 'status' }
  | { type: 'web' }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'compact_reset' }
  | { type: 'unknown'; raw: string };

export function parseSlashCommand(input: string): SlashAction | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  const [rawCommand, ...args] = trimmed.split(/\s+/);
  const normalizedCommand = rawCommand?.toLowerCase();
  const cmd =
    SLASH_COMMAND_DEFS.find(
      (definition) =>
        definition.name === normalizedCommand ||
        definition.aliases.includes(normalizedCommand ?? ''),
    )?.name ?? normalizedCommand;
  const arg = args.join(' ');

  switch (cmd) {
    case 'effort':
      return args.length === 0 ? { type: 'effort' } : { type: 'effort_invalid_args' };
    case 'model':
      return args.length === 0 ? { type: 'model' } : { type: 'unknown', raw: input };
    case 'theme':
      return args.length === 0 ? { type: 'theme' } : { type: 'theme_invalid_args' };
    case 'language':
      return args.length === 0 ? { type: 'language' } : { type: 'unknown', raw: input };
    case 'resume':
      return { type: 'sessions' };
    case 'plan':
      return { type: 'plan', task: arg || undefined };
    case 'permissions':
      return args.length === 0 ? { type: 'permissions' } : { type: 'permissions_invalid_args' };
    case 'clear':
      return { type: 'clear' };
    case 'help':
      return { type: 'help' };
    case 'new':
      return { type: 'new' };
    case 'mcp':
      return args.length === 0 ? { type: 'mcp' } : { type: 'unknown', raw: input };
    case 'rewind':
      return { type: 'rewind' };
    case 'export':
      return { type: 'export' };
    case 'context':
      return { type: 'context' };
    case 'status':
      return args.length === 0 ? { type: 'status' } : { type: 'unknown', raw: input };
    case 'web':
      return args.length === 0 ? { type: 'web' } : { type: 'unknown', raw: input };
    case 'compact':
      // PR 9: /compact reset is a distinct action, not a compaction with customInstructions="reset"
      if (args[0] === 'reset' && args.length === 1) {
        return { type: 'compact_reset' };
      }
      return { type: 'compact', ...(arg ? { customInstructions: arg } : {}) };
    case 'exit':
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
  onCompact?: (customInstructions?: string) => void,
  onContext?: () => void,
  onCompactReset?: () => void,
  onDiscoverWeb?: () => Promise<string | undefined>,
  onStatus?: () => void,
) {
  return useCallback(
    (input: string): boolean => {
      const action = parseSlashCommand(input);
      if (!action) return false;

      switch (action.type) {
        case 'effort':
          dispatch({ type: 'SHOW_EFFORT_SELECTOR' });
          break;
        case 'effort_invalid_args':
          dispatch({
            type: 'LOCAL_TEXT',
            text: '推理深度只能在选择器中设置，请直接输入 /effort。',
            isError: true,
          });
          break;
        case 'model':
          dispatch({ type: 'SHOW_MODEL_SELECTOR' });
          break;
        case 'theme':
          dispatch({ type: 'SHOW_THEME_SELECTOR' });
          break;
        case 'language':
          dispatch({ type: 'SHOW_LANGUAGE_SELECTOR' });
          break;
        case 'theme_invalid_args':
          dispatch({
            type: 'LOCAL_TEXT',
            text: '主题只能在选择器中设置，请直接输入 /theme。',
            isError: true,
          });
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
        case 'permissions':
          dispatch({ type: 'SHOW_PERMISSION_SELECTOR' });
          break;
        case 'permissions_invalid_args':
          dispatch({
            type: 'LOCAL_TEXT',
            text: '权限模式只能在选择器中设置，请直接输入 /permissions。',
            isError: true,
          });
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
        case 'status':
          onStatus?.();
          break;
        case 'web':
          dispatch({ type: 'USER_MESSAGE', text: '/web' });
          if (!onDiscoverWeb) {
            dispatch({
              type: 'LOCAL_TEXT',
              text: '  ⎿  Kite Web is not running. Run `kite-code web`.',
              isError: true,
            });
            break;
          }
          void onDiscoverWeb()
            .then((url) => {
              dispatch({
                type: 'LOCAL_TEXT',
                text: url ? `  ⎿  ${url}` : '  ⎿  Kite Web is not running. Run `kite-code web`.',
                ...(url ? {} : { isError: true }),
              });
            })
            .catch(() => {
              dispatch({
                type: 'LOCAL_TEXT',
                text: '  ⎿  Kite Web discovery is unavailable.',
                isError: true,
              });
            });
          break;
        case 'exit':
          // Process teardown is owned by the single injected TUI exit coordinator.  Keeping the
          // optional callback as a no-op in isolated hook tests avoids a second direct exit path.
          onExit?.();
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
      onCompact,
      onContext,
      onCompactReset,
      onDiscoverWeb,
      onStatus,
    ],
  );
}
