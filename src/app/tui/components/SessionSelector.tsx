import { Box, Text, useInput, useStdout } from 'ink';
import { VirtualList } from 'ink-virtual-list';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { useTheme } from '@/app/tui/theme';
import type { SessionInfo } from '@/core/persistence/sessions.js';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useSessionList } from '../hooks/useSessionList.js';
import OverlayChoiceList, { type OverlayChoiceOption } from './OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './OverlayFrame';
import { OverlayEmptyState, OverlayListRow } from './OverlayPrimitives';
import OverlaySearchInput from './OverlaySearchInput';

type DeleteChoice = 'keep' | 'delete';

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
  return result ? `${result}…` : `${text.slice(0, 1)}…`;
}

interface SessionSelectorProps {
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  onDelete?: (sessionId: string) => void;
  initialQuery?: string;
  loadingSessionId?: string | null;
  activeSessionId?: string | null;
  layeredEscRef?: MutableRefObject<boolean>;
}

export default function SessionSelector({
  onSelect,
  onClose,
  onDelete,
  initialQuery,
  loadingSessionId,
  activeSessionId,
  layeredEscRef,
}: SessionSelectorProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const { sessions, loading, error, search } = useSessionList();
  const [selected, setSelected] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteChoice, setDeleteChoice] = useState<DeleteChoice>('keep');
  const [searchInput, setSearchInput] = useState(initialQuery ?? '');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const deleteConfirmRef = useRef(deleteConfirm);
  deleteConfirmRef.current = deleteConfirm;
  const deleteChoiceRef = useRef(deleteChoice);
  deleteChoiceRef.current = deleteChoice;
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
  const searchInitializedRef = useRef(false);
  const isSearching = searchInput.length > 0;
  const searchSelected = selected === -1;
  if (layeredEscRef) {
    layeredEscRef.current = deleteConfirm || searchSelected || isSearching;
  }

  const maxContentHeight = useOverlayHeight(12);

  useEffect(
    () => () => {
      if (layeredEscRef) layeredEscRef.current = false;
    },
    [layeredEscRef],
  );

  useEffect(() => {
    if (!searchInitializedRef.current) {
      searchInitializedRef.current = true;
      if (!initialQuery) return;
    }
    search(searchInput);
  }, [searchInput, initialQuery, search]);

  const handleInput = useCallback(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
      },
    ) => {
      const s = sessionsRef.current;
      if (deleteConfirmRef.current) {
        if (key.escape) {
          setDeleteConfirm(false);
          setDeleteChoice('keep');
          return;
        }
        if (key.upArrow) {
          setDeleteChoice('keep');
          return;
        }
        if (key.downArrow) {
          setDeleteChoice('delete');
          return;
        }
        if (key.return && s.length > 0) {
          if (deleteChoiceRef.current === 'keep') {
            setDeleteConfirm(false);
            return;
          }
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
        if (selectedRef.current === -1 && searchInputRef.current.length === 0) {
          setSelected(0);
          return;
        }
        if (searchInputRef.current.length > 0) {
          setSearchInput('');
          return;
        }
        onCloseRef.current();
        return;
      }
      if (key.return) {
        if (selectedRef.current === -1) {
          if (s.length > 0) setSelected(0);
          return;
        }
        if (s.length > 0) {
          const session = s[selectedRef.current];
          if (session && session.threadId !== activeSessionRef.current) {
            onSelectRef.current(session.threadId);
          }
        }
        return;
      }
      if (key.upArrow) {
        setSelected((p) => Math.max(-1, p - 1));
        return;
      }
      if (key.downArrow) {
        setSelected((p) => Math.min(s.length - 1, p + 1));
        return;
      }
      if (
        (input === 'd' || input === 'D') &&
        selectedRef.current >= 0 &&
        searchInputRef.current.length === 0 &&
        s.length > 0 &&
        onDeleteRef.current
      ) {
        setDeleteChoice('keep');
        setDeleteConfirm(true);
        return;
      }
    },
    [],
  );

  useInput(handleInput);

  useEffect(() => {
    setSelected((current) => {
      if (sessions.length === 0) return loading ? current : -1;
      return Math.min(Math.max(-1, current), sessions.length - 1);
    });
  }, [sessions, loading]);

  const selectedSession = selected >= 0 ? sessions[selected] : undefined;
  const deleteOptions: readonly OverlayChoiceOption<DeleteChoice>[] = selectedSession
    ? [
        {
          id: 'keep',
          label: '保留会话',
          description: '返回会话列表，不做任何更改',
        },
        {
          id: 'delete',
          label: '永久删除',
          description:
            activeSessionId === selectedSession.threadId
              ? '删除当前会话并自动创建新会话；此操作不可撤销'
              : '移除这条会话历史；此操作不可撤销',
          destructive: true,
          separatorBefore: true,
        },
      ]
    : [];

  // Precompute display strings — NOT dependent on `selected`, so arrow keys
  // don't re-trigger expensive stringWidth / truncation.
  const cols = stdout?.columns ?? 80;
  const maxWidth = Math.max(20, cols - 4);
  const statusColWidth = 6;
  const metadataGap = 3;
  const rightColWidth = 19 + metadataGap;
  const nameMaxCols = Math.max(4, maxWidth - 4 - statusColWidth - rightColWidth);

  const renderItem = useCallback(
    ({ index }: { item: SessionInfo; index: number; isSelected: boolean }) => {
      const session = sessions[index];
      if (!session) return null;

      const isSelected = index === selected;
      const isLoading = loadingSessionId === session.threadId;
      const isActive = activeSessionId === session.threadId;
      const rightCol = isLoading ? 'Loading...' : session.updatedAt;
      const rawName = session.name.replace(/\n/g, ' ');
      const displayName = truncateByDisplayWidth(rawName, nameMaxCols);
      const lineColor = isLoading ? t.warning : isSelected ? t.primary : t.muted;
      const dimColor = isLoading ? t.warning : t.dim;

      return (
        <Box width={maxWidth} flexShrink={0} flexGrow={0}>
          <OverlayListRow
            selected={isSelected}
            primary={displayName}
            indicator={
              <Text bold color={lineColor}>
                {isLoading ? '◌ ' : isSelected ? '❯ ' : '  '}
              </Text>
            }
            trailing={
              <Box>
                <OverlayStatusColumn active={isActive} width={statusColWidth} />
                <Box width={rightColWidth} paddingLeft={metadataGap}>
                  <Text color={dimColor}>{rightCol}</Text>
                </Box>
              </Box>
            }
          />
        </Box>
      );
    },
    [
      sessions,
      selected,
      loadingSessionId,
      activeSessionId,
      nameMaxCols,
      maxWidth,
      rightColWidth,
      t,
    ],
  );

  return (
    <OverlayFrame
      title="会话列表"
      meta={
        deleteConfirm ? (
          <Text color={t.error}>删除确认</Text>
        ) : searchSelected ? (
          <Text color={t.dim}>搜索</Text>
        ) : sessions.length > 0 ? (
          <Text color={t.dim}>
            {selected + 1} / {sessions.length}
          </Text>
        ) : undefined
      }
      footer={
        <OverlayShortcutBar
          shortcuts={
            deleteConfirm
              ? [
                  { keys: '↑↓', label: '选择' },
                  { keys: 'Enter', label: '确认' },
                  { keys: 'Esc', label: '返回' },
                ]
              : searchSelected
                ? [
                    { keys: '输入', label: '搜索' },
                    { keys: 'Enter / ↓', label: '会话列表' },
                    { keys: 'Esc', label: searchInput ? '清空' : '退出搜索' },
                  ]
                : [
                    { keys: '↑↓', label: '导航' },
                    { keys: 'Enter', label: '选择' },
                    ...(onDelete ? [{ keys: 'D', label: '删除' }] : []),
                    { keys: 'Esc', label: '关闭' },
                  ]
          }
        />
      }
    >
      {deleteConfirm && selectedSession ? (
        <Box flexDirection="column">
          <Box paddingX={2} flexDirection="column">
            <Box width="100%">
              <Text bold color={t.muted} wrap="truncate-end">
                “{selectedSession.name.replace(/\n/g, ' ')}”
              </Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <OverlayChoiceList
              options={deleteOptions}
              selectedId={deleteChoice}
              selectionBackground={false}
            />
          </Box>
        </Box>
      ) : (
        <>
          <OverlaySearchInput
            value={searchInput}
            onChange={setSearchInput}
            active={searchSelected}
          />
          <Box flexDirection="column" flexGrow={1} maxHeight={maxContentHeight}>
            {loading && <Text color={t.muted}>Loading...</Text>}
            {error && <Text color={t.error}>Error: {error}</Text>}
            {!loading && !error && sessions.length === 0 && (
              <OverlayEmptyState>
                {isSearching ? '未找到匹配的会话' : '暂无历史会话'}
              </OverlayEmptyState>
            )}
            <VirtualList<SessionInfo>
              items={sessions}
              selectedIndex={Math.max(0, selected)}
              renderItem={renderItem}
              keyExtractor={(s) => s.threadId}
              height={maxContentHeight}
              itemHeight={1}
              showOverflowIndicators={false}
            />
          </Box>
        </>
      )}
    </OverlayFrame>
  );
}
