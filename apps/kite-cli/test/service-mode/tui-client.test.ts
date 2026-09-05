import { expect, test } from 'bun:test';
import type { KiteAppControlClient } from '@kite-ai/kite-app-contract';
import type { KiteAppServerConnection } from '@kite-ai/kite-local-runtime/client';
import type {
  RuntimeClientConnection,
  RuntimeClientTransport,
  RuntimeHistoryClient,
} from '@kite-ai/runtime-client';
import { RuntimeClient } from '@kite-ai/runtime-client';
import type { RuntimeClientInteraction } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type { SessionPresentationAction } from '../../src/adapters/tui/session-adapter';
import { createNativeTuiRuntimeClient } from '../../src/service-mode';

test('Native TUI facade uses Runtime commands/events and close only tears down the client connection', async () => {
  const remote = new FakeRuntimeConnection();
  const runtime: RuntimeClient = new RuntimeClient({
    transport: transport(remote),
    clientInfo: { name: 'tui-test', version: '1', instanceId: 'client-tui-test' },
    history: history(),
  });
  let closeCalls = 0;
  const connection: KiteAppServerConnection = {
    runtime,
    history: history(),
    app: {} as KiteAppControlClient,
    credential: {
      writeProviderCredential: async () => {
        throw new Error('not used');
      },
    },
    get status() {
      return runtime.snapshotStore.getSnapshot().status === 'closed' ? 'closed' : 'active';
    },
    get generation() {
      return runtime.connectionGeneration;
    },
    snapshotStore: runtime.snapshotStore,
    subscribe: (listener) => runtime.snapshotStore.subscribe(listener),
    prepareAppControl: async () => undefined,
    connect: async () => undefined,
    reconnect: () => runtime.reconnect(),
    close: async () => {
      closeCalls += 1;
      await runtime.close('tui-test-close');
    },
    [Symbol.asyncDispose]: async () => {
      closeCalls += 1;
      await runtime.close('tui-test-dispose');
    },
  };
  const events: string[] = [];
  const facade = createNativeTuiRuntimeClient({
    connection,
    workspace: '/tmp/tui-client-workspace',
    flushPresentation: async () => {
      events.push('presentation.flush');
    },
  });
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const session = facade.getRuntime(sessionId);
  expect(session).toBeDefined();
  expect(session?.modelProvider).toBe('fixture-provider');
  expect(session?.modelName).toBe('fixture-model');
  await session!.runTask('hello', {
    dispatch: (action) => {
      if (action.type === 'ACCEPT_PRESENTATION_ENVELOPE') {
        expect(action.event.sessionId).toBe(sessionId);
        expect(action.event.connectionGeneration).toBeGreaterThan(0);
        events.push(action.event.event.type);
      }
    },
  });
  await Bun.sleep(10);
  expect(remote.commands).toContain('create_session');
  expect(remote.commands).toContain('start_turn');
  expect(events).toContain('tool.progress');
  expect(events).toContain('run.terminal');
  expect(events.indexOf('reasoning.activity')).toBeLessThan(events.indexOf('presentation.flush'));
  expect(events.indexOf('presentation.flush')).toBeLessThan(events.indexOf('model.text_delta'));

  remote.requestApprovalOnNextTurn();
  const approvalRun = session!.runTask('confirm tool', {
    dispatch: (action) => {
      if (action.type === 'ACCEPT_PRESENTATION_ENVELOPE') events.push(action.event.event.type);
    },
  });
  await Bun.sleep(5);
  expect(remote.commands.filter((command) => command === 'start_turn')).toHaveLength(2);
  expect(events).toContain('interaction.available');
  await facade.submitUserAction({
    type: 'approve',
    interactionId: 'approval-native-receipt',
    generation: 0,
    grant: 'approve_once',
  });
  await approvalRun;
  expect(remote.commands).toContain('respond_interaction');
  expect(remote.interactionExpectedRevisions).toEqual([5, 6]);
  expect(remote.interactionPayloadRevisions).toEqual([5, 6]);

  session!.setLocalReplayRecovery(true);
  const continued = await facade.forkRecoveredSessionForContinuation(sessionId);
  expect(continued?.threadId).toBe('service-created-fork-session');
  await facade.waitForSessionReady('service-created-fork-session');
  expect(remote.commands).toContain('fork_session');

  const rewind = await facade.executeRewind({
    sourceThreadId: sessionId,
    snapshotId: 'checkpoint-1',
    scope: 'code_only',
    workspace: '/tmp/tui-client-workspace',
  });
  expect(rewind).toEqual({
    targetThreadId: sessionId,
    recoveredData: null,
    fileOutcome: { restored: ['safe.txt'], deleted: [], failed: [], conflicts: [] },
  });
  expect(remote.commands).toContain('rewind_session');

  await facade.dispose();
  expect(closeCalls).toBe(1);
  expect(remote.closeCalls).toBe(1);
  expect(remote.commands).not.toContain('cancel_turn');
});

test('Native TUI facade restores an approval from a snapshot without waiting for another event', async () => {
  const remote = new FakeRuntimeConnection();
  remote.requestApprovalSnapshotOnNextTurn();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const session = facade.getRuntime(sessionId)!;
  const actions: SessionPresentationAction[] = [];
  const run = session.runTask('confirm snapshot tool', {
    dispatch: (action) => actions.push(action),
  });

  await Bun.sleep(5);
  expect(actions).toContainEqual({
    type: 'RECONCILE_RUNTIME_PROJECTION',
    projection: expect.objectContaining({
      revision: 4,
      currentRun: expect.objectContaining({ runId: 'run-1', status: 'waiting' }),
      interactionQueue: {
        revision: 4,
        activeInteractionId: 'approval-native-receipt',
        interactions: [
          expect.objectContaining({
            kind: 'approval',
            interactionId: 'approval-native-receipt',
            command: 'echo approved',
          }),
        ],
      },
    }),
  });
  await facade.submitUserAction({
    type: 'approve',
    interactionId: 'approval-native-receipt',
    generation: 0,
    grant: 'approve_once',
  });
  await run;
  await facade.dispose();
});

test('Native TUI facade buffers accepted envelopes for a background session', async () => {
  const remote = new FakeRuntimeConnection();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const session = facade.getRuntime(sessionId)!;
  session.setForeground(false);

  await session.runTask('background envelope', { dispatch: () => {} });

  expect(session.eventBuffer.length).toBeGreaterThan(0);
  expect(
    session.eventBuffer.every(
      (envelope) =>
        envelope.sessionId === sessionId &&
        envelope.connectionGeneration > 0 &&
        (envelope.durability === 'durable' || envelope.durability === 'ephemeral') &&
        envelope.event !== undefined,
    ),
  ).toBe(true);
  expect(session.eventBuffer.some((envelope) => envelope.event.type === 'run.terminal')).toBe(true);
  await facade.dispose();
});

