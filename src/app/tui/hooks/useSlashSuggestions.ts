import { type SetStateAction, useMemo, useState } from 'react';
import { listAvailableModels } from '@/core/config';
import { detectSandboxBackend, type SandboxBackend } from '@/core/sandbox';
import type { SkillManifest } from '@/core/skills/types';

export interface SlashCommandDef {
  name: string;
  aliases: string[];
  description: string;
  args?: string;
}

export const SLASH_COMMAND_DEFS: SlashCommandDef[] = [
  { name: 'effort', aliases: [], description: 'Set reasoning effort', args: 'low|medium|high|max' },
  { name: 'model', aliases: [], description: 'Switch model', args: '[name]' },
  {
    name: 'theme',
    aliases: [],
    description: 'Switch color theme',
    args: 'teal|blue|purple|cyan|mono',
  },
  { name: 'sessions', aliases: [], description: 'Show sessions' },
  { name: 'new', aliases: [], description: 'Start a new session' },
  { name: 'plan', aliases: [], description: 'Enter planning mode' },
  { name: 'permissions', aliases: [], description: 'Set permissions', args: 'ask|auto|full' },
  { name: 'mcp', aliases: [], description: 'Open MCP management panel' },
  { name: 'clear', aliases: ['c'], description: 'Clear output' },
  { name: 'help', aliases: ['h'], description: 'Show help' },
  { name: 'exit', aliases: ['quit', 'q'], description: 'Exit Kite Code' },
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
  command: string;
  aliases: string[];
  description: string;
  args?: string;
  /** Whether this item is the currently active selection (e.g. active theme preset) */
  isActive?: boolean;
  disabled?: boolean;
}

export interface SlashSuggestionsResult {
  kind: 'command' | 'model' | 'effort' | 'theme' | 'permissions';
  partial: string;
  items: SuggestionItem[];
}

export interface ActiveSelections {
  theme?: string;
  model?: string;
  interactionMode?: string;
  sandboxBackend?: SandboxBackend;
}

export function buildModeSuggestionItems(
  partial: string,
  activeInteractionMode: string | undefined,
  sandboxBackend: SandboxBackend,
): SuggestionItem[] {
  const fullDisabled = sandboxBackend === 'none';
  const modes = [
    {
      command: 'accept_edits',
      description: '本地工作区操作自动执行；出网、外部写入和未知副作用需确认',
      disabled: false,
    },
    { command: 'auto', description: '模型自动审核，不确定时询问', disabled: false },
    {
      command: 'full',
      description: fullDisabled ? '未启用沙箱，Full 不可用' : '完全自主，全部放行，不询问用户',
      disabled: fullDisabled,
    },
  ];

  return modes
    .filter((m) => m.command.startsWith(partial))
    .map((m) => ({
      command: m.command,
      aliases: [],
      description: m.description,
      isActive: m.command === activeInteractionMode,
      disabled: m.disabled,
    }));
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

export function useSlashSuggestions(
  inputValue: string,
  skillManifests?: SkillManifest[],
  activeSelections?: ActiveSelections,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const result = useMemo((): SlashSuggestionsResult | null => {
    // /model <partial-model-name>
    const modelMatch = inputValue.match(/^\/model\s+(\S*)$/i);
    if (modelMatch) {
      const partial = modelMatch[1]!.toLowerCase();
      const available = listAvailableModels();
      const models = available
        .map((m) => m.name)
        .filter((n) => n.toLowerCase().startsWith(partial));
      if (models.length === 0) return null;
      return {
        kind: 'model',
        partial,
        items: models.map((m) => ({
          command: m,
          aliases: [],
          description: '',
          isActive: m === activeSelections?.model,
        })),
      };
    }

    // /effort <partial-level>
    const effortMatch = inputValue.match(/^\/effort\s+(\S*)$/i);
    if (effortMatch) {
      const partial = effortMatch[1]!;
      const levels = ['low', 'medium', 'high', 'max'];
      const matched = levels.filter((l) => l.startsWith(partial));
      if (matched.length === 0) return null;
      return {
        kind: 'effort',
        partial,
        items: matched.map((l) => ({ command: l, aliases: [], description: '' })),
      };
    }

    // /theme <partial-preset>
    const themeMatch = inputValue.match(/^\/theme\s+(\S*)$/i);
    if (themeMatch) {
      const partial = themeMatch[1]!.toLowerCase();
      const presets = ['teal', 'blue', 'purple', 'cyan', 'mono'];
      const matched = presets.filter((p) => p.startsWith(partial));
      if (matched.length === 0) return null;
      return {
        kind: 'theme',
        partial,
        items: matched.map((p) => ({
          command: p,
          aliases: [],
          description: '',
          isActive: p === activeSelections?.theme,
        })),
      };
    }

    // /permissions <partial-mode>
    const modeMatch = inputValue.match(/^\/permissions\s+(\S*)$/i);
    if (modeMatch) {
      const partial = modeMatch[1]!.toLowerCase();
      const matched = buildModeSuggestionItems(
        partial,
        activeSelections?.interactionMode,
        activeSelections?.sandboxBackend ?? detectSandboxBackend(),
      );
      if (matched.length === 0) return null;
      return {
        kind: 'permissions',
        partial,
        items: matched,
      };
    }

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
  }, [inputValue, skillManifests, activeSelections]);

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

  const replaceCommand = (
    item: SuggestionItem,
    kind: 'command' | 'model' | 'effort' | 'theme' | 'permissions',
  ): string => {
    if (kind === 'model') {
      return inputValue.replace(/\/model\s+\S*$/, `/model ${item.command}`);
    }
    if (kind === 'effort') {
      return inputValue.replace(/\/effort\s+\S*$/, `/effort ${item.command}`);
    }
    if (kind === 'permissions') {
      return inputValue.replace(/\/permissions\s+\S*$/, `/permissions ${item.command}`);
    }
    if (kind === 'theme') {
      return inputValue.replace(/\/theme\s+\S*$/, `/theme ${item.command}`);
    }
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
