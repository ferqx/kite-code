import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { type Dispatch } from 'react';
import {
  dispatchTuiRewindRequest,
  type RewindDeps,
  useRunRewind,
} from '../../../../src/app/tui/hooks/useRewindHandler';
import { parseSlashCommand, useSlashCommand } from '../../../../src/app/tui/hooks/useSlashCommand';
import { createInitialState } from '../../../../src/app/tui/initialState';
import { eventReducer } from '../../../../src/app/tui/reducers';
import type { Action } from '../../../../src/app/tui/reducers/actions';
import { SessionManager } from '../../../../src/app/tui/session-manager';
import type { RewindScope } from '../../../../src/app/tui/types';
import type { AgentConfig } from '../../../../src/core/config';
import { createInitialRuntimeState, type RuntimeState } from '../../../../src/core/runtime/state';
import { createRuntimeStore, runtimeStorePathFor } from '../../../../src/core/runtime/store';
import {
  evaluateL1TuiRewindForkProjectionCorpusV1,
  type L1TuiRewindForkProjectionCaseObservationV1,
  type L1TuiRewindForkProjectionReportV1,
  l1TuiRewindForkProjectionObservationForCaseV1,
} from './l1-tui-rewind-projection-evaluator-v1';
import {
  buildL1TuiRewindForkProjectionEvaluatorIdentityV1,
  L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1,
  L1_TUI_REWIND_FORK_PROJECTION_FIXTURE_ID_V1,
  L1_TUI_REWIND_FORK_PROJECTION_RUNNER_ID_V1,
  type L1TuiRewindForkProjectionAdapterIdV1,
  type L1TuiRewindForkProjectionAdapterResultV1,
  type L1TuiRewindForkProjectionEvaluatorIdentityV1,
} from './l1-tui-rewind-projection-schema-v1';

export {
  L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1,
  L1_TUI_REWIND_FORK_PROJECTION_FIXTURE_ID_V1,
  L1_TUI_REWIND_FORK_PROJECTION_RUNNER_ID_V1,
} from './l1-tui-rewind-projection-schema-v1';

/** A fresh private root is allocated for every run and unconditionally removed. */
const L1_TUI_REWIND_FORK_PROJECTION_SYNTHETIC_ROOT_PREFIX_V1 =
  'kite-l1-tui-rewind-fork-projection-';
const FIXTURE_SOURCE_THREAD_ID_V1 = 'qualification-rewind-source';
const FIXTURE_CHECKPOINT_ID_V1 = 'qualification-rewind-checkpoint';

interface TuiRewindProjectionControlsV1 {
  handleSlashCommand: (input: string) => boolean;
  runRewind: (scope: RewindScope, snapshotId: string) => Promise<void>;
}

/**
 * This component exposes the callbacks returned by the real hooks. It does
 * not replace `runRewind`, the TUI dispatch bridge, or RuntimeStore behavior.
 */
function TuiRewindProjectionHarnessV1({
  deps,
  onReady,
}: {
  deps: RewindDeps;
  onReady: (controls: TuiRewindProjectionControlsV1) => void;
}): React.ReactNode {
  const handleSlashCommand = useSlashCommand(deps.dispatch);
  const { runRewind } = useRunRewind(deps);
  onReady({ handleSlashCommand, runRewind });
  return React.createElement(Text, null, 'qualification-rewind-harness');
}

