import { Box } from 'ink';
import { activity, type TuiController, terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';

/** Explicit fields only: never stringify a diagnostic object into the terminal. */
export function TuiStatusPanel({ controller }: { controller: TuiController }) {
  const { t } = useTuiPresentation();
  const state = controller.state,
    status = state.status,
    facts = status?.facts;
  const host = controller.statusHost;
  const run = state.snapshot?.view.runs.find((value) => value.isActive);
  const execution = state.snapshot?.view.executions.find((value) =>
    ['planned', 'dispatching', 'running', 'outcome_unknown'].includes(value.status),
  );
  return (
    <Box flexDirection="column">
      <Text>{t('Host status · Esc back · R refresh')}</Text>
      <Text>
        {t('Connection:')} {status?.connection ?? 'unknown'} {'·'} {host?.mode ?? 'unknown'}{' '}
        {t('· Profile:')} {terminalText(host?.profile ?? 'unknown')}
      </Text>
      <Text>
        {t('Observation:')} {state.observationState} {t('· Session snapshot:')}{' '}
        {state.snapshotStale ? 'unknown' : 'confirmed'}
      </Text>
      {facts ? (
        <>
          <Text>
            {status?.connection === 'verified'
              ? t('Confirmed host facts')
              : t('Last confirmed host facts (current unknown)')}
          </Text>
          <Text>
            {t('Build:')} {terminalText(facts.identity.buildId)} {t('· API:')}{' '}
            {facts.identity.apiMajor}
          </Text>
          <Text>
            {t('Instance:')} {terminalText(facts.identity.instanceId)}
          </Text>
          <Text>
            {t('Store:')} {terminalText(facts.identity.storeId ?? t('unavailable'))} {t('· Data:')}{' '}
            {facts.identity.dataAvailability}
          </Text>
          <Text>
            {t('Workspace:')} {terminalText(facts.scope.workspaceId ?? 'unbound')} {t('· Session:')}{' '}
            {terminalText(facts.scope.sessionId ?? 'unbound')}
          </Text>
          <Text>
            {t('Execution host:')} {facts.execution.state} {t('· Last Session snapshot:')}{' '}
            {t(activity(state.snapshot))}
          </Text>
          <Text>
            {t('Active Run:')}{' '}
            {run ? `${terminalText(run.id)} / ${run.status}` : t('none in snapshot')}
          </Text>
          <Text>
            {t('Unsettled execution:')}{' '}
            {execution
              ? `${terminalText(execution.id)} / ${execution.kind} / ${execution.status}`
              : t('none in snapshot')}
          </Text>
          <Text>
            {t('Sandbox:')} {facts.execution.sandbox.backend} {'/'}{' '}
            {facts.execution.sandbox.qualification}
          </Text>
          <Text>
            {t('Shell:')} {facts.execution.shell.available ? t('available') : t('unavailable')}{' '}
            {'/'} {facts.execution.shell.supervision} {'/'} {facts.execution.shell.qualification}
          </Text>
          <Text>
            {t('Permissions:')} {facts.execution.permissions.state} {'/'}{' '}
            {facts.execution.permissions.mode ?? 'unbound'} {t('· Trust:')}{' '}
            {facts.execution.permissions.workspaceTrust}
          </Text>
          <Text>
            {t('Release:')} {facts.release.state} {'/'} {facts.release.qualification} {'·'}{' '}
            {facts.release.reason}
          </Text>
          <Text>
            {t('Telemetry: disabled ·')} {facts.telemetry.state} {'/'} {facts.telemetry.reason}
          </Text>
        </>
      ) : (
        <Text>{t('No confirmed host facts')}</Text>
      )}
      {status?.error && (
        <Text>{t('Current host status unknown; refresh to verify original host')}</Text>
      )}
    </Box>
  );
}
