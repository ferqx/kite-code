import React, { useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { ScrollList } from "ink-scroll-list";
import { useTheme } from "@/app/tui/theme";
import { useOverlayHeight } from "../hooks/useOverlayHeight";

interface HelpPanelProps {
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  shortcuts: [string, string][];
}

export default function HelpPanel({ onClose }: HelpPanelProps) {
  const t = useTheme();
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxContentHeight = useOverlayHeight(8);

  const groups: ShortcutGroup[] = [
    {
      title: "Actions",
      shortcuts: [
        ["Ctrl+C", "Cancel / Stop generation"],
        ["Ctrl+C x2", "Exit"],
        ["Ctrl+L", "Clear output"],
        ["Ctrl+N", "New session"],
        ["Ctrl+R", "Toggle authorization mode"],
        ["Ctrl+T", "Expand/collapse all reasoning"],
        ["Ctrl+E", "Open external editor ($EDITOR)"],
        ["Shift+Enter", "Insert newline"],
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
        ["Q", "Exit"],
      ],
    },
    {
      title: "Navigation",
      shortcuts: [
        ["Up / Down", "Navigate output history"],
        ["Esc", "Cancel interaction / close overlays"],
        ["Enter", "Submit / toggle reasoning block"],
      ],
    },
    {
      title: "Input",
      shortcuts: [
        ["Enter", "Submit message"],
        ["Shift+Enter", "Newline"],
        ["Up/Down", "Command history"],
        ["Escape", "Clear paste placeholder / dismiss suggestions"],
        ["Tab", "Autocomplete slash command or file path"],
      ],
    },
    {
      title: "Slash Commands",
      shortcuts: [
        ["/model", "Switch model"],
        ["/model list", "List available models"],
        ["/plan", "Switch to planning mode"],
        ["/auth", "Toggle authorization"],
        ["/clear", "Clear output"],
        ["/compact", "Compact context"],
        ["/thinking", "Toggle reasoning visibility"],
        ["/sessions", "Browse session history"],
        ["/new", "New session"],
        ["/setting", "Show current settings"],
        ["/help", "Show this help"],
        ["/exit", "Exit"],
      ],
    },
  ];

  type FlatRow =
    | { type: "header"; id: string; title: string }
    | { type: "shortcut"; id: string; key: string; desc: string };

  const flatRows: FlatRow[] = groups.flatMap((group, gi) => [
    { type: "header" as const, id: `h-${gi}`, title: group.title },
    ...group.shortcuts.map(([key, desc], si) => ({ type: "shortcut" as const, id: `s-${gi}-${si}`, key, desc })),
  ]);

  useInput((_input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) { setScrollOffset((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setScrollOffset((s) => Math.min(flatRows.length - 1, s + 1)); return; }
    onClose();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginY={1}>
      <Text bold color={t.primary}>
        快捷键
      </Text>

      <Box marginTop={1} flexGrow={1} maxHeight={maxContentHeight}>
        <ScrollList selectedIndex={scrollOffset} scrollAlignment="auto">
          {flatRows.map((row, i) => {
            if (row.type === "header") {
              return (
                <Box key={row.id} marginTop={i === 0 ? 0 : 1}>
                  <Text bold color={t.warning}>{row.title}</Text>
                </Box>
              );
            }
            return (
              <Box key={row.id} paddingLeft={2}>
                <Text color={t.primary}>{row.key.padEnd(18)}</Text>
                <Text color={t.muted}>{row.desc}</Text>
              </Box>
            );
          })}
        </ScrollList>
      </Box>

      <Box marginTop={1}>
        <Text color={t.dim}>Esc 关闭  ↑↓ 滚动</Text>
      </Box>
    </Box>
  );
}