function createFixtureRuntimeStateV1(threadId: string, workspace: string): RuntimeState {
  const state = createInitialRuntimeState({
    threadId,
    userId: 'qualification',
    workspace,
    interactionMode: 'full',
    authorizationMode: 'full_access',
    authorizationSource: 'test',
  });
  state.authorization.commandGrants = {
    'qualification-command-grant': {
      workspace,
      threadId,
      command: 'qualification-synthetic',
      source: 'test',
      grantedAt: '2026-08-06T00:00:00.000Z',
    },
  };
  state.capabilities.bindings = {
    qualification: {
      bindingId: 'qualification-capability-binding',
      capabilityId: 'mcp:qualification/read',
      capabilityRevision: 'qualification-v1',
      exposedToolName: 'mcp__qualification__read',
      schemaDigest: 'sha256:qualification',
      issuedForTurnId: state.turn.turnId,
    },
  };
  state.capabilities.disclosures = {
    qualification: {
      capabilityId: 'mcp:qualification/read',
      capabilityRevision: 'qualification-v1',
      issuedForTurnId: state.turn.turnId,
    },
  };
  state.providerAdmission.pending = [
    {
      interactionId: 'qualification-provider-admission',
      providerId: 'qualification-provider',
      source: 'explicit',
      providerStatus: 'login_required',
      retryable: true,
    },
  ];
  state.interactions = {
    kind: 'awaiting_provider_admission',
    ...state.providerAdmission.pending[0]!,
  };
  state.suspendedSubagents = {
    qualification: {
      subagentId: 'qualification-subagent',
      role: 'code',
      task: 'qualification-synthetic',
      messages: [],
      toolCallCount: 0,
      steps: [],
      blockedTool: {
        toolCallId: 'qualification-child-tool',
        toolName: 'read_file',
        args: {},
        command: 'qualification-synthetic',
      },
    },
  };
  state.subagentResumeClaims = {
    qualification: {
      claimId: 'qualification-resume-claim',
      subagentId: 'qualification-subagent',
      childToolCallId: 'qualification-child-tool',
      claimedAt: '2026-08-06T00:00:00.000Z',
    },
  };
  return state;
}

async function withSyntheticRootV1<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), L1_TUI_REWIND_FORK_PROJECTION_SYNTHETIC_ROOT_PREFIX_V1));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function forkStateIsTightenedV1(fork: RuntimeState | null, targetThreadId: string): boolean {
  return (
    fork !== null &&
    fork.session.threadId === targetThreadId &&
    fork.authorization.mode === 'default' &&
    Object.keys(fork.authorization.commandGrants).length === 0 &&
    fork.mode === 'accept_edits' &&
    Object.keys(fork.capabilities.bindings).length === 0 &&
    Object.keys(fork.capabilities.disclosures).length === 0 &&
    fork.providerAdmission.pending.length === 0 &&
    Object.keys(fork.providerAdmission.waivers).length === 0 &&
    fork.interactions.kind === 'idle' &&
    fork.tools.queue.length === 0 &&
    fork.tools.active.length === 0 &&
    Object.keys(fork.suspendedSubagents).length === 0 &&
    Object.keys(fork.subagentResumeClaims).length === 0
  );
}

/**
 * Exercises only this production path:
 * safe `/rewind` parse -> TUI dispatch bridge -> actual `useRunRewind` ->
 * RuntimeStore `forkSession`. The returned boolean is the sole observation.
 */
async function runTuiRewindForkProjectionV1(): Promise<boolean> {
  try {
    return await withSyntheticRootV1(async (root) => {
      const workspace = join(root, 'workspace');
      const checkpointPath = join(root, 'checkpoints.sqlite');
      const runtimeStorePath = runtimeStorePathFor(checkpointPath);
      const threadIdRef = {
        current: FIXTURE_SOURCE_THREAD_ID_V1,
      } as React.MutableRefObject<string>;
      const sessionManager = new SessionManager({
        config: { sandbox: { enabled: false } } as AgentConfig,
        provider: {} as never,
        skillManifests: [],
        skillOptions: null,
        mcpManager: null,
        checkpointPath,
      });
      let rendered: ReturnType<typeof render> | undefined;
      try {
        mkdirSync(workspace, { recursive: true });
        const store = createRuntimeStore(runtimeStorePath);
        try {
          const sourceState = createFixtureRuntimeStateV1(FIXTURE_SOURCE_THREAD_ID_V1, workspace);
          store.saveSnapshot(FIXTURE_SOURCE_THREAD_ID_V1, sourceState);
          store.saveNamedSnapshot(
            FIXTURE_SOURCE_THREAD_ID_V1,
            FIXTURE_CHECKPOINT_ID_V1,
            sourceState,
          );
        } finally {
          store.close();
        }

        sessionManager.registerSession(FIXTURE_SOURCE_THREAD_ID_V1, workspace).setForeground(true);
        let tuiState = createInitialState();
        const dispatch: Dispatch<Action> = (action) => {
          tuiState = eventReducer(tuiState, action);
        };
        const deps: RewindDeps = {
          dispatch,
          sessionManager,
          workspace,
          threadIdRef,
          checkpointPath,
        };
        let controls: TuiRewindProjectionControlsV1 | undefined;
        rendered = render(
          React.createElement(TuiRewindProjectionHarnessV1, {
            deps,
            onReady: (next) => {
              controls = next;
            },
          }),
        );

        if (
          parseSlashCommand('/rewind')?.type !== 'rewind' ||
          !controls?.handleSlashCommand('/rewind') ||
          !tuiState.showRewind
        ) {
          return false;
        }
        await dispatchTuiRewindRequest(
          dispatch,
          {
            type: 'EXECUTE_REWIND',
            checkpointId: FIXTURE_CHECKPOINT_ID_V1,
            scope: 'conversation_only',
          },
          controls.runRewind,
        );

        const targetThreadId = threadIdRef.current;
        if (
          targetThreadId === FIXTURE_SOURCE_THREAD_ID_V1 ||
          sessionManager.getActiveId() !== targetThreadId ||
          tuiState.activeSessionId !== targetThreadId ||
          tuiState.showRewind
        ) {
          return false;
        }
        const verificationStore = createRuntimeStore(runtimeStorePath);
        try {
          return forkStateIsTightenedV1(
            verificationStore.loadSnapshot<RuntimeState>(targetThreadId),
            targetThreadId,
          );
        } finally {
          verificationStore.close();
        }
      } finally {
        rendered?.unmount();
        sessionManager.dispose();
      }
    });
  } catch {
    // Never retain or expose a filesystem, fixture, source, or provider error.
    return false;
  }
}