test('Native TUI facade refreshes a pending interaction from an eventful projection', async () => {
  const remote = new FakeRuntimeConnection();
  remote.requestApprovalOnNextTurn();
  remote.acceptNextInteractionWithoutConflict();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const actions: SessionPresentationAction[] = [];
  const run = facade
    .getRuntime(sessionId)!
    .runTask('confirm after sibling progress', { dispatch: (action) => actions.push(action) });

  await Bun.sleep(5);
  remote.advancePendingApprovalWithDurableEvent(8);
  await Bun.sleep(5);
  expect(
    actions.some(
      (action) =>
        action.type === 'RECONCILE_RUNTIME_PROJECTION' && action.projection.revision === 8,
    ),
  ).toBe(true);
  await facade.submitUserAction({
    type: 'approve',
    interactionId: 'approval-native-receipt',
    generation: 0,
    grant: 'approve_once',
  });

  expect(remote.interactionExpectedRevisions).toEqual([8]);
  expect(remote.interactionPayloadRevisions).toEqual([8]);
  await run;
  await facade.dispose();
});

test('Native TUI facade follows repeated interaction conflicts within a bounded deadline', async () => {
  const remote = new FakeRuntimeConnection();
  remote.requestApprovalOnNextTurn();
  remote.conflictNextInteractionTimes(5);
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const run = facade
    .getRuntime(sessionId)!
    .runTask('confirm through sibling revisions', { dispatch: () => {} });

  await Bun.sleep(5);
  await facade.submitUserAction({
    type: 'approve',
    interactionId: 'approval-native-receipt',
    generation: 0,
    grant: 'approve_once',
  });

  expect(remote.interactionExpectedRevisions).toEqual([3, 4, 5, 6, 7, 8]);
  expect(remote.interactionPayloadRevisions).toEqual(remote.interactionExpectedRevisions);
  expect(new Set(remote.interactionCommandIds).size).toBe(1);
  await run;
  await facade.dispose();
});

test('Native TUI facade replaces stale interactions from an authoritative snapshot queue', async () => {
  const remote = new FakeRuntimeConnection();
  remote.replaceApprovalSnapshotOnNextTurn();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const run = facade
    .getRuntime(sessionId)!
    .runTask('replace stale approval', { dispatch: () => {} });

  await Bun.sleep(5);
  await expect(
    facade.submitUserAction({
      type: 'approve',
      interactionId: 'approval-stale',
      generation: 0,
      grant: 'approve_once',
    }),
  ).rejects.toThrow('no longer pending');
  expect(remote.commands).not.toContain('respond_interaction');
  await facade.submitUserAction({
    type: 'approve',
    interactionId: 'approval-replacement',
    generation: 0,
    grant: 'approve_once',
  });
  await run;
  await facade.dispose();
});

test('Native TUI facade never routes a stale interaction cancel to the active session', async () => {
  const remote = new FakeRuntimeConnection();
  const facade = facadeFor(remote);
  const first = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(first);
  const second = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(second);

  await expect(
    facade.submitUserAction({ type: 'cancel', interactionId: 'stale-interaction' }),
  ).rejects.toThrow('no longer pending');
  expect(remote.commands).not.toContain('cancel_turn');
  await facade.dispose();
});

test('Native TUI facade completes an active run from its exact Run query after a subscription gap', async () => {
  const remote = new FakeRuntimeConnection();
  remote.finishNextTurnWithSnapshot();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const actions: SessionPresentationAction[] = [];

  await facade.getRuntime(sessionId)!.runTask('finish from snapshot', {
    dispatch: (action) => actions.push(action),
  });

  expect(remote.idleQueryRevisions).toContain(3);
  await facade.dispose();
});

test('Native TUI facade polls an accepted run when its Run terminal notification is absent', async () => {
  const remote = new FakeRuntimeConnection();
  remote.finishNextTurnWithoutRunTerminal();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const actions: SessionPresentationAction[] = [];

  await Promise.race([
    facade.getRuntime(sessionId)!.runTask('recover terminal notification gap', {
      dispatch: (action) => actions.push(action),
    }),
    Bun.sleep(3_500).then(() => {
      throw new Error('Accepted Runtime turn did not recover from a terminal notification gap.');
    }),
  ]);

  expect(remote.idleQueryRevisions).toContain(3);
  expect(actions.some((action) => action.type === 'ACCEPT_PRESENTATION_ENVELOPE')).toBe(true);
  await facade.dispose();
});

test('Native TUI facade fences a late predecessor projection from the current accepted Run', async () => {
  const remote = new FakeRuntimeConnection();
  remote.overlapIdleWaitersOnConsecutiveTurns();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const session = facade.getRuntime(sessionId)!;

  await session.runTask('first turn with delayed idle query', { dispatch: () => {} });
  await Promise.race([
    session.runTask('second turn after event-free idle', { dispatch: () => {} }),
    Bun.sleep(3_500).then(() => {
      throw new Error(
        `The current accepted Runtime turn did not consume authoritative idle: ${remote.idleQueryRevisions.join(',')}`,
      );
    }),
  ]);

  expect(remote.commands.filter((command) => command === 'start_turn')).toHaveLength(3);
  expect(remote.startTurnCommandIds.at(-1)).toBe(remote.startTurnCommandIds.at(-2));
  expect(remote.idleQueryRevisions).toContain(6);
  await facade.dispose();
});

test('Native TUI facade bounds a stalled Ink flush without blocking later answer events', async () => {
  const remote = new FakeRuntimeConnection();
  const facade = facadeFor(remote, {
    flushPresentation: () => new Promise<void>(() => undefined),
  });
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const events: string[] = [];

  await Promise.race([
    facade.getRuntime(sessionId)!.runTask('answer after stalled presentation flush', {
      dispatch: (action) => {
        if (action.type === 'ACCEPT_PRESENTATION_ENVELOPE') events.push(action.event.event.type);
      },
    }),
    Bun.sleep(3_000).then(() => {
      throw new Error('A stalled Ink flush blocked Runtime subscription consumption.');
    }),
  ]);

  expect(events.indexOf('reasoning.activity')).toBeLessThan(events.indexOf('model.text_delta'));
  expect(events).toContain('run.terminal');
  await facade.dispose();
});

