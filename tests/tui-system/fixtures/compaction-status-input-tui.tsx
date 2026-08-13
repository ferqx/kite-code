import { render, Text } from 'ink';
import React from 'react';
import App, {
  type Action,
  createInitialState,
  eventReducer,
  shouldDisablePromptInput,
} from '@/app/tui/App';
import InputLine from '@/app/tui/components/InputLine';
import { TuiUserInputProvider } from '@/app/tui/provider';
import type { TuiState } from '@/app/tui/types';

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

function manualCompactionState(): TuiState {
  let state = withModelName(createInitialState());
  state = eventReducer(state, {
    type: 'RUNTIME_EVENT',
    event: {
      type: 'user.command_invoked',
      commandId: 'manual-command',
      command: '/compact',
    },
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
    type: 'RUNTIME_EVENT',
    event: {
      type: 'context.compaction_requested',
      compactionId: 'automatic-command',
      reason: 'auto',
      requestedAtRevision: 1,
      requestedAtTurnId: 'turn-1',
      force: false,
      estimate: {
        systemTokens: 0,
        toolSchemaTokens: 0,
        transcriptTokens: 0,
        summaryTokens: 0,
        dynamicRuntimeTokens: 0,
        framingTokens: 0,
        totalInputTokens: 0,
      },
    },
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
