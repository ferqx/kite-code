import React from "react";
import { Box, Text } from "ink";
import type { FileChangeRecord } from "./types";
import { darkTheme as t } from "./theme";

interface DiffPreviewProps {
  changes: FileChangeRecord[];
}

export default function DiffPreview({ changes }: DiffPreviewProps) {
  if (changes.length === 0) return null;

  return (
    <Box flexDirection="column">
      <Text color={t.muted}>── File Changes ──</Text>
      {changes.map((change, i) => (
        <Box key={`${change.path}-${i}`}>
          <Text color={change.kind === "add" ? t.success : t.warning}>
            {change.kind === "add" ? "+" : "~"} {change.path}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
