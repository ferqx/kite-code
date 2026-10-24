import { Box, useInput, useStdout } from 'ink';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { TuiChildSessionPanel } from './child-session-panel';
import { TuiOverlayFrame } from './chrome';
import { type TuiController, terminalText } from './controller';
import { inkToolArguments } from './execution-projection';
import { TuiText as Text, useTuiPresentation } from './presentation';
import { TuiResult } from './result';

export function TuiExecutionPanel({
  controller,
  initialExecutionId,
}: {
  controller: TuiController;
  initialExecutionId?: string;
}) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  const { t, testDiagnostics } = useTuiPresentation();
  const { stdout } = useStdout();
  const jobs =
    state.snapshot?.view.executions.filter(
      (execution) => execution.kind !== 'model' && execution.sessionId === state.sessionId,
    ) ?? [];
  const [selected, setSelected] = useState<string | undefined>(initialExecutionId),
    [confirm, setConfirm] = useState<string>(),
    [childDetail, setChildDetail] = useState(false);
  useEffect(() => {
    void state.sessionId;
    setSelected(initialExecutionId);
    setConfirm(undefined);
    setChildDetail(false);
  }, [initialExecutionId, state.sessionId]);
  const index = Math.max(
      0,
      jobs.findIndex((job) => job.id === selected),
    ),
    job = jobs[index];
  const page = Math.max(1, Math.min(10, (stdout.rows || 24) - 15));
  const start = Math.max(0, Math.min(jobs.length - page, index - Math.floor(page / 2)));
  useInput((input, key) => {
    if (childDetail) return;
    if (key.escape || (key.ctrl && input === 'c')) {
      controller.closePanel();
      return;
    }
    if (key.upArrow || key.downArrow) {
      setConfirm(undefined);
      setSelected((current) => {
        const at = Math.max(
          0,
          jobs.findIndex((item) => item.id === current),
        );
        return jobs[Math.max(0, Math.min(jobs.length - 1, at + (key.downArrow ? 1 : -1)))]?.id;
      });
      return;
    }
    if (input.toLowerCase() === 'r') {
      const id = state.sessionId;
      if (id) void controller.select(id);
      return;
    }
    if (!job) return;
    if (
      input.toLowerCase() === 's' &&
      job.kind === 'job' &&
      job.originStoreId === state.snapshot?.storeId &&
      ['planned', 'dispatching', 'running'].includes(job.status) &&
      job.cancelRequestedAt === null &&
      !state.stale
    ) {
      setConfirm(job.id);
      return;
    }
    if (key.return && confirm) {
      setConfirm(undefined);
      if (
        confirm === job.id &&
        job.kind === 'job' &&
        job.originStoreId === state.snapshot?.storeId &&
        ['planned', 'dispatching', 'running'].includes(job.status) &&
        job.cancelRequestedAt === null &&
        !state.stale
      )
        void controller.stopJob(confirm);
      return;
    }
    if (
      job.kind === 'job' &&
      (input.toLowerCase() === 'o' || (key.return && !job.childSessionId))
    ) {
      void controller.readExecution(job.id, false);
      return;
    }
    if (job.kind === 'job' && job.childSessionId && (input.toLowerCase() === 'c' || key.return)) {
      void controller.readExecution(job.id, true);
    }
  });
  const originalRead = state.executionReading;
  const reading =
    job?.kind === 'job' &&
    originalRead &&
    originalRead.target.executionId === job.id &&
    originalRead.target.sessionId === job.sessionId &&
    originalRead.target.originStoreId === job.originStoreId &&
    originalRead.target.definitionId === job.definitionId &&
    originalRead.target.definitionVersion === job.definitionVersion
      ? originalRead
      : undefined;
  useEffect(() => {
    if (reading?.phase === 'ready' && reading.child) setChildDetail(true);
  }, [reading]);
  if (childDetail && reading?.child)
    return (
      <TuiChildSessionPanel
        key={`${reading.child.view.session.id}/${reading.child.view.session.nextSeq}`}
        child={reading.child}
        onBack={() => setChildDetail(false)}
        onRefresh={() => void controller.readExecution(reading.target.executionId, true)}
      />
    );
  return (
    <TuiOverlayFrame
      title={
        testDiagnostics
          ? `${t('Original background Jobs · Session')} ${terminalText(state.sessionId ?? t('unavailable'))}`
          : t('Execution details')
      }
    >
      <Text>
        {t(
          'Up/Down target · O complete recorded output · C child logs · S then Enter stop original Job · R refresh · Esc/Ctrl+C close reader',
        )}
      </Text>
      {jobs.slice(start, start + page).map((item, offset) => (
        <Text key={item.id}>
          {index === start + offset ? '› ' : '  '}
          {terminalText(item.definitionId)} {testDiagnostics && <>[{terminalText(item.id)}] </>}
          {testDiagnostics ? item.status : t(item.status)}
          {typeof item.originStoreId !== 'string'
            ? t(' · origin unavailable; read only')
            : item.originStoreId !== state.snapshot?.storeId
              ? t(' · restored history; read only')
              : ''}
          {item.cancelRequestedAt === null ? '' : t(' · cancel requested; cleanup not confirmed')}
        </Text>
      ))}
      {jobs.length > 0 && (
        <Text dimColor>
          {index + 1}/{jobs.length}
        </Text>
      )}
      {!jobs.length && <Text>{t('No verified execution in the current snapshot')}</Text>}
      {job?.kind === 'tool' &&
        state.snapshot &&
        inkToolArguments(job, state.snapshot, state.loadedOutputBodies) && (
          <Box flexDirection="column">
            <Text bold>{t('Recorded tool arguments')}</Text>
            <TuiResult
              value={
                inkToolArguments(
                  job,
                  state.snapshot,
                  state.loadedOutputBodies,
                )! as import('@kite-ai/client').Execution['result']
              }
            />
          </Box>
        )}
      {job && (
        <Box flexDirection="column">
          <Text bold>{t('Recorded execution result')}</Text>
          <TuiResult value={job.result} />
        </Box>
      )}
      {job?.kind === 'tool' && (
        <Text dimColor>
          {t(
            'Tool result is read only; background output and child navigation require an exact Job',
          )}
        </Text>
      )}
      {confirm && (
        <Text bold>
          {t('Confirm stop original Job')} {testDiagnostics && <>[{terminalText(confirm)}]</>}
          {t(' · Enter submits once; Esc closes')}
        </Text>
      )}
      {[...state.jobStops.values()].map((intent) => (
        <Text key={intent.request.commandId}>
          {testDiagnostics ? (
            <>
              {t('Original')} {terminalText(intent.target.storeId)} /{' '}
              {terminalText(intent.target.sessionId)} / Job{' '}
              {terminalText(intent.target.executionId)} {t('/ stop Command')}{' '}
              {terminalText(intent.request.commandId)}:
            </>
          ) : (
            t('Stop request')
          )}{' '}
          {intent.phase}
          {intent.phase === 'applied' ? t(' · cancel requested; await actual Job terminal') : ''}
        </Text>
      ))}
      {state.stale && <Text>{t('Observation unknown: new stop requests disabled')}</Text>}
      {state.error && <Text>{terminalText(state.error)}</Text>}
      {reading && (
        <Text>
          {t('Original read')}{' '}
          {testDiagnostics && <>[{terminalText(reading.target.executionId)}]</>}: {reading.phase}
          {reading.error ? ` · ${terminalText(reading.error)}` : ''}
        </Text>
      )}
      {reading?.output && (
        <Box flexDirection="column">
          <Text>
            {testDiagnostics ? (
              <>
                {t('Recorded output through')} {reading.output.highWaterSeq}
              </>
            ) : (
              t('Verified recorded output')
            )}
            {t('; gaps remain unavailable')}
          </Text>
          {reading.output.items.map((item, i) => (
            <Box key={i} flexDirection="column">
              <Text>
                {item.stream}
                {testDiagnostics && (
                  <>
                    {' '}
                    · {item.seq}…{item.throughSeq}
                  </>
                )}
                {item.droppedBytes === null
                  ? t(' · dropped bytes unavailable')
                  : item.droppedBytes !== '0'
                    ? ` · ${t('dropped')} ${item.droppedBytes} ${t('bytes')}`
                    : ''}
              </Text>
              {item.content !== '' && <Text>{terminalText(item.content)}</Text>}
            </Box>
          ))}
        </Box>
      )}
      {reading?.child && (
        <Text dimColor>{t('Child conversation')} · read-only history · C reopens the reader</Text>
      )}
    </TuiOverlayFrame>
  );
}
