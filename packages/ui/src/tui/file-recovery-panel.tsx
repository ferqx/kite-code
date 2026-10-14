import { useInput, useStdout } from 'ink';
import { useState } from 'react';
import { TuiOverlayFrame, truncateDisplayWidth } from './chrome';
import { type TuiController, terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';

const scopes = ['session', 'code', 'both'] as const;
export function TuiFileRecoveryPanel({ controller }: { controller: TuiController }) {
  const { t, testDiagnostics } = useTuiPresentation(),
    { stdout } = useStdout();
  const state = controller.state,
    recovery = state.fileRecovery;
  const [index, select] = useState(0),
    [fileIndex, selectFile] = useState(0);
  const [confirm, setConfirm] = useState(false),
    [scopeIndex, selectScope] = useState<number>();
  const items = recovery?.points?.payload.items ?? [],
    saved = recovery?.saved ?? [];
  const page = Math.max(2, Math.min(5, (stdout.rows ?? 24) - 15));
  const start = Math.max(0, Math.min(index - 2, items.length - page));
  const detail = recovery?.detail,
    files = detail?.preview.payload.files ?? [];
  const names = { session: t('Session only'), code: t('Code only'), both: t('Session and code') };
  useInput((input, key) => {
    if (key.ctrl) return;
    if (key.escape) {
      if (confirm) setConfirm(false);
      else controller.closePanel();
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
    if (!confirm && (key.upArrow || key.downArrow)) {
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
    if (confirm) {
      if (key.upArrow || key.downArrow) {
        const next = scopeIndex === undefined ? 0 : (scopeIndex + (key.downArrow ? 1 : 2)) % 3;
        selectScope(next);
        controller.chooseFileRecoveryScope(scopes[next]!);
      } else if (key.return && scopeIndex !== undefined)
        void controller.startFileRecovery(scopes[scopeIndex]!);
      return;
    }
    if (key.leftArrow) selectFile((n) => Math.max(0, n - page));
    else if (key.rightArrow)
      selectFile((n) => Math.min(Math.max(0, files.length - page), n + page));
    else if (key.upArrow) select((n) => Math.max(0, n - 1));
    else if (key.downArrow)
      select((n) => Math.min(Math.max(0, Math.max(items.length, saved.length) - 1), n + 1));
    else if (key.return && items[index]) {
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
  return (
    <TuiOverlayFrame title={t('Files recovery')}>
      <Text>{t('↑/↓ choose · Enter preview · 1 session · 2 code · 3 both · Esc back')}</Text>
      {items.slice(start, start + page).map((item, offset) => (
        <Text key={item.checkpoint.id}>
          {index === start + offset ? '› ' : '  '}
          {label(item.checkpoint.id, start + offset)}
          {testDiagnostics ? ` [${terminalText(item.checkpoint.id)}]` : ''}
        </Text>
      ))}
      {!items.length && <Text>{t('No recovery points')}</Text>}
      <Text>
        {items.length ? `${Math.min(index + 1, items.length)}/${items.length}` : '0/0'} ·{' '}
        {t('Reading state:')} {recovery?.phase ?? 'unavailable'}
      </Text>
      {detail && (
        <>
          <Text>
            {t('Preview')}:{' '}
            {label(
              detail.boundary.checkpoint.id,
              Math.max(
                0,
                items.findIndex((item) => item.checkpoint.id === detail.boundary.checkpoint.id),
              ),
            )}
          </Text>
          <Text>
            {t('Files')}: {files.length} · {t('Conflicts')}:{' '}
            {files.filter((file) => file.status === 'conflict').length} · {t('Unavailable')}:{' '}
            {files.filter((file) => file.status === 'unavailable').length}
          </Text>
          {files.slice(fileIndex, fileIndex + page).map((file) => (
            <Text key={file.path}>
              {terminalText(file.path)} · {file.status}
              {file.reason ? ` · ${terminalText(file.reason)}` : ''}
            </Text>
          ))}
          {files.length > page && <Text>{t('←/→ more files')}</Text>}
          {confirm ? (
            scopes.map((scope, i) => (
              <Text key={scope}>
                {scopeIndex === i ? '› ' : '  '}
                {names[scope]}
              </Text>
            ))
          ) : (
            <Text>
              {t('Choose recovery scope explicitly; files and conversation have separate results.')}
            </Text>
          )}
          {confirm && (
            <Text>{t('Enter confirms selected scope · Esc returns without submitting')}</Text>
          )}
        </>
      )}
      {recovery?.intent && (
        <>
          <Text>
            {t('Original recovery')}: {names[recovery.intent.scope]} · {t('Code')}:{' '}
            {recovery.intent.code?.phase ?? '-'} · {t('Session')}:{' '}
            {recovery.intent.fork?.phase ?? '-'}
          </Text>
          <Text>
            {t('A: pending approval panel; R: original GET; C: explicitly continue untouched leg')}
          </Text>
          {testDiagnostics && <Text>{terminalText(JSON.stringify(recovery.intent))}</Text>}
        </>
      )}
      {saved.slice(Math.max(0, index - 2), index + page).map((intent, i) => (
        <Text key={intent.code?.request.commandId ?? intent.fork!.request.commandId}>
          {index === Math.max(0, index - 2) + i ? '› ' : '  '}
          {t('Saved')} {Math.max(0, index - 2) + i + 1}: {names[intent.scope]} · {t('Code')}{' '}
          {intent.code?.phase ?? '-'} · {t('Session')} {intent.fork?.phase ?? '-'}
        </Text>
      ))}
      {saved.length > 0 && <Text>{t('; L queries selected original intent')}</Text>}
      {state.error && <Text color="red">{terminalText(state.error)}</Text>}
    </TuiOverlayFrame>
  );
}
