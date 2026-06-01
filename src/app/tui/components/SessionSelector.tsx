import React, { useState, useRef, useEffect } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { ScrollList } from "ink-scroll-list";
import { useSessionList } from "../hooks/useSessionList.js";
import { useTheme } from "@/app/tui/theme";
import { useOverlayHeight } from "../hooks/useOverlayHeight";

interface SessionSelectorProps {
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  onDelete?: (sessionId: string) => void;
  initialQuery?: string;
}

export default function SessionSelector({ onSelect, onClose, onDelete, initialQuery }: SessionSelectorProps) {
  const t = useTheme();
  const { sessions, loading, error, refresh, search } = useSessionList();
  const [selected, setSelected] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [searchInput, setSearchInput] = useState(initialQuery ?? "");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const deleteConfirmRef = useRef(deleteConfirm);
  deleteConfirmRef.current = deleteConfirm;
  const searchInputRef = useRef(searchInput);
  searchInputRef.current = searchInput;
  const isSearching = searchInput.length > 0;

  const maxContentHeight = useOverlayHeight(12);

  // Trigger search when input changes
  useEffect(() => {
    search(searchInput);
  }, [searchInput, search]);

  // Re-fetch on mount
  React.useEffect(() => { refresh(); }, [refresh]);

  // Apply initial query
  useEffect(() => {
    if (initialQuery) setSearchInput(initialQuery);
  }, [initialQuery]);

  useInput((input, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean; backspace?: boolean; ctrl?: boolean; meta?: boolean }) => {
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
      return;
    }

    if (key.escape) {
      if (searchInputRef.current.length > 0) {
        setSearchInput("");
        return;
      }
      onClose();
      return;
    }

    if (key.return && sessions.length > 0) {
      const session = sessions[selectedRef.current];
      if (session) onSelect(session.threadId);
      return;
    }

    if (key.upArrow) { setSelected((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSelected((s) => Math.min(sessions.length - 1, s + 1)); return; }

    // Backspace removes last character from search
    if (key.backspace || input === '\x7f') {
      setSearchInput(prev => prev.slice(0, -1));
      return;
    }

    // D to delete (only when search is empty)
    if ((input === "d" || input === "D") && searchInputRef.current.length === 0 && sessions.length > 0 && onDelete) {
      setDeleteConfirm(true);
      return;
    }

    // Regular character input goes to search
    if (input && !key.ctrl && !key.meta && input.length === 1) {
      setSearchInput(prev => prev + input);
    }
  });

  // Reset selection when search results change
  useEffect(() => { setSelected(0); }, [sessions.length]);

  const selectedSession = sessions[selected];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginY={1}>
      <Text bold color={t.primary}>会话列表</Text>
      <Box marginTop={1}>
        <Text color={t.muted}>搜索: </Text>
        <Text color={t.primary}>{searchInput}</Text>
        <Text color={t.muted}>_</Text>
      </Box>
      {deleteConfirm && selectedSession && (
        <Box marginTop={1}>
          <Text color={t.warning}>
            删除 "{selectedSession.name}"? Enter 确认  Esc 取消
          </Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1} flexGrow={1} maxHeight={maxContentHeight}>
        {loading && <Text color={t.muted}>Loading...</Text>}
        {error && <Text color={t.error}>Error: {error}</Text>}
        {!loading && !error && sessions.length === 0 && (
          <Text color={t.muted}>{isSearching ? "未找到匹配的会话" : "暂无历史会话"}</Text>
        )}
        <ScrollList selectedIndex={selected} scrollAlignment="auto">
          {sessions.map((session, i) => (
            <Box key={session.threadId}>
              <Text color={i === selected ? t.primary : t.muted}>
                {i === selected ? ">" : " "} {session.name}
              </Text>
              <Text color={t.dim}>  {session.updatedAt}</Text>
            </Box>
          ))}
        </ScrollList>
      </Box>
      <Box height={1} />
      <Text color={t.dim}>{onDelete ? "输入搜索  上/下 导航  Enter 选择  D 删除  Esc 关闭" : "输入搜索  上/下 导航  Enter 选择  Esc 关闭"}</Text>
    </Box>
  );
}
