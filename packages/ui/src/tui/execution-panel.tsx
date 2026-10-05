import { Box, useInput } from 'ink';
import { useState, useSyncExternalStore } from 'react';
import { type TuiController, terminalText } from './controller';
import { TerminalMarkdown } from './markdown';
import { TuiText as Text } from './presentation';

export function TuiExecutionPanel({ controller }: { controller: TuiController }) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  const jobs =
    state.snapshot?.view.executions.filter(
      (execution) =>
        execution.kind === 'job' &&
        execution.sessionId === state.sessionId &&
        execution.originStoreId === state.snapshot?.storeId,
    ) ?? [];
  const [selected, setSelected] = useState<string>(),
    [confirm, setConfirm] = useState<string>();
  const index = Math.max(
      0,
      jobs.findIndex((job) => job.id === selected),
    ),
    job = jobs[index];
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      controller.closePanel();
      return;
    }
    if (key.ctrl && input === 'l') {
      void controller.lookup();
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
    if (input.toLowerCase() === 's') {
      setConfirm(job.id);
      return;
    }
    if (key.return && confirm) {
      setConfirm(undefined);
      if (confirm === job.id) void controller.stopJob(confirm);
      return;
    }
    if (input.toLowerCase() === 'o' || (key.return && !job.childSessionId)) {
      void controller.readExecution(job.id, false);
      return;
    }
    if (input.toLowerCase() === 'c' || (key.return && job.childSessionId)) {
      void controller.readExecution(job.id, true);
    }
  });
  const reading = state.executionReading;
  return (
    <Box flexDirection="column">
      <Text bold>
        Original background Jobs · Session {terminalText(state.sessionId ?? 'unavailable')}
      </Text>
      <Text>
        Up/Down target · O complete recorded output · C child logs · S then Enter stop original Job
        · R refresh · Ctrl+L original receipt · Esc/Ctrl+C close reader
      </Text>
      {jobs.map((item, i) => (
        <Text key={item.id}>
          {index === i ? '› ' : '  '}
          {terminalText(item.definitionId)} [{terminalText(item.id)}] {item.status}
          {item.cancelRequestedAt === null ? '' : ' · cancel requested; cleanup not confirmed'}
        </Text>
      ))}
      {!jobs.length && <Text>No verified Job in the current snapshot</Text>}
      {confirm && (
        <Text bold>
          Confirm stop original Job [{terminalText(confirm)}] · Enter submits once; Esc closes
        </Text>
      )}
      {[...state.jobStops.values()].map((intent) => (
        <Text key={intent.request.commandId}>
          Original {terminalText(intent.target.storeId)} / {terminalText(intent.target.sessionId)} /
          Job {terminalText(intent.target.executionId)} / stop Command{' '}
          {terminalText(intent.request.commandId)}: {intent.phase}
          {intent.phase === 'applied' ? ' · cancel requested; await actual Job terminal' : ''}
        </Text>
      ))}
      {state.stale && <Text>Observation unknown: new stop requests disabled</Text>}
      {state.error && <Text>{terminalText(state.error)}</Text>}
      {reading && (
        <Text>
          Original read [{terminalText(reading.target.executionId)}]: {reading.phase}
          {reading.error ? ' · ' + terminalText(reading.error) : ''}
        </Text>
      )}
      {reading?.output && (
        <Box flexDirection="column">
          <Text>
            Recorded output through {reading.output.highWaterSeq}; gaps remain unavailable
          </Text>
          {reading.output.items.map((item, i) => (
            <Box key={i} flexDirection="column">
              <Text>
                {item.stream} · {item.seq}…{item.throughSeq}
                {item.droppedBytes === null
                  ? ' · dropped bytes unavailable'
                  : item.droppedBytes !== '0'
                    ? ` · dropped ${item.droppedBytes} bytes`
                    : ''}
              </Text>
              {item.content !== '' && <Text>{terminalText(item.content)}</Text>}
            </Box>
          ))}
        </Box>
      )}
      {reading?.child && (
        <Box flexDirection="column">
          <Text bold>
            Original child [{terminalText(reading.child.view.session.id)}] · parent carrier [
            {terminalText(reading.child.carrier.id)}] · selection{' '}
            {terminalText(reading.child.view.session.contextSelectionId)} · frozen history through{' '}
            {reading.child.view.session.nextSeq}
          </Text>
          {reading.child.messages.map((message) => {
            const full = reading.child!.modelOutputs.get(message.id);
            return (
              <Box key={message.id} flexDirection="column">
                <Text>
                  {message.role} [{terminalText(message.id)}] · seq {message.seq} · {message.status}
                </Text>
                <TerminalMarkdown content={full?.output.content ?? message.content} />
                {message.toolCallId && (
                  <Text>Original tool call [{terminalText(message.toolCallId)}]</Text>
                )}
                {!full && message.toolCalls && (
                  <Text>{terminalText(JSON.stringify(message.toolCalls))}</Text>
                )}
                {full && (
                  <>
                    <Text>
                      Verified recorded Model body · {full.contentBytes} content bytes ·{' '}
                      {full.output.complete ? 'complete' : 'incomplete recorded prefix'}
                    </Text>
                    <Text>{terminalText(full.output.reasoning)}</Text>
                    <Text>{terminalText(JSON.stringify(full.output.toolCalls))}</Text>
                  </>
                )}
                {message.outputBody && !full && (
                  <Text>Full Model reader unsupported; showing original message projection</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
