import React, { useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import type { OutputLine } from "./types";
import { darkTheme as t } from "./theme";

interface OutputAreaProps {
  lines: OutputLine[];
  onToggleReason: (id: number) => void;
}

export default function OutputArea({ lines, onToggleReason }: OutputAreaProps) {
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  useInput((_input, key) => {
    if (!key) return;
    if (key.upArrow && lines.length > 0) {
      setFocusedIndex((prev) => Math.max(0, (prev ?? lines.length) - 1));
    }
    if (key.downArrow && lines.length > 0) {
      setFocusedIndex((prev) => Math.min(lines.length - 1, (prev ?? -1) + 1));
    }
    if (key.return && focusedIndex !== null) {
      const line = lines[focusedIndex];
      if (line && line.type === "reason") {
        onToggleReason(line.id);
      }
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {lines.map((line, i) => (
        <Box key={line.id} flexDirection="column">
          {line.type === "reason" ? (
            <Box flexDirection="column">
              <Text color={i === focusedIndex ? t.primary : t.dim}>
                {line.folded ? "▶ Thinking..." : "▼ Thinking"}
              </Text>
              {!line.folded && (
                <Box paddingLeft={2}>
                  <Text color={t.muted}>{line.content}</Text>
                </Box>
              )}
            </Box>
          ) : (
            <Text color={i === focusedIndex ? t.primary : undefined}>{line.content}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
