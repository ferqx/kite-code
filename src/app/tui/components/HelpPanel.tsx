import React from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { darkTheme as t } from "../theme";

interface HelpPanelProps {
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  shortcuts: [string, string][];
}

export default function HelpPanel({ onClose }: HelpPanelProps) {
  useInput(() => {
    onClose();
  });

  const groups: ShortcutGroup[] = [
    {
      title: "Actions",
      shortcuts: [
        ["Ctrl+C", "Cancel / Stop generation"],
        ["Ctrl+C x2", "Exit"],
        ["Ctrl+L", "Clear output"],
        ["Ctrl+R", "Toggle authorization mode"],
        ["Ctrl+T", "Expand/collapse all reasoning"],
        ["Ctrl+E", "Open external editor ($EDITOR)"],
        ["Ctrl+O", "Reset overlays / focus output"],
        ["Ctrl+H / F1", "Show this help"],
      ],
    },
    {
      title: "Leader Keys (Ctrl+X then…)",
      shortcuts: [
        ["C", "Compact context"],
        ["M", "Switch model"],
        ["L", "List sessions"],
        ["E", "External editor"],
        ["N", "New session"],
        ["Q", "Exit"],
      ],
    },
    {
      title: "Navigation",
      shortcuts: [
        ["Up / Down", "Navigate output history"],
        ["PgUp / PgDn", "Page scroll"],
        ["End", "Jump to bottom"],
        ["Esc", "Cancel interaction / close"],
        ["Enter", "Submit / toggle reasoning"],
      ],
    },
    {
      title: "Input",
      shortcuts: [
        ["Enter", "Submit message"],
        ["Shift+Enter", "Newline"],
        ["Up/Down", "Command history"],
      ],
    },
    {
      title: "Slash Commands",
      shortcuts: [
        ["/model", "Switch model"],
        ["/model list", "List available models"],
        ["/plan", "Switch to planning mode"],
        ["/code", "Switch to building mode"],
        ["/auth", "Toggle authorization"],
        ["/clear", "Clear output"],
        ["/thinking", "Toggle reasoning visibility (global)"],
        ["/help", "Show this help"],
        ["/exit", "Exit"],
      ],
    },
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginY={1}>
      <Text bold color={t.primary}>
        ══ Keyboard Shortcuts ══
      </Text>

      {groups.map((group) => (
        <Box key={group.title} flexDirection="column" marginTop={1}>
          <Text bold color={t.warning}>
            {group.title}
          </Text>
          {group.shortcuts.map(([key, desc]) => (
            <Box key={key} paddingLeft={2}>
              <Text color={t.primary}>{key.padEnd(18)}</Text>
              <Text color={t.muted}>{desc}</Text>
            </Box>
          ))}
        </Box>
      ))}

      <Text color={t.dim} marginTop={1}>
        Press any key to close
      </Text>
    </Box>
  );
}
