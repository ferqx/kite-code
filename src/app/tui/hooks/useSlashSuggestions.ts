import { useState, useMemo } from "react";
import type { SkillManifest } from "@/core/skills/types";
import { listAvailableModels } from "@/core/config";

export interface SlashCommandDef {
  name: string;
  aliases: string[];
  description: string;
  args?: string;
}

export const SLASH_COMMAND_DEFS: SlashCommandDef[] = [
  { name: "effort", aliases: [], description: "Set reasoning effort", args: "low|medium|high|max" },
  { name: "model", aliases: [], description: "Switch model", args: "[name]" },
  { name: "sessions", aliases: [], description: "Show sessions", args: "[id]" },
  { name: "new", aliases: [], description: "Start a new session" },
  { name: "plan", aliases: [], description: "Enter planning mode" },
  { name: "auth", aliases: [], description: "Toggle authorization mode", args: "[mode]" },
  { name: "clear", aliases: ["c"], description: "Clear output" },
  { name: "compact", aliases: [], description: "Compact context" },
  { name: "setting", aliases: ["config"], description: "Show settings" },
  { name: "help", aliases: ["h"], description: "Show help" },
  { name: "exit", aliases: ["quit", "q"], description: "Exit OpenPX" },
];

export const SLASH_COMMANDS = SLASH_COMMAND_DEFS.map((c) => c.name);

export interface SuggestionItem {
  command: string;
  aliases: string[];
  description: string;
  args?: string;
}

export interface SlashSuggestionsResult {
  kind: "command" | "model" | "effort";
  partial: string;
  items: SuggestionItem[];
}

export function useSlashSuggestions(
  inputValue: string,
  skillManifests?: SkillManifest[],
) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const result = useMemo((): SlashSuggestionsResult | null => {
    // /model <partial-model-name>
    const modelMatch = inputValue.match(/^\/model\s+(\S*)$/i);
    if (modelMatch) {
      const partial = modelMatch[1].toLowerCase();
      const available = listAvailableModels();
      const models = available
        .map((m) => m.name)
        .filter((n) => n.toLowerCase().startsWith(partial));
      if (models.length === 0) return null;
      return {
        kind: "model",
        partial,
        items: models.map((m) => ({ command: m, aliases: [], description: "" })),
      };
    }

    // /effort <partial-level>
    const effortMatch = inputValue.match(/^\/effort\s+(\S*)$/i);
    if (effortMatch) {
      const partial = effortMatch[1];
      const levels = ["low", "medium", "high", "max"];
      const matched = levels.filter((l) => l.startsWith(partial));
      if (matched.length === 0) return null;
      return {
        kind: "effort",
        partial,
        items: matched.map((l) => ({ command: l, aliases: [], description: "" })),
      };
    }

    // /<partial-command>
    const cmdMatch = inputValue.match(/^\/(\S*)$/);
    if (!cmdMatch) return null;

    const partial = cmdMatch[1].toLowerCase();
    const commands = SLASH_COMMAND_DEFS.filter(
      (cmd) =>
        cmd.name.startsWith(partial) ||
        cmd.aliases.some((a) => a.startsWith(partial))
    );

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
      kind: "command",
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
  const safeSelectedIndex =
    result && selectedIndex >= result.items.length ? 0 : selectedIndex;

  const replaceCommand = (item: SuggestionItem, kind: "command" | "model" | "effort"): string => {
    if (kind === "model") {
      return inputValue.replace(/\/model\s+\S*$/, `/model ${item.command}`);
    }
    if (kind === "effort") {
      return inputValue.replace(/\/effort\s+\S*$/, `/effort ${item.command}`);
    }
    return "/" + item.command;
  };

  return {
    result,
    active,
    selectedIndex: safeSelectedIndex,
    setSelectedIndex,
    replaceCommand,
  };
}
