import React from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { darkTheme as t } from "../theme";

interface HelpPanelProps {
  onClose: () => void;
}

export default function HelpPanel({ onClose }: HelpPanelProps) {
  useInput(() => {
    onClose();
  });

  const rows: [string, string][] = [
    ["Ctrl+C", "Cancel / Stop generation"],
    ["Ctrl+C x2", "Exit"],
    ["Ctrl+L", "Clear output"],
    ["Ctrl+R", "Toggle authorization mode"],
    ["Ctrl+T", "Toggle thinking/reasoning"],
    ["Ctrl+E", "Open external editor"],
    ["Ctrl+Z / Y", "Undo / Redo"],
    ["Ctrl+H", "Show this help"],
    ["Ctrl+X ...", "Leader key menu"],
    ["  Ctrl+X C", "Compact context"],
    ["  Ctrl+X M", "List models"],
    ["  Ctrl+X L", "List sessions"],
    ["  Ctrl+X E", "External editor"],
    ["  Ctrl+X N", "New session"],
    ["  Ctrl+X Q", "Exit"],
    ["↑/↓", "Navigate output history"],
    ["PgUp/PgDn", "Page scroll"],
    ["End", "Jump to bottom"],
    ["Esc", "Cancel / close"],
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginY={1}>
      <Text bold color={t.primary}>── Keyboard Shortcuts ──</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map(([key, desc]) => (
          <Box key={key}>
            <Text color={t.warning}>{key.padEnd(14)}</Text>
            <Text color={t.muted}>{desc}</Text>
          </Box>
        ))}
      </Box>
      <Text color={t.dim} marginTop={1}>Press any key to close</Text>
    </Box>
  );
}
