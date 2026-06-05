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
      title: "快捷键",
      shortcuts: [
        ["Ctrl+C", "中断运行 / 双按退出"],
        ["Ctrl+T", "展开/折叠所有 reasoning"],
        ["Ctrl+E", "展开输入框折叠内容"],
        ["Ctrl+L", "清空输出屏幕"],
        ["Shift+Enter", "换行"],
        ["?", "打开帮助面板（输入为空时）"],
        ["Esc", "取消交互 / 关闭面板"],
      ],
    },
    {
      title: "输入",
      shortcuts: [
        ["Enter", "提交消息"],
        ["Shift+Enter", "换行"],
        ["Up/Down", "命令历史"],
        ["Tab", "补全斜杠命令或文件路径"],
      ],
    },
    {
      title: "斜杠命令",
      shortcuts: [
        ["/model", "切换模型"],
        ["/sessions", "浏览会话历史"],
        ["/new", "新建会话"],
        ["/clear", "清空输出"],
        ["/compact", "压缩上下文"],
        ["/thinking", "切换 reasoning 可见性"],
        ["/auth", "切换授权模式"],
        ["/plan", "切换规划模式"],
        ["/setting", "查看当前设置"],
        ["/mcp", "MCP 面板"],
        ["/rewind", "回退检查点"],
        ["/export", "导出会话"],
        ["/help", "帮助面板"],
        ["/exit", "退出"],
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
    // Only close on Escape — other keys are ignored
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
