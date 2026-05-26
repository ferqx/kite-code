import React, { useState, useRef, useCallback } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { useSessionList } from "../hooks/useSessionList.js";
import type { SessionInfo } from "../hooks/useSessionList.js";
import { useTheme } from "@/app/tui/theme";

interface SessionSelectorProps {
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  onDelete?: (sessionId: string) => void;
}

export default function SessionSelector({ onSelect, onClose, onDelete }: SessionSelectorProps) {
  const t = useTheme();
  const { sessions, loading, error, refresh } = useSessionList();
  const [selected, setSelected] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const deleteConfirmRef = useRef(deleteConfirm);
  deleteConfirmRef.current = deleteConfirm;

  useInput((input, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
    // Delete confirmation mode
    if (deleteConfirmRef.current) {
      if (key.escape) {
        setDeleteConfirm(false);
        return;
      }
      if (key.return && sessions.length > 0) {
        const session = sessions[selectedRef.current];
        if (session) {
          onDelete?.(session.threadId);
          onClose();
        }
        return;
      }
      return; // block navigation in confirm mode
    }

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
    if ((input === "d" || input === "D") && sessions.length > 0 && onDelete) {
      setDeleteConfirm(true);
    }
  });

  // Re-fetch on mount to get latest sessions list
  React.useEffect(() => { refresh(); }, [refresh]);

  const selectedSession = sessions[selected];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginY={1}>
      <Text bold color={t.primary}>会话列表</Text>
      {deleteConfirm && selectedSession && (
        <Box marginTop={1}>
          <Text color={t.warning}>
            删除 "{selectedSession.name}"? Enter 确认  Esc 取消
          </Text>
        </Box>
      )}
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
      <Text color={t.dim}>{onDelete ? "上/下 导航  Enter 选择  D 删除  Esc 关闭" : "上/下 导航  Enter 选择  Esc 关闭"}</Text>
    </Box>
  );
}
