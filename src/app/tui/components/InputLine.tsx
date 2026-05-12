import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import TextInput from "ink-text-input";
import { darkTheme as t } from "../theme";

interface InputLineProps {
  mode: "prompt" | "approval" | "question";
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export default function InputLine({ mode, onSubmit, disabled, placeholder }: InputLineProps) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

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

  useInput((_input: unknown, key: { upArrow?: boolean; downArrow?: boolean }) => {
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
    <Box>
      <Text color={t.primary}>{promptChar}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={placeholder}
      />
    </Box>
  );
}
