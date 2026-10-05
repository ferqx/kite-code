import { Box, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { type TuiController, terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';

/** Separate Review/Confirm and original-ID navigation; no letter key dispatches business. */
export function TuiMcpReconnectionPanel({ controller }: { controller: TuiController }) {
  const { t } = useTuiPresentation(),
    state = controller.state;
  const [index, setIndex] = useState(0);
  const observed = state.mcpReconnectionObservation,
    outcome = state.mcpReconnection;
  const replacementServer = observed?.management.items.find(
    (row) => row.id === observed.carrier.request.input.serverId,
  );
  const sourceItem = observed?.source?.items.find(
    (row) => row.id === observed.carrier.request.input.serverId,
  );
  const rows = (state.mcpReconnections ?? []).filter(
    (r) => r.intent.workspaceId === state.snapshot?.view.session.workspaceId,
  );
  type Choice =
    | { kind: 'original'; id: string }
    | { kind: 'check' | 'review' | 'confirm' | 'back' };
  const actions: Choice[] = observed
    ? [{ kind: 'confirm' }, { kind: 'back' }]
    : [
        ...(outcome ? [{ kind: 'check' as const }] : []),
        ...(controller.canReviewMcpReconnection('reconnection')
          ? [{ kind: 'review' as const }]
          : []),
        ...rows.map((r) => ({ kind: 'original' as const, id: r.intent.request.commandId })),
        { kind: 'back' },
      ];
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new review or its removal resets navigation to an independent confirmation.
  useEffect(() => {
    setIndex(0);
  }, [observed]);
  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || key.escape) {
      controller.closeMcpReconnections();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.upArrow) setIndex((v) => Math.max(0, v - 1));
    else if (key.downArrow) setIndex((v) => Math.min(actions.length - 1, v + 1));
    else if (key.return) {
      const action = actions[index];
      if (action?.kind === 'original') controller.selectMcpReconnection(action.id);
      else if (action?.kind === 'check') void controller.lookupMcpReconnection();
      else if (action?.kind === 'review') void controller.reviewMcpReconnection('reconnection');
      else if (action?.kind === 'confirm') void controller.confirmMcpReconnection(observed);
      else if (action?.kind === 'back') controller.closeMcpReconnections();
    }
  });
  const offset = Math.max(0, Math.min(index - 2, actions.length - 5));
  const label = (row: Choice) =>
    row.kind === 'original'
      ? `${t('Original forced reconnect:')} ${terminalText(row.id)}`
      : t(
          row.kind === 'check'
            ? 'Check original forced reconnect'
            : row.kind === 'review'
              ? 'Review forced reconnect'
              : row.kind === 'confirm'
                ? 'Confirm forced reconnect'
                : 'Back',
        );
  return (
    <Box flexDirection="column">
      <Text bold>
        {t('Forced reconnects')} · {terminalText(state.snapshot?.view.session.workspaceId ?? '')}
      </Text>
      <Text>{t('Selecting an original ID does not query, reconnect or authorize tools.')}</Text>
      {state.mcpReconnectionObserving && <Text>{t('Reading current reconnect target')}</Text>}
      {observed && (
        <>
          <Text>
            {t('Confirm forced reconnect:')} {terminalText(observed.carrier.request.input.serverId)}{' '}
            · {t('Session')} {terminalText(observed.carrier.sessionId)}
          </Text>
          <Text>
            {t('Original carrier:')} {terminalText(observed.carrier.request.commandId)} ·{' '}
            {t('current generation')} {observed.target.currentGeneration}
          </Text>
          <Text>
            {t('Replacement source:')}{' '}
            {t(
              observed.replacement.kind === 'static'
                ? 'Static registration'
                : sourceItem?.source.kind === 'user'
                  ? 'User Source'
                  : 'Project Source',
            )}
            {' · '}
            {t('Replacement transport:')} {terminalText(replacementServer?.transport ?? '')}
          </Text>
          <Text>
            {t('Replacement configuration digest:')}{' '}
            {terminalText(observed.replacement.expectedConfigDigest)}
          </Text>
          {observed.source?.items.find(
            (row) => row.id === observed.carrier.request.input.serverId,
          ) && (
            <Text>
              {t('Source name:')}{' '}
              {terminalText(
                observed.source.items.find(
                  (row) => row.id === observed.carrier.request.input.serverId,
                )!.name,
              )}
            </Text>
          )}
          <Text>
            {t(
              'Enter submits a new independently approved request. The old connection may stop before replacement succeeds; no automatic restore or tool permission.',
            )}
          </Text>
          <Text>{t('Stopping the connection does not confirm remote Tool work stopped.')}</Text>
        </>
      )}
      {actions.slice(offset, offset + 5).map((row, i) => (
        <Text key={row.kind === 'original' ? row.id : row.kind}>
          {index === offset + i ? '›' : ' '} {label(row)}
        </Text>
      ))}
      <Text>{t('↑/↓ choose · Enter select · Esc back')}</Text>
      {outcome && (
        <>
          <Text>
            {t('Original forced reconnect:')} {terminalText(outcome.intent.request.commandId)} ·{' '}
            {t('Original Store:')} {terminalText(outcome.intent.request.expectedStoreId)} ·{' '}
            {t('Session')} {terminalText(outcome.intent.sessionId)}
          </Text>
          <Text>
            {t(
              state.mcpReconnectionReading
                ? 'Reading original forced reconnect'
                : outcome.phase === 'ready' && outcome.fact?.ready
                  ? 'Replacement catalogue ready'
                  : outcome.phase === 'failed'
                    ? 'Forced reconnect failed'
                    : outcome.phase === 'cancelled'
                      ? 'Forced reconnect cancelled'
                      : outcome.phase === 'pending'
                        ? 'Waiting for original forced reconnect'
                        : 'Forced reconnect outcome unknown; Check original',
            )}
          </Text>
          <Text>
            {t(
              outcome.fact?.oldStop.confirmed
                ? 'Original connection stop confirmed'
                : 'Original connection stop unknown',
            )}
          </Text>
          <Text>
            {t(outcome.fact?.live ? 'Live replacement observed' : 'Live replacement not confirmed')}{' '}
            · {t('current generation')} {outcome.fact?.currentGeneration ?? t('unavailable')}
          </Text>
        </>
      )}
      {state.mcpReconnectionUnavailable && (
        <Text>{terminalText(state.mcpReconnectionUnavailable)}</Text>
      )}
      {state.error && (
        <Text color="red">
          {t('Error:')} {terminalText(state.error)}
        </Text>
      )}
    </Box>
  );
}