test('Native TUI facade ignores an idle snapshot older than the accepted turn receipt', async () => {
  const remote = new FakeRuntimeConnection();
  remote.finishNextTurnAfterStaleSnapshot();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const actions: SessionPresentationAction[] = [];

  await facade.getRuntime(sessionId)!.runTask('ignore stale snapshot', {
    dispatch: (action) => actions.push(action),
  });

  expect(actions).not.toContainEqual({
    type: 'RECONCILE_RUNTIME_PROJECTION',
    projection: expect.objectContaining({ currentRun: undefined }),
  });
  expect(
    actions.some(
      (action) =>
        action.type === 'ACCEPT_PRESENTATION_ENVELOPE' &&
        action.event.event.type === 'run.terminal',
    ),
  ).toBe(true);
  await facade.dispose();
});

test('Native TUI facade waits for a restored active turn before admitting the next message', async () => {
  const remote = new FakeRuntimeConnection();
  remote.restoreActiveTurnOnSubscribe();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const session = facade.getRuntime(sessionId)!;
  expect(session.agentLoopActive).toBe(true);

  let idle = false;
  const waiting = session.waitForRunCompletion().then(() => {
    idle = true;
  });
  await Bun.sleep(10);
  expect(idle).toBe(false);

  remote.releaseRestoredTurn();
  await waiting;
  expect(session.agentLoopActive).toBe(false);
  expect(session.tryReservePrompt()).toBe(true);
  await session.runTask('queued after restored turn', { dispatch: () => {} });
  expect(remote.commands).toContain('start_turn');
  await facade.dispose();
});

test('Native TUI facade retries a queued turn after an exact revision conflict', async () => {
  const remote = new FakeRuntimeConnection();
  remote.conflictNextStartTurnAt(7);
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);

  await facade.getRuntime(sessionId)!.runTask('queued after terminal projection', {
    dispatch: () => {},
  });

  expect(remote.startTurnExpectedRevisions).toEqual([1, 7]);
  expect(remote.startTurnCommandIds[0]).toBe(remote.startTurnCommandIds[1]);
  await facade.dispose();
});

test('Native TUI facade keeps a conflicted successor queued until active cleanup is idle', async () => {
  const remote = new FakeRuntimeConnection();
  remote.restoreActiveTurnOnSubscribe();
  remote.conflictNextStartTurnAt(2);
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);

  let accepted = 0;
  const run = facade.getRuntime(sessionId)!.runTask('queued behind active revision churn', {
    dispatch: () => {},
    onAccepted: () => {
      accepted += 1;
    },
  });
  await Bun.sleep(10);
  expect(accepted).toBe(0);
  expect(remote.startTurnExpectedRevisions).toEqual([1]);

  remote.releaseRestoredTurn();
  await run;
  expect(accepted).toBe(1);
  expect(remote.startTurnExpectedRevisions).toEqual([1, 2]);
  expect(new Set(remote.startTurnCommandIds).size).toBe(1);
  await facade.dispose();
});

test('Native TUI facade keeps a queued successor pending across runtime_busy', async () => {
  const remote = new FakeRuntimeConnection();
  remote.rejectNextStartTurnAsBusy();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);

  let accepted = 0;
  await facade.getRuntime(sessionId)!.runTask('queued behind active subagents', {
    dispatch: () => {},
    onAccepted: () => {
      accepted += 1;
      expect(remote.commands.filter((command) => command === 'start_turn')).toHaveLength(2);
    },
  });

  expect(accepted).toBe(1);
  expect(remote.commands.filter((command) => command === 'start_turn')).toHaveLength(2);
  expect(new Set(remote.startTurnCommandIds).size).toBe(2);
  await facade.dispose();
});

test('Native TUI facade coalesces repeated abort requests for the same active turn', async () => {
  const remote = new FakeRuntimeConnection();
  remote.restoreActiveTurnOnSubscribe();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const session = facade.getRuntime(sessionId)!;

  const first = session.abort();
  const second = session.abort();
  expect(first).toBe(second);
  await Promise.all([first, second]);

  expect(remote.commands.filter((command) => command === 'cancel_turn')).toHaveLength(1);
  await facade.dispose();
});

test('Native TUI facade recovers the Session before retrying cancellation', async () => {
  const remote = new FakeRuntimeConnection();
  remote.restoreActiveTurnOnSubscribe();
  remote.rejectNextCancelAsSessionUnavailable();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);

  await facade.getRuntime(sessionId)!.abort();

  expect(remote.commands.filter((command) => command === 'cancel_turn')).toHaveLength(2);
  expect(remote.commands.filter((command) => command === 'resume_session')).toHaveLength(1);
  expect(remote.commands.indexOf('resume_session')).toBeGreaterThan(
    remote.commands.indexOf('cancel_turn'),
  );
  expect(remote.commands.lastIndexOf('cancel_turn')).toBeGreaterThan(
    remote.commands.indexOf('resume_session'),
  );
  await facade.dispose();
});

test('Native TUI facade reproduces the latest real session and fences a predecessor terminal by revision', async () => {
  // Regression extracted from tui-60771b71-c6d8-4944-b816-75c4dc723745:
  // the queued "主要了解tui" start_turn first saw runtime_busy, then the
  // predecessor completed before the successor receipt was accepted. The old
  // client retained that predecessor Run ID and falsely rejected the successor.
  const remote = new FakeRuntimeConnection();
  remote.rejectNextStartTurnAsBusyAndFinishPredecessor();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);

  let accepted = 0;
  await facade.getRuntime(sessionId)!.runTask('主要了解tui', {
    dispatch: () => {},
    onAccepted: () => {
      accepted += 1;
    },
  });

  expect(accepted).toBe(1);
  expect(remote.startTurnExpectedRevisions).toEqual([1, 1, 2]);
  expect(new Set(remote.startTurnCommandIds).size).toBe(2);
  await facade.dispose();
});

test('Native TUI facade waits through repeated start conflicts and preserves one command identity', async () => {
  const remote = new FakeRuntimeConnection();
  remote.conflictNextStartTurns(3);
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);

  await facade.getRuntime(sessionId)!.runTask('admit after active revision churn', {
    dispatch: () => {},
  });
  expect(remote.startTurnExpectedRevisions).toEqual([1, 2, 3, 4]);
  expect(new Set(remote.startTurnCommandIds).size).toBe(1);
  await facade.dispose();
});

