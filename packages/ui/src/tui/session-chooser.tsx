import { Box, useInput, usePaste, useStdout } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import stringWidth from 'string-width';
import { ComposerBuffer, composerDisplay } from './composer';
import { isCtrlCBatch } from './composer-input';
import { type TuiController, terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';

/** Search and confirmation stay local; the controller owns the original deletion identity. */
export function TuiSessionChooser({
  controller,
  close,
}: {
  controller: TuiController;
  close(): void;
}) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  const { t } = useTuiPresentation(),
    { stdout } = useStdout();
  const buffer = useRef(new ComposerBuffer()).current;
  const [query, setQuery] = useState(''),
    [focus, setFocus] = useState<'search' | 'list'>('list');
  const [selectedId, setSelectedId] = useState(state.sessionId);
  const [remove, setRemove] = useState(false);
  const deletion = state.sessionDeletion;
  const sessions = state.sessions.filter((session) =>
    `${session.title}\n${session.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const selected = Math.max(
    0,
    sessions.findIndex((session) => session.id === selectedId),
  );
  const item = sessions[selected];
  useEffect(() => () => controller.closeSessionDeletion(), [controller]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each newly opened target defaults to retention.
  useEffect(() => {
    setRemove(false);
  }, [deletion?.sessionId]);
  const change = () => {
    setQuery(buffer.text);
    setSelectedId(undefined);
  };
  const searchText = (text: string) => text.replace(/[\r\n\t]/g, ' ');
  usePaste((text) => {
    if (deletion || focus !== 'search') return;
    buffer.insert(searchText(text));
    change();
  });
  useInput((input, key) => {
    const cancel = key.escape || (key.ctrl && input === 'c') || isCtrlCBatch(input);
    if (deletion) {
      if (cancel) {
        controller.closeSessionDeletion();
        return;
      }
      if (deletion.phase === 'ready') {
        if (key.upArrow || key.leftArrow) setRemove(false);
        else if (key.downArrow || key.rightArrow) setRemove(true);
        else if (key.tab) setRemove((value) => !value);
        else if (key.return) {
          if (remove) void controller.confirmSessionDeletion();
          else controller.closeSessionDeletion();
        }
      } else if (deletion.phase === 'outcome_unknown' && input.toLowerCase() === 'r')
        void controller.lookupSessionDeletion();
      else if (['delete_requested', 'failed'].includes(deletion.phase) && key.return)
        controller.closeSessionDeletion();
      return;
    }
    if (cancel) {
      if (key.escape && query) {
        buffer.sync('');
        change();
      } else if (key.escape && focus === 'search') setFocus('list');
      else close();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.upArrow) {
      if (selected === 0) setFocus('search');
      else setSelectedId(sessions[selected - 1]?.id);
    } else if (key.downArrow) {
      if (focus === 'search') setFocus('list');
      else setSelectedId(sessions[Math.min(sessions.length - 1, selected + 1)]?.id);
    } else if (key.tab) setFocus((value) => (value === 'search' ? 'list' : 'search'));
    else if (key.return) {
      if (focus === 'search') setFocus('list');
      else if (item) {
        void controller.select(item.id);
        close();
      }
    } else if (focus === 'list') {
      if (!query && input.toLowerCase() === 'd' && item)
        void controller.requestSessionDeletion(item.id);
    } else {
      if (key.backspace) buffer.remove(true);
      else if (key.delete) buffer.remove(false);
      else if (key.leftArrow) buffer.horizontal(-1);
      else if (key.rightArrow) buffer.horizontal(1);
      else if (key.home || key.end)
        buffer.boundary(
          !!key.end,
          Math.max(24, (stdout.columns ?? 80) - stringWidth(`${t('Search')} > `) - 1),
        );
      else if (input) buffer.insert(searchText(input));
      change();
    }
  });
  if (deletion)
    return (
      <Box flexDirection="column">
        <Text bold>{t('Delete Session?')}</Text>
        <Text wrap="truncate">{terminalText(deletion.title)}</Text>
        <Text>
          {t('Original Session')} [{terminalText(deletion.sessionId)}]
        </Text>
        <Text>
          {t(
            'Delete hides this Session and requests its work to stop. Workspace files stay unchanged.',
          )}
        </Text>
        {deletion.phase === 'reading' ? (
          <Text>{t('Reading original Session control…')}</Text>
        ) : deletion.phase === 'ready' ? (
          <>
            <Text>
              {remove ? '  ' : '> '}
              {t('Keep Session')}
            </Text>
            <Text>
              {remove ? '> ' : '  '}
              {t('Delete Session')}
            </Text>
            <Text>{t('Up/Down: choose · Enter: confirm · Esc/Ctrl+C: keep')}</Text>
          </>
        ) : (
          <>
            <Text>
              {t('Original deletion:')} {deletion.phase}
            </Text>
            {deletion.error && <Text>{terminalText(deletion.error)}</Text>}
            {deletion.phase === 'outcome_unknown' ? (
              <Text>{t('R: query original deletion · Esc/Ctrl+C: close')}</Text>
            ) : deletion.phase === 'delete_requested' ? (
              <Text>{t('(stop unconfirmed; files unchanged)')}</Text>
            ) : null}
          </>
        )}
      </Box>
    );
  const prefix = `${t('Search')} > `,
    display = (part: ComposerBuffer['parts'][number]) => composerDisplay(part, t),
    row = buffer.row(Math.max(24, (stdout.columns ?? 80) - stringWidth(prefix) - 1), display),
    line = row.lines[row.index]!;
  const start = Math.max(0, selected - 2);
  return (
    <Box flexDirection="column">
      <Text bold>{t('Select Session (arrows/Enter, Esc)')}</Text>
      <Text>
        {prefix}
        {buffer.parts.slice(line.start, line.end).map((part, offset) => (
          <Text
            key={line.start + offset}
            inverse={focus === 'search' && buffer.cursor === line.start + offset}
          >
            {display(part)}
          </Text>
        ))}
        {focus === 'search' && buffer.cursor === line.end ? <Text inverse> </Text> : null}
      </Text>
      {sessions.slice(start, start + 5).map((session, offset) => (
        <Text key={session.id} wrap="truncate">
          {focus === 'list' && start + offset === selected ? '> ' : '  '}
          {terminalText(session.title.replace(/[\r\n]/g, ' '))} [{terminalText(session.id)}]
        </Text>
      ))}
      {!sessions.length && <Text>{t('No matching Sessions')}</Text>}
      <Text dimColor>
        {sessions.length ? `${selected + 1}/${sessions.length}` : '0/0'} ·{' '}
        {t('Up/Down: search/list · Enter: open · D: delete with empty search · Esc: clear/back')}
      </Text>
    </Box>
  );
}
