import { useInput } from 'ink';
import { useState } from 'react';
import { TuiOverlayFrame } from './chrome';
import { type TuiController, terminalText } from './controller';
import type { TuiPermissionSnapshot } from './permissions';
import { TuiText as Text, useTuiPresentation } from './presentation';

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
  const { t, testDiagnostics } = useTuiPresentation();
  const state = controller.state,
    observed = state.permissions;
  const [index, setIndex] = useState(0),
    [makeDefault, setDefault] = useState(false),
    [pending, setPending] = useState<{ choice: Choice; observed: TuiPermissionSnapshot }>();
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
            <Text key={mode}>
              {i === index ? '›' : ' '} {modeLabels[mode]}
            </Text>
          ))}
          <Text>
            {t('Future Session default:')} {makeDefault ? t('yes') : t('no')}{' '}
            {t('· D toggle · Enter review mode choice')}
          </Text>
          <Text>
            {t('Workspace')} {terminalText(observed.trust.workspaceId)}
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
          {observed.grants.items.map(({ grant }) => (
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
