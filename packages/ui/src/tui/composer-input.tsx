import { Box, Text, useInput, usePaste, useStdout } from 'ink';
import { useEffect, useReducer } from 'react';
import stringWidth from 'string-width';
import { TuiOverlayFrame, truncateDisplayWidth } from './chrome';
import { type ComposerBuffer, composerDisplay } from './composer';
import type { TuiState } from './controller';
import type { FileToken } from './file-candidates';
import { TuiText as Label, useTuiPresentation } from './presentation';
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
}) {
  const [, render] = useReducer((n: number) => n + 1, 0);
  const { t, testDiagnostics } = useTuiPresentation();
  const display = (part: ComposerBuffer['parts'][number]) => composerDisplay(part, t);
  const { stdout } = useStdout();
  const prefix = testDiagnostics ? `${label} > ` : '❯ ';
  const width = Math.max(1, (stdout.columns || 80) - stringWidth(prefix) - 1);
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
      buffer.insert(text, true);
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
  const { lines, index } = buffer.row(width, display),
    start = Math.max(0, index - 2),
    visible = lines.slice(start, start + 5);
  const candidates = filePaths.length ? filePaths : buffer.candidates;
  const window = candidateViewport(
    candidates.length,
    buffer.candidate,
    stdout.rows || 24,
    visible.length + Number(start > 0) + Number(start + visible.length < lines.length),
  );
  return (
    <Box flexDirection="column">
      {start > 0 && <Label dimColor>{t('↑ Earlier input')}</Label>}
      {visible.map((line, n) => (
        <Text key={start + n}>
          {n === 0 ? prefix : ' '.repeat(stringWidth(prefix))}
          {buffer.parts.slice(line.start, line.end).map((part, i) => (
            <Text key={line.start + i} inverse={buffer.cursor === line.start + i}>
              {display(part)}
            </Text>
          ))}
          {buffer.cursor === line.end && <Text inverse> </Text>}
        </Text>
      ))}
      {start + visible.length < lines.length && <Label dimColor>{t('↓ Later input')}</Label>}
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
      {candidates.length > 0 && (
        <TuiOverlayFrame
          title={`${t(filePaths.length ? 'Workspace file candidates' : 'Command suggestions')} · ${window.index + 1}/${candidates.length} · ${window.start + 1}–${window.end}`}
          hint={t('Up/Down: choose · Tab/Enter: complete · Esc: close')}
        >
          {candidates.slice(window.start, window.end).map((command, n) => (
            <Text key={`${window.start + n}:${command}`}>
              {window.start + n === window.index ? '› ' : '  '}
              {truncateDisplayWidth(
                composerDisplay({ text: command }),
                Math.max(1, (stdout.columns || 80) - 6),
              )}
            </Text>
          ))}
        </TuiOverlayFrame>
      )}
    </Box>
  );
}
