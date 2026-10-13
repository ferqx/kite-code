import { Box, useInput, usePaste } from 'ink';
import { useState, useSyncExternalStore } from 'react';
import { isCtrlCBatch } from './composer-input';
import { type TuiController, terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';

export function TuiManagementRequestsPanel({ controller }: { controller: TuiController }) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state),
    requests = state.managementRequests,
    rows = requests?.saved ?? [],
    index = rows.findIndex((row) => row.intent.request.commandId === requests?.selectedId),
    selected = rows[index];
  const { t } = useTuiPresentation();
  const [showRequest, setShowRequest] = useState(false);
  // Literal paste is never interpreted as an original query or a cancellation.
  usePaste(() => {});
  useInput((input, key) => {
    if (key.escape) controller.closePanel();
    else if ((key.ctrl && input === 'c') || isCtrlCBatch(input)) controller.cancelManagementRead();
    else if (key.upArrow || key.downArrow) {
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + (key.downArrow ? 1 : -1)))];
      if (next) controller.selectManagementRequest(next.intent.request.commandId);
      setShowRequest(false);
    } else if (key.return || (!key.ctrl && !key.meta && input.toLowerCase() === 'k'))
      void controller.lookupManagementRequest();
    else if (!key.ctrl && !key.meta && input.toLowerCase() === 'v')
      setShowRequest((shown) => !shown);
  });
  return (
    <Box flexDirection="column">
      <Text bold>{t('Original management requests')}</Text>
      <Text>
        {t('↑/↓ choose · K/Enter query original · V request · Ctrl+C stop read · Esc close')}
      </Text>
      {!rows.length && <Text>{t('No saved management requests in this client')}</Text>}
      {rows.slice(Math.max(0, index - 2), Math.max(0, index - 2) + 5).map((row) => (
        <Text key={row.intent.request.commandId}>
          {row === selected ? '› ' : '  '}
          {terminalText(row.intent.request.commandId)} · {terminalText(row.intent.sessionId)} ·{' '}
          {terminalText(row.intent.kind)} · {row.status}
        </Text>
      ))}
      {selected && (
        <>
          <Text>
            {t('Original Store')} {terminalText(selected.intent.request.expectedStoreId)} ·{' '}
            {t('Original Session')} {terminalText(selected.intent.sessionId)}
          </Text>
          {selected.command && selected.status !== 'outcome_unknown' && (
            <Text>
              {t('Original Command receipt')} {selected.command.status} ·{' '}
              {terminalText(JSON.stringify(selected.command.receipt))}
            </Text>
          )}
          {(selected.status === 'accepted' || selected.status === 'queued') && (
            <Text>
              {t('Original receipt accepted/queued; not dispatch or maintenance completion')}
            </Text>
          )}
          {selected.status === 'delete_requested' && (
            <Text>{t('Directory hidden; stop is unconfirmed; workspace files unchanged')}</Text>
          )}
          {selected.omittedExtensionState && (
            <Text>{t('Fork omitted extension state; authorization is not inherited')}</Text>
          )}
          {showRequest && <Text>{terminalText(JSON.stringify(selected.intent))}</Text>}
        </>
      )}
      {requests?.phase === 'reading' && <Text>{t('Reading the selected original request')}</Text>}
      {requests?.phase === 'unknown' && (
        <Text>{t('Original result unverified; saved facts retained')}</Text>
      )}
      {requests?.phase === 'cancelled' && (
        <Text>{t('Original request read cancelled; work unchanged')}</Text>
      )}
      {requests?.error && (
        <Text>
          {t('Original request query failed:')} {terminalText(requests.error)}
        </Text>
      )}
      {state.stale && <Text>{t('Stale')}</Text>}
    </Box>
  );
}
