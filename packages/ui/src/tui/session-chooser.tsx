import { Box, useInput, usePaste, useStdout } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import stringWidth from 'string-width';
import { ComposerBuffer, composerDisplay } from './composer';
import { isCtrlCBatch } from './composer-input';
import { type TuiController, terminalText } from './controller';
import OverlayChoiceList from './ink/OverlayChoiceList';
import TuiOverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './ink/OverlayFrame';
import { OverlayEmptyState, OverlayImpactNotice, OverlayListRow } from './ink/OverlayPrimitives';
import OverlaySearchInput from './ink/OverlaySearchInput';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';

/** Search and confirmation stay local; the controller owns the original deletion identity. */
export function TuiSessionChooser({
  controller,
  close,
}: {
  controller: TuiController;
  close(): void;
}) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  const { t, testDiagnostics } = useTuiPresentation(),
    { stdout } = useStdout();
  const { t: originalLabel, language: inkLanguage } = useInkI18n();
  const buffer = useRef(new ComposerBuffer()).current;
  const [query, setQuery] = useState(''),
    [focus, setFocus] = useState<'search' | 'list'>('list');
  const [selectedId, setSelectedId] = useState(state.sessionId);
  const [remove, setRemove] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string>();
  const [selectionError, setSelectionError] = useState<string>();
  const selecting = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const deletion = state.sessionDeletion;
  useEffect(() => {
    const outcome = state.management;
    if (
      deletion?.phase === 'delete_requested' &&
      deletion.intent?.kind === 'session.delete' &&
      outcome?.status === 'delete_requested' &&
      outcome.intent.kind === 'session.delete' &&
      outcome.intent.request.commandId === deletion.intent.request.commandId &&
      outcome.intent.sessionId === deletion.sessionId &&
      outcome.intent.request.expectedStoreId === controller.port.storeId &&
      deletion.sourceSessionId === state.sessionId &&
      !state.sessionDirectoryLoading &&
      !state.sessionDirectoryError &&
      !state.sessions.some((session) => session.id === deletion.sessionId)
    ) {
      controller.closeSessionDeletion();
      close();
    }
  }, [
    close,
    controller,
    deletion,
    state.management,
    state.sessionId,
    state.sessionDirectoryLoading,
    state.sessionDirectoryError,
    state.sessions,
  ]);
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
    if (focus === 'list' && state.sessionDirectoryError && input.toLowerCase() === 'r') {
      void controller.list();
      return;
    }
    if (key.upArrow) {
      if (selected === 0) setFocus('search');
      else setSelectedId(sessions[selected - 1]?.id);
    } else if (key.downArrow) {
      if (focus === 'search') setFocus('list');
      else setSelectedId(sessions[Math.min(sessions.length - 1, selected + 1)]?.id);
    } else if (key.tab) setFocus((value) => (value === 'search' ? 'list' : 'search'));
    else if (key.return) {
      if (focus === 'search') setFocus('list');
      else if (item && !selecting.current && item.id !== state.sessionId) {
        const targetId = item.id;
        selecting.current = targetId;
        setLoadingSessionId(targetId);
        setSelectionError(undefined);
        void controller
          .select(targetId)
          .then(() => {
            if (!alive.current || selecting.current !== targetId) return;
            if (
              controller.state.sessionId === targetId &&
              controller.state.snapshot &&
              !controller.state.stale
            )
              close();
            else
              setSelectionError(
                controller.state.error ?? t('Could not open Session; retry after refreshing.'),
              );
          })
          .catch((error: unknown) => {
            if (alive.current)
              setSelectionError(
                error instanceof Error
                  ? error.message
                  : t('Could not open Session; retry after refreshing.'),
              );
          })
          .finally(() => {
            if (alive.current && selecting.current === targetId) {
              selecting.current = undefined;
              setLoadingSessionId(undefined);
            }
          });
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
      <TuiOverlayFrame
        title={testDiagnostics ? t('Delete Session?') : originalLabel('session.title')}
        meta={testDiagnostics ? undefined : originalLabel('session.deleteConfirm')}
        footer={
          <OverlayShortcutBar
            shortcuts={[
              { keys: '↑↓', label: t('Select') },
              { keys: 'Enter', label: t('Confirm') },
              { keys: 'Esc', label: t('Back') },
            ]}
          />
        }
      >
        <OverlayImpactNotice>
          {t(
            'Delete hides this Session and requests its work to stop. Workspace files stay unchanged.',
          )}
        </OverlayImpactNotice>
        <Text wrap="truncate">{terminalText(deletion.title)}</Text>
        {testDiagnostics && (
          <Text>
            {t('Original Session')} [{terminalText(deletion.sessionId)}]
          </Text>
        )}
        <Text>
          {t(
            'Delete hides this Session and requests its work to stop. Workspace files stay unchanged.',
          )}
        </Text>
        {deletion.phase === 'reading' ? (
          <Text>{t('Reading original Session control…')}</Text>
        ) : deletion.phase === 'ready' ? (
          <>
            <OverlayChoiceList
              selectedId={remove ? 'delete' : 'keep'}
              selectionBackground={false}
              options={[
                {
                  id: 'keep',
                  label: t('Keep Session'),
                  description: t('Return without changing this Session.'),
                },
                {
                  id: 'delete',
                  label: testDiagnostics
                    ? t('Delete Session')
                    : originalLabel('session.deletePermanently'),
                  description: t(
                    'Delete hides this Session and requests its work to stop. Workspace files stay unchanged.',
                  ),
                  destructive: true,
                  separatorBefore: true,
                },
              ]}
            />
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
      </TuiOverlayFrame>
    );
  const prefix = `${t('Search')} > `,
    display = (part: ComposerBuffer['parts'][number]) => composerDisplay(part, t),
    row = buffer.row(Math.max(24, (stdout.columns ?? 80) - stringWidth(prefix) - 1), display),
    line = row.lines[row.index]!;
  const displayDate = (value: number) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? inkLanguage === 'zh-CN'
        ? '（未知）'
        : '(unknown)'
      : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  };
  const page = Math.max(2, Math.min(8, (stdout.rows ?? 24) - 13));
  const listStart = Math.max(0, Math.min(selected - Math.floor(page / 2), sessions.length - page));
  return (
    <TuiOverlayFrame
      title={
        testDiagnostics ? t('Select Session (arrows/Enter, Esc)') : originalLabel('session.title')
      }
      meta={
        state.sessionDirectoryError
          ? t('History unverified')
          : focus === 'search'
            ? t('Search')
            : `${sessions.length ? selected + 1 : 0} / ${sessions.length}`
      }
      footer={
        <OverlayShortcutBar
          shortcuts={
            focus === 'search'
              ? [
                  { keys: t('Type'), label: t('Search') },
                  { keys: 'Enter / ↓', label: t('Sessions') },
                  { keys: 'Esc', label: t(query ? 'Clear search' : 'Back') },
                ]
              : [
                  { keys: '↑↓', label: originalLabel('common.navigate') },
                  { keys: 'Enter', label: originalLabel('common.select') },
                  { keys: 'D', label: originalLabel('common.delete') },
                  ...(state.sessionDirectoryError
                    ? [{ keys: 'R', label: t('Retry history read') }]
                    : []),
                  { keys: 'Esc', label: t('Close') },
                ]
          }
        />
      }
    >
      <OverlaySearchInput
        value={query}
        onChange={() => undefined}
        active={focus === 'search'}
        label={t('Search')}
        editor={
          <Text>
            {buffer.parts.slice(line.start, line.end).map((part, offset) => (
              <Text key={line.start + offset} inverse={buffer.cursor === line.start + offset}>
                {display(part)}
              </Text>
            ))}
            {buffer.cursor === line.end ? <Text inverse> </Text> : null}
          </Text>
        }
      />
      <Box flexDirection="column" marginTop={1}>
        {sessions.slice(listStart, listStart + page).map((session, offset) => (
          <OverlayListRow
            key={session.id}
            selected={focus === 'list' && listStart + offset === selected}
            indicator={loadingSessionId === session.id ? <Text>◌ </Text> : undefined}
            primary={
              terminalText(
                session.title.replace(/[\r\n]/g, ' ') ||
                  (inkLanguage === 'zh-CN' ? '新会话' : 'New conversation'),
              ) + (testDiagnostics ? ` [${terminalText(session.id)}]` : '')
            }
            trailing={
              <Box>
                <OverlayStatusColumn
                  active={session.id === state.sessionId}
                  label={inkLanguage === 'zh-CN' ? '当前' : 'Current'}
                />
                {session.updatedAt !== undefined && (
                  <Box width={22} paddingLeft={3}>
                    <Text dimColor>{displayDate(session.updatedAt)}</Text>
                  </Box>
                )}
              </Box>
            }
          />
        ))}
        {!sessions.length && !state.sessionDirectoryLoading && !state.sessionDirectoryError && (
          <OverlayEmptyState>
            {t(query ? 'No matching Sessions' : 'No session history')}
          </OverlayEmptyState>
        )}
      </Box>
      {state.sessionDirectoryLoading && <Text dimColor>{t('Loading session history')}</Text>}
      {state.sessionDirectoryError && (
        <>
          <Text color="red">{t('Error: Could not load session history; please retry.')}</Text>
          <Text>{t('R retries this read; saved history remains unchanged.')}</Text>
          {testDiagnostics && <Text dimColor>{terminalText(state.sessionDirectoryError)}</Text>}
        </>
      )}
      {selectionError && <Text color="red">{terminalText(selectionError)}</Text>}
      {testDiagnostics && (
        <Text dimColor>
          {t('Up/Down: search/list · Enter: open · D: delete with empty search · Esc: clear/back')}
        </Text>
      )}
    </TuiOverlayFrame>
  );
}