test('Native TUI facade converges when terminal projection arrives before the command receipt', async () => {
  const remote = new FakeRuntimeConnection();
  remote.deliverNextStartTurnReceiptAfterTerminalProjection();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);

  const actions: SessionPresentationAction[] = [];
  await facade.getRuntime(sessionId)!.runTask('out-of-order transport', {
    dispatch: (action) => actions.push(action),
  });

  expect(remote.deferredTurnDeliveryOrder).toEqual(['terminal_projection', 'command_receipt']);
  expect(remote.startTurnExpectedRevisions).toEqual([1]);
  const terminalActions = actions.filter(
    (
      action,
    ): action is Extract<SessionPresentationAction, { type: 'ACCEPT_PRESENTATION_ENVELOPE' }> =>
      action.type === 'ACCEPT_PRESENTATION_ENVELOPE' && action.event.event.type === 'run.terminal',
  );
  expect(terminalActions).toHaveLength(2);
  expect(terminalActions[0]?.event).toBe(terminalActions[1]?.event);
  expect(terminalActions[0]?.event).toMatchObject({
    sessionId,
    connectionGeneration: expect.any(Number),
    durability: 'durable',
    revision: 3,
    runId: 'run-1',
    event: { type: 'run.terminal', runId: 'run-1', status: 'completed' },
  });
  await facade.dispose();
});

test('App Server TUI keeps historical open observer-only and resumes on the first mutation', async () => {
  const remote = new FakeRuntimeConnection();
  const facade = facadeFor(remote, { initialInteractionMode: 'full' });
  const session = facade.registerSession('existing-session', '/tmp/tui-client-workspace');
  await facade.waitForSessionReady('existing-session');

  expect(session.interactionMode).toBe('full');
  expect(remote.commands).not.toContain('resume_session');

  await session.runTask('mutate existing app-server session', { dispatch: () => {} });

  expect(remote.commands).toContain('resume_session');
  expect(remote.commands.indexOf('resume_session')).toBeLessThan(
    remote.commands.indexOf('start_turn'),
  );
  await facade.dispose();
});

class FakeRuntimeConnection implements RuntimeClientConnection {
  readonly commands: string[] = [];
  readonly interactionExpectedRevisions: number[] = [];
  readonly interactionPayloadRevisions: number[] = [];
  readonly interactionCommandIds: string[] = [];
  readonly startTurnExpectedRevisions: number[] = [];
  readonly startTurnCommandIds: string[] = [];
  readonly deferredTurnDeliveryOrder: string[] = [];
  readonly idleQueryRevisions: number[] = [];
  closeCalls = 0;
  #items: unknown[] = [];
  #waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  #sessionId = '';
  #nextSubscription = 0;
  #approvalOnNextTurn = false;
  #approvalSnapshotOnNextTurn = false;
  #replacementApprovalSnapshotOnNextTurn = false;
  #terminalSnapshotOnNextTurn = false;
  #staleSnapshotOnNextTurn = false;
  #restoreActiveTurn = false;
  #restoredTurnReleased = false;
  #authoritativeRevision = 1;
  #nextStartTurnConflictRevision: number | undefined;
  #startTurnBusyRemaining = 0;
  #finishPredecessorAfterBusy = false;
  #startTurnConflictsRemaining = 0;
  #deferNextStartTurnReceipt = false;
  #overlapIdleWaiters = false;
  #omitSecondTerminalNotification = false;
  #terminalGapOnNextTurn = false;
  #delayedIdleQueries = 0;
  #startTurnOrdinal = 0;
  #currentRunId = 'run-0';
  #currentRunCreatedRevision = 0;
  #currentRunTerminalRevision: number | undefined;
  #pendingInteraction: RuntimeClientInteraction | undefined;
  #interactionConflictsRemaining = 1;
  #cancelSessionUnavailableRemaining = 0;
  readonly #subscriptionBySession = new Map<string, string>();

  requestApprovalOnNextTurn(): void {
    this.#approvalOnNextTurn = true;
  }

  acceptNextInteractionWithoutConflict(): void {
    this.#interactionConflictsRemaining = 0;
  }

  conflictNextInteractionTimes(count: number): void {
    this.#interactionConflictsRemaining = count;
  }

  advancePendingApprovalWithDurableEvent(revision: number): void {
    if (!this.#pendingInteraction) throw new Error('No pending approval to advance.');
    this.#authoritativeRevision = revision;
    this.#pendingInteraction = { ...this.#pendingInteraction, sessionRevision: revision };
    this.push(
      subscriptionUpdate(this.#subscriptionBySession.get(this.#sessionId)!, 1, {
        type: 'notification',
        durability: 'durable',
        sessionId: this.#sessionId,
        revision,
        session: projection(this.#sessionId, revision, 'waiting', this.#pendingInteraction),
        event: { type: 'tool.started', toolId: 'sibling-shell', summary: 'Sibling tool started' },
      }),
    );
  }

  requestApprovalSnapshotOnNextTurn(): void {
    this.#approvalSnapshotOnNextTurn = true;
  }

  replaceApprovalSnapshotOnNextTurn(): void {
    this.#replacementApprovalSnapshotOnNextTurn = true;
  }

  finishNextTurnWithSnapshot(): void {
    this.#terminalSnapshotOnNextTurn = true;
  }

  finishNextTurnAfterStaleSnapshot(): void {
    this.#staleSnapshotOnNextTurn = true;
  }

  restoreActiveTurnOnSubscribe(): void {
    this.#restoreActiveTurn = true;
  }

  releaseRestoredTurn(): void {
    this.#restoredTurnReleased = true;
    this.#authoritativeRevision = 2;
  }

  conflictNextStartTurnAt(currentRevision: number): void {
    this.#nextStartTurnConflictRevision = currentRevision;
  }

  rejectNextStartTurnAsBusy(): void {
    this.#startTurnBusyRemaining = 1;
  }

  rejectNextStartTurnAsBusyAndFinishPredecessor(): void {
    this.#startTurnBusyRemaining = 1;
    this.#finishPredecessorAfterBusy = true;
  }

  conflictNextStartTurns(count: number): void {
    this.#startTurnConflictsRemaining = count;
  }

  rejectNextCancelAsSessionUnavailable(): void {
    this.#cancelSessionUnavailableRemaining = 1;
  }

  deliverNextStartTurnReceiptAfterTerminalProjection(): void {
    this.#deferNextStartTurnReceipt = true;
  }

  overlapIdleWaitersOnConsecutiveTurns(): void {
    this.#overlapIdleWaiters = true;
    this.#omitSecondTerminalNotification = true;
    this.#delayedIdleQueries = 1;
  }

  finishNextTurnWithoutRunTerminal(): void {
    this.#terminalGapOnNextTurn = true;
  }

  #emitApproval(sessionId: string): void {
    this.#authoritativeRevision += 1;
    this.#pendingInteraction = approvalInteraction(this.#authoritativeRevision);
    this.push(
      subscriptionUpdate(this.#subscriptionBySession.get(sessionId)!, 1, {
        type: 'notification',
        durability: 'durable',
        sessionId,
        revision: this.#authoritativeRevision,
        session: projection(sessionId, this.#authoritativeRevision, 'running'),
        event: {
          type: 'interaction.available',
          interaction: this.#pendingInteraction,
        },
      }),
    );
  }

