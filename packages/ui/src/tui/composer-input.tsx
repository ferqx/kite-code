import { Box, Text, useInput, usePaste, useStdout } from 'ink';
import { useEffect, useReducer } from 'react';
import stringWidth from 'string-width';
import { type ComposerBuffer, composerDisplay } from './composer';
import type { TuiState } from './controller';
import type { FileToken } from './file-candidates';
export function isCtrlCBatch(input: string): boolean {
  return input.length > 1 && [...input].every((control) => control === '\u0003');
}
export function TuiComposer({
  buffer,
  value,
  active,
  label,
  onChange,
  onSubmit,
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
  onTogglePlan?(): void;
  files?: TuiState['fileCandidates'];
  fileScope?: string;
  onFileQuery?(token?: FileToken): void;
}) {
  const [, render] = useReducer((n: number) => n + 1, 0);
  const { stdout } = useStdout();
  const prefix = `${label} > `;
  const width = Math.max(24, (stdout.columns ?? 80) - stringWidth(prefix) - 1);
  buffer.sync(value);
  const token = active ? buffer.fileToken : undefined;
  const tokenKey = token?.key;
  // A stable original draft/scope key avoids reopening a reader when its pages render.
  const requestKey = token ? JSON.stringify([token, value, fileScope]) : undefined;
  useEffect(() => {
    onFileQuery?.(requestKey ? (JSON.parse(requestKey)[0] as FileToken) : undefined);
  }, [requestKey, onFileQuery]);
  const filePaths = token && files?.key === token.key && files.phase === 'ready' ? files.paths : [];
  const complete = () =>
    filePaths.length
      ? buffer.completeFile(filePaths[buffer.candidate % filePaths.length]!, token!.key)
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
      const candidates = filePaths.length ? filePaths : buffer.candidates;
      if (key.escape) {
        buffer.dismissed = true;
        render();
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
      if (key.return && !key.shift && !key.meta) {
        if (token && !filePaths.length) return;
        if (candidates.length && buffer.text !== candidates[buffer.candidate]) {
          complete();
          update();
          return;
        }
        buffer.remember();
        onSubmit();
        return;
      }
      if (key.leftArrow) buffer.horizontal(-1);
      else if (key.rightArrow) buffer.horizontal(1);
      else if (key.upArrow) buffer.vertical(-1, width);
      else if (key.downArrow) buffer.vertical(1, width);
      else if (key.home) buffer.boundary(false, width);
      else if (key.end) buffer.boundary(true, width);
      else if (key.backspace) buffer.remove(true);
      else if (key.delete) buffer.remove(false);
      else if (key.return) buffer.insert('\n');
      else if (input) buffer.insert(input);
      update();
    },
    { isActive: active },
  );
  if (!active) return null;
  const { lines, index } = buffer.row(width),
    start = Math.max(0, index - 2),
    visible = lines.slice(start, start + 5);
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>↑ Earlier input</Text>}
      {visible.map((line, n) => (
        <Text key={start + n}>
          {n === 0 ? prefix : ' '.repeat(stringWidth(prefix))}
          {buffer.parts.slice(line.start, line.end).map((part, i) => (
            <Text key={line.start + i} inverse={buffer.cursor === line.start + i}>
              {composerDisplay(part)}
            </Text>
          ))}
          {buffer.cursor === line.end && <Text inverse> </Text>}
        </Text>
      ))}
      {start + visible.length < lines.length && <Text dimColor>↓ Later input</Text>}
      {files && files.key === tokenKey && files.phase === 'reading' && (
        <Text dimColor>Reading Workspace file names…</Text>
      )}
      {files && files.key === tokenKey && files.phase === 'ready' && (
        <Text dimColor>
          {filePaths.length
            ? `${filePaths.length} Workspace file candidates · ${(buffer.candidate % filePaths.length) + 1}/${filePaths.length}`
            : 'No matching Workspace file names · Esc resumes ordinary input'}
        </Text>
      )}
      {files && files.key === tokenKey && files.phase === 'failed' && (
        <Text color="yellow">
          File candidates unavailable: {composerDisplay({ text: files.error ?? 'unavailable' })}
        </Text>
      )}
      {files && files.key === tokenKey && files.unavailable.length > 0 && (
        <Text color="yellow">
          File candidates incomplete: {files.unavailable.length} unavailable paths
        </Text>
      )}
      {(filePaths.length ? filePaths : buffer.candidates)
        .slice(Math.max(0, buffer.candidate - 2), buffer.candidate + 3)
        .map((command) => (
          <Text key={command}>
            {command === (filePaths.length ? filePaths : buffer.candidates)[buffer.candidate]
              ? '› '
              : '  '}
            {composerDisplay({ text: command })}
          </Text>
        ))}
    </Box>
  );
}
