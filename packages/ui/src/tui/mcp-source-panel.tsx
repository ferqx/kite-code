import { Box, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { type TuiController, terminalText } from './controller';
import { TuiMcpAuthPanel } from './mcp-auth-panel';
import type { TuiMcpSourceSnapshot } from './mcp-source';
import { reviewableMcpSource } from './mcp-source-question';
import { TuiText as Text, useTuiPresentation } from './presentation';

/** Host supplies a complete snapshot; Ink renders only a finite local page. */
export function TuiMcpSourcePanel({ controller }: { controller: TuiController }) {
  const { t } = useTuiPresentation(),
    state = controller.state,
    facts = state.mcpSource?.facts;
  const [index, setIndex] = useState(0),
    [page, setPage] = useState(0),
    [detail, setDetail] = useState<string>();
  const [pending, setPending] = useState<{ serverId: string; observed: TuiMcpSourceSnapshot }>();
  const rows = facts?.items ?? [],
    server = rows.find((row) => row.id === detail);
  const originals = (state.mcpSourceSaved ?? []).filter(
    (row) => row.intent.workspaceId === state.snapshot?.view.session.workspaceId,
  );
  type Choice =
    | { kind: 'server' | 'saved'; id: string }
    | {
        kind:
          | 'auth'
          | 'authHistory'
          | 'review'
          | 'lookup'
          | 'refresh'
          | 'next'
          | 'previous'
          | 'back'
          | 'main';
      };
  const actions: Choice[] = [
    ...(server
      ? facts && state.mcpSource?.read === 'ready' && reviewableMcpSource(server, facts)
        ? [{ kind: 'review' as const }]
        : []
      : rows
          .slice(page * 25, (page + 1) * 25)
          .map((row) => ({ kind: 'server' as const, id: row.id }))),
    ...(controller.hasMcpAuth && server?.transport === 'http' ? [{ kind: 'auth' as const }] : []),
    ...(!server && controller.hasMcpAuth ? [{ kind: 'authHistory' as const }] : []),
    ...(state.mcpSourceOutcome ? [{ kind: 'lookup' as const }] : []),
    ...originals.map((row) => ({ kind: 'saved' as const, id: row.intent.request.commandId })),
    ...(!server && page > 0 ? [{ kind: 'previous' as const }] : []),
    ...(!server && (page + 1) * 25 < rows.length ? [{ kind: 'next' as const }] : []),
    { kind: 'refresh' },
    { kind: server ? 'back' : 'main' },
    ...(server ? [{ kind: 'main' as const }] : []),
  ];
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changed observations invalidate local navigation and confirmation.
  useEffect(() => {
    setIndex(0);
    setPage(0);
    setDetail(undefined);
    setPending(undefined);
  }, [facts]);
  useInput((input, key) => {
    if (state.mcpAuthOpen) return;
    if (key.ctrl && input === 'c') {
      controller.closePanel();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.escape) {
      if (pending) setPending(undefined);
      else if (detail) {
        setDetail(undefined);
        setIndex(0);
      } else controller.closeMcpSources();
      return;
    }
    if (pending) {
      if (key.return) {
        void controller.requestMcpSourceApproval(pending.serverId, pending.observed);
        setPending(undefined);
      }
      return;
    }
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIndex((i) => Math.min(actions.length - 1, i + 1));
    else if (key.return) {
      const choice = actions[index];
      if (!choice) return;
      if (choice.kind === 'auth') void controller.openMcpAuth(server?.id);
      else if (choice.kind === 'authHistory') void controller.openMcpAuth();
      else if (choice.kind === 'server') {
        setDetail(choice.id);
        setIndex(0);
      } else if (choice.kind === 'saved') controller.selectMcpSourceOriginal(choice.id);
      else if (choice.kind === 'lookup') void controller.lookupMcpSourceApproval();
      else if (choice.kind === 'review' && server && facts)
        setPending({ serverId: server.id, observed: facts });
      else if (choice.kind === 'refresh') void controller.openMcpSources();
      else if (choice.kind === 'next' || choice.kind === 'previous') {
        setPage((p) => p + (choice.kind === 'next' ? 1 : -1));
        setIndex(0);
      } else if (choice.kind === 'back') {
        setDetail(undefined);
        setIndex(0);
      } else if (choice.kind === 'main') controller.closePanel();
    }
  });
  const label = (choice: Choice) => {
    if (choice.kind === 'server') {
      const row = rows.find((r) => r.id === choice.id);
      return row ? `${terminalText(row.id)} · ${terminalText(row.name)}` : '';
    }
    if (choice.kind === 'saved') {
      const original = originals.find((row) => row.intent.request.commandId === choice.id);
      return `${t('Original source decision:')} ${terminalText(choice.id)} · ${t('Original Store:')} ${terminalText(original?.intent.request.expectedStoreId ?? '')}`;
    }
    return t(
      (
        {
          auth: 'Authentication',
          authHistory: 'Original authentication requests',
          review: 'Review project source',
          lookup: 'Check original source decision',
          refresh: 'Refresh project sources',
          next: 'Next project sources',
          previous: 'Previous project sources',
          back: 'Back',
          main: 'Return to pending requests',
        } as const
      )[choice.kind],
    );
  };
  const offset = Math.max(0, Math.min(index - 2, actions.length - 5)),
    outcome = state.mcpSourceOutcome;
  const fact =
    outcome?.fact &&
    outcome.fact.storeId === outcome.intent.request.expectedStoreId &&
    outcome.fact.sessionId === outcome.intent.sessionId &&
    outcome.fact.command?.id === outcome.intent.request.commandId &&
    outcome.fact.serverId === outcome.intent.request.input.serverId &&
    outcome.fact.phase === outcome.phase
      ? outcome.fact
      : undefined;
  const phase = state.mcpSourceReading
    ? 'Reading original source decision'
    : outcome?.phase === 'saved' && fact?.phase === 'saved'
      ? fact.decision === 'approved'
        ? 'Source approval saved'
        : fact.decision === 'rejected'
          ? 'Source rejection saved'
          : 'Source outcome unknown; check original'
      : outcome?.phase === 'pending'
        ? 'Waiting for original source decision'
        : outcome?.phase === 'failed' && fact?.phase === 'failed'
          ? 'Source request failed'
          : outcome?.phase === 'cancelled' && fact?.phase === 'cancelled'
            ? 'Source request cancelled'
            : 'Source outcome unknown; check original';
  if (state.mcpAuthOpen) return <TuiMcpAuthPanel controller={controller} />;
  return (
    <Box flexDirection="column">
      <Text bold>
        {t('Project sources')} · {terminalText(state.snapshot?.view.session.workspaceId ?? '')}
      </Text>
      <Text>
        {t('Review requests an independent decision; it does not connect or authorize tools.')}
      </Text>
      <Text>
        {t(
          state.mcpSource?.read === 'ready'
            ? 'Source list ready'
            : state.mcpSource?.read === 'reading'
              ? 'Reading project sources'
              : 'Source list unknown; original decisions remain available',
        )}
      </Text>
      {!rows.length && <Text>{t('No project sources in this observation')}</Text>}
      {server && (
        <>
          <Text>
            {t('Server:')} {terminalText(server.id)} · {terminalText(server.name)}
          </Text>
          <Text>
            {t('Source:')} {terminalText(server.source.kind)} ·{' '}
            {server.transport ?? t('unavailable')}
          </Text>
          <Text>
            {t(server.admitted ? 'admitted' : 'not admitted')} ·{' '}
            {t(server.enabled ? 'enabled' : 'disabled')}
          </Text>
          {server.reason && <Text>{terminalText(server.reason)}</Text>}
        </>
      )}
      {actions.slice(offset, offset + 5).map((choice, i) => (
        <Text key={'id' in choice ? `${choice.kind}:${choice.id}` : `${choice.kind}:${offset + i}`}>
          {index === offset + i ? '›' : ' '} {label(choice)}
        </Text>
      ))}
      <Text>{t('↑/↓ choose · Enter select · Esc back')}</Text>
      {pending && (
        <Text>
          {t('Confirm project source review:')} {terminalText(pending.serverId)} ·{' '}
          {terminalText(server?.name ?? '')} · {terminalText(server?.source.kind ?? '')} ·{' '}
          {server?.transport} ·{' '}
          {t('Enter requests review; Esc abandons. Answer the original Question separately.')}
        </Text>
      )}
      {outcome && (
        <>
          <Text>
            {t('Original source decision:')} {terminalText(outcome.intent.request.commandId)} ·{' '}
            {t('Original Store:')} {terminalText(outcome.intent.request.expectedStoreId)} ·{' '}
            {t('Session')} {terminalText(outcome.intent.sessionId)}
          </Text>
          <Text>{t(phase)}</Text>
        </>
      )}
      {state.mcpSourceUnavailable && <Text>{terminalText(state.mcpSourceUnavailable)}</Text>}
      {state.error && (
        <Text color="red">
          {t('Error:')} {terminalText(state.error)}
        </Text>
      )}
    </Box>
  );
}
