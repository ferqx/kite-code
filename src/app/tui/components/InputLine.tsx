import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import CtrlSafeTextInput from "./CtrlSafeTextInput";
import type { AtomicBlock } from "./CtrlSafeTextInput";
import { useFileSearch } from "@/app/tui/hooks/useFileSearch";
import {
  useSlashSuggestions,
  SLASH_COMMANDS,
  SLASH_COMMAND_DEFS,
  MODEL_NAMES,
} from "@/app/tui/hooks/useSlashSuggestions";
import { darkTheme as t } from "@/app/tui/theme";

const PASTE_THRESHOLD = 10_000;

interface PasteState {
  pastedContent: string;
  placeholder: string;
}

interface InputLineProps {
  mode: "prompt" | "approval" | "question";
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  workspace: string;
  overlayActive?: boolean;
  editorContentRef?: React.MutableRefObject<(() => string) | null>;
}

function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") break;
  }
  return prefix;
}

function completeSlash(input: string): string | null {
  if (!input.startsWith("/")) return null;

  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const restStr = rest.join(" ");

  if (rest.length === 0 || (rest.length === 1 && restStr.length === 0)) {
    const partial = cmd.toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => c.startsWith(partial));
    if (matches.length === 1) return "/" + matches[0];
    if (matches.length > 1) {
      const prefix = commonPrefix(matches);
      if (prefix.length > partial.length) return "/" + prefix;
    }
    return null;
  }

  if (cmd === "model" && rest.length >= 1) {
    const partial = rest[0].toLowerCase();
    const matches = MODEL_NAMES.filter((m) => m.startsWith(partial));
    if (matches.length === 1) return "/model " + matches[0];
    if (matches.length > 1) {
      const prefix = commonPrefix(matches);
      if (prefix.length > partial.length) return "/model " + prefix;
    }
  }

  return null;
}