  async send(message: RuntimeProtocolMessage): Promise<void> {
    if ('method' in message) {
      if (message.method === 'initialize') {
        this.push(result(message.id, initializeResult('service-tui-test')));
        return;
      }
      if (message.method === 'runtime/subscribe') {
        const subscriptionId = `tui-subscription-${++this.#nextSubscription}`;
        const sessionId =
          message.params.subscription.scope === 'session'
            ? message.params.subscription.sessionId
            : this.#sessionId;
        this.#subscriptionBySession.set(sessionId, subscriptionId);
        this.push(result(message.id, { subscriptionId, generation: 1 }));
        const snapshotRevision = Math.max(1, this.#authoritativeRevision);
        const snapshot = this.#pendingInteraction
          ? projection(sessionId, snapshotRevision, 'waiting', {
              ...this.#pendingInteraction,
              sessionRevision: snapshotRevision,
            })
          : this.#restoreActiveTurn && !this.#restoredTurnReleased
            ? projection(sessionId, snapshotRevision, 'running')
            : this.#currentRunCreatedRevision > 0 && this.#currentRunTerminalRevision === undefined
              ? projection(sessionId, snapshotRevision, 'running')
              : idleProjection(sessionId, snapshotRevision);
        this.push(
          subscriptionUpdate(subscriptionId, 1, {
            type: 'notification',
            durability: 'durable',
            sessionId,
            revision: snapshotRevision,
            session: snapshot,
          }),
        );
        this.push(subscriptionUpdate(subscriptionId, 1, { type: 'ready', scope: 'session' }));
        return;
      }
      if (message.method === 'runtime/unsubscribe') {
        this.push(result(message.id, { unsubscribed: true }));
        return;
      }
      if (message.method === 'runtime/query') {
        const query = message.params.query;
        if (query.type === 'get_run') {
          const revision = this.#currentRunTerminalRevision ?? this.#authoritativeRevision;
          this.idleQueryRevisions.push(revision);
          this.push(
            result(message.id, {
              status: query.runId === this.#currentRunId ? 'ok' : 'not_found',
              queryType: query.type,
              ...(query.runId === this.#currentRunId
                ? {
                    revision,
                    run: {
                      schema: 'kite.runtime-run.v1',
                      sessionId: query.sessionId,
                      runId: query.runId,
                      phase: 'building',
                      status:
                        this.#currentRunTerminalRevision === undefined
                          ? ('running' as const)
                          : ('completed' as const),
                      createdRevision: this.#currentRunCreatedRevision,
                      lastRevision: revision,
                      createdAtMs: this.#currentRunCreatedRevision,
                      startedAtMs: this.#currentRunCreatedRevision,
                      ...(this.#currentRunTerminalRevision === undefined
                        ? {}
                        : { finishedAtMs: revision }),
                    },
                  }
                : { code: 'run_not_found' as const }),
            }),
          );
          return;
        }
        if (query.type === 'get_session_projection') {
          const respond = () => {
            const session = this.#pendingInteraction
              ? projection(query.sessionId, this.#authoritativeRevision, 'waiting', {
                  ...this.#pendingInteraction,
                  sessionRevision: this.#authoritativeRevision,
                })
              : this.#overlapIdleWaiters
                ? idleProjection(query.sessionId, this.#authoritativeRevision)
                : this.#restoreActiveTurn && !this.#restoredTurnReleased
                  ? projection(query.sessionId, 1, 'running')
                  : idleProjection(query.sessionId, Math.max(2, this.#authoritativeRevision));
            this.idleQueryRevisions.push(session.revision);
            this.push(
              result(message.id, {
                status: 'ok',
                queryType: query.type,
                revision: session.revision,
                session,
              }),
            );
          };
          if (this.#delayedIdleQueries > 0) {
            this.#delayedIdleQueries -= 1;
            setTimeout(respond, 200);
          } else {
            respond();
          }
        }
        return;
      }
      if (message.method !== 'runtime/command') return;
      const command = message.params.command;
      this.commands.push(command.type);
      if (command.type === 'create_session') {
        this.#sessionId = command.bootstrapSessionId ?? '';
        this.#authoritativeRevision = 1;
        this.push(
          result(message.id, {
            status: 'applied',
            commandId: command.commandId,
            sessionId: this.#sessionId,
            revision: 1,
          }),
        );
        return;
      }
      if (command.type === 'resume_session') {
        this.#sessionId = command.sessionId;
        this.push(
          result(message.id, {
            status: 'applied',
            commandId: command.commandId,
            sessionId: this.#sessionId,
            revision: 1,
          }),
        );
        return;
      }
      if (command.type === 'fork_session') {
        this.#sessionId = 'service-created-fork-session';
        this.push(
          result(message.id, {
            status: 'applied',
            commandId: command.commandId,
            sessionId: this.#sessionId,
            revision: command.sourceRevision,
          }),
        );
        return;
      }
      if (command.type === 'rewind_session') {
        this.#authoritativeRevision = command.expectedRevision + 1;
        this.push(
          result(message.id, {
            status: 'applied',
            commandId: command.commandId,
            sessionId: command.sessionId,
            revision: command.expectedRevision + 1,
          }),
        );
        this.push(
          subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
            type: 'notification',
            durability: 'ephemeral',
            sessionId: command.sessionId,
            workId: 'work-1',
            runId: 'rewind-run',
            turnId: 'turn-1',
            actorId: 'runtime-rewind',
            attemptId: command.commandId,
            compositionRevision: 'runtime-state-store',
            streamId: command.commandId,
            sequence: 1,
            event: {
              type: 'rewind.terminal',
              rewindId: 'rewind-service-test',
              commandId: command.commandId,
              sourceSessionId: command.sessionId,
              targetSessionId: command.sessionId,
              status: 'completed',
              fileOutcome: {
                restored: ['safe.txt'],
                deleted: [],
                failed: [],
                conflicts: [],
              },
            },
          }),
        );
        return;
      }
      if (command.type === 'respond_interaction') {
        this.interactionExpectedRevisions.push(command.expectedRevision);
        this.interactionPayloadRevisions.push(command.interaction.sessionRevision);
        this.interactionCommandIds.push(command.commandId);
        if (this.#interactionConflictsRemaining > 0) {
          this.#interactionConflictsRemaining -= 1;
          this.#authoritativeRevision = Math.max(
            this.#authoritativeRevision + 1,
            command.expectedRevision + 1,
          );
          this.push(
            result(message.id, {
              status: 'conflict',
              commandId: command.commandId,
              code: 'revision_conflict',
              currentRevision: this.#authoritativeRevision,
            }),
          );
          return;
        }
        this.#pendingInteraction = undefined;
        this.#currentRunTerminalRevision = command.expectedRevision + 2;
        this.push(
          result(message.id, {
            status: 'applied',
            commandId: command.commandId,
            sessionId: command.sessionId,
            revision: command.expectedRevision + 1,
          }),
        );
        this.push(
          subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
            type: 'notification',
            durability: 'durable',
            sessionId: command.sessionId,
            revision: command.expectedRevision + 1,
            session: projection(command.sessionId, command.expectedRevision + 1, 'running'),
            event: {
              type: 'approval.granted',
              interactionId: command.interaction.interactionId,
              generation:
                command.interaction.kind === 'approval' ? command.interaction.generation : 0,
              owner:
                command.interaction.kind === 'approval'
                  ? command.interaction.owner
                  : { kind: 'root_tool', toolCallId: command.interaction.interactionId },
            },
          }),
        );
        this.push(
          subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
            type: 'notification',
            durability: 'durable',
            sessionId: command.sessionId,
            revision: command.expectedRevision + 2,
            session: projection(command.sessionId, command.expectedRevision + 2, 'completed'),
            event: { type: 'run.terminal', runId: this.#currentRunId, status: 'completed' },
          }),
        );
        this.#authoritativeRevision = command.expectedRevision + 2;
        return;
      }
      if (command.type === 'cancel_turn') {
        if (this.#cancelSessionUnavailableRemaining > 0) {
          this.#cancelSessionUnavailableRemaining -= 1;
          this.push(
            result(message.id, {
              status: 'rejected',
              commandId: command.commandId,
              code: 'session_unavailable',
              currentRevision: this.#authoritativeRevision,
            }),
          );
          return;
        }
        const revision = command.expectedRevision + 1;
        this.#authoritativeRevision = revision;
        this.#restoredTurnReleased = true;
        this.push(
          result(message.id, {
            status: 'applied',
            commandId: command.commandId,
            sessionId: command.sessionId,
            revision,
          }),
        );
        this.push(
          subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
            type: 'notification',
            durability: 'durable',
            sessionId: command.sessionId,
            revision,
            session: projection(command.sessionId, revision, 'completed'),
            event: {
              type: 'turn.terminal',
              turnId: command.turnId,
              status: 'cancelled',
              cause: 'user',
            },
          }),
        );
        return;
      }
      if (command.type === 'start_turn') {
        this.startTurnExpectedRevisions.push(command.expectedRevision);
        this.startTurnCommandIds.push(command.commandId);
        if (this.#startTurnBusyRemaining > 0) {
          this.#startTurnBusyRemaining -= 1;
          this.push(
            result(message.id, {
              status: 'rejected',
              commandId: command.commandId,
              code: 'runtime_busy',
              currentRevision: this.#authoritativeRevision,
            }),
          );
          if (this.#finishPredecessorAfterBusy) {
            this.#finishPredecessorAfterBusy = false;
            this.#authoritativeRevision += 1;
            this.push(
              subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
                type: 'notification',
                durability: 'durable',
                sessionId: command.sessionId,
                revision: this.#authoritativeRevision,
                session: projection(command.sessionId, this.#authoritativeRevision, 'completed'),
                event: {
                  type: 'run.terminal',
                  runId: 'run-predecessor',
                  status: 'completed',
                },
              }),
            );
          }
          return;
        }
        if (this.#nextStartTurnConflictRevision !== undefined) {
          this.#authoritativeRevision = this.#nextStartTurnConflictRevision;
          this.#nextStartTurnConflictRevision = undefined;
        }
        if (this.#startTurnConflictsRemaining > 0) {
          this.#startTurnConflictsRemaining -= 1;
          this.#authoritativeRevision = Math.max(
            this.#authoritativeRevision,
            command.expectedRevision + 1,
          );
        }
        if (command.expectedRevision !== this.#authoritativeRevision) {
          this.push(
            result(message.id, {
              status: 'conflict',
              commandId: command.commandId,
              code: 'revision_conflict',
              currentRevision: this.#authoritativeRevision,
            }),
          );
          return;
        }
        this.#startTurnOrdinal += 1;
        this.#currentRunId = `run-${this.#startTurnOrdinal}`;
        const acceptedRevision = command.expectedRevision + 1;
        const terminalRevision = acceptedRevision + 1;
        this.#currentRunCreatedRevision = acceptedRevision;
        this.#currentRunTerminalRevision = undefined;
        const deferReceipt =
          this.#deferNextStartTurnReceipt &&
          !this.#approvalOnNextTurn &&
          !this.#approvalSnapshotOnNextTurn &&
          !this.#replacementApprovalSnapshotOnNextTurn &&
          !this.#terminalSnapshotOnNextTurn &&
          !this.#staleSnapshotOnNextTurn;
        this.#deferNextStartTurnReceipt = false;
        this.#authoritativeRevision = acceptedRevision;
        const commandReceipt = result(message.id, {
          status: 'applied',
          commandId: command.commandId,
          sessionId: command.sessionId,
          revision: acceptedRevision,
          resource: {
            kind: 'run',
            messageId: `message-${this.#startTurnOrdinal}`,
            run: {
              schema: 'kite.runtime-run.v1',
              sessionId: command.sessionId,
              runId: this.#currentRunId,
              phase: command.phase ?? 'building',
              status: 'queued',
              createdRevision: acceptedRevision,
              lastRevision: acceptedRevision,
              createdAtMs: acceptedRevision,
            },
          },
        });
        if (!deferReceipt) this.push(commandReceipt);
        this.push(
          subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
            type: 'notification',
            durability: 'durable',
            sessionId: command.sessionId,
            revision: acceptedRevision,
            session: projection(command.sessionId, acceptedRevision, 'running'),
          }),
        );
        if (this.#approvalOnNextTurn) {
          this.#approvalOnNextTurn = false;
          this.#emitApproval(command.sessionId);
          return;
        }
        if (this.#approvalSnapshotOnNextTurn) {
          this.#approvalSnapshotOnNextTurn = false;
          this.#authoritativeRevision = 4;
          this.#pendingInteraction = approvalInteraction(4);
          this.push(
            subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
              type: 'notification',
              durability: 'durable',
              sessionId: command.sessionId,
              revision: 4,
              session: projection(command.sessionId, 4, 'waiting', this.#pendingInteraction),
            }),
          );
          return;
        }
        if (this.#replacementApprovalSnapshotOnNextTurn) {
          this.#replacementApprovalSnapshotOnNextTurn = false;
          this.#authoritativeRevision = 5;
          const subscriptionId = this.#subscriptionBySession.get(command.sessionId)!;
          const stale = {
            kind: 'approval' as const,
            interactionId: 'approval-stale',
            sessionRevision: 4,
            generation: 0,
            grants: ['approve_once'] as const,
            owner: { kind: 'root_tool' as const, toolCallId: 'approval-stale-tool' },
          };
          const replacement = {
            kind: 'approval' as const,
            interactionId: 'approval-replacement',
            sessionRevision: 5,
            generation: 0,
            grants: ['approve_once'] as const,
            owner: { kind: 'root_tool' as const, toolCallId: 'approval-replacement-tool' },
          };
          this.#pendingInteraction = replacement;
          this.push(
            subscriptionUpdate(subscriptionId, 1, {
              type: 'notification',
              durability: 'durable',
              sessionId: command.sessionId,
              revision: 4,
              session: projection(command.sessionId, 4, 'waiting', stale),
              event: { type: 'interaction.available', interaction: stale },
            }),
          );
          this.push(
            subscriptionUpdate(subscriptionId, 1, {
              type: 'notification',
              durability: 'durable',
              sessionId: command.sessionId,
              revision: 5,
              session: projection(command.sessionId, 5, 'waiting', replacement),
            }),
          );
          return;
        }
        if (this.#terminalSnapshotOnNextTurn) {
          this.#terminalSnapshotOnNextTurn = false;
          this.#authoritativeRevision = terminalRevision;
          this.#currentRunTerminalRevision = terminalRevision;
          this.push(
            subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
              type: 'notification',
              durability: 'durable',
              sessionId: command.sessionId,
              revision: terminalRevision,
              session: idleProjection(command.sessionId, terminalRevision),
            }),
          );
          return;
        }
        if (this.#staleSnapshotOnNextTurn) {
          this.#staleSnapshotOnNextTurn = false;
          this.#authoritativeRevision = terminalRevision;
          this.#currentRunTerminalRevision = terminalRevision;
          const subscriptionId = this.#subscriptionBySession.get(command.sessionId)!;
          this.push(
            subscriptionUpdate(subscriptionId, 1, {
              type: 'notification',
              durability: 'durable',
              sessionId: command.sessionId,
              revision: 1,
              session: idleProjection(command.sessionId, 1),
            }),
          );
          this.push(
            subscriptionUpdate(subscriptionId, 1, {
              type: 'notification',
              durability: 'durable',
              sessionId: command.sessionId,
              revision: terminalRevision,
              session: idleProjection(command.sessionId, terminalRevision),
              event: {
                type: 'run.terminal',
                runId: this.#currentRunId,
                status: 'completed',
              },
            }),
          );
          return;
        }
        this.push(
          subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
            type: 'notification',
            durability: 'durable',
            sessionId: command.sessionId,
            revision: acceptedRevision,
            session: projection(command.sessionId, acceptedRevision, 'running'),
            event: { type: 'model.requested', requestId: 'request-1' },
          }),
        );
        this.push(
          subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
            type: 'notification',
            durability: 'ephemeral',
            sessionId: command.sessionId,
            workId: 'work-1',
            turnId: 'turn-1',
            actorId: 'runtime-agent',
            attemptId: command.commandId,
            compositionRevision: 'runtime-state-store',
            streamId: command.commandId,
            sequence: 1,
            event: {
              type: 'reasoning.activity',
              requestId: 'request-1',
              segmentId: 'segment-1',
              state: 'completed',
              text: 'fixture reasoning',
            },
          }),
        );
        this.push(
          subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
            type: 'notification',
            durability: 'ephemeral',
            sessionId: command.sessionId,
            workId: 'work-1',
            turnId: 'turn-1',
            actorId: 'runtime-agent',
            attemptId: command.commandId,
            compositionRevision: 'runtime-state-store',
            streamId: command.commandId,
            sequence: 2,
            event: {
              type: 'model.text_delta',
              requestId: 'request-1',
              text: 'fixture answer paragraph',
            },
          }),
        );
        this.push(
          subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
            type: 'notification',
            durability: 'ephemeral',
            sessionId: command.sessionId,
            workId: 'work-1',
            turnId: 'turn-1',
            actorId: 'runtime-agent',
            attemptId: command.commandId,
            compositionRevision: 'runtime-state-store',
            streamId: command.commandId,
            sequence: 3,
            event: {
              type: 'tool.progress',
              toolId: 'shell-1',
              summary: 'fixture-progress',
              stream: 'stdout',
            },
          }),
        );
        if (deferReceipt) this.deferredTurnDeliveryOrder.push('terminal_projection');
        const omitRunTerminal =
          this.#terminalGapOnNextTurn ||
          (this.#omitSecondTerminalNotification && this.#startTurnOrdinal === 2);
        this.#terminalGapOnNextTurn = false;
        this.#currentRunTerminalRevision = terminalRevision;
        if (!omitRunTerminal) {
          this.push(
            subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
              type: 'notification',
              durability: 'durable',
              sessionId: command.sessionId,
              revision: terminalRevision,
              session: projection(
                command.sessionId,
                terminalRevision,
                this.#overlapIdleWaiters ? 'running' : 'completed',
              ),
              event: {
                type: 'run.terminal',
                runId: this.#currentRunId,
                status: 'completed',
              },
            }),
          );
        } else {
          this.push(
            subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
              type: 'notification',
              durability: 'durable',
              sessionId: command.sessionId,
              revision: terminalRevision,
              session: projection(
                command.sessionId,
                terminalRevision,
                this.#overlapIdleWaiters ? 'running' : 'completed',
              ),
              event: {
                type: 'turn.terminal',
                turnId: this.#overlapIdleWaiters ? 'run-1' : this.#currentRunId,
                status: 'completed',
              },
            }),
          );
        }
        if (deferReceipt) {
          this.deferredTurnDeliveryOrder.push('command_receipt');
          setTimeout(() => this.push(commandReceipt), 0);
        }
        if (this.#overlapIdleWaiters) {
          const idleRevision = terminalRevision + 1;
          this.#authoritativeRevision = idleRevision;
          if (this.#startTurnOrdinal === 1) {
            setTimeout(() => {
              this.push(
                subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
                  type: 'notification',
                  durability: 'durable',
                  sessionId: command.sessionId,
                  revision: idleRevision,
                  session: idleProjection(command.sessionId, idleRevision),
                }),
              );
            }, 10);
          }
        } else {
          this.#authoritativeRevision = terminalRevision;
        }
        return;
      }
      const revision = ('expectedRevision' in command ? command.expectedRevision : 0) + 1;
      this.#authoritativeRevision = revision;
      this.push(
        result(message.id, {
          status: 'applied',
          commandId: command.commandId,
          sessionId: 'sessionId' in command ? command.sessionId : this.#sessionId,
          revision,
        }),
      );
    }
  }

  messages(): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => {
          const value = this.#items.shift();
          if (value !== undefined) return Promise.resolve({ done: false, value });
          return new Promise((resolve) => this.#waiters.push(resolve));
        },
      }),
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    for (const resolve of this.#waiters.splice(0)) resolve({ done: true, value: undefined });
  }

  push(value: unknown): void {
    const resolve = this.#waiters.shift();
    if (resolve) resolve({ done: false, value });
    else this.#items.push(value);
  }
}

