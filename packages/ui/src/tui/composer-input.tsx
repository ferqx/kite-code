import { Box, Text, useInput, usePaste } from 'ink';
import { useEffect, useReducer } from 'react';
import stringWidth from 'string-width';
import { describeTuiCommand, slashGhostSuffix } from './command-catalog';
import { type ComposerBuffer, composerDisplay } from './composer';
import type { TuiState } from './controller';
import type { FileToken } from './file-candidates';
import OverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { OverlayListRow } from './ink/OverlayPrimitives';
import { useInkWindowSize } from './ink/window-size';
import { TuiText as Label, useInkI18n, useInkTheme, useTuiPresentation } from './presentation';
export function isCtrlCBatch(input: string): boolean {
  return input.length > 1 && [...input].every((control) => control === '\u0003');
}
export function candidateViewport(
  count: number,
  selected: number,
  rows: number,
  inputRows: number,
) {
  // Keep the editor, frame and footer visible; candidate text is one visual row.
  const capacity = Math.max(1, Math.min(count, Math.floor(rows * 0.6), rows - inputRows - 9));
  const index = count ? ((selected % count) + count) % count : 0;
  const start = Math.max(0, Math.min(count - capacity, index - Math.floor(capacity / 2)));
  return { index, start, end: Math.min(count, start + capacity) };
}
export function TuiComposer({
  buffer,
  value,
  active,
  label,
  onChange,
  onSubmit,
  onEmptyEnter,
  onEscape,
  onTogglePlan,
  files,
  fileScope,
  onFileQuery,
  planning = false,
  planName,
}: {
  buffer: ComposerBuffer;
  value: string;
  active: boolean;
  label: string;
  onChange(text: string): void;
  onSubmit(): void;
  onEmptyEnter?(): void;
  onEscape?(): void;
  onTogglePlan?(): void;
  files?: TuiState['fileCandidates'];
  fileScope?: string;
  onFileQuery?(token?: FileToken): void;
  planning?: boolean;
  planName?: string;
}) {
  const [, render] = useReducer((n: number) => n + 1, 0);
  const { t, testDiagnostics } = useTuiPresentation();
  const display = (part: ComposerBuffer['parts'][number]) => composerDisplay(part, t);
  const theme = useInkTheme();
  const i18n = useInkI18n();
  const { columns, rows } = useInkWindowSize();
  const prefix = testDiagnostics ? `${label} > ` : '❯ ';
  const width = Math.max(1, columns - stringWidth(prefix) - 1);
  buffer.sync(value);
  const token = active ? buffer.fileToken : undefined;
  const tokenKey = token?.key;
  // A stable original draft/scope key avoids reopening a reader when its pages render.
  const requestKey = token ? JSON.stringify([token, value, fileScope]) : undefined;
  useEffect(() => {
    onFileQuery?.(requestKey ? (JSON.parse(requestKey)[0] as FileToken) : undefined);
  }, [requestKey, onFileQuery]);
  const filePaths = token && files?.key === token.key && files.phase === 'ready' ? files.paths : [];
  const complete = (currentToken = token, currentPaths = filePaths) =>
    currentPaths.length
      ? buffer.completeFile(
          currentPaths[buffer.candidate % currentPaths.length]!,
          currentToken!.key,
        )
      : buffer.complete();
  const update = () => {
    if (buffer.text !== value) onChange(buffer.text);
    render();
  };
  usePaste(
    (text) => {
      // Original InputLine folds only large pastes; small multiline text stays editable.
      buffer.insert(text, text.length >= 100);
      update();
    },
    { isActive: active },
  );
  useInput(
    (input, key) => {
      if (key.ctrl || isCtrlCBatch(input) || (key.meta && !key.return)) return;
      // Ink may deliver ordinary text and its final native Return in one read.
      // Literal bracketed paste uses usePaste and never enters this branch.
      const textReturn =
        !key.return &&
        !key.shift &&
        !key.meta &&
        // biome-ignore lint/suspicious/noControlCharactersInRegex: recognize only plain text followed by one native Return.
        /^[^\u0000-\u001f\u007f]+\r$/u.test(input);
      if (textReturn) {
        buffer.insert(input.slice(0, -1));
        update();
      }
      const currentToken = buffer.fileToken;
      const currentPaths =
        currentToken && files?.key === currentToken.key && files.phase === 'ready'
          ? files.paths
          : [];
      const candidates = currentPaths.length ? currentPaths : buffer.candidates;
      if (key.escape) {
        const dismissing = !!currentToken || candidates.length > 0;
        buffer.dismissed = true;
        render();
        if (!dismissing) onEscape?.();
        return;
      }
      if (key.tab) {
        if (key.shift) {
          onTogglePlan?.();
          return;
        }
        complete();
        update();
        return;
      }
      if (candidates.length && (key.upArrow || key.downArrow)) {
        buffer.candidate =
          (buffer.candidate + (key.downArrow ? 1 : candidates.length - 1)) % candidates.length;
        render();
        return;
      }
      if ((key.return || textReturn) && !key.shift && !key.meta) {
        if (buffer.text.length === 0 && onEmptyEnter) {
          onEmptyEnter();
          return;
        }
        if (currentToken && !currentPaths.length) return;
        if (candidates.length && buffer.text !== candidates[buffer.candidate]) {
          complete(currentToken, currentPaths);
          update();
          return;
        }
        buffer.remember();
        onSubmit();
        return;
      }
      if (
        key.rightArrow &&
        buffer.cursor === buffer.parts.length &&
        slashGhostSuffix(buffer.text, buffer.candidates, buffer.candidate)
      ) {
        buffer.complete();
        update();
        return;
      }
      if (key.leftArrow) buffer.horizontal(-1);
      else if (key.rightArrow) buffer.horizontal(1);
      else if (key.upArrow) buffer.vertical(-1, width, display);
      else if (key.downArrow) buffer.vertical(1, width, display);
      else if (key.home) buffer.boundary(false, width, display);
      else if (key.end) buffer.boundary(true, width, display);
      else if (key.backspace) buffer.remove(true);
      else if (key.delete) buffer.remove(false);
      else if (key.return) buffer.insert('\n');
      else if (input) buffer.insert(input);
      update();
    },
    { isActive: active },
  );
  if (!active) return null;
  const { lines, index } = buffer.row(width, display);
  const visibleRows = Math.min(40, lines.length);
  const start = Math.max(
    0,
    Math.min(lines.length - visibleRows, index - Math.floor(visibleRows / 2)),
  );
  const visible = lines.slice(start, start + visibleRows);
  const candidates = filePaths.length ? filePaths : buffer.candidates;
  const window = candidateViewport(
    candidates.length,
    buffer.candidate,
    rows,
    visible.length + Number(start > 0) + Number(start + visible.length < lines.length),
  );
  const ghost =
    buffer.cursor === buffer.parts.length
      ? slashGhostSuffix(buffer.text, buffer.candidates, buffer.candidate)
      : '';
  const planLabel = ` ${(planName || 'plan').toLowerCase()} ────`;
  const topRule = planning
    ? '─'.repeat(Math.max(0, columns - stringWidth(planLabel))) + planLabel
    : '─'.repeat(columns);
  const suggestions = candidates.length === 1 && candidates[0] === buffer.text ? [] : candidates;
  return (
    <Box flexDirection="column">
      <Text color={planning ? theme.primary : undefined}>{topRule}</Text>
      {start > 0 && (
        <Label dimColor>
          {t('↑ Earlier input')} · ... {start} more lines above ...
        </Label>
      )}
      {visible.map((line, n) => (
        <Text key={start + n}>
          <Text bold={suggestions.length === 0 && /^\/[a-z]+$/i.test(buffer.text)}>
            {n === 0 ? prefix : ' '.repeat(stringWidth(prefix))}
          </Text>
          {buffer.parts.slice(line.start, line.end).map((part, i) => (
            <Text key={line.start + i} inverse={buffer.cursor === line.start + i}>
              {display(part)}
            </Text>
          ))}
          {buffer.cursor === line.end &&
            (ghost ? (
              <>
                <Text inverse>{ghost[0]}</Text>
                <Text color={theme.dim}>{ghost.slice(1)}</Text>
              </>
            ) : (
              <Text inverse> </Text>
            ))}
        </Text>
      ))}
      {start + visible.length < lines.length && (
        <Label dimColor>
          {t('↓ Later input')} · ... {lines.length - start - visible.length} more lines below ...
        </Label>
      )}
      <Text color={planning ? theme.primary : undefined}>{'─'.repeat(columns)}</Text>
      {files && files.key === tokenKey && files.phase === 'reading' && (
        <Text dimColor>{t('Reading Workspace file names…')}</Text>
      )}
      {files && files.key === tokenKey && files.phase === 'ready' && (
        <Text dimColor>
          {filePaths.length
            ? `${filePaths.length} ${t('Workspace file candidates')} · ${(buffer.candidate % filePaths.length) + 1}/${filePaths.length}`
            : t('No matching Workspace file names · Esc resumes ordinary input')}
        </Text>
      )}
      {files && files.key === tokenKey && files.phase === 'failed' && (
        <Text color="yellow">
          {t('File candidates unavailable:')}{' '}
          {composerDisplay({ text: files.error ?? t('unavailable') })}
        </Text>
      )}
      {files && files.key === tokenKey && files.unavailable.length > 0 && (
        <Text color="yellow">
          {t('File candidates incomplete:')} {files.unavailable.length} {t('unavailable paths')}
        </Text>
      )}
      {suggestions.length > 0 &&
        (() => {
          const slash = !filePaths.length;
          const items = suggestions.map((command) => {
            const item = describeTuiCommand(command, i18n);
            return {
              ...item,
              description: buffer.commandDescriptions[command] ?? item.description,
            };
          });
          const rowWidth = Math.max(12, columns - 6);
          const commandWidth = Math.min(
            Math.max(...items.map((item) => stringWidth(`/${item.command}`))) + 2,
            Math.max(10, Math.floor(rowWidth * 0.3)),
          );
          const details = (item: (typeof items)[number]) =>
            [
              item.args,
              item.aliases.length ? `· ${item.aliases.map((alias) => `/${alias}`).join(' ')}` : '',
            ]
              .filter(Boolean)
              .join('  ');
          const descriptions = rowWidth - 2 - commandWidth >= 28;
          const detailsWidth = Math.min(
            Math.max(...items.map((item) => stringWidth(details(item)))) + 2,
            Math.max(2, rowWidth - 2 - commandWidth - (descriptions ? 18 : 0)),
          );
          const fileNameWidth = Math.max(12, Math.min(32, Math.floor((columns - 6) * 0.35)));
          return (
            <OverlayFrame
              title={
                slash
                  ? i18n.t('slash.matches')
                  : `${i18n.language === 'zh-CN' ? '文件匹配' : 'File matches'} @${token?.query ?? ''}`
              }
              meta={
                <Text color={theme.dim}>
                  {window.index + 1} / {suggestions.length}
                </Text>
              }
              footer={
                <OverlayShortcutBar
                  shortcuts={[
                    { keys: '↑↓', label: i18n.t('common.navigate') },
                    { keys: slash ? 'Tab / →' : 'Tab / Enter', label: i18n.t('slash.complete') },
                    { keys: 'Enter', label: i18n.t('common.confirm') },
                    { keys: 'Esc', label: i18n.t('common.close') },
                  ]}
                />
              }
            >
              <Box flexDirection="column">
                {suggestions.slice(window.start, window.end).map((command, n) => {
                  const selected = window.start + n === window.index;
                  const item = items[window.start + n]!;
                  return (
                    <OverlayListRow
                      key={command}
                      selected={selected}
                      content={
                        slash ? (
                          <>
                            <Box width={commandWidth} flexShrink={0}>
                              <Text
                                wrap="truncate-end"
                                bold={selected}
                                color={selected ? theme.primary : theme.muted}
                              >
                                /{item.command}
                              </Text>
                            </Box>
                            <Box width={detailsWidth} flexShrink={0}>
                              <Text wrap="truncate-end" color={theme.dim}>
                                {details(item)}
                              </Text>
                            </Box>
                            {descriptions && (
                              <Box flexGrow={1}>
                                <Text wrap="truncate-end" color={theme.dim}>
                                  {item.description}
                                </Text>
                              </Box>
                            )}
                          </>
                        ) : (
                          <>
                            <Box width={fileNameWidth} flexShrink={0}>
                              <Text
                                wrap="truncate-end"
                                bold={selected}
                                color={selected ? theme.primary : theme.muted}
                              >
                                {composerDisplay({
                                  text: command.split(/[\\/]/).at(-1) ?? command,
                                })}
                              </Text>
                            </Box>
                            <Text wrap="truncate-end" color={theme.dim}>
                              {composerDisplay({ text: command })}
                            </Text>
                          </>
                        )
                      }
                    />
                  );
                })}
              </Box>
            </OverlayFrame>
          );
        })()}
    </Box>
  );
}
