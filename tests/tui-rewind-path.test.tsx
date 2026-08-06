import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type React from 'react';
import type { Dispatch } from 'react';
import { createInitialState, eventReducer } from '../src/app/tui/App';
import {
  dispatchTuiRewindRequest,
  type RewindDeps,
  useRunRewind,
} from '../src/app/tui/hooks/useRewindHandler';
import { parseSlashCommand, useSlashCommand } from '../src/app/tui/hooks/useSlashCommand';
import type { Action } from '../src/app/tui/reducers/actions';
import { SessionManager } from '../src/app/tui/session-manager';
import type { RewindScope } from '../src/app/tui/types';
import type { AgentConfig } from '../src/core/config';
import { createInitialRuntimeState, type RuntimeState } from '../src/core/runtime/state';
import { createRuntimeStore, runtimeStorePathFor } from '../src/core/runtime/store';

interface RewindPathControls {
  handleSlashCommand: (input: string) => boolean;
  runRewind: (scope: RewindScope, snapshotId: string) => Promise<void>;
}

function RewindPathHarness({
  deps,
  onReady,
}: {
  deps: RewindDeps;
  onReady: (controls: RewindPathControls) => void;
}) {
  const handleSlashCommand = useSlashCommand(deps.dispatch);
  const { runRewind } = useRunRewind(deps);
  onReady({ handleSlashCommand, runRewind });
  return <Text>rewind-path-harness</Text>;
}

function seedAuthorizedRewindSnapshot(threadId: string, workspace: string): RuntimeState {
  const state = createInitialRuntimeState({
    threadId,
    userId: 'tui-diagnostic',
    workspace,
    interactionMode: 'full',
    authorizationMode: 'full_access',
    authorizationSource: 'test',
  });
  state.authorization.commandGrants = {
    'fixture-command-grant': {
      workspace,
      threadId,
      command: 'fixture-only',
      source: 'test',
      grantedAt: '2026-08-06T00:00:00.000Z',
    },
  };
  state.capabilities.bindings = {
    inherited: {
      bindingId: 'binding-inherited',
      capabilityId: 'mcp:fixture/read',
      capabilityRevision: 'fixture-v1',
      exposedToolName: 'mcp__fixture__read',
      schemaDigest: 'sha256:fixture',
      issuedForTurnId: state.turn.turnId,
    },
  };
  state.capabilities.disclosures = {
    inherited: {
      capabilityId: 'mcp:fixture/read',
      capabilityRevision: 'fixture-v1',
      issuedForTurnId: state.turn.turnId,
    },
  };
  state.providerAdmission.waivers = {
    fixture: {
      providerId: 'fixture',
      source: 'explicit',
      reason: 'user_session_waiver',
      waivedAt: '2026-08-06T00:00:00.000Z',
    },
  };
  return state;
}

describe('TUI /rewind public path', () => {
  test('routes /rewind through the real hooks and forks an authority-cleared conversation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openpx-tui-rewind-path-'));
    const workspace = join(root, 'workspace');
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const runtimeStorePath = runtimeStorePathFor(checkpointPath);
    const sourceThreadId = 'tui-rewind-source';
    const checkpointId = 'before-authority';
    const threadIdRef = { current: sourceThreadId } as React.MutableRefObject<string>;
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
      const store = createRuntimeStore(runtimeStorePath);
      const sourceState = seedAuthorizedRewindSnapshot(sourceThreadId, workspace);
      store.saveSnapshot(sourceThreadId, sourceState);
      store.saveNamedSnapshot(sourceThreadId, checkpointId, sourceState);
      store.close();

      sessionManager.registerSession(sourceThreadId, workspace).setForeground(true);
      let tuiState = createInitialState();
      const dispatched: Action[] = [];
      const dispatch: Dispatch<Action> = (action) => {
        dispatched.push(action);
        tuiState = eventReducer(tuiState, action);
      };
      const deps: RewindDeps = {
        dispatch,
        sessionManager,
        workspace,
        threadIdRef,
        checkpointPath,
      };
      let controls: RewindPathControls | undefined;
      rendered = render(<RewindPathHarness deps={deps} onReady={(next) => (controls = next)} />);

      // The public parser and the actual hook both consume the same slash input.
      expect(parseSlashCommand('/rewind')).toEqual({ type: 'rewind' });
      expect(controls?.handleSlashCommand('/rewind')).toBe(true);
      expect(tuiState.showRewind).toBe(true);

      await dispatchTuiRewindRequest(
        dispatch,
        { type: 'EXECUTE_REWIND', checkpointId, scope: 'conversation_only' },
        controls!.runRewind,
      );

      const targetThreadId = threadIdRef.current;
      expect(targetThreadId).not.toBe(sourceThreadId);
      expect(sessionManager.getActiveId()).toBe(targetThreadId);
      expect(tuiState.activeSessionId).toBe(targetThreadId);
      expect(tuiState.showRewind).toBe(false);
      expect(dispatched.map((action) => action.type)).toEqual([
        'SHOW_REWIND',
        'EXECUTE_REWIND',
        'SET_SESSIONS',
        'LOAD_SESSION',
        'SET_EXITED',
        'LOCAL_TEXT',
      ]);

      const verificationStore = createRuntimeStore(runtimeStorePath);
      const fork = verificationStore.loadSnapshot<RuntimeState>(targetThreadId);
      verificationStore.close();
      expect(fork).not.toBeNull();
      expect(fork?.session.threadId).toBe(targetThreadId);
      expect(fork?.authorization).toEqual({ mode: 'default', commandGrants: {} });
      expect(fork?.mode).toBe('accept_edits');
      expect(fork?.capabilities.bindings).toEqual({});
      expect(fork?.capabilities.disclosures).toEqual({});
      expect(fork?.providerAdmission).toEqual({ pending: [], waivers: {} });
      expect(fork?.suspendedSubagents).toEqual({});
      expect(fork?.subagentResumeClaims).toEqual({});
    } finally {
      rendered?.unmount();
      sessionManager.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
