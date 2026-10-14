import { useInput } from 'ink';
import { useEffect, useState } from 'react';
import { callerKey } from './caller';
import { type TuiController, terminalText } from './controller';
import TuiOverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { OverlayListRow, OverlaySection } from './ink/OverlayPrimitives';
import { mcpAuthRequest, type TuiMcpAuthAction } from './mcp-auth';
import type { TuiMcpSourceSnapshot } from './mcp-source';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';

const names: Record<TuiMcpAuthAction, string> = {
  'mcp.auth.login': 'Login',
  'mcp.auth.refresh': 'Refresh credentials',
  'mcp.auth.clear': 'Clear local credentials',
  'mcp.auth.revoke': 'Revoke remote credentials',
};
export function TuiMcpAuthPanel({ controller }: { controller: TuiController }) {
  const { t: originalLabel } = useInkI18n();
  const { t, testDiagnostics } = useTuiPresentation(),
    state = controller.state,
    status = state.mcpAuthStatus;
  const [index, setIndex] = useState(0),
    [pending, setPending] = useState<
      { action: TuiMcpAuthAction; observed: TuiMcpSourceSnapshot } | { cancel: true }
    >();
  const originals = [...state.callers.values()].filter((row) => mcpAuthRequest(row.intent));
  type Choice =
    | { kind: 'action'; action: TuiMcpAuthAction }
    | { kind: 'original'; key: string }
    | { kind: 'check' | 'cancel' | 'back' };
  const actions: Choice[] = [
    ...(status?.status === 'available'
      ? [
          ...(status.loginAllowed
            ? [{ kind: 'action' as const, action: 'mcp.auth.login' as const }]
            : []),
          ...(status.credentialPresent
            ? [
                { kind: 'action' as const, action: 'mcp.auth.refresh' as const },
                { kind: 'action' as const, action: 'mcp.auth.clear' as const },
                { kind: 'action' as const, action: 'mcp.auth.revoke' as const },
              ]
            : []),
        ]
      : []),
    ...(state.mcpAuthOutcome ? [{ kind: 'check' as const }] : []),
    ...(state.mcpAuthOutcome?.phase === 'pending' &&
    state.mcpAuthOutcome.fact?.execution &&
    state.mcpAuthOutcome.intent.scope.storeId === state.snapshot?.storeId &&
    state.mcpAuthOutcome.intent.scope.sessionId === state.sessionId
      ? [{ kind: 'cancel' as const }]
      : []),
    ...originals.map((row) => ({ kind: 'original' as const, key: callerKey(row.intent) })),
    { kind: 'back' },
  ];
  // biome-ignore lint/correctness/useExhaustiveDependencies: new scope/status resets local confirmation, never a submitted operation.
  useEffect(() => {
    setIndex(0);
    setPending(undefined);
  }, [state.sessionId, state.mcpAuthServerId, status]);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      controller.closeMcpAuth();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.escape) {
      if (pending) setPending(undefined);
      else controller.closeMcpAuth();
      return;
    }
    if (pending) {
      if (key.return) {
        if ('cancel' in pending) void controller.cancelMcpAuth();
        else void controller.requestMcpAuth(pending.action, pending.observed);
        setPending(undefined);
      }
      return;
    }
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIndex((i) => Math.min(actions.length - 1, i + 1));
    else if (key.return) {
      const choice = actions[index];
      if (!choice) return;
      if (choice.kind === 'action' && state.mcpSource?.facts)
        setPending({ action: choice.action, observed: state.mcpSource.facts });
      else if (choice.kind === 'original') controller.selectMcpAuthOriginal(choice.key);
      else if (choice.kind === 'check') void controller.lookupMcpAuth();
      else if (choice.kind === 'cancel') setPending({ cancel: true });
      else if (choice.kind === 'back') controller.closeMcpAuth();
    }
  });
  const original = state.mcpAuthOutcome,
    request = original && mcpAuthRequest(original.intent),
    fact = original?.fact;
  const verified = Boolean(
    original &&
      request &&
      fact &&
      fact.phase === original.phase &&
      fact.storeId === original.intent.scope.storeId &&
      fact.sessionId === original.intent.scope.sessionId &&
      fact.command?.id === request.commandId &&
      fact.command.subjectId === original.intent.subjectId &&
      fact.command.requestDigest === original.intent.requestDigest &&
      fact.binding?.originCommandId === request.commandId &&
      fact.binding.serverId === request.input.serverId,
  );
  const phase = state.mcpAuthReading
    ? 'Reading authentication'
    : original?.phase === 'pending'
      ? 'Authentication pending'
      : verified && original?.phase === 'completed'
        ? fact?.authStatus === 'authenticated'
          ? 'Credentials saved; reconnect separately'
          : fact?.authStatus === 'not_supported'
            ? 'Remote revocation not supported; credentials retained'
            : 'Credentials cleared'
        : verified && original?.phase === 'failed'
          ? 'Authentication failed'
          : verified && original?.phase === 'cancelled'
            ? 'Authentication cancelled'
            : 'Authentication outcome unknown; check original';
  const label = (choice: Choice) =>
    choice.kind === 'action'
      ? `${t('Review')} ${t(names[choice.action])}`
      : choice.kind === 'original'
        ? `${t('Original authentication:')} ${testDiagnostics ? terminalText(state.callers.get(choice.key)?.intent.request.commandId ?? '') : originals.findIndex((row) => callerKey(row.intent) === choice.key) + 1}`
        : t(
            {
              check: 'Check original authentication',
              cancel: 'Cancel original authentication',
              back: 'Back',
            }[choice.kind],
          );
  const offset = Math.max(0, Math.min(index - 2, actions.length - 5));
  return (
    <TuiOverlayFrame
      title={t('MCP authentication')}
      meta={`${index + 1} / ${actions.length}`}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: originalLabel('common.select') },
            { keys: 'Enter', label: originalLabel('common.confirm') },
            { keys: 'Esc', label: originalLabel('common.back') },
          ]}
        />
      }
    >
      <Text>{t('Authentication does not reconnect or replay tools.')}</Text>
      {state.mcpAuthServerId && (
        <Text>
          {t('Server:')} {terminalText(state.mcpAuthServerId)}
        </Text>
      )}
      {status && (
        <Text>
          {t('Credential store:')} {terminalText(status.status)} ·{' '}
          {t(status.credentialPresent ? 'Credentials present' : 'No credentials')}
        </Text>
      )}
      <OverlaySection>{t('Actions')}</OverlaySection>
      {actions.slice(offset, offset + 5).map((choice, i) => (
        <OverlayListRow
          key={choice.kind === 'original' ? choice.key : `${choice.kind}:${offset + i}`}
          selected={offset + i === index}
          primary={label(choice)}
        />
      ))}
      <Text>{t('↑/↓ choose · Enter select · Esc back')}</Text>
      {pending && (
        <Text>
          {t('Confirm authentication:')}{' '}
          {t('cancel' in pending ? 'Cancel original authentication' : names[pending.action])} ·{' '}
          {t('Enter submits this request; Esc abandons.')}
        </Text>
      )}
      {original && (
        <>
          {testDiagnostics && (
            <Text>
              {t('Original authentication:')} {terminalText(original.intent.request.commandId)}
            </Text>
          )}
          {testDiagnostics && (
            <Text>
              {t('Original Store:')} {terminalText(original.intent.scope.storeId)} · {t('Session')}{' '}
              {terminalText(original.intent.scope.sessionId)}
            </Text>
          )}
          <Text>{t(phase)}</Text>
        </>
      )}
      {!original && state.mcpAuthReading && <Text>{t('Reading authentication')}</Text>}
      {state.mcpAuthError && <Text>{t('Authentication unavailable')}</Text>}
    </TuiOverlayFrame>
  );
}
