import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import TextInput from "ink-text-input";
import { useFileSearch } from "../hooks/useFileSearch";
import { darkTheme as t } from "../theme";

interface InputLineProps {
  mode: "prompt" | "approval" | "question";
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  workspace: string;
}

const SLASH_COMMANDS = [
  "thinking", "model", "sessions", "plan", "code", "auth",
  "clear", "compact", "undo", "redo", "export", "editor",
  "setting", "help", "exit",
];

const MODEL_NAMES = ["deepseek-v4", "deepseek-v3", "gpt-4o", "claude-sonnet-4"];

function completeSlash(input: string): string | null {
  if (!input.startsWith("/")) return null;

  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const restStr = rest.join(" ");

  if (rest.length === 0 || (rest.length === 1 && restStr.length === 0)) {
    const partial = cmd.toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => c.startsWith(partial));
    if (matches.length === 1) return "/" + matches[0];
    if (matches.length > 1) {
      let common = matches[0];
      for (const m of matches.slice(1)) {
        let i = 0;
        while (i < common.length && i < m.length && common[i] === m[i]) i++;
        common = common.slice(0, i);
      }
      if (common.length > partial.length) return "/" + common;
    }
    return null;
  }

  if (cmd === "model" && rest.length >= 1) {
    const partial = rest[0].toLowerCase();
    const matches = MODEL_NAMES.filter((m) => m.startsWith(partial));
    if (matches.length === 1) return "/model " + matches[0];
    if (matches.length > 1) {
      let common = matches[0];
      for (const m of matches.slice(1)) {
        let i = 0;
        while (i < common.length && i < m.length && common[i] === m[i]) i++;
        common = common.slice(0, i);
      }
      if (common.length > partial.length) return "/model " + common;
    }
  }

  return null;
}

export default function InputLine({ mode, onSubmit, disabled, placeholder, workspace }: InputLineProps) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const fileSearch = useFileSearch(value, workspace);

  const handleSubmit = useCallback(
    (val: string) => {
      if (val.trim()) {
        setHistory((prev) => [...prev, val]);
        setHistoryIndex(-1);
        onSubmit(val);
        setValue("");
      }
    },
    [onSubmit]
  );

  useInput((_input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; shift?: boolean; tab?: boolean }) => {
    // @file search navigation
    if (fileSearch.active) {
      if (key.upArrow) {
        fileSearch.setSelectedIndex((s: number) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        fileSearch.setSelectedIndex((s: number) => Math.min(fileSearch.results.length - 1, s + 1));
        return;
      }
      if (key.tab || key.return) {
        const selected = fileSearch.results[fileSearch.selectedIndex];
        if (selected) {
          const newVal = fileSearch.replaceQuery(selected);
          setValue(newVal);
        }
        return;
      }
    }

    // Tab completion for slash commands
    if (key.tab) {
      const completed = completeSlash(value);
      if (completed) {
        setValue(completed);
      }
      return;
    }

    if (key.return && key.shift) {
      setValue((v) => v + "\n");
      return;
    }
    if (key.upArrow && history.length > 0) {
      const idx = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(idx);
      setValue(history[idx]);
      return;
    }
    if (key.downArrow) {
      if (historyIndex === -1) return;
      const idx = historyIndex + 1;
      if (idx >= history.length) {
        setHistoryIndex(-1);
        setValue("");
      } else {
        setHistoryIndex(idx);
        setValue(history[idx]);
      }
    }
  });

  if (disabled) {
    return (
      <Box>
        <Text color={t.dim}>Waiting for response...</Text>
      </Box>
    );
  }

  const promptChar = mode === "approval" ? "[A/S/F/D] " : mode === "question" ? "? " : "> ";

  return (
    <Box flexDirection="column">
      {/* @file search dropdown */}
      {fileSearch.active && (
        <Box flexDirection="column" borderStyle="round" borderColor={t.warning} paddingX={1} marginBottom={1}>
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

      {/* Main input line */}
      <Box>
        <Text color={t.primary}>{promptChar}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder={placeholder}
        />
      </Box>
    </Box>
  );
}
