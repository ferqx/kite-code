import React, { useState, useRef } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { useSessionList } from "../hooks/useSessionList.js";
import type { SessionInfo } from "../hooks/useSessionList.js";
import { darkTheme as t } from "@/app/tui/theme";

interface SessionSelectorProps {
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

export default function SessionSelector({ onSelect, onClose }: SessionSelectorProps) {
  const { sessions, loading, error } = useSessionList();
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useInput((_input, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(sessions.length - 1, s + 1));
    if (key.return && sessions.length > 0) {
      const session = sessions[selectedRef.current];
      if (session) onSelect(session.threadId);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginY={1}>
      <Text bold color={t.primary}>会话列表</Text>
      <Box flexDirection="column" marginTop={1}>
        {loading && <Text color={t.muted}>Loading...</Text>}
        {error && <Text color={t.error}>Error: {error}</Text>}
        {!loading && !error && sessions.length === 0 && (
          <Text color={t.muted}>暂无历史会话</Text>
        )}
        {sessions.map((session, i) => (
          <Box key={session.threadId}>
            <Text color={i === selected ? t.primary : t.muted}>
              {i === selected ? ">" : " "} {session.name}
            </Text>
            <Text color={t.dim}>  {session.updatedAt}</Text>
          </Box>
        ))}
      </Box>
      <Box height={1} />
      <Text color={t.dim}>上/下 导航  Enter 选择  Esc 关闭</Text>
    </Box>
  );
}
