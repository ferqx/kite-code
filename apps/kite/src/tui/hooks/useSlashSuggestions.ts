import type { SkillManifest } from '@kite/runtime-contract';
import { type SetStateAction, useMemo, useState } from 'react';
import { type MessageKey, useI18n } from '../i18n';

export interface SlashCommandDef {
  name: string;
  aliases: string[];
  descriptionKey?: MessageKey;
  description?: string;
  argsKey?: MessageKey;
}

export const SLASH_COMMAND_DEFS: SlashCommandDef[] = [
  { name: 'effort', aliases: [], descriptionKey: 'command.effort' },
  { name: 'model', aliases: [], descriptionKey: 'command.model' },
  { name: 'theme', aliases: [], descriptionKey: 'command.theme' },
  { name: 'language', aliases: [], descriptionKey: 'command.language' },
  { name: 'resume', aliases: [], descriptionKey: 'command.resume' },
  { name: 'new', aliases: [], descriptionKey: 'command.new' },
  { name: 'plan', aliases: [], descriptionKey: 'command.plan', argsKey: 'slash.args.plan' },
  {
    name: 'compact',
    aliases: [],
    descriptionKey: 'command.compact',
    argsKey: 'slash.args.compact',
  },
  {
    name: 'permissions',
    aliases: [],
    descriptionKey: 'command.permissions',
  },
  {
    name: 'release',
    aliases: [],
    descriptionKey: 'command.release',
  },
  {
    name: 'telemetry',
    aliases: [],
    descriptionKey: 'command.telemetry',
  },
  {
    name: 'mcp',
    aliases: [],
    descriptionKey: 'command.mcp',
  },
  { name: 'rewind', aliases: [], descriptionKey: 'command.rewind' },
  { name: 'export', aliases: [], descriptionKey: 'command.export' },
  { name: 'context', aliases: [], descriptionKey: 'command.context' },
  { name: 'clear', aliases: ['c'], descriptionKey: 'command.clear' },
  { name: 'help', aliases: ['h'], descriptionKey: 'command.help' },
  { name: 'exit', aliases: ['quit', 'q'], descriptionKey: 'command.exit' },
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
  const { t } = useI18n();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const result = useMemo((): SlashSuggestionsResult | null => {
    // /<partial-command>
    const cmdMatch = inputValue.match(/^\/(\S*)$/);
    if (!cmdMatch) return null;

    const partial = cmdMatch[1]!.toLowerCase();
    const commands = findSlashCommandDefs(partial);

    // Also check skill manifests
    if (skillManifests && skillManifests.length > 0) {
      const skillMatches: SlashCommandDef[] = skillManifests
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
        description: c.description ?? (c.descriptionKey ? t(c.descriptionKey) : ''),
        args: c.argsKey ? t(c.argsKey) : undefined,
      })),
    };
  }, [inputValue, skillManifests, t]);

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
