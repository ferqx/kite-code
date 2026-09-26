import type { RuntimeChildSessionSummary } from '@kite-ai/runtime-contract';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { ScrollList, type ScrollListRef } from 'ink-scroll-list';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TuiRuntimeClientFacade } from '../../adapters/tui/session-adapter';
import { sessionDataToUI } from '../replay-blocks';
import { useTheme } from '../theme';
import BlockRenderer from './BlockRenderer';
import OverlayFrame, { OverlayShortcutBar } from './OverlayFrame';

type Reader = NonNullable<TuiRuntimeClientFacade['childSessionReader']>;
type ChildDetail = Awaited<ReturnType<Reader['load']>>;

export default function ChildSessionPanel({
  parentSessionId,
  reader,
  onClose,
  layeredEscRef,
}: {
  parentSessionId: string;
  reader: Reader;
  onClose: () => void;
  layeredEscRef: { current: boolean };
}) {
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  const [entries, setEntries] = useState<readonly RuntimeChildSessionSummary[]>([]);
  const [cursor, setCursor] = useState<Awaited<ReturnType<Reader['list']>>['nextCursor']>();
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<ChildDetail>();
  const [retryDetail, setRetryDetail] = useState<RuntimeChildSessionSummary>();
  const [blockIndex, setBlockIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const loadingRef = useRef(false);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const detailScrollRef = useRef<ScrollListRef>(null);
  layeredEscRef.current = !!detail;

  const loadPage = useCallback(
    (next?: typeof cursor) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setError('');
      const request = ++generation.current;
      void reader
        .list(parentSessionId, 100, next)
        .then(
          (page) => {
            if (generation.current !== request) return;
            if (page.entries.some((entry) => entry.parentSessionId !== parentSessionId)) {
              setError('子线程列表的父会话身份不一致。');
              return;
            }
            setEntries(next ? [...entriesRef.current, ...page.entries] : page.entries);
            setCursor(page.nextCursor);
          },
          (cause: unknown) => {
            if (generation.current === request)
              setError(cause instanceof Error ? cause.message : '子线程列表读取失败。');
          },
        )
        .finally(() => {
          if (generation.current === request) {
            loadingRef.current = false;
            setLoading(false);
          }
        });
    },
    [parentSessionId, reader],
  );

  useEffect(() => {
    loadPage();
    return () => {
      generation.current++;
      layeredEscRef.current = false;
    };
  }, [layeredEscRef, loadPage]);

  const openDetail = (entry: RuntimeChildSessionSummary) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError('');
    setRetryDetail(entry);
    const request = ++generation.current;
    void reader
      .load(parentSessionId, entry.sessionId)
      .then(
        (result) => {
          if (generation.current !== request) return;
          if (
            result.projection.sessionId !== entry.sessionId ||
            result.history.threadId !== entry.sessionId
          ) {
            setError('子线程详情身份不一致。');
            return;
          }
          setDetail(result);
          setRetryDetail(undefined);
          setBlockIndex(0);
        },
        (cause: unknown) => {
          if (generation.current === request)
            setError(cause instanceof Error ? cause.message : '子线程详情读取失败。');
        },
      )
      .finally(() => {
        if (generation.current === request) {
          loadingRef.current = false;
          setLoading(false);
        }
      });
  };

  const blocks = useMemo(() => (detail ? sessionDataToUI(detail.history).blocks : []), [detail]);
  useInput((_input, key) => {
    if (key.escape) {
      if (detailRef.current) {
        generation.current++;
        loadingRef.current = false;
        setLoading(false);
        setDetail(undefined);
        setRetryDetail(undefined);
        setError('');
      } else onClose();
      return;
    }
    if (key.ctrl) return;
    if (key.upArrow || key.downArrow) {
      const delta = key.downArrow ? 1 : -1;
      if (detailRef.current) detailScrollRef.current?.scrollBy(delta * 3);
      else
        setSelected((index) =>
          Math.min(Math.max(index + delta, 0), Math.max(0, entriesRef.current.length - 1)),
        );
      return;
    }
    if (detailRef.current && (key.leftArrow || key.rightArrow)) {
      const delta = key.rightArrow ? 1 : -1;
      setBlockIndex((index) =>
        Math.min(Math.max(index + delta, 0), Math.max(0, blocks.length - 1)),
      );
      return;
    }
    if (key.return && !loadingRef.current) {
      if (detailRef.current) return;
      const entry = entriesRef.current[selected];
      if (entry) openDetail(entry);
      else if (cursorRef.current) loadPage(cursorRef.current);
      return;
    }
    if (_input === 'r' && !loadingRef.current) {
      if (detailRef.current) {
        const entry = entriesRef.current[selected];
        if (entry) openDetail(entry);
      } else if (retryDetail) openDetail(retryDetail);
      else if (error) loadPage(cursorRef.current);
      return;
    }
    if (_input === 'n' && !detailRef.current && cursorRef.current && !loadingRef.current)
      loadPage(cursorRef.current);
  });

  const item = blocks[blockIndex];
  const selectedEntry = entries[selected];
  return (
    <OverlayFrame
      title={
        detail
          ? `子 Agent · ${selectedEntry?.displayName ?? selectedEntry?.taskId ?? ''}`
          : '子 Agent 线程'
      }
      meta={detail ? '只读历史' : `${entries.length}${cursor ? '+' : ''} 个`}
      footer={
        <OverlayShortcutBar
          shortcuts={
            detail
              ? [
                  { keys: '←→', label: '切换记录' },
                  { keys: '↑↓', label: '滚动内容' },
                  { keys: 'R', label: '刷新' },
                  { keys: 'Esc', label: '返回列表' },
                ]
              : [
                  { keys: '↑↓', label: '选择' },
                  { keys: 'Enter', label: '查看' },
                  { keys: 'N', label: '下一页' },
                  { keys: 'Esc', label: '返回父会话' },
                ]
          }
        />
      }
    >
      {loading && <Text color={theme.dim}>正在读取子线程…</Text>}
      {error && <Text color={theme.error}>读取失败：{error}（按 R 重试）</Text>}
      {detail ? (
        <Box flexDirection="column" maxHeight={Math.max(4, rows - 9)} overflowY="hidden">
          <Text color={theme.dim}>
            {detail.projection.lifecycle} ·{' '}
            {blocks.length ? `记录 ${blockIndex + 1}/${blocks.length}` : '无可展示记录'}
          </Text>
          {item && (
            <ScrollList
              key={blockIndex}
              ref={detailScrollRef}
              selectedIndex={0}
              scrollAlignment="top"
            >
              <BlockRenderer
                block={item}
                isFocused={false}
                index={blockIndex}
                columns={Math.max(20, columns - 4)}
              />
            </ScrollList>
          )}
        </Box>
      ) : entries.length ? (
        <Box maxHeight={Math.max(4, rows - 9)}>
          <ScrollList selectedIndex={selected} scrollAlignment="auto">
            {entries.map((entry, index) => (
              <Box key={entry.sessionId} flexDirection="column">
                <Text
                  color={selected === index ? theme.primary : undefined}
                  bold={selected === index}
                >
                  {selected === index ? '❯ ' : '  '}
                  {entry.displayName ?? entry.taskId}
                </Text>
                <Text color={theme.dim}>
                  {' '}
                  {entry.taskId} · {entry.sessionId}
                </Text>
              </Box>
            ))}
          </ScrollList>
        </Box>
      ) : !loading && !error ? (
        <Text color={theme.dim}>当前父会话没有独立子线程。</Text>
      ) : null}
      {!detail && cursor && <Text color={theme.dim}>还有更多子线程，按 N 读取下一页。</Text>}
    </OverlayFrame>
  );
}
