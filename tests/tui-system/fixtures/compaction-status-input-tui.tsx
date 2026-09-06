import { render, Text } from 'ink';
import React from 'react';
import App, {
  type Action,
  createInitialState,
  eventReducer,
  shouldDisablePromptInput,
} from '#kite-cli/tui/App';
import InputLine from '#kite-cli/tui/components/InputLine';
import { TuiUserInputProvider } from '#kite-cli/tui/provider';
import type { TuiState } from '#kite-cli/tui/types';

type CompactionSource = 'manual' | 'automatic';

function withModelName(state: TuiState): TuiState {
  return {
    ...state,
    status: {
      ...state.status,
      modelProvider: 'mock',
      modelName: 'mock-model',
    },
  };
}

function messageEnvelope(messageId: string, text: string) {
  return {
    sessionId: 'compaction-status-fixture',
    connectionGeneration: 1,
    durability: 'durable' as const,
    revision: 1,
    turnId: 'compaction-turn',
    event: { type: 'user.message' as const, messageId, kind: 'task' as const, text },
  };
}

function manualCompactionState(): TuiState {
  let state = withModelName(createInitialState());
  state = eventReducer(state, {
    type: 'ACCEPT_PRESENTATION_ENVELOPE',
    event: messageEnvelope('manual-command', '/compact'),
  });
  return eventReducer(state, {
    type: 'SET_COMPACTION_PROGRESS',
    phase: 'summarizing',
    source: 'manual',
  });
}

function automaticCompactionState(): TuiState {
  let state = eventReducer(withModelName(createInitialState()), { type: 'SET_RUNNING' });
  state = eventReducer(state, {
    type: 'ACCEPT_PRESENTATION_ENVELOPE',
    event: messageEnvelope('automatic-command', '/auto-compact'),
  });
  return eventReducer(state, {
    type: 'SET_COMPACTION_PROGRESS',
    phase: 'summarizing',
    source: 'automatic',
  });
}

const provider = new TuiUserInputProvider();
const noopDispatch = (_action: Action) => {};

function CompactionStatusInputFixture() {
  const [source, setSource] = React.useState<CompactionSource>('manual');
  const [automaticSubmitted, setAutomaticSubmitted] = React.useState(false);
  const state = source === 'manual' ? manualCompactionState() : automaticCompactionState();

  return (
    <App
      state={state}
      dispatch={noopDispatch}
      onToggleReason={() => {}}
      provider={provider}
      workspace={process.cwd()}
    >
      <InputLine
        key={source}
        mode="prompt"
        onSubmit={() => {
          if (source === 'manual') setSource('automatic');
          else setAutomaticSubmitted(true);
        }}
        disabled={shouldDisablePromptInput(state)}
        workspace={process.cwd()}
      />
      {automaticSubmitted && <Text>Automatic input submitted</Text>}
    </App>
  );
}

render(<CompactionStatusInputFixture />, {
  // Ink treats every CI process as non-interactive by default, even when the
  // fixture owns a real PTY. Match the production composition root so state
  // updates and the live prompt are flushed before process teardown.
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
});
