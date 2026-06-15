import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { ScrollList } from "ink-scroll-list";
import stringWidth from "string-width";
import CtrlSafeTextInput from "./CtrlSafeTextInput";
import type { AtomicBlock } from "./CtrlSafeTextInput";
import { useFileSearch } from "@/app/tui/hooks/useFileSearch";
import {
  useSlashSuggestions,
  SLASH_COMMANDS,
  SLASH_COMMAND_DEFS,
} from "@/app/tui/hooks/useSlashSuggestions";
import { listAvailableModels } from "@/core/config";
import { useTheme } from "@/app/tui/theme";
import { useOverlayHeight } from "../hooks/useOverlayHeight";
import { useTerminalFocus } from "../hooks/useTerminalFocus";

export const PASTE_THRESHOLD = 100;
const MAX_INPUT_LENGTH = 100_000; // 100KB — reject input exceeding this to prevent DOS

interface PasteState {
  pastedContent: string;
  placeholder: string;
}

export interface EditorContentHandle {
  getContent(): string;
  handleEditorResult(content: string): void;
}

export interface SlashSuggestionData {
  kind: "command" | "model" | "effort";
  partial: string;
  items: Array<{
    command: string;
    aliases: string[];
    description: string;
    args?: string;
  }>;
  selectedIndex: number;
}

interface InputLineProps {
  mode: "prompt" | "approval" | "question";
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  workspace: string;
  overlayActive?: boolean;
  editorContentRef?: React.MutableRefObject<EditorContentHandle | null>;
  onSlashSuggestionChange?: (data: SlashSuggestionData | null) => void;
  /** Initial value — used to restore input text after resize remount. */
  initialValue?: string;
  /** Called when the input value changes (for external state sync). */
  onValueChange?: (value: string) => void;
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
    const available = listAvailableModels().map((m) => m.name);
    const matches = available.filter((m) => m.startsWith(partial));
    if (matches.length === 1) return "/model " + matches[0];
    if (matches.length > 1) {
      const prefix = commonPrefix(matches);
      if (prefix.length > partial.length) return "/model " + prefix;
    }
  }

  return null;
}

