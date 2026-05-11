import React from "react";
import { Box, Text } from "ink";
import type { OutputLine } from "./types";
import { darkTheme as t } from "./theme";

interface OutputAreaProps {
  lines: OutputLine[];
  onToggleReason: (id: number) => void;
}

export default function OutputArea({ lines, onToggleReason }: OutputAreaProps) {
  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {lines.map((line) => (
        <Box key={line.id} flexDirection="column">
          {line.type === "reason" ? (
            <Box flexDirection="column">
              <Text color={t.dim}>
                {line.folded ? "▶ Thinking..." : "▼ Thinking"}
              </Text>
              {!line.folded && (
                <Box paddingLeft={2}>
                  <Text color={t.muted}>{line.content}</Text>
                </Box>
              )}
            </Box>
          ) : (
            <Text>{line.content}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
