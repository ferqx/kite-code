import { Box, Text, useInput } from 'ink';
import { ScrollList, type ScrollListRef } from 'ink-scroll-list';
import { useRef, useState } from 'react';
import type { TuiSnapshot } from './controller';
import { terminalText } from './controller';
import { InkExecution } from './execution-projection';
import type { TuiChildLog } from './executions';
import MarkdownBlock from './ink/MarkdownBlock';
import OverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { OverlayListRow } from './ink/OverlayPrimitives';
import UserMessageBlock from './ink/UserMessageBlock';
import { useInkWindowSize } from './ink/window-size';
import { useInkI18n, useInkTheme, useTuiPresentation } from './presentation';

/** Original list/detail interaction, reading only the controller's verified, frozen child log. */
export function TuiChildSessionPanel({
  child,
  onBack,
  onRefresh,
}: {
  child: TuiChildLog;
  onBack(): void;
  onRefresh(): void;
}) {
  const { columns, rows } = useInkWindowSize(),
    theme = useInkTheme(),
    i18n = useInkI18n();
  const { testDiagnostics } = useTuiPresentation();
  const [detail, setDetail] = useState(false),
    [kind, setKind] = useState<'message' | 'block'>('message'),
    [index, setIndex] = useState(0),
    [scroll, setScroll] = useState(0),
    [page, setPage] = useState(0);
  const pageSize = Math.max(1, Math.min(100, rows - 10));
  const executions = child.view.executions.filter(
    (item) =>
      item.kind !== 'model' &&
      item.originStoreId === child.target.originStoreId &&
      item.sessionId === child.view.session.id,
  );
  const items = kind === 'message' ? child.messages : executions;
  const current = Math.min(index, Math.max(0, items.length - 1));
  const message = kind === 'message' ? child.messages[current] : undefined;
  const full = message ? child.modelOutputs.get(message.id) : undefined;
  const selectedExecution = kind === 'block' ? executions[current] : undefined;
  const calls = full?.output.toolCalls ?? message?.toolCalls ?? [];
  const content = full?.output.content ?? message?.content ?? '';
  const contentRows = Math.max(3, rows - 12);
  const detailScroll = useRef<ScrollListRef>(null);
  const scrollContent = (direction: 'top' | 'bottom' | number) => {
    const reader = detailScroll.current;
    if (!reader) return;
    if (direction === 'top') reader.scrollToTop();
    else if (direction === 'bottom') reader.scrollToBottom();
    else reader.scrollBy(direction);
  };
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onBack();
      return;
    }
    if (key.escape) {
      if (detail) {
        setDetail(false);
        setScroll(0);
      } else onBack();
      return;
    }
    if (key.ctrl) return;
    if (key.tab) {
      setKind((value) => (value === 'message' ? 'block' : 'message'));
      setIndex(0);
      setScroll(0);
      setPage(0);
      return;
    }
    if (input.toLowerCase() === 'r') {
      onRefresh();
      return;
    }
    if (input.toLowerCase() === 'n' && !detail) {
      const next = page + 1;
      if (next * pageSize < items.length) {
        setPage(next);
        setIndex(next * pageSize);
      }
      return;
    }
    if (key.upArrow || key.downArrow) {
      const delta = key.downArrow ? 1 : -1;
      if (detail) scrollContent(delta * 3);
      else
        setIndex((value) =>
          Math.max(
            page * pageSize,
            Math.min(Math.min(items.length, (page + 1) * pageSize) - 1, value + delta),
          ),
        );
      return;
    }
    if (detail && (key.leftArrow || key.rightArrow)) {
      setIndex((value) =>
        Math.max(0, Math.min(items.length - 1, value + (key.rightArrow ? 1 : -1))),
      );
      setScroll(0);
      return;
    }
    if (detail && key.home) {
      scrollContent('top');
      return;
    }
    if (detail && key.end) {
      scrollContent('bottom');
      return;
    }
    if (key.return && !detail && items.length) {
      setDetail(true);
      setScroll(0);
    }
  });
  const loaded = new Map([...child.modelOutputs].map(([id, body]) => [id, body.output]));
  const snapshot: TuiSnapshot = {
    storeId: child.view.storeId,
    view: child.view,
    messages: child.messages,
    interactions: [],
  };
  const label = kind === 'message' ? 'Messages' : 'Execution blocks';
  return (
    <OverlayFrame
      title={`${i18n.t('common.select')} · ${terminalText(child.view.session.title)}`}
      meta={`${label} · ${items.length}`}
      footer={
        <OverlayShortcutBar
          shortcuts={
            detail
              ? [
                  { keys: '←→', label: 'Previous/next record' },
                  { keys: '↑↓', label: 'Scroll 3 lines' },
                  { keys: 'Tab', label: 'Messages / blocks' },
                  { keys: 'R', label: 'Refresh' },
                  { keys: 'Esc', label: 'Back to list' },
                ]
              : [
                  { keys: '↑↓', label: i18n.t('common.navigate') },
                  { keys: 'Enter', label: 'Read' },
                  { keys: 'Tab', label: 'Messages / blocks' },
                  { keys: 'N', label: 'Next page' },
                  { keys: 'R', label: 'Refresh' },
                  { keys: 'Esc', label: 'Parent conversation' },
                ]
          }
        />
      }
    >
      <Text color={theme.dim}>
        Read-only child history ·{' '}
        {detail
          ? `${current + 1}/${items.length}`
          : `${Math.min(page + 1, Math.ceil(items.length / pageSize) || 1)}/${Math.ceil(items.length / pageSize) || 1}`}{' '}
        · {testDiagnostics ? 'EOF confirmed' : 'History fully read'}
      </Text>
      {testDiagnostics && (
        <Text color={theme.dim}>
          {child.view.storeId} / {child.view.session.id} · parent carrier {child.carrier.id} · fixed
          upper {child.view.session.nextSeq}
        </Text>
      )}
      {detail ? (
        <Box flexDirection="column">
          <Text color={theme.dim}>
            {message ? `${message.role} · ${message.status} · ` : ''}Lines {scroll + 1}
          </Text>
          <ScrollList
            key={`${kind}:${items[current]?.id ?? ''}`}
            ref={detailScroll}
            height={contentRows}
            selectedIndex={0}
            scrollAlignment="auto"
            onScroll={setScroll}
          >
            <Box flexDirection="column">
              {message && (
                <>
                  {message.role === 'user' ? (
                    <UserMessageBlock content={content} columns={Math.max(20, columns - 4)} />
                  ) : (
                    <MarkdownBlock
                      content={terminalText(content)}
                      maxWidth={Math.max(20, columns - 4)}
                    />
                  )}
                  {full?.output.reasoning && (
                    <Box flexDirection="column" marginTop={1}>
                      <Text color={theme.dim}>Recorded reasoning</Text>
                      <MarkdownBlock
                        content={terminalText(full.output.reasoning)}
                        color={theme.dim}
                        maxWidth={Math.max(20, columns - 4)}
                      />
                    </Box>
                  )}
                  {calls.map((call) => (
                    <Box key={call.id} flexDirection="column" marginTop={1}>
                      <Text color={theme.dim}>{terminalText(call.name)}</Text>
                      <Text>{terminalText(call.arguments)}</Text>
                    </Box>
                  ))}
                </>
              )}
              {selectedExecution && (
                <InkExecution
                  execution={selectedExecution}
                  snapshot={snapshot}
                  loadedOutputs={loaded}
                  expanded
                  columns={Math.max(20, columns - 4)}
                />
              )}
            </Box>
          </ScrollList>
          {full && (
            <Text color={theme.dim}>
              {full.output.complete
                ? 'Complete verified Model body'
                : 'Incomplete verified Model prefix'}
            </Text>
          )}
          {message?.outputBody && !full && (
            <Text color={theme.warning}>
              Full Model reader unavailable; original message projection only
            </Text>
          )}
        </Box>
      ) : (
        <Box flexDirection="column">
          {items.slice(page * pageSize, (page + 1) * pageSize).map((item, n) => {
            const at = page * pageSize + n;
            const text =
              'role' in item
                ? `${item.role} · ${item.status} · ${item.content.split('\n')[0] ?? ''}`
                : `${item.definitionId} · ${item.status}`;
            return (
              <OverlayListRow
                key={item.id}
                selected={at === current}
                primary={terminalText(text)}
              />
            );
          })}
          {!items.length && <Text color={theme.dim}>No recorded {label.toLowerCase()}</Text>}
          {(page + 1) * pageSize < items.length && (
            <Text color={theme.dim}>More records · N shows the next page</Text>
          )}
        </Box>
      )}
    </OverlayFrame>
  );
}
