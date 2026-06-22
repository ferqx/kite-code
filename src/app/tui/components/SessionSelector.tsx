import { Box, Text, useInput, useStdout } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import React, { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { useTheme } from '@/app/tui/theme';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useSessionList } from '../hooks/useSessionList.js';

/** Truncate `text` so its terminal display width ≤ `maxCols`, appending `…` when truncated. */
function truncateByDisplayWidth(text: string, maxCols: number): string {
  if (maxCols <= 0) return '';
  if (stringWidth(text) <= maxCols) return text;
  const ellipsisWidth = stringWidth('…');
  let result = '';
  let used = 0;
  for (const char of text) {
    const cw = stringWidth(char);
    if (used + cw + ellipsisWidth > maxCols) break;
    result += char;
    used += cw;
  }
  return result ? result + '…' : text.slice(0, 1) + '…';
}

interface SessionSelectorProps {
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  onDelete?: (sessionId: string) => void;
  initialQuery?: string;
  /** 正在从 DB 加载的会话 ID / ID of the session currently being loaded from DB */
  loadingSessionId?: string | null;
  /** 当前活跃会话 ID，用于标记显示 / Current active session ID, for visual indicator */
  activeSessionId?: string | null;
}

export default function SessionSelector({
  onSelect,
  onClose,
  onDelete,
  initialQuery,
  loadingSessionId,
  activeSessionId,
}: SessionSelectorProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const { sessions, loading, error, refresh, search } = useSessionList();
  const [selected, setSelected] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [searchInput, setSearchInput] = useState(initialQuery ?? '');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const deleteConfirmRef = useRef(deleteConfirm);
  deleteConfirmRef.current = deleteConfirm;
  const searchInputRef = useRef(searchInput);
  searchInputRef.current = searchInput;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const activeSessionRef = useRef(activeSessionId);
  activeSessionRef.current = activeSessionId;
  const isSearching = searchInput.length > 0;

  const maxContentHeight = useOverlayHeight(12);

  // Trigger search when input changes
  useEffect(() => {
    search(searchInput);
  }, [searchInput, search]);

  // Re-fetch on mount
  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Apply initial query
  useEffect(() => {
    if (initialQuery) setSearchInput(initialQuery);
  }, [initialQuery]);

  useInput(
    (
      input,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        backspace?: boolean;
        ctrl?: boolean;
        meta?: boolean;
      },
    ) => {
      const s = sessionsRef.current;
      // Delete confirmation mode
      if (deleteConfirmRef.current) {
        if (key.escape) {
          setDeleteConfirm(false);
          return;
        }
        if (key.return && s.length > 0) {
          const session = s[selectedRef.current];
          if (session) {
            onDeleteRef.current?.(session.threadId);
            onCloseRef.current();
          }
          return;
        }
        return;
      }

      if (key.escape) {
        if (searchInputRef.current.length > 0) {
          setSearchInput('');
          return;
        }
        onCloseRef.current();
        return;
      }

      if (key.return && s.length > 0) {
        const session = s[selectedRef.current];
        if (session && session.threadId !== activeSessionRef.current) {
          onSelectRef.current(session.threadId);
        }
        return;
      }

      if (key.upArrow) {
        setSelected((p) => Math.max(0, p - 1));
        return;
      }
      if (key.downArrow) {
        setSelected((p) => Math.min(s.length - 1, p + 1));
        return;
      }

      // Backspace removes last character from search
      if (key.backspace || input === '\x7f') {
        setSearchInput((prev) => prev.slice(0, -1));
        return;
      }

      // D to delete (only when search is empty)
      if (
        (input === 'd' || input === 'D') &&
        searchInputRef.current.length === 0 &&
        s.length > 0 &&
        onDeleteRef.current
      ) {
        setDeleteConfirm(true);
        return;
      }

      // Regular character input goes to search.
      // Some IMEs (e.g. macOS Chinese) prepend a space when switching between
      // CJK composition and ASCII — strip it to avoid a leading space artifact.
      if (input && !key.ctrl && !key.meta) {
        let text = input;
        const prev = searchInputRef.current;
        if (
          text.length >= 2 &&
          text[0] === ' ' &&
          text[1] !== ' ' &&
          (prev.length === 0 || prev[prev.length - 1] !== ' ')
        ) {
          text = text.slice(1);
        }
        setSearchInput((p) => p + text);
      }
    },
  );

  // Reset selection when search results change
  useEffect(() => {
    setSelected(0);
  }, []);

  const selectedSession = sessions[selected];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={t.primary}>
        会话列表
      </Text>
      <Box marginTop={1}>
        <Text color={t.muted}>搜索: </Text>
        <Text color={t.primary}>{searchInput}</Text>
        <Text color={t.muted}>_</Text>
      </Box>
      {deleteConfirm && selectedSession && (
        <Box marginTop={1} flexDirection="column">
          <Text color={activeSessionId === selectedSession.threadId ? t.error : t.warning}>
            删除 "{selectedSession.name}"? Enter 确认 Esc 取消
          </Text>
          {activeSessionId === selectedSession.threadId && (
            <Text color={t.warning}>注意：这是当前活跃会话，删除后将自动创建新会话</Text>
          )}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1} flexGrow={1} maxHeight={maxContentHeight}>
        {loading && <Text color={t.muted}>Loading...</Text>}
        {error && <Text color={t.error}>Error: {error}</Text>}
        {!loading && !error && sessions.length === 0 && (
          <Text color={t.muted}>{isSearching ? '未找到匹配的会话' : '暂无历史会话'}</Text>
        )}
        <ScrollList selectedIndex={selected} scrollAlignment="auto">
          {sessions.map((session, i) => {
            const isLoading = loadingSessionId === session.threadId;
            const isActive = activeSessionId === session.threadId;
            const cursor = isLoading ? '⏳' : i === selected ? '>' : ' ';
            const marker = isActive ? '● ' : '';
            const timestamp = session.updatedAt;
            // 右列固定宽度：2 空格间隙 + 19 字符时间戳 "YYYY-MM-DD HH:mm:ss"
            const rightCol = isLoading ? '  Loading...        ' : `  ${timestamp}`;
            const rightColWidth = 21;
            // 预留：border(2) + paddingX(2) = 4，Safe margin = 2
            const cols = stdout?.columns ?? 80;
            const maxWidth = cols - 6;
            const prefix = `${cursor} ${marker}`;
            const rawName = session.name.replace(/\n/g, ' ');
            const prefixWidth = stringWidth(prefix);
            const nameMaxCols = Math.max(4, maxWidth - prefixWidth - rightColWidth);
            const displayName = truncateByDisplayWidth(rawName, nameMaxCols);
            // 用空格填充至固定列宽，确保时间戳列对齐
            const namePad = Math.max(0, nameMaxCols - stringWidth(displayName));
            const paddedName = displayName + ' '.repeat(namePad);
            const lineColor = isLoading ? t.warning : i === selected ? t.primary : t.muted;
            const dimColor = isLoading ? t.warning : t.dim;
            return (
              <Box key={session.threadId} width={maxWidth} flexShrink={0} flexGrow={0}>
                <Text color={lineColor}>
                  {prefix}
                  {paddedName}
                </Text>
                <Text color={dimColor}>{rightCol}</Text>
              </Box>
            );
          })}
        </ScrollList>
      </Box>
      <Box height={1} />
      <Text color={t.dim}>
        {onDelete
          ? '输入搜索  上/下 导航  Enter 选择  D 删除  Esc 关闭'
          : '输入搜索  上/下 导航  Enter 选择  Esc 关闭'}
      </Text>
    </Box>
  );
}
