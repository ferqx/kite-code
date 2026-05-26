import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme";
import type { CheckpointEntry } from "@/core/persistence/checkpoint";

export type { CheckpointEntry };

interface CheckpointSelectorProps {
  checkpoints: CheckpointEntry[];
  onRevert: (checkpointId: string) => void;
  onFork: (checkpointId: string) => void;
  onClose: () => void;
}

export default function CheckpointSelector({ checkpoints, onRevert, onFork, onClose }: CheckpointSelectorProps) {
  const t = useTheme();
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(checkpoints.length - 1, s + 1));
      return;
    }
    if (key.return) {
      const cp = checkpoints[selected];
      if (cp) onRevert(cp.checkpointId);
      return;
    }
    const char = _input.toLowerCase();
    if (char === "r") {
      const cp = checkpoints[selected];
      if (cp) onRevert(cp.checkpointId);
      return;
    }
    if (char === "f") {
      const cp = checkpoints[selected];
      if (cp) onFork(cp.checkpointId);
      return;
    }
  });

  if (checkpoints.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={t.dim} paddingX={1} marginY={1}>
        <Text bold color={t.primary}>Rewind</Text>
        <Box marginTop={1}>
          <Text color={t.muted}>No checkpoints found for the current session.</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>Press any key to close</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.dim} paddingX={1} marginY={1}>
      <Text bold color={t.primary}>Rewind — select a checkpoint</Text>

      <Box flexDirection="column" marginTop={1}>
        {checkpoints.map((cp, i) => {
          const isSelected = i === selected;
          const prefix = isSelected ? "\u2192" : " ";
          const color = isSelected ? t.primary : t.muted;
          const displayId = cp.checkpointId.slice(0, 8);
          const displayMsg = cp.firstUserMessage || "(no message)";
          const displayTime = cp.createdAt ? cp.createdAt.slice(0, 19) : "";

          return (
            <Text key={cp.checkpointId} color={color}>
              {prefix} {i + 1}. [{displayId}] {displayMsg}
              {displayTime ? ` \u2014 ${displayTime}` : ""}
            </Text>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={t.dim}>
          [Enter]/[R]evert  [F]ork  [Esc] cancel  \u2191\u2193 navigate
        </Text>
      </Box>
    </Box>
  );
}
