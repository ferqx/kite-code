import { useInput } from 'ink';
import { useEffect, useState } from 'react';
import { type TuiController, terminalText } from './controller';
import TuiOverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './ink/OverlayFrame';
import { OverlayListRow, OverlaySection } from './ink/OverlayPrimitives';
import type { TuiPermissionSnapshot } from './permissions';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';

const modes = ['accept_edits', 'auto', 'full'] as const;
const modeLabels = {
  accept_edits: '请求批准',
  auto: '自动审核',
  full: '完全访问',
} as const;
type Choice =
  | { kind: 'mode'; mode: (typeof modes)[number]; makeDefault: boolean }
  | { kind: 'trust'; trusted: boolean }
  | { kind: 'clear' };
export function TuiPermissionPanel({ controller }: { controller: TuiController }) {
  const { t: originalLabel, language: inkLanguage } = useInkI18n();
  const { t, testDiagnostics } = useTuiPresentation();
  const state = controller.state,
    observed = state.permissions;
  const [index, setIndex] = useState(0),
    [makeDefault, setDefault] = useState(false),
    [pending, setPending] = useState<{ choice: Choice; observed: TuiPermissionSnapshot }>();
  const observedMode = observed?.mode.mode;
  useEffect(() => {
    if (observedMode) setIndex(Math.max(0, modes.indexOf(observedMode)));
  }, [observedMode]);
  useEffect(() => {
    if (
      pending &&
      (!observed ||
        JSON.stringify(pending.observed.mode) !== JSON.stringify(observed.mode) ||
        JSON.stringify(pending.observed.trust) !== JSON.stringify(observed.trust) ||
        pending.observed.grants.revision !== observed.grants.revision)
    )
      setPending(undefined);
  }, [observed, pending]);
  const descriptions = {
    accept_edits: t(
      'Workspace writes are allowed. External writes and internet access require approval.',
    ),
    auto: t('The model reviews commands and denies unsafe operations with a reason.'),
    full: t('Access files and the network freely; extremely dangerous operations remain denied.'),
  };
  useInput((input, key) => {
    if (key.ctrl) return;
    if (key.escape) {
      if (pending) setPending(undefined);
      else controller.closePanel();
      return;
    }
    if (input === 'r') {
      setPending(undefined);
      void controller.openPermissions();
      return;
    }
    if (input === 'k') {
      void controller.lookupPermission();
      return;
    }
    if (!observed) return;
    if (pending) {
      if (key.return) {
        void controller.choosePermission(pending.choice, pending.observed);
        setPending(undefined);
      }
      return;
    }
    if (key.upArrow) setIndex((i) => (i + modes.length - 1) % modes.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % modes.length);
    else if (input === 'd') setDefault((v) => !v);
    else if (input === 't' || input === 'u')
      setPending({ choice: { kind: 'trust', trusted: input === 't' }, observed });
    else if (input === 'c') setPending({ choice: { kind: 'clear' }, observed });
    else if (key.return)
      setPending({ choice: { kind: 'mode', mode: modes[index]!, makeDefault }, observed });
  });
  return (
    <TuiOverlayFrame
      title={
        <>
          {t('Permissions · original Session')}{' '}
          {testDiagnostics && terminalText(state.sessionId ?? t('unavailable'))}
        </>
      }
      meta={`${index + 1} / ${modes.length}`}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: originalLabel('common.select') },
            { keys: 'Enter', label: originalLabel('common.confirm') },
            { keys: 'C', label: t('Clear Session grants') },
            { keys: 'R', label: t('Refresh') },
            { keys: 'Esc', label: originalLabel('common.close') },
          ]}
        />
      }
    >
      {!observed ? (
        <Text>{t('Reading actual permission controls')}</Text>
      ) : (
        <>
          <Text>
            {t('Mode')} {modeLabels[observed.mode.mode]}{' '}
            {testDiagnostics && `(${observed.mode.mode})`}{' '}
            {testDiagnostics && (
              <>
                {t('revision')} {observed.mode.revision} {t('· scope')}{' '}
                {terminalText(observed.mode.scopeSessionId)}{' '}
              </>
            )}
            {t('· default')} {modeLabels[observed.mode.defaultMode]}{' '}
            {testDiagnostics && `(${observed.mode.defaultMode})`}{' '}
            {testDiagnostics && (
              <>
                {t('revision')} {observed.mode.defaultRevision}
              </>
            )}
          </Text>
          {modes.map((mode, i) => (
            <OverlayListRow
              key={mode}
              selected={i === index}
              primary={modeLabels[mode]}
              secondary={descriptions[mode]}
              trailing={
                <OverlayStatusColumn
                  active={mode === observed.mode.mode}
                  label={inkLanguage === 'zh-CN' ? '当前' : 'Current'}
                />
              }
            />
          ))}
          <Text>
            {t('Future Session default:')} {makeDefault ? t('yes') : t('no')}{' '}
            {t('· D toggle · Enter review mode choice')}
          </Text>
          <OverlaySection>{t('Workspace trust')}</OverlaySection>
          <Text>
            {t('Workspace')} {testDiagnostics && terminalText(observed.trust.workspaceId)}
            {':'} {observed.trust.status}
            {testDiagnostics && (
              <>
                {t(', revision')} {observed.trust.revision}
              </>
            )}
          </Text>
          <Text>
            {t('Identity')} {observed.trust.canonicalIdentity}{' '}
            {testDiagnostics && (
              <>
                {t('· read scope')} {observed.trust.externalReadScopeDigest}
              </>
            )}
          </Text>
          {observed.trust.readScopes.map((scope, i) => (
            <Text key={i}>
              {terminalText(scope.kind)}
              {':'} {terminalText(scope.description)}
            </Text>
          ))}
          <Text>{t('T review trust / U review untrust · trust does not approve every Tool')}</Text>
          <Text>
            {t('Saved same_command grants:')} {observed.grants.items.length}{' '}
            {testDiagnostics && (
              <>
                {t('· revision')} {observed.grants.revision} {t('· frozen upper')}{' '}
                {observed.grants.upperSeq}
              </>
            )}
          </Text>
          {testDiagnostics &&
            observed.grants.items.map(({ grant }) => (
              <Text key={grant.id}>{terminalText(JSON.stringify(grant))}</Text>
            ))}
          <Text>
            {t(
              'C review clear this exact Session only; earlier effects remain · R refresh · K original outcome lookup · Esc close',
            )}
          </Text>
        </>
      )}
      {pending && (
        <Text color="yellow">
          {t('Confirm original')}{' '}
          {testDiagnostics
            ? terminalText(JSON.stringify(pending.choice))
            : pending.choice.kind === 'mode'
              ? `${modeLabels[pending.choice.mode]} · ${t('Future Session default:')} ${t(pending.choice.makeDefault ? 'yes' : 'no')}`
              : pending.choice.kind === 'trust'
                ? t(pending.choice.trusted ? 'Trust' : 'Untrust')
                : t('Saved same_command grants:') + ' 0'}{' '}
          {t('· Enter explicitly submits · Esc leaves unchanged')}
        </Text>
      )}
      {state.permissionOutcome && (
        <Text>
          {t('Original permission')}{' '}
          {testDiagnostics && terminalText(state.permissionOutcome.intent.request.commandId)}{' '}
          {state.permissionOutcome.intent.kind}
          {':'} {state.permissionOutcome.status} {t('(control saved is not dispatch success)')}
        </Text>
      )}
    </TuiOverlayFrame>
  );
}
