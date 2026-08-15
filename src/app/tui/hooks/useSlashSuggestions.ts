import { type SetStateAction, useMemo, useState } from 'react';
import type { SkillManifest } from '@/core/skills/types';

export interface SlashCommandDef {
  name: string;
  aliases: string[];
  description: string;
  args?: string;
}

export const SLASH_COMMAND_DEFS: SlashCommandDef[] = [
  { name: 'effort', aliases: [], description: '设置推理深度' },
  { name: 'model', aliases: [], description: '打开模型选择器' },
  { name: 'theme', aliases: [], description: '切换色彩主题' },
  { name: 'resume', aliases: [], description: '恢复历史会话' },
  { name: 'new', aliases: [], description: '新建会话' },
  { name: 'plan', aliases: [], description: '进入规划模式', args: '[任务]' },
  {
    name: 'compact',
    aliases: [],
    description: '压缩对话上下文',
    args: '[reset|自定义摘要指令]',
  },
  {
    name: 'permissions',
    aliases: [],
    description: '设置权限模式',
  },
  {
    name: 'release',
    aliases: [],
    description: 'Show release profile and Gate status',
  },
  {
    name: 'telemetry',
    aliases: [],
    description: 'Show telemetry consent and export status',
  },
  {
    name: 'mcp',
    aliases: [],
    description: '管理 MCP Server',
  },
  { name: 'rewind', aliases: [], description: '回退检查点并恢复文件' },
  { name: 'export', aliases: [], description: '导出当前会话' },
  { name: 'context', aliases: [], description: '显示上下文用量' },
  { name: 'clear', aliases: ['c'], description: '清空输出' },
  { name: 'help', aliases: ['h'], description: '打开帮助面板' },
  { name: 'exit', aliases: ['quit', 'q'], description: '退出 Kite Code' },
];

export const SLASH_COMMANDS = SLASH_COMMAND_DEFS.map((c) => c.name);

export function findSlashCommandDefs(partial: string): SlashCommandDef[] {
  const normalized = partial.toLowerCase();
  return SLASH_COMMAND_DEFS.filter(
    (command) =>
      command.name.startsWith(normalized) ||
      command.aliases.some((alias) => alias.startsWith(normalized)),
  );
}

export interface SuggestionItem {
  id?: string;
  command: string;
  aliases: string[];
  description: string;
  args?: string;
  /** Whether this item is the currently active selection (e.g. active theme preset) */
  isActive?: boolean;
  disabled?: boolean;
  warning?: string;
}

export interface SlashSuggestionsResult {
  kind: 'command';
  partial: string;
  items: SuggestionItem[];
}

export interface SlashSuggestionData extends SlashSuggestionsResult {
  selectedIndex: number;
}

function nearestEnabledIndex(
  items: SuggestionItem[] | undefined,
  proposed: number,
  previous: number,
): number {
  if (!items || items.length === 0) return 0;
  const clamped = Math.max(0, Math.min(items.length - 1, proposed));
  if (!items[clamped]?.disabled) return clamped;

  const direction = clamped >= previous ? 1 : -1;
  for (let i = clamped + direction; i >= 0 && i < items.length; i += direction) {
    if (!items[i]?.disabled) return i;
  }
  for (let i = clamped - direction; i >= 0 && i < items.length; i -= direction) {
    if (!items[i]?.disabled) return i;
  }
  return clamped;
}

export function useSlashSuggestions(inputValue: string, skillManifests?: SkillManifest[]) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const result = useMemo((): SlashSuggestionsResult | null => {
    // /<partial-command>
    const cmdMatch = inputValue.match(/^\/(\S*)$/);
    if (!cmdMatch) return null;

    const partial = cmdMatch[1]!.toLowerCase();
    const commands = findSlashCommandDefs(partial);

    // Also check skill manifests
    if (skillManifests && skillManifests.length > 0) {
      const skillMatches = skillManifests
        .filter((s) => s.name.startsWith(partial))
        .map((s) => ({
          name: s.name,
          aliases: [] as string[],
          description: s.description,
        }));

      if (skillMatches.length > 0) {
        commands.push(...skillMatches);
      }
    }

    if (commands.length === 0) return null;

    return {
      kind: 'command',
      partial,
      items: commands.map((c) => ({
        command: c.name,
        aliases: c.aliases,
        description: c.description,
        args: c.args,
      })),
    };
  }, [inputValue, skillManifests]);

  // Reset selection when results change
  const active = result !== null && result.items.length > 0;

  // Memo: clamp selectedIndex when results change
  const safeSelectedIndex = result
    ? nearestEnabledIndex(result.items, selectedIndex, selectedIndex)
    : 0;

  const setSelectableIndex = (next: SetStateAction<number>) => {
    setSelectedIndex((previous) => {
      const proposed = typeof next === 'function' ? next(previous) : next;
      return nearestEnabledIndex(result?.items, proposed, previous);
    });
  };

  const replaceCommand = (item: SuggestionItem): string => {
    return `/${item.command}`;
  };

  return {
    result,
    active,
    selectedIndex: safeSelectedIndex,
    setSelectedIndex: setSelectableIndex,
    replaceCommand,
  };
}
