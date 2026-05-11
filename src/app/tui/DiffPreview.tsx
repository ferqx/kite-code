import React from "react";
import { Box, Text } from "ink";
import type { FileChangeRecord } from "./types";
import { darkTheme as t } from "./theme";

interface DiffPreviewProps {
  changes: FileChangeRecord[];
}

function changePrefix(kind: FileChangeRecord["kind"]): { prefix: string; color: string } {
  switch (kind) {
    case "add": return { prefix: "+", color: t.success };
    case "edit": return { prefix: "~", color: t.warning };
    case "delete": return { prefix: "-", color: t.error };
  }
}

export default function DiffPreview({ changes }: DiffPreviewProps) {
  if (changes.length === 0) return null;

  return (
    <Box flexDirection="column">
      <Text color={t.muted}>── File Changes ──</Text>
      {changes.map((change) => {
        const { prefix, color } = changePrefix(change.kind);
        return (
          <Box key={`${change.path}-${change.kind}`}>
            <Text color={color}>
              {prefix} {change.path}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