export default function InputLine({ mode, onSubmit, disabled, placeholder, workspace, overlayActive, editorContentRef, onSlashSuggestionChange, initialValue = "", onValueChange }: InputLineProps) {
  const t = useTheme();
  const { columns } = useWindowSize();
  const hasWindowFocus = useTerminalFocus();
  const fileMaxHeight = useOverlayHeight(7);
  const [value, setValue] = useState(initialValue);
  // Sync value changes to parent for resize persistence
  useEffect(() => {
    onValueChange?.(value);
  }, [value, onValueChange]);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const fileSearch = useFileSearch(value, workspace);
  const slashSuggestions = useSlashSuggestions(value);
  // Refs for useInput to avoid Ink 7 stale closure (read latest values)
  const slashSuggestionsRef = useRef(slashSuggestions);
  slashSuggestionsRef.current = slashSuggestions;
  const fileSearchRef = useRef(fileSearch);
  fileSearchRef.current = fileSearch;

  // Notify parent about slash suggestion changes
  useEffect(() => {
    if (onSlashSuggestionChange) {
      if (slashSuggestions.active && slashSuggestions.result) {
        onSlashSuggestionChange({
          kind: slashSuggestions.result.kind,
          partial: slashSuggestions.result.partial,
          items: slashSuggestions.result.items,
          selectedIndex: slashSuggestions.selectedIndex,
        });
      } else {
        onSlashSuggestionChange(null);
      }
    }
  }, [slashSuggestions.active, slashSuggestions.result, slashSuggestions.selectedIndex, onSlashSuggestionChange]);

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
  const [inputWarning, setInputWarning] = useState<string | null>(null);
  const pasteStateRef = useRef(pasteState);
  pasteStateRef.current = pasteState;

  const clearPasteState = useCallback(() => setPasteState(null), []);

  const handleChange = useCallback((next: string, meta?: { insertPos: number; insertLen: number }) => {

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

  // Auto-dismiss input warning after 3 seconds
  useEffect(() => {
    if (!inputWarning) return;
    const timer = setTimeout(() => setInputWarning(null), 3000);
    return () => clearTimeout(timer);
  }, [inputWarning]);

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

      // Normalize \r\n and standalone \r to \n, preventing carriage
      // return from resetting cursor to column 0 and overwriting output.
      finalValue = finalValue.replace(/\r\n?/g, "\n");

      if (!finalValue.trim()) return;
      if (finalValue.length > MAX_INPUT_LENGTH) {
        // Reject oversized input with visual feedback
        setInputWarning(`Input too large (${(finalValue.length / 1000).toFixed(0)}KB > ${(MAX_INPUT_LENGTH / 1000).toFixed(0)}KB limit)`);
        return;
      }
      if (finalValue.startsWith("/") && slashNeedsCommitRef.current) return;
      if (fileActiveRef.current) return;
      setPasteState(null);
      setHistory((prev) => {
        const next = [...prev, finalValue];
        // Cap history to prevent unbounded memory growth
        if (next.length > 500) return next.slice(next.length - 500);
        return next;
      });
      setHistoryIndex(-1);
      textKeyRef.current++;
      onSubmit(finalValue);
      setValue("");
    },
    [onSubmit],
  );
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

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
      textKeyRef.current++;
      setValue(entry);
    }
  }, []);

  // History navigation triggered by CtrlSafeTextInput when cursor is at line boundary
  const handleNavigateHistory = useCallback((direction: "up" | "down") => {
    if (direction === "up" && history.length > 0) {
      const idx = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(idx);
      applyHistoryEntry(history[idx]);
    } else if (direction === "down") {
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
    }
  }, [history, historyIndex, applyHistoryEntry]);

  useInput((_input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; shift?: boolean; meta?: boolean; tab?: boolean; escape?: boolean; rightArrow?: boolean; ctrl?: boolean }) => {
    // When an overlay is active, yield all keyboard handling to it
    if (overlayActive) return;

    if (key.escape && pasteStateRef.current) {
      setPasteState(null);
      commitValue("");
      return;
    }

    const ss = slashSuggestionsRef.current;
    const fs = fileSearchRef.current;

    // Slash command suggestion navigation
    if (ss.active && ss.result) {
      if (key.escape) {
        // Dismiss suggestions without clearing input (preserve what user typed)
        return;
      }
      if (key.upArrow) {
        ss.setSelectedIndex((s: number) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        ss.setSelectedIndex((s: number) =>
          Math.min(ss.result!.items.length - 1, s + 1)
        );
        return;
      }
      if (key.tab || key.rightArrow) {
        // Commit ghost text: shell-style common prefix completion
        const names = ss.result.items.map((item) => item.command);
        const prefix = commonPrefix(names);
        if (prefix.length > ss.result.partial.length) {
          commitValue(ss.result.kind === "model" ? "/model " + prefix : ss.result.kind === "effort" ? "/effort " + prefix : "/" + prefix);
        } else {
          // No common prefix extension — commit the selected item directly
          const selected = ss.result.items[ss.selectedIndex];
          if (selected) {
            commitValue(ss.replaceCommand(selected, ss.result.kind));
          }
        }
        return;
      }
      if (key.return) {
        // Commit completed command and submit it inline — TextInput already
        // processed Enter (with the partial text) and was suppressed via
        // slashActiveRef in handleSubmit.
        const selected = ss.result.items[ss.selectedIndex];
        if (selected) {
          const fullCmd = ss.replaceCommand(selected, ss.result.kind);
          commitValue(fullCmd);
          setHistory((prev) => [...prev, fullCmd]);
          setHistoryIndex(-1);
          textKeyRef.current++;
          onSubmit(fullCmd);
          setValue("");
        }
        return;
      }
    }

    // @file search navigation
    if (fs.active) {
      if (key.escape) {
        // Remove @query to dismiss the dropdown
        commitValue(valueRef.current.replace(/@\S*$/, ""));
        return;
      }
      if (key.upArrow) {
        fs.setSelectedIndex((s: number) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        fs.setSelectedIndex((s: number) => Math.min(fs.results.length - 1, s + 1));
        return;
      }
      if (key.tab) {
        const selected = fs.results[fs.selectedIndex];
        if (selected) {
          commitValue(fs.replaceQuery(selected));
        }
        return;
      }
      if (key.return) {
        // Same root cause as slash suggestions: TextInput fires before
        // InputLine and would submit the uncompleted text. Commit + submit
        // inline; handleSubmit suppresses the premature TextInput submit.
        const selected = fs.results[fs.selectedIndex];
        if (selected) {
          const newVal = fs.replaceQuery(selected);
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
      const completed = completeSlash(valueRef.current);
      if (completed) {
        commitValue(completed);
      }
      return;
    }

    if (key.return) {
      if (key.shift || key.meta) {
        // Handled by CtrlSafeTextInput (inserts at cursor position).
        return;
      }
      handleSubmitRef.current(valueRef.current);
      return;
    }
    // Up/Down cursor movement and history navigation are handled by
    // CtrlSafeTextInput (multi-line cursor) via onNavigateHistory callback.
  });

  // Keep editorContentRef in sync via useEffect (not render body) per React purity guidelines
  useEffect(() => {
    if (editorContentRef) {
      editorContentRef.current = {
        getContent: () => {
          const ps = pasteStateRef.current;
          if (ps) {
            const idx = value.indexOf(ps.placeholder);
            if (idx >= 0) {
              return value.slice(0, idx) + ps.pastedContent + value.slice(idx + ps.placeholder.length);
            }
          }
          return value;
        },
        handleEditorResult: (content: string) => {
          if (!content) return;
          if (content.length >= PASTE_THRESHOLD) {
            const placeholder = `[已粘贴 ${content.length.toLocaleString()} 字符]`;
            setPasteState({ pastedContent: content, placeholder });
            textKeyRef.current++;
            setValue(placeholder);
          } else {
            setPasteState(null);
            textKeyRef.current++;
            setValue(content);
          }
        },
      };
    }
  });

  if (disabled) {
    return (
      <Box>
        <Text color={t.dim}>Waiting for response...</Text>
      </Box>
    );
  }

  const promptChar = mode === "approval" ? "↑↓ select · Enter confirm  " : mode === "question" ? "? " : "❯ ";
  const promptWidth = stringWidth(promptChar);
  const inputMaxWidth = Math.max(1, columns - promptWidth * 2);

  // Slash suggestions are rendered in App.tsx Overlay area

  return (
    <Box flexDirection="column">
      {/* Main input line with ghost text */}
      <Text color={t.primary}>{"─".repeat(inputMaxWidth + promptWidth)}</Text>
      <Box>
        <Text color={t.primary} bold={slashMatched}>{promptChar}</Text>
        <CtrlSafeTextInput
          key={textKeyRef.current}
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder={placeholder}
          focus={!overlayActive && hasWindowFocus}
          atomicBlock={atomicBlock}
          onRemoveAtomicBlock={clearPasteState}
          onNavigateHistory={handleNavigateHistory}
          disableArrowNav={slashSuggestions.active || fileSearch.active}
          trailingText={slashGhost ?? undefined}
          maxWidth={inputMaxWidth}
        />
      </Box>
      <Text color={t.primary}>{"─".repeat(inputMaxWidth + promptWidth)}</Text>

      {pasteState && (
        <Box marginTop={1}>
          <Text color={t.dim}>Ctrl+E 展开粘贴内容</Text>
        </Box>
      )}
      {inputWarning && (
        <Box marginTop={1}>
          <Text color={t.error}>{inputWarning}</Text>
        </Box>
      )}

      {/* @file search dropdown */}
      {fileSearch.active && (() => {
        if (fileSearch.results.length === 0) {
          return (
            <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginTop={1}>
              <Text bold color={t.primary}>文件匹配 @{fileSearch.query}</Text>
              <Text color={t.dim}>  No matching files</Text>
              <Text color={t.dim}>Esc 关闭</Text>
            </Box>
          );
        }
        const listHeight = Math.max(3, fileMaxHeight - 2);
        return (
        <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginTop={1} flexGrow={1} maxHeight={fileMaxHeight}>
          <Text bold color={t.primary}>文件匹配 @{fileSearch.query}</Text>
          <Box flexGrow={1} maxHeight={listHeight}>
            <ScrollList selectedIndex={fileSearch.selectedIndex} scrollAlignment="auto">
              {fileSearch.results.map((f, i) => (
                <Box key={f.path}>
                  <Text color={i === fileSearch.selectedIndex ? t.primary : t.muted}>
                    {i === fileSearch.selectedIndex ? "❯ " : "  "}
                    {f.name}
                  </Text>
                  <Text color={t.dim}> — {f.path}</Text>
                </Box>
              ))}
            </ScrollList>
          </Box>
          <Text color={t.dim}>Tab/Enter 选择  Esc 关闭</Text>
        </Box>
        );
      })()}
    </Box>
  );
}
