import { Box, useInput, useStdout } from 'ink';
import { useMemo, useState } from 'react';
import { truncateDisplayWidth } from './chrome';
import { type TuiController, terminalText } from './controller';
import OverlayChoiceList from './ink/OverlayChoiceList';
import TuiOverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import {
  OverlayEmptyState,
  OverlayImpactNotice,
  OverlayListRow,
  OverlayMessage,
} from './ink/OverlayPrimitives';
import { mcpTextRows, mcpTextWindow } from './mcp-tools';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';

const scopes = ['session', 'code', 'both'] as const;
export function TuiFileRecoveryPanel({ controller }: { controller: TuiController }) {
  const { t: originalLabel, formatDateTime } = useInkI18n();
  const { t, testDiagnostics } = useTuiPresentation(),
    { stdout } = useStdout();
  const state = controller.state,
    recovery = state.fileRecovery;
  const [index, select] = useState(0),
    [fileIndex, selectFile] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [readingDiff, setReadingDiff] = useState(false),
    [diffLine, setDiffLine] = useState(0);
  const [confirm, setConfirm] = useState(false),
    [scopeIndex, selectScope] = useState<number>();
  const items = recovery?.points?.payload.items ?? [],
    saved = recovery?.saved ?? [];
  const page = Math.max(2, Math.min(5, (stdout.rows ?? 24) - 15));
  const start = Math.max(0, Math.min(index - 2, items.length - page));
  const detail = recovery?.detail,
    files = detail?.preview.payload.files ?? [];
  const diffText = terminalText(files[fileIndex]?.textChange?.preview ?? '');
  const diffRows = useMemo(
    () => mcpTextRows(diffText, Math.max(4, (stdout.columns ?? 80) - 6)),
    [diffText, stdout.columns],
  );
  const names = { session: t('Session only'), code: t('Code only'), both: t('Session and code') };
  useInput((input, key) => {
    if (key.ctrl) return;
    if (key.escape) {
      if (readingDiff) setReadingDiff(false);
      else if (confirm) setConfirm(false);
      else if (previewing) setPreviewing(false);
      else controller.closePanel();
      return;
    }
    if (previewing && input.toLowerCase() === 'v') {
      if (files[fileIndex]?.textChange) {
        setReadingDiff((value) => !value);
        setDiffLine(0);
      }
      return;
    }
    if (readingDiff) {
      const length = diffRows.length;
      if (key.upArrow) setDiffLine((line) => Math.max(0, line - 1));
      else if (key.downArrow) setDiffLine((line) => Math.min(Math.max(0, length - 8), line + 1));
      else if (key.home) setDiffLine(0);
      else if (key.end) setDiffLine(Math.max(0, length - 8));
      return;
    }
    if (input.toLowerCase() === 'a') {
      controller.closePanel();
      return;
    }
    if (input.toLowerCase() === 'r') {
      if (recovery?.intent) void controller.observeFileRecovery();
      else void controller.openFileRecovery();
      return;
    }
    if (input.toLowerCase() === 'c') {
      void controller.observeFileRecovery(true);
      return;
    }
    if (input.toLowerCase() === 'l') {
      controller.selectSavedFileRecovery(index);
      void controller.observeFileRecovery();
      return;
    }
    if (!previewing && !confirm && (key.upArrow || key.downArrow)) {
      select((n) =>
        Math.max(
          0,
          Math.min(Math.max(items.length, saved.length) - 1, n + (key.downArrow ? 1 : -1)),
        ),
      );
      return;
    }
    if (recovery?.phase !== 'ready' || recovery.intent) return;
    if (detail && ['1', '2', '3'].includes(input)) {
      const selected = Number(input) - 1;
      selectScope(selected);
      controller.chooseFileRecoveryScope(scopes[selected]!);
      setConfirm(true);
      return;
    }
    if (previewing && (confirm || key.upArrow || key.downArrow)) {
      setConfirm(true);
      if (key.upArrow || key.downArrow) {
        const next = scopeIndex === undefined ? 0 : (scopeIndex + (key.downArrow ? 1 : 2)) % 3;
        selectScope(next);
        controller.chooseFileRecoveryScope(scopes[next]!);
      } else if (key.return && scopeIndex !== undefined)
        void controller.startFileRecovery(scopes[scopeIndex]!);
      return;
    }
    if (key.leftArrow) selectFile((n) => Math.max(0, n - 1));
    else if (key.rightArrow) selectFile((n) => Math.min(Math.max(0, files.length - 1), n + 1));
    else if (key.upArrow) select((n) => Math.max(0, n - 1));
    else if (key.downArrow)
      select((n) => Math.min(Math.max(0, Math.max(items.length, saved.length) - 1), n + 1));
    else if (key.return && items[index]) {
      setPreviewing(true);
      setReadingDiff(false);
      setDiffLine(0);
      selectFile(0);
      selectScope(undefined);
      void controller.readFileRecoveryPoint(items[index]!.checkpoint.id);
    }
  });
  const label = (id: string, ordinal: number) => {
    const checkpoint = items.find((item) => item.checkpoint.id === id)?.checkpoint;
    const message = state.snapshot?.messages.find(
      (message) => message.id === checkpoint?.boundary.triggerMessageId,
    );
    return message
      ? truncateDisplayWidth(
          message.content.replace(/[\r\n]/g, ' '),
          Math.max(20, (stdout.columns ?? 80) - 10),
        )
      : `${t('Recovery point')} ${ordinal + 1}`;
  };
  const descriptions = {
    both: t('Restore workspace files and return to the conversation before this message.'),
    session: t('Return to the conversation before this message; keep workspace files.'),
    code: t('Restore workspace files; keep the current conversation.'),
  };
  const quote = detail
    ? state.snapshot?.messages.find(
        (message) => message.id === detail.boundary.checkpoint.boundary.triggerMessageId,
      )?.content
    : undefined;
  return (
    <TuiOverlayFrame
      title={
        previewing
          ? originalLabel('rewind.beforeMessage')
          : testDiagnostics
            ? t('Files recovery')
            : originalLabel('rewind.title')
      }
      meta={
        !previewing
          ? `${items.length ? Math.min(index + 1, items.length) : 0} / ${items.length}`
          : undefined
      }
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: originalLabel(readingDiff ? 'help.scroll' : 'common.select') },
            ...(!readingDiff
              ? [{ keys: 'Enter', label: t(previewing ? 'Confirm' : 'Continue') }]
              : [{ keys: 'Home/End', label: t('First / Last') }]),
            ...(previewing && files.length > page ? [{ keys: '←→', label: t('More files') }] : []),
            { keys: 'Esc', label: t(previewing ? 'Back' : 'Close') },
          ]}
        />
      }
    >
      {!previewing && (
        <>
          {items.slice(start, start + page).map((item, offset) => (
            <OverlayListRow
              key={item.checkpoint.id}
              selected={index === start + offset}
              primary={label(item.checkpoint.id, start + offset)}
              secondary={[
                item.recordedAt === undefined
                  ? t('Recorded time unavailable')
                  : `${t('Recorded at:')} ${formatDateTime(item.recordedAt)}`,
                testDiagnostics ? terminalText(item.checkpoint.id) : undefined,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          ))}
          {!items.length && <OverlayEmptyState>{t('No recovery points')}</OverlayEmptyState>}
        </>
      )}
      {previewing && !detail && (
        <OverlayMessage tone="busy">{t('Reading file preview')}</OverlayMessage>
      )}
      {previewing && detail && (
        <>
          <Box
            marginLeft={1}
            paddingLeft={1}
            width={Math.max(20, (stdout.columns ?? 80) - 6)}
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            flexDirection="column"
          >
            <Text>
              {quote
                ? truncateDisplayWidth(
                    quote.replace(/\s+/g, ' ').trim(),
                    Math.max(20, (stdout.columns ?? 80) - 6) * 2,
                  )
                : label(detail.boundary.checkpoint.id, index)}
            </Text>
          </Box>
          {items.find((item) => item.checkpoint.id === detail.boundary.checkpoint.id)
            ?.recordedAt !== undefined && (
            <Text dimColor>
              {t('Recorded at:')}{' '}
              {formatDateTime(
                items.find((item) => item.checkpoint.id === detail.boundary.checkpoint.id)!
                  .recordedAt!,
              )}
            </Text>
          )}
          <Box flexDirection="column" marginTop={1} paddingLeft={1}>
            <Text>
              {t('Files')}: {files.length} · {t('Conflicts')}:{' '}
              {files.filter((file) => file.status === 'conflict').length} · {t('Unavailable')}:{' '}
              {files.filter((file) => file.status === 'unavailable').length}
            </Text>
            {scopeIndex === 0 ? (
              <Text>{originalLabel('rewind.codeUnchanged')}</Text>
            ) : files.some((file) => file.textChange) ? (
              <Text>
                {t('Recorded text changes:')} +
                {files.reduce((total, file) => total + (file.textChange?.addedLines ?? 0), 0)} −
                {files.reduce((total, file) => total + (file.textChange?.removedLines ?? 0), 0)}
                {files.some((file) => !file.textChange)
                  ? ` · ${t('Some text statistics unavailable')}`
                  : ''}
              </Text>
            ) : (
              <Text>{t('Text statistics unavailable')}</Text>
            )}
            {!readingDiff &&
              files.slice(fileIndex, fileIndex + page).map((file, offset) => (
                <Text key={file.path}>
                  {offset === 0 ? '❯ ' : '  '}
                  {terminalText(file.path)} · {t(file.status)}{' '}
                  {scopeIndex !== 0 &&
                    file.textChange &&
                    `· +${file.textChange.addedLines} −${file.textChange.removedLines}`}
                  {file.reason ? ` · ${terminalText(file.reason)}` : ''}
                </Text>
              ))}
            {!readingDiff && files.length > 1 && <Text>{t('←/→ more files')}</Text>}
            {files[fileIndex]?.textChange && <Text>{t('V: read text preview')}</Text>}
            {readingDiff && files[fileIndex]?.textChange && (
              <Box flexDirection="column">
                <Text bold>{terminalText(files[fileIndex]!.path)}</Text>
                {mcpTextWindow(diffText, diffRows, diffLine, 8).map((line, i) => (
                  <Text key={diffLine + i}>{terminalText(line) || ' '}</Text>
                ))}
                <Text dimColor>
                  {t(
                    files[fileIndex]!.textChange!.truncated
                      ? 'Bounded preview; line counts use complete text.'
                      : 'Complete text preview',
                  )}{' '}
                  · {t('↑/↓ scroll · Home/End · Esc back')}
                </Text>
              </Box>
            )}
          </Box>
          {!readingDiff && (
            <Box marginTop={1} flexDirection="column">
              <OverlayChoiceList
                selectionBackground={false}
                selectedId={scopeIndex === undefined ? undefined : scopes[scopeIndex]}
                options={scopes.map((scope, i) => ({
                  id: scope,
                  label: `${i + 1}. ${names[scope]}`,
                  description: descriptions[scope],
                }))}
              />
              <OverlayImpactNotice>
                {scopeIndex === undefined
                  ? t(
                      'Choose recovery scope explicitly; files and conversation have separate results.',
                    )
                  : descriptions[scopes[scopeIndex]!]}
              </OverlayImpactNotice>
              {confirm && (
                <Text>{t('Enter confirms selected scope · Esc returns without submitting')}</Text>
              )}
            </Box>
          )}
        </>
      )}
      {recovery?.intent && (
        <OverlayMessage tone={recovery.phase === 'failed' ? 'error' : 'info'}>
          {t('Original recovery')}: {names[recovery.intent.scope]} · {t('Code')}:{' '}
          {recovery.intent.code?.phase ?? '-'} · {t('Session')}:{' '}
          {recovery.intent.fork?.phase ?? '-'}
          <Text>
            {testDiagnostics
              ? t(
                  'A: pending approval panel; R: original GET; C: explicitly continue untouched leg',
                )
              : t('A: approvals · R: check progress · C: continue remaining part')}
          </Text>
          {testDiagnostics && <Text>{terminalText(JSON.stringify(recovery.intent))}</Text>}
        </OverlayMessage>
      )}
      {!previewing &&
        saved
          .slice(Math.max(0, index - 2), index + page)
          .map((intent, i) => (
            <OverlayListRow
              key={intent.code?.request.commandId ?? intent.fork!.request.commandId}
              selected={index === Math.max(0, index - 2) + i}
              primary={`${t('Saved')} ${Math.max(0, index - 2) + i + 1}: ${names[intent.scope]}`}
              secondary={`${t('Code')} ${intent.code?.phase ?? '-'} · ${t('Session')} ${intent.fork?.phase ?? '-'}`}
            />
          ))}
      {saved.length > 0 && <Text>{t('; L queries selected original intent')}</Text>}
      {testDiagnostics && (
        <Text>
          {t('Reading state:')} {recovery?.phase ?? 'unavailable'}
        </Text>
      )}
      {state.error && <OverlayMessage tone="error">{terminalText(state.error)}</OverlayMessage>}
    </TuiOverlayFrame>
  );
}
