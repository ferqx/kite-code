import { Box, useInput, usePaste } from 'ink';
import { useState, useSyncExternalStore } from 'react';
import { callerKey } from './caller';
import { type TuiController, terminalText } from './controller';
import { TuiText as Text } from './presentation';

export function TuiRecoveryPanel({ controller }: { controller: TuiController }) {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState(0);
  const [showRequest, setShowRequest] = useState(false);
  const callers = [...state.callers.values()];
  const caller = callers[Math.min(selected, Math.max(0, callers.length - 1))];
  const cancelRead = () => {
    controller.cancelCallerRead();
    controller.cancelRecoveryRead();
  };
  const lookupOriginal = () => {
    if (caller) void controller.lookupCaller(callerKey(caller.intent));
    else void controller.lookup();
  };
  usePaste((input) => setText((previous) => previous + input));
  useInput((input, key) => {
    // Ink can group native control bytes; bracketed paste uses the separate hook above.
    if (
      input.length > 1 &&
      [...input].every((control) => control === '\u0003' || control === '\u000c')
    ) {
      for (const control of input) {
        if (control === '\u0003') cancelRead();
        else lookupOriginal();
      }
      return;
    }
    if (key.escape) {
      controller.closePanel();
      return;
    }
    if (key.ctrl && input === 'c') {
      cancelRead();
      return;
    }
    if (key.ctrl && input === 'l') {
      lookupOriginal();
      return;
    }
    if (!text && callers.length && (key.upArrow || key.downArrow)) {
      setSelected((n) => Math.max(0, Math.min(callers.length - 1, n + (key.downArrow ? 1 : -1))));
      setShowRequest(false);
      return;
    }
    if (key.ctrl && input === 'v') {
      setShowRequest((v) => !v);
      return;
    }
    if (key.ctrl && input === 'd' && caller) {
      void controller.clearCaller(callerKey(caller.intent));
      return;
    }
    if (key.return) {
      const match = /^(run|report|interrupt) ([A-Za-z0-9_-]{1,128})$/.exec(text);
      if (match) {
        void controller.submitRecovery(match[1] as 'run' | 'report' | 'interrupt', match[2]!);
        setText('');
      }
      return;
    }
    if (key.backspace || key.delete) setText(text.slice(0, -1));
    else if (!key.ctrl && !key.meta) setText(text + input);
  });
  return (
    <Box flexDirection="column">
      <Text>Explicit recovery · {terminalText(state.sessionId ?? '')}</Text>
      <Text>run &lt;original Run ID&gt; / report &lt;original report Command ID&gt;</Text>
      <Text>
        interrupt confirm: explicitly interrupt this root Session's orphan execution group; unknown
        effects remain unknown.
      </Text>
      <Text>
        Enter submits once; Ctrl+L checks the original request; Ctrl+C stops this read; Esc closes.
      </Text>
      <Text>{terminalText(text)}</Text>
      {callers.length > 0 && (
        <>
          <Text>
            Saved caller intents {callers.length} · ↑/↓ select · Ctrl+L original GET · Ctrl+V full
            frozen request · Ctrl+D clear confirmed caller only
          </Text>
          {callers.slice(Math.max(0, selected - 2), selected + 3).map((row) => (
            <Text key={callerKey(row.intent)}>
              {row === caller ? '› ' : '  '}
              {terminalText(row.intent.request.kind)} · {row.phase} ·{' '}
              {terminalText(row.intent.request.commandId)}
            </Text>
          ))}
          {caller && (
            <>
              <Text>
                Original Store {terminalText(caller.intent.scope.storeId)} · Workspace{' '}
                {terminalText(caller.intent.scope.workspaceId)} · Session{' '}
                {terminalText(caller.intent.scope.sessionId)}
              </Text>
              <Text>
                Subject {terminalText(caller.intent.subjectId)} · target{' '}
                {terminalText(JSON.stringify(caller.intent.target))}
              </Text>
              <Text>Request SHA {caller.intent.requestDigest}</Text>
              <Text>
                {caller.intent.request.kind === 'execution.cancel' ||
                caller.intent.request.kind === 'command.cancel'
                  ? 'applied means cancellation requested; actual termination is separate'
                  : 'applied means original Command applied; actual Run result is separate'}
              </Text>
              {showRequest && <Text>{terminalText(JSON.stringify(caller.intent.request))}</Text>}
            </>
          )}
        </>
      )}
      {state.callerUnavailable && (
        <Text>Caller journal unavailable: {terminalText(state.callerUnavailable)}</Text>
      )}
      {state.recovery && (
        <>
          <Text>
            {state.recovery.intent.kind} · {state.recovery.status}
          </Text>
          <Text>
            Original Session {terminalText(state.recovery.intent.sessionId)} · Command{' '}
            {terminalText(state.recovery.intent.request.commandId)}
          </Text>
          {state.recovery.run && (
            <Text>
              Original result Run {terminalText(state.recovery.run.id)} ·{' '}
              {state.recovery.run.status}
            </Text>
          )}
          <Text>{terminalText(state.recovery.error ?? '')}</Text>
        </>
      )}
      {state.error && <Text>{terminalText(state.error)}</Text>}
    </Box>
  );
}
