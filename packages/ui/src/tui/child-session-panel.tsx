import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { TuiSnapshot } from './controller';
import { terminalText } from './controller';
import { InkExecution, inkResultSummary } from './execution-projection';
import type { TuiChildLog } from './executions';
import MarkdownBlock from './ink/MarkdownBlock';
import OverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { OverlayListRow } from './ink/OverlayPrimitives';
import { wrapDisplayLines } from './ink/soft-wrap';
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
  const content = message
    ? [
        full?.output.content ?? message.content,
        full?.output.reasoning ? `Recorded reasoning\n${full.output.reasoning}` : '',
        ...calls.map((call) => `${call.name}\n${call.arguments}`),
      ]
        .filter(Boolean)
        .join('\n\n')
    : selectedExecution
      ? inkResultSummary(selectedExecution.result)
      : '';
  const fullLines = useMemo(
    () => wrapDisplayLines(terminalText(content), Math.max(20, columns - 4)),
    [content, columns],
  );
  const contentRows = Math.max(3, rows - 12),
    offset = Math.max(0, Math.min(scroll, Math.max(0, fullLines.length - contentRows)));
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
      if (detail)
        setScroll((value) =>
          Math.max(0, Math.min(Math.max(0, fullLines.length - contentRows), value + delta * 3)),
        );
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
    if (key.home) {
      setScroll(0);
      return;
    }
    if (key.end) {
      setScroll(Math.max(0, fullLines.length - contentRows));
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
          {message && (
            <>
              <Text color={theme.dim}>
                {message.role} · {message.status}
              </Text>
              {offset === 0 && fullLines.length <= contentRows ? (
                message.role === 'user' ? (
                  <UserMessageBlock content={content} columns={Math.max(20, columns - 4)} />
                ) : (
                  <MarkdownBlock
                    content={terminalText(content)}
                    maxWidth={Math.max(20, columns - 4)}
                  />
                )
              ) : (
                <Box flexDirection="column">
                  <Text color={theme.dim}>
                    Lines {offset + 1}–{Math.min(fullLines.length, offset + contentRows)}/
                    {fullLines.length}
                  </Text>
                  {fullLines.slice(offset, offset + contentRows).map((line, n) => (
                    <Text key={offset + n}>{line || ' '}</Text>
                  ))}
                </Box>
              )}
              {full && (
                <Text color={theme.dim}>
                  {full.output.complete
                    ? 'Complete verified Model body'
                    : 'Incomplete verified Model prefix'}
                </Text>
              )}
              {message.outputBody && !full && (
                <Text color={theme.warning}>
                  Full Model reader unavailable; original message projection only
                </Text>
              )}
            </>
          )}
          {selectedExecution &&
            (offset === 0 ? (
              <InkExecution
                execution={selectedExecution}
                snapshot={snapshot}
                loadedOutputs={loaded}
                expanded
                columns={Math.max(20, columns - 4)}
              />
            ) : (
              <Box flexDirection="column">
                <Text color={theme.dim}>
                  Lines {offset + 1}–{Math.min(fullLines.length, offset + contentRows)}/
                  {fullLines.length}
                </Text>
                {fullLines.slice(offset, offset + contentRows).map((line, n) => (
                  <Text key={offset + n}>{line || ' '}</Text>
                ))}
              </Box>
            ))}
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