function transport(connection: FakeRuntimeConnection): RuntimeClientTransport {
  return { connect: async () => connection };
}

function history(): RuntimeHistoryClient {
  return {
    listSessions: async () => ({ entries: [], hasMore: false }),
    listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
    loadSession: async () => {
      throw new Error('not used');
    },
  };
}

function result(id: string | number | null, value: object): object {
  return { jsonrpc: '2.0', id, result: value };
}

function initializeResult(instanceId: string): object {
  return {
    protocolVersion: 2,
    protocolSchema: 'kite.runtime-protocol.v2',
    serverInfo: { version: '1', instanceId },
    capabilities: {
      methods: [
        'initialize',
        'runtime/command',
        'runtime/query',
        'runtime/subscribe',
        'runtime/unsubscribe',
        'server/ping',
      ],
      subscriptions: ['session', 'sessions'],
    },
    limits: {
      maxMessageBytes: 1024,
      maxDepth: 8,
      maxInFlightRequests: 8,
      maxSubscriptions: 8,
      maxOutboundMessages: 8,
    },
  };
}

function approvalInteraction(revision: number): RuntimeClientInteraction {
  return {
    kind: 'approval',
    interactionId: 'approval-native-receipt',
    sessionRevision: revision,
    generation: 0,
    grants: ['approve_once'],
    owner: { kind: 'root_tool', toolCallId: 'approval-native-receipt' },
    command: 'echo approved',
    title: 'shell_execute',
    summary: 'Approve a shell command',
  };
}