function adapterResult(
  adapterId: L1TuiRewindForkProjectionAdapterIdV1,
  passed: boolean,
): L1TuiRewindForkProjectionAdapterResultV1 {
  const pair = L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1.find(
    (entry) => entry.adapterId === adapterId,
  );
  if (!pair) throw new Error(`unregistered_l1_tui_rewind_fork_projection_adapter:${adapterId}`);
  return { ...pair, outcome: passed ? 'passed' : 'failed' };
}

/** Runs the real isolated TUI rewind path and returns only the closed outcome token. */
export async function runL1TuiRewindForkProjectionAdaptersV1(): Promise<
  readonly L1TuiRewindForkProjectionAdapterResultV1[]
> {
  return [adapterResult('tui-rewind-fork-projection-v1', await runTuiRewindForkProjectionV1())];
}

export function buildL1TuiRewindForkProjectionEvaluatorV1(): L1TuiRewindForkProjectionEvaluatorIdentityV1 {
  return buildL1TuiRewindForkProjectionEvaluatorIdentityV1({
    oracle: {
      observedState: 'fork-authority-tightening-v1',
      retention: 'closed-outcome-token-only-v1',
    },
    verifier: {
      inventory: 'single-closed-pair-v1',
      result: 'state-cleanup-boolean-v1',
    },
    runner: {
      runner: L1_TUI_REWIND_FORK_PROJECTION_RUNNER_ID_V1,
      fixtureId: L1_TUI_REWIND_FORK_PROJECTION_FIXTURE_ID_V1,
      fixtureRoot: 'fresh-private-temporary-root-v1',
    },
    scheduler: {
      parser: 'parse-slash-command-v1',
      slashHook: 'use-slash-command-v1',
      dispatchBridge: 'dispatch-tui-rewind-request-v1',
      rewindHook: 'use-run-rewind-v1',
      store: 'runtime-store-fork-session-v1',
    },
    isolation: {
      network: 'not-used-v1',
      provider: 'not-used-v1',
      process: 'not-used-v1',
      workspace: 'fresh-private-temporary-root-v1',
    },
  });
}

/** Rebuilds the closed corpus from a new real hook-and-fork observation. */
export async function runL1TuiRewindForkProjectionContractCorpusV1(
  input: { evaluator?: L1TuiRewindForkProjectionEvaluatorIdentityV1 } = {},
): Promise<L1TuiRewindForkProjectionReportV1> {
  const results = await runL1TuiRewindForkProjectionAdaptersV1();
  const passed = results[0]?.outcome === 'passed';
  const observations: L1TuiRewindForkProjectionCaseObservationV1[] = [
    l1TuiRewindForkProjectionObservationForCaseV1('l1-tui-rewind-fork-projection-v1', passed),
  ];
  return evaluateL1TuiRewindForkProjectionCorpusV1({
    evaluator: input.evaluator ?? buildL1TuiRewindForkProjectionEvaluatorV1(),
    observations,
  });
}
