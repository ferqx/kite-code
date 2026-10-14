import { useInput } from 'ink';
import { useEffect, useState } from 'react';
import { type TuiController, terminalText } from './controller';
import TuiOverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { OverlayListRow, OverlaySection } from './ink/OverlayPrimitives';
import type { TuiMcpSnapshot } from './mcp';
import { TuiMcpDirectoryPanel } from './mcp-directory-panel';
import { TuiMcpReconnectionPanel } from './mcp-reconnection-panel';
import { TuiMcpSourceMutationPanel } from './mcp-source-mutation-panel';
import { TuiMcpSourcePanel } from './mcp-source-panel';
import { TuiMcpToolsPanel } from './mcp-tools-panel';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';

/** Visible choices use arrows, Enter and Esc; each mutation has a separate scope review. */
export function TuiMcpPanel({ controller }: { controller: TuiController }) {
  const { t: originalLabel } = useInkI18n();
  const { t, testDiagnostics } = useTuiPresentation(),
    state = controller.state,
    facts = state.mcp?.facts;
  const [index, setIndex] = useState(0),
    [detail, setDetail] = useState<string>();
  const [pending, setPending] = useState<{
    kind: 'selection' | 'connection';
    serverId: string;
    enabled: boolean;
    scope: 'user' | 'workspace';
    observed: TuiMcpSnapshot;
  }>();
  const [directory, setDirectory] = useState<'resources' | 'prompts'>();
  const rows = facts?.items ?? [];
  const server = rows.find((row) => row.id === detail);
  const serverName = (id: string) => facts?.labels?.[id] ?? id;
  type Choice =
    | { kind: 'server' | 'saved'; id: string }
    | { kind: 'connectionSaved'; id: string }
    | {
        kind:
          | 'user'
          | 'workspace'
          | 'lookup'
          | 'refresh'
          | 'back'
          | 'tools'
          | 'connection'
          | 'connectionLookup'
          | 'sources'
          | 'reconnections'
          | 'reconnectReview'
          | 'sourceMutations'
          | 'resources'
          | 'prompts';
      };
  const actions: Choice[] = server
    ? [
        ...(server.admitted
          ? [
              { kind: 'user' as const },
              ...(facts?.readSet.workspaceEtag !== null ? [{ kind: 'workspace' as const }] : []),
            ]
          : []),
        ...(state.mcpOutcome ? [{ kind: 'lookup' as const }] : []),
        { kind: 'refresh' },
        ...(state.mcpSaved ?? [])
          .filter((row) => row.intent.sessionId === state.sessionId)
          .map((row) => ({ kind: 'saved' as const, id: row.intent.request.commandId })),
        { kind: 'back' },
        { kind: 'tools' },
        ...(controller.port.mcp?.connection &&
        server.admitted &&
        server.selected &&
        server.available
          ? [{ kind: 'connection' as const }]
          : []),
        ...(state.mcpConnection ? [{ kind: 'connectionLookup' as const }] : []),
        ...(state.mcpConnections ?? [])
          .filter((row) => row.intent.sessionId === state.sessionId)
          .map((row) => ({ kind: 'connectionSaved' as const, id: row.intent.request.commandId })),
      ]
    : [
        ...rows.map((row) => ({ kind: 'server' as const, id: row.id })),
        ...(state.mcpOutcome ? [{ kind: 'lookup' as const }] : []),
        { kind: 'refresh' },
        ...(state.mcpSaved ?? [])
          .filter((row) => row.intent.sessionId === state.sessionId)
          .map((row) => ({ kind: 'saved' as const, id: row.intent.request.commandId })),
        { kind: 'tools' },
        ...(state.mcpConnection ? [{ kind: 'connectionLookup' as const }] : []),
        ...(state.mcpConnections ?? [])
          .filter((row) => row.intent.sessionId === state.sessionId)
          .map((row) => ({ kind: 'connectionSaved' as const, id: row.intent.request.commandId })),
      ];
  if (controller.port.mcp?.readDirectory) actions.push({ kind: 'resources' }, { kind: 'prompts' });
  if (controller.port.mcp?.sourceMutation) actions.push({ kind: 'sourceMutations' });
  if (controller.port.mcp?.reconnection) {
    actions.push({ kind: 'reconnections' });
    if (controller.canReviewMcpReconnection('connection'))
      actions.push({ kind: 'reconnectReview' });
  }
  if (controller.port.mcp?.source) actions.unshift({ kind: 'sources' });
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new observation invalidates the selected choice and confirmation.
  useEffect(() => {
    setIndex(0);
    setDetail(undefined);
    setPending(undefined);
  }, [facts]);
  useInput(
    (input, key) => {
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
        } else controller.closePanel();
        return;
      }
      if (pending) {
        if (key.return) {
          if (pending.kind === 'connection')
            void controller.requestMcpConnection(pending.serverId, pending.observed);
          else
            void controller.chooseMcp(
              pending.serverId,
              pending.enabled,
              pending.scope,
              pending.observed,
            );
          setPending(undefined);
        }
        return;
      }
      if (key.upArrow) setIndex((value) => Math.max(0, value - 1));
      else if (key.downArrow) setIndex((value) => Math.min(actions.length - 1, value + 1));
      else if (key.return) {
        const action = actions[index];
        if (!action) return;
        if (action.kind === 'resources' || action.kind === 'prompts') {
          setDirectory(action.kind);
          return;
        }
        if (action.kind === 'reconnections') {
          void controller.openMcpReconnections();
          return;
        }
        if (action.kind === 'reconnectReview') {
          void controller.reviewMcpReconnection('connection');
          return;
        }
        if (action.kind === 'sourceMutations') {
          void controller.openMcpSourceMutations();
          return;
        }
        if (action.kind === 'sources') {
          void controller.openMcpSources();
          return;
        }
        if (action.kind === 'tools') {
          void controller.openMcpTools();
          return;
        }
        if (action.kind === 'refresh') {
          void controller.openMcp();
          return;
        }
        if (action.kind === 'server') {
          setDetail(action.id);
          setIndex(0);
          return;
        }
        if (action.kind === 'connectionSaved') {
          controller.selectMcpConnection(action.id);
          return;
        }
        if (action.kind === 'connectionLookup') {
          void controller.lookupMcpConnection();
          return;
        }
        if (action.kind === 'connection' && server && facts && state.mcp?.read === 'ready') {
          setPending({
            kind: 'connection',
            serverId: server.id,
            enabled: true,
            scope: 'user',
            observed: facts,
          });
          return;
        }
        if (action.kind === 'saved') {
          controller.selectMcpOriginal(action.id);
          return;
        }
        if (action.kind === 'lookup') {
          void controller.lookupMcp();
          return;
        }
        if (!server) return;
        if (action.kind === 'back') {
          setDetail(undefined);
          setIndex(0);
        } else if (
          (action.kind === 'user' || action.kind === 'workspace') &&
          facts &&
          state.mcp?.read === 'ready'
        )
          setPending({
            kind: 'selection',
            serverId: server.id,
            enabled: !server.selected,
            scope: action.kind,
            observed: facts,
          });
      }
    },
    {
      isActive:
        !directory &&
        !state.mcpTools &&
        !state.mcpSourceOpen &&
        !state.mcpReconnectionOpen &&
        !state.mcpMutationOpen,
    },
  );
  if (directory)
    return (
      <TuiMcpDirectoryPanel
        controller={controller}
        family={directory}
        serverId={server?.id}
        onBack={() => setDirectory(undefined)}
      />
    );
  if (state.mcpMutationOpen) return <TuiMcpSourceMutationPanel controller={controller} />;
  if (state.mcpReconnectionOpen) return <TuiMcpReconnectionPanel controller={controller} />;
  if (state.mcpSourceOpen) return <TuiMcpSourcePanel controller={controller} />;
  if (state.mcpTools) return <TuiMcpToolsPanel controller={controller} />;
  const offset = Math.max(0, Math.min(index - 2, actions.length - 5));
  const label = (action: Choice) => {
    if (server && (action.kind === 'user' || action.kind === 'workspace'))
      return `${t(server.selected ? 'Disable' : 'Enable')} · ${t(action.kind === 'user' ? 'User settings' : 'Project settings')}`;
    if (action.kind === 'connectionSaved')
      return `${t('Original connection:')} ${testDiagnostics ? terminalText(action.id) : (state.mcpConnections ?? []).findIndex((row) => row.intent.request.commandId === action.id) + 1}`;
    if (action.kind === 'connection') return t('Request connection');
    if (action.kind === 'connectionLookup') return t('Check original connection');
    if (action.kind === 'saved')
      return `${t('Original change:')} ${testDiagnostics ? terminalText(action.id) : (state.mcpSaved ?? []).findIndex((row) => row.intent.request.commandId === action.id) + 1}`;
    if (action.kind === 'refresh') return t('Refresh servers');
    if (action.kind === 'lookup') return t('Check original change');
    if (action.kind === 'back') return originalLabel('common.back');
    if (action.kind === 'sourceMutations') return t('Add / remove MCP server');
    if (action.kind === 'reconnections') return t('Forced reconnects');
    if (action.kind === 'reconnectReview') return t('Review forced reconnect');
    if (action.kind === 'sources') return t('Project sources');
    if (action.kind === 'prompts') return t('Saved MCP prompts');
    if (action.kind === 'resources') return t('Saved MCP resources');
    if (action.kind === 'tools') return t('Saved tool snapshots');
    const row = action.kind === 'server' ? rows.find((value) => value.id === action.id) : undefined;
    return row
      ? `${terminalText(testDiagnostics ? row.id : serverName(row.id))} · ${t(row.selected ? 'enabled' : 'disabled')} · ${t(row.available ? 'available' : 'unavailable')}`
      : '';
  };
  return (
    <TuiOverlayFrame
      title={
        server
          ? `MCP · ${terminalText(testDiagnostics ? server.id : serverName(server.id))}`
          : t('MCP servers')
      }
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
      {testDiagnostics && <Text>{terminalText(facts?.workspaceId ?? '')}</Text>}
      <Text>
        {t(
          'Selection applies to later work; active work and connections retain their configuration.',
        )}
      </Text>
      {testDiagnostics && (
        <Text>{t('Reading this list does not connect or authorize tools.')}</Text>
      )}
      {state.mcp?.read === 'ready' && <Text>{t('Server list ready')}</Text>}
      {state.mcp?.read !== 'ready' && (
        <Text>
          {t(
            state.mcp?.read === 'reading'
              ? 'Reading servers'
              : 'Server list unknown; refresh to verify',
          )}
        </Text>
      )}
      {server && (
        <>
          <Text>
            {t('Server:')} {terminalText(testDiagnostics ? server.id : serverName(server.id))} ·{' '}
            {server.transport}
          </Text>
          <Text>
            {t('Source:')}{' '}
            {t(
              server.source.kind === 'workspace'
                ? 'Project Source'
                : server.source.kind === 'user'
                  ? 'User Source'
                  : 'Static registration',
            )}
            {testDiagnostics && <> · {terminalText(server.source.id)}</>}
          </Text>
          <Text>
            {t('State:')} {t(server.selected ? 'enabled' : 'disabled')} ·{' '}
            {t(server.available ? 'available' : 'unavailable')}
          </Text>
          {server.reason && (
            <Text>
              {t('· Reason:')} {terminalText(server.reason)}
            </Text>
          )}
        </>
      )}
      {!rows.length && <Text>{t('No configured MCP servers')}</Text>}
      {state.mcpUnavailable && <Text>{terminalText(state.mcpUnavailable)}</Text>}
      <OverlaySection>{t('Actions')}</OverlaySection>
      {actions.slice(offset, offset + 5).map((action, position) => (
        <OverlayListRow
          key={
            action.kind === 'server' || action.kind === 'saved' || action.kind === 'connectionSaved'
              ? `${action.kind}:${action.id}`
              : action.kind
          }
          selected={index === offset + position}
          primary={label(action)}
        />
      ))}
      <Text>{t('↑/↓ choose · Enter select · Esc back')}</Text>
      {pending?.kind === 'connection' && (
        <Text>
          {t('Confirm connection request:')}{' '}
          {terminalText(testDiagnostics ? pending.serverId : serverName(pending.serverId))} ·{' '}
          {server?.transport} · {t('Source:')} {terminalText(server?.source.kind ?? '')}{' '}
          {testDiagnostics && (
            <>
              · {t('Session')} {terminalText(state.sessionId ?? '')}
            </>
          )}{' '}
          ·{' '}
          {t(
            'Enter requests connection; Esc abandons. Independent approval required; no tool permission granted.',
          )}
        </Text>
      )}
      {pending?.kind === 'selection' && (
        <Text>
          {t('Confirm server change:')}{' '}
          {terminalText(testDiagnostics ? pending.serverId : serverName(pending.serverId))} ·{' '}
          {t(pending.enabled ? 'Enable' : 'Disable')} ·{' '}
          {t(pending.scope === 'user' ? 'User settings' : 'Project settings')} ·{' '}
          {t('Enter saves; Esc abandons')}
        </Text>
      )}
      {state.mcpOutcome && (
        <Text>
          {t('Original change:')}{' '}
          {testDiagnostics && terminalText(state.mcpOutcome.intent.request.commandId)} ·{' '}
          {t(
            state.mcpOutcome.phase === 'applied'
              ? 'Selection saved'
              : state.mcpOutcome.phase === 'failed'
                ? 'Selection failed'
                : state.mcpOutcome.phase === 'pending'
                  ? 'Waiting for original result'
                  : 'Outcome unknown; check original change',
          )}
        </Text>
      )}
      {state.mcpConnectionUnavailable && (
        <Text>{terminalText(state.mcpConnectionUnavailable)}</Text>
      )}
      {state.mcpConnection && (
        <>
          <Text>
            {t('Original connection:')}{' '}
            {testDiagnostics && terminalText(state.mcpConnection.intent.request.commandId)} ·{' '}
            {t(
              state.mcpConnectionReading
                ? 'Reading original connection'
                : state.mcpConnection.phase === 'ready'
                  ? 'Original catalogue ready'
                  : state.mcpConnection.phase === 'pending'
                    ? 'Waiting for original connection'
                    : state.mcpConnection.phase === 'failed'
                      ? 'Connection request failed'
                      : 'Connection outcome unknown; check original',
            )}
          </Text>
          {state.mcpConnection.fact && (
            <Text>
              {t(
                state.mcpConnection.fact.live
                  ? 'Live connection observed'
                  : 'Live connection not confirmed',
              )}{' '}
              ·{' '}
              {t(
                state.mcpConnection.fact.created === true
                  ? 'Created by original request'
                  : state.mcpConnection.fact.created === false
                    ? 'Reused original connection'
                    : 'Creation unknown',
              )}{' '}
              {testDiagnostics && (
                <>
                  · {t('current generation')}{' '}
                  {state.mcpConnection.fact.currentGeneration ?? t('unavailable')}
                </>
              )}
            </Text>
          )}
        </>
      )}
      {state.error && (
        <Text color="red">
          {t('Error:')} {terminalText(state.error)}
        </Text>
      )}
    </TuiOverlayFrame>
  );
}