export default function InputLine({ mode, onSubmit, disabled, placeholder, workspace, overlayActive, editorContentRef }: InputLineProps) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const fileSearch = useFileSearch(value, workspace);
  const slashSuggestions = useSlashSuggestions(value);

  // Force TextInput remount on programmatic value changes so cursor resets to end.
  // ink-text-input only advances cursorOffset when it exceeds new length, never
  // when the value grows externally — so we remount via changing key.
  const textKeyRef = useRef(0);
  const commitValue = useCallback((next: string) => {
    textKeyRef.current++;
    setValue(next);
  }, []);
  // Track whether slash input needs commit (active suggestions + partial match).
  // Set after slashMatched is computed below.
  const slashNeedsCommitRef = useRef(false);
  // Track whether @file search is active so handleSubmit can suppress
  // premature TextInput submits (same root cause as slash suggestions).
  const fileActiveRef = useRef(false);
  fileActiveRef.current = fileSearch.active;

  const [pasteState, setPasteState] = useState<PasteState | null>(null);
  const pasteStateRef = useRef(pasteState);
  pasteStateRef.current = pasteState;
  const prevValueLenRef = useRef(0);

  const handleChange = useCallback((next: string, meta?: { insertPos: number; insertLen: number }) => {
    const prevLen = prevValueLenRef.current;
    prevValueLenRef.current = next.length;

    if (meta && meta.insertLen >= PASTE_THRESHOLD) {
      const ps = pasteStateRef.current;
      const { insertPos, insertLen } = meta;
      const pastedContent = next.slice(insertPos, insertPos + insertLen);

      if (ps) {
        const oldIdx = next.indexOf(ps.placeholder);
        if (oldIdx >= 0) {
          const cleaned = next.slice(0, oldIdx) + next.slice(oldIdx + ps.placeholder.length);
          let adjustedPos = insertPos;
          if (insertPos >= oldIdx + ps.placeholder.length) {
            adjustedPos = insertPos - ps.placeholder.length;
          }
          const placeholder = `[已粘贴 ${pastedContent.length.toLocaleString()} 字符]`;
          const before = cleaned.slice(0, adjustedPos);
          const after = cleaned.slice(adjustedPos + insertLen);
          setPasteState({ pastedContent, placeholder });
          textKeyRef.current++;
          setValue(before + placeholder + after);
          return;
        }
      }

      const placeholder = `[已粘贴 ${pastedContent.length.toLocaleString()} 字符]`;
      const before = next.slice(0, insertPos);
      const after = next.slice(insertPos + insertLen);
      setPasteState({ pastedContent, placeholder });
      textKeyRef.current++;
      setValue(before + placeholder + after);
      return;
    }

    setValue(next);
  }, []);

  useEffect(() => {
    if (pasteState && !value.includes(pasteState.placeholder)) {
      setPasteState(null);
    }
  }, [value, pasteState]);

  const atomicBlock: AtomicBlock | undefined = pasteState
    ? (() => {
        const idx = value.indexOf(pasteState.placeholder);
        if (idx < 0) return undefined;
        return { start: idx, end: idx + pasteState.placeholder.length - 1 };
      })()
    : undefined;

  const handleSubmit = useCallback(
    (val: string) => {
      const ps = pasteStateRef.current;
      let finalValue: string;
      if (ps) {
        const idx = val.indexOf(ps.placeholder);
        if (idx >= 0) {
          finalValue =
            val.slice(0, idx) +
            ps.pastedContent +
            val.slice(idx + ps.placeholder.length);
        } else {
          finalValue = val;
        }
      } else {
        finalValue = val;
      }

      if (!finalValue.trim()) return;
      if (finalValue.startsWith("/") && slashNeedsCommitRef.current) return;
      if (fileActiveRef.current) return;
      setPasteState(null);
      setHistory((prev) => [...prev, finalValue]);
      setHistoryIndex(-1);
      textKeyRef.current++;
      onSubmit(finalValue);
      const isSlashOverlay = /^\/model(\s|$)/.test(finalValue);
      if (!isSlashOverlay) {
        setValue("");
      }
    },
    [onSubmit],
  );

  // Check if input value is exactly a known slash command (no args, no trailing spaces)
  const slashMatched = useMemo((): boolean => {
    if (!value.startsWith("/")) return false;
    if (/\s/.test(value)) return false;
    const cmd = value.slice(1);
    if (!cmd) return false;
    return SLASH_COMMAND_DEFS.some(
      (def) => def.name === cmd || def.aliases.includes(cmd)
    );
  }, [value]);

  // Sync ref for handleSubmit: only suppress TextInput's premature submit
  // when suggestions are active AND the current text is not yet a valid command.
  slashNeedsCommitRef.current = slashSuggestions.active && !slashMatched;

  // Ghost text: the untyped suffix of the selected suggestion, shown as a dimmed preview
  const slashGhost = useMemo((): string | null => {
    if (!slashSuggestions.active || !slashSuggestions.result) return null;
    const selected = slashSuggestions.result.items[slashSuggestions.selectedIndex];
    if (!selected) return null;
    const suffix = selected.command.slice(slashSuggestions.result.partial.length);
    return suffix.length > 0 ? suffix : null;
  }, [slashSuggestions.active, slashSuggestions.result, slashSuggestions.selectedIndex]);

  const applyHistoryEntry = useCallback((entry: string) => {
    if (entry.length >= PASTE_THRESHOLD) {
      const placeholder = `[已粘贴 ${entry.length.toLocaleString()} 字符]`;
      setPasteState({ pastedContent: entry, placeholder });
      textKeyRef.current++;
      setValue(placeholder);
    } else {
      setPasteState(null);
      setValue(entry);
    }
  }, []);

  useInput((_input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; shift?: boolean; tab?: boolean; escape?: boolean; rightArrow?: boolean; ctrl?: boolean }) => {
    // When an overlay is active, yield all keyboard handling to it
    if (overlayActive) return;

    if (key.escape && pasteState) {
      setPasteState(null);
      commitValue("");
      return;
    }

    // Slash command suggestion navigation
    if (slashSuggestions.active && slashSuggestions.result) {
      if (key.escape) {
        commitValue("");
        return;
      }
      if (key.upArrow) {
        slashSuggestions.setSelectedIndex((s: number) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        slashSuggestions.setSelectedIndex((s: number) =>
          Math.min(slashSuggestions.result!.items.length - 1, s + 1)
        );
        return;
      }
      if (key.tab || key.rightArrow) {
        // Commit ghost text: shell-style common prefix completion
        const names = slashSuggestions.result.items.map((item) => item.command);
        const prefix = commonPrefix(names);
        if (prefix.length > slashSuggestions.result.partial.length) {
          commitValue(slashSuggestions.result.kind === "model" ? "/model " + prefix : "/" + prefix);
        } else {
          // No common prefix extension — commit the selected item directly
          const selected = slashSuggestions.result.items[slashSuggestions.selectedIndex];
          if (selected) {
            commitValue(slashSuggestions.replaceCommand(selected, slashSuggestions.result.kind));
          }
        }
        return;
      }
      if (key.return) {
        // Commit completed command and submit it inline — TextInput already
        // processed Enter (with the partial text) and was suppressed via
        // slashActiveRef in handleSubmit.
        const selected = slashSuggestions.result.items[slashSuggestions.selectedIndex];
        if (selected) {
          const fullCmd = slashSuggestions.replaceCommand(selected, slashSuggestions.result.kind);
          commitValue(fullCmd);
          setHistory((prev) => [...prev, fullCmd]);
          setHistoryIndex(-1);
          textKeyRef.current++;
          onSubmit(fullCmd);
          const isSlashOverlay = /^\/model(\s|$)/.test(fullCmd);
          if (!isSlashOverlay) {
            setValue("");
          }
        }
        return;
      }
    }

    // @file search navigation
    if (fileSearch.active) {
      if (key.escape) {
        // Remove @query to dismiss the dropdown
        commitValue(value.replace(/@\S*$/, ""));
        return;
      }
      if (key.upArrow) {
        fileSearch.setSelectedIndex((s: number) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        fileSearch.setSelectedIndex((s: number) => Math.min(fileSearch.results.length - 1, s + 1));
        return;
      }
      if (key.tab) {
        const selected = fileSearch.results[fileSearch.selectedIndex];
        if (selected) {
          commitValue(fileSearch.replaceQuery(selected));
        }
        return;
      }
      if (key.return) {
        // Same root cause as slash suggestions: TextInput fires before
        // InputLine and would submit the uncompleted text. Commit + submit
        // inline; handleSubmit suppresses the premature TextInput submit.
        const selected = fileSearch.results[fileSearch.selectedIndex];
        if (selected) {
          const newVal = fileSearch.replaceQuery(selected);
          commitValue(newVal);
          setHistory((prev) => [...prev, newVal]);
          setHistoryIndex(-1);
          textKeyRef.current++;
          onSubmit(newVal);
          setValue("");
        }
        return;
      }
    }

    // Tab completion for slash commands (fallback when dropdown is not active)
    if (key.tab) {
      const completed = completeSlash(value);
      if (completed) {
        commitValue(completed);
      }
      return;
    }

    if (key.return && key.shift) {
      commitValue(value + "\n");
      return;
    }
    if (key.upArrow && history.length > 0) {
      const idx = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(idx);
      applyHistoryEntry(history[idx]);
      return;
    }
    if (key.downArrow) {
      if (historyIndex === -1) return;
      const idx = historyIndex + 1;
      if (idx >= history.length) {
        setHistoryIndex(-1);
        setPasteState(null);
        setValue("");
      } else {
        setHistoryIndex(idx);
        applyHistoryEntry(history[idx]);
      }
      return;
    }
  });

  if (editorContentRef) {
    editorContentRef.current = () => {
      const ps = pasteStateRef.current;
      if (ps) {
        const idx = value.indexOf(ps.placeholder);
        if (idx >= 0) {
          return value.slice(0, idx) + ps.pastedContent + value.slice(idx + ps.placeholder.length);
        }
      }
      return value;
    };
  }

  if (disabled) {
    return (
      <Box>
        <Text color={t.dim}>Waiting for response...</Text>
      </Box>
    );
  }

  const promptChar = mode === "approval" ? "[A/S/F/D] " : mode === "question" ? "? " : "> ";

  // Suppress slash suggestions when an overlay is active (stack discipline)
  const showSlashDropdown = slashSuggestions.active && slashSuggestions.result && !overlayActive;

  return (
    <Box flexDirection="column">
      {/* Main input line with ghost text */}
      <Box>
        <Text color={t.primary} bold={slashMatched}>{promptChar}</Text>
        <CtrlSafeTextInput
          key={textKeyRef.current}
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder={placeholder}
          focus={!overlayActive}
          atomicBlock={atomicBlock}
          onRemoveAtomicBlock={() => setPasteState(null)}
        />
        {slashGhost && !overlayActive && (
          <Text color={t.dim}>{slashGhost}</Text>
        )}
      </Box>

      {pasteState && (
        <Box marginTop={1}>
          <Text color={t.dim}>Ctrl+E 在编辑器中查看完整内容</Text>
        </Box>
      )}

      {/* Slash command suggestion dropdown */}
      {showSlashDropdown && (
        <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginTop={1}>
          <Text bold color={t.primary}>
            {slashSuggestions.result!.kind === "model"
              ? `── Models matching "${slashSuggestions.result!.partial}" ──`
              : `── Commands matching /${slashSuggestions.result!.partial} ──`}
          </Text>
          {slashSuggestions.result!.items.map((item, i) => {
            const isSelected = i === slashSuggestions.selectedIndex;
            const aliasStr =
              slashSuggestions.result!.kind === "command" && item.aliases.length > 0
                ? ` (${item.aliases.join(", ")})`
                : "";
            const argsStr = item.args ? ` ${item.args}` : "";
            return (
              <Box key={item.command}>
                <Text color={isSelected ? t.primary : t.muted}>
                  {isSelected ? "❯ " : "  "}/{item.command}{argsStr}
                </Text>
                <Text color={t.dim}>{aliasStr}</Text>
                {item.description && (
                  <Text color={t.dim}> — {item.description}</Text>
                )}
              </Box>
            );
          })}
          <Text color={t.dim}>↑↓ navigate  Tab/→ complete  Enter commit  Esc dismiss</Text>
        </Box>
      )}

      {/* @file search dropdown */}
      {fileSearch.active && (
        <Box flexDirection="column" borderStyle="round" borderColor={t.warning} paddingX={1} marginTop={1}>
          <Text bold color={t.warning}>── Files matching @{fileSearch.query} ──</Text>
          {fileSearch.results.map((f, i) => (
            <Box key={f.path}>
              <Text color={i === fileSearch.selectedIndex ? t.primary : t.muted}>
                {i === fileSearch.selectedIndex ? "❯ " : "  "}
                {f.name}
              </Text>
              <Text color={t.dim}> — {f.path}</Text>
            </Box>
          ))}
          {fileSearch.results.length === 0 && (
            <Text color={t.dim}>  No matching files</Text>
          )}
          <Text color={t.dim}>Tab/Enter select  Esc dismiss</Text>
        </Box>
      )}
    </Box>
  );
}