function projection(
  sessionId: string,
  revision: number,
  status: 'running' | 'waiting' | 'completed',
  interaction?: import('@kite-ai/runtime-contract').RuntimeClientInteraction,
) {
  return {
    schema: 'kite.runtime-projection.v2',
    sessionId,
    revision,
    lifecycle: 'open',
    model: { provider: 'fixture-provider', name: 'fixture-model' },
    sessionCommandGrantCount: 0,
    interactionQueue: {
      revision,
      ...(interaction === undefined ? {} : { activeInteractionId: interaction.interactionId }),
      interactions: interaction === undefined ? [] : [structuredClone(interaction)],
    },
    currentRun: {
      runId: 'run-1',
      initialTurnId: 'run-1',
      activeTurnId: 'turn-1',
      status,
      revision,
      ...(interaction === undefined ? {} : { activeInteractionId: interaction.interactionId }),
    },
  };
}

function idleProjection(sessionId: string, revision: number) {
  return {
    schema: 'kite.runtime-projection.v2',
    sessionId,
    revision,
    lifecycle: 'open',
    model: { provider: 'fixture-provider', name: 'fixture-model' },
    sessionCommandGrantCount: 0,
    interactionQueue: { revision, interactions: [] },
  };
}

function facadeFor(
  remote: FakeRuntimeConnection,
  options: {
    readonly initialInteractionMode?: 'accept_edits' | 'auto' | 'full';
    readonly onConnect?: () => void;
    readonly onReconnect?: () => void;
    readonly flushPresentation?: () => Promise<void>;
  } = {},
) {
  const runtime = new RuntimeClient({
    transport: transport(remote),
    clientInfo: { name: 'tui-test', version: '1', instanceId: 'client-tui-test' },
    history: history(),
  });
  const connection = {
    runtime,
    history: history(),
    app: {} as KiteAppControlClient,
    credential: {
      writeProviderCredential: async () => {
        throw new Error('not used');
      },
    },
    get status() {
      return runtime.snapshotStore.getSnapshot().status === 'closed' ? 'closed' : 'active';
    },
    get generation() {
      return runtime.connectionGeneration;
    },
    snapshotStore: runtime.snapshotStore,
    subscribe: (listener) => runtime.snapshotStore.subscribe(listener),
    prepareAppControl: async () => undefined,
    connect: async () => {
      options.onConnect?.();
    },
    reconnect: async () => {
      options.onReconnect?.();
      await runtime.reconnect();
    },
    close: async () => runtime.close('tui-test-close'),
    [Symbol.asyncDispose]: async () => runtime.close('tui-test-dispose'),
  } as KiteAppServerConnection;
  return createNativeTuiRuntimeClient({
    connection,
    workspace: '/tmp/tui-client-workspace',
    ...(options.initialInteractionMode === undefined
      ? {}
      : { initialInteractionMode: options.initialInteractionMode }),
    ...(options.flushPresentation === undefined
      ? {}
      : { flushPresentation: options.flushPresentation }),
  });
}

function subscriptionUpdate(subscriptionId: string, generation: number, message: object): object {
  return {
    jsonrpc: '2.0',
    method: 'runtime/subscription',
    params: { subscriptionId, generation, message },
  };
}
