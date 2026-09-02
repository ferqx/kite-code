import { expect, test } from 'bun:test';
import type { KiteAppControlClient } from '@kite-ai/kite-app-contract';
import {
  WORKER_CONTROLLER_RESPONSE_SCHEMA_,
  type WorkerControllerClient,
  type WorkerControllerDurableOperation,
  type WorkerControllerMutationResponse,
} from '@kite-ai/kite-app-contract/worker-controller';
import type {
  KiteAppServerConnection,
  LocalKiteConnection,
  LocalRuntimeServiceDescriptor,
} from '@kite-ai/kite-local-runtime/client';
import { LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_ } from '@kite-ai/kite-local-runtime/client';
import type {
  RuntimeClientConnection,
  RuntimeClientTransport,
  RuntimeHistoryClient,
} from '@kite-ai/runtime-client';
import { RuntimeClient } from '@kite-ai/runtime-client';
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
  const connection: LocalKiteConnection = {
    runtime,
    history: history(),
    app: {} as KiteAppControlClient,
    credential: {
      writeProviderCredential: async () => {
        throw new Error('not used');
      },
    },
    service: descriptor(),
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
      if (action.type === 'RUNTIME_EVENT') events.push(action.event.type);
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
      if (action.type === 'RUNTIME_EVENT') events.push(action.event.type);
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
  expect(remote.interactionExpectedRevisions).toEqual([4, 5]);

  session!.setLocalReplayRecovery(true);
  const continued = await facade.forkRecoveredSessionForContinuation(sessionId);
  expect(continued?.threadId).toBe('service-created-fork-session');
  await facade.waitForSessionReady('service-created-fork-session');
  expect(remote.commands).toContain('fork_session');
  expect(remote.commands).toContain('resume_session');

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
    active: true,
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

test('Native TUI facade completes an active run from an idle snapshot after a subscription gap', async () => {
  const remote = new FakeRuntimeConnection();
  remote.finishNextTurnWithSnapshot();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const actions: SessionPresentationAction[] = [];

  await facade.getRuntime(sessionId)!.runTask('finish from snapshot', {
    dispatch: (action) => actions.push(action),
  });

  expect(actions).toContainEqual({
    type: 'RECONCILE_RUNTIME_PROJECTION',
    active: false,
    interactionQueue: { revision: 3, interactions: [] },
  });
  await facade.dispose();
});

test('Native TUI facade polls an accepted run when its Run terminal notification is absent', async () => {
  const remote = new FakeRuntimeConnection();
  remote.finishNextTurnWithoutRunTerminal();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);

  await Promise.race([
    facade.getRuntime(sessionId)!.runTask('recover terminal notification gap', {
      dispatch: () => {},
    }),
    Bun.sleep(3_500).then(() => {
      throw new Error('Accepted Runtime turn did not recover from a terminal notification gap.');
    }),
  ]);

  expect(remote.idleQueryRevisions).toContain(3);
  await facade.dispose();
});

test('Native TUI facade hands a late idle query to the current accepted turn', async () => {
  const remote = new FakeRuntimeConnection();
  remote.overlapIdleWaitersOnConsecutiveTurns();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);
  const session = facade.getRuntime(sessionId)!;

  await session.runTask('first turn with delayed idle query', { dispatch: () => {} });
  await Promise.race([
    session.runTask('second turn after event-free idle', { dispatch: () => {} }),
    Bun.sleep(1_000).then(() => {
      throw new Error(
        `The current accepted Runtime turn did not consume authoritative idle: ${remote.idleQueryRevisions.join(',')}`,
      );
    }),
  ]);

  expect(remote.commands.filter((command) => command === 'start_turn')).toHaveLength(2);
  expect(remote.idleQueryRevisions).toContain(7);
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
        if (action.type === 'RUNTIME_EVENT') events.push(action.event.type);
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
    active: false,
    interactionQueue: expect.anything(),
  });
  expect(
    actions.some(
      (action) => action.type === 'RUNTIME_EVENT' && action.event.type === 'run.terminal',
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

test('Native TUI facade bounds repeated start conflicts and preserves one command identity', async () => {
  const remote = new FakeRuntimeConnection();
  remote.advanceRevisionBeforeEveryStartTurn();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);

  await expect(
    facade.getRuntime(sessionId)!.runTask('never admitted', { dispatch: () => {} }),
  ).rejects.toThrow('revision_conflict');
  expect(remote.startTurnExpectedRevisions).toEqual([1, 2, 3]);
  expect(new Set(remote.startTurnCommandIds).size).toBe(1);
  await facade.dispose();
});

test('Native TUI facade converges when terminal projection arrives before the command receipt', async () => {
  const remote = new FakeRuntimeConnection();
  remote.deliverNextStartTurnReceiptAfterTerminalProjection();
  const facade = facadeFor(remote);
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);

  await facade.getRuntime(sessionId)!.runTask('out-of-order transport', { dispatch: () => {} });

  expect(remote.deferredTurnDeliveryOrder).toEqual(['terminal_projection', 'command_receipt']);
  expect(remote.startTurnExpectedRevisions).toEqual([1]);
  await facade.dispose();
});

test('Native TUI opens an existing Session as Observer, then acquires its lease without reconnecting', async () => {
  const remote = new FakeRuntimeConnection();
  const controllerCalls: string[] = [];
  const controller = createControllerClient('service-tui-test', controllerCalls);
  let connectCalls = 0;
  let reconnectCalls = 0;
  const facade = facadeFor(remote, {
    controller,
    onConnect: () => {
      connectCalls += 1;
    },
    onReconnect: () => {
      reconnectCalls += 1;
    },
  });
  const session = facade.registerSession('existing-session', '/tmp/tui-client-workspace');
  await facade.waitForSessionReady('existing-session');

  await session.runTask('mutate existing session', { dispatch: () => {} });

  expect(connectCalls).toBe(1);
  expect(reconnectCalls).toBe(0);
  expect(remote.commands).not.toContain('resume_session');
  expect(remote.commands).toContain('start_turn');
  expect(controllerCalls).toEqual([
    'read:existing-session',
    'request:existing-session',
    'read:existing-session',
  ]);
  await facade.dispose();
  expect(remote.commands).not.toContain('cancel_turn');
});

test('App Server TUI keeps historical open observer-only and resumes on the first mutation', async () => {
  const remote = new FakeRuntimeConnection();
  const facade = facadeFor(remote, { appServer: true, initialInteractionMode: 'full' });
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

test('Native TUI releases every confirmed-idle Session lease on dispose without cancelling Turns', async () => {
  const remote = new FakeRuntimeConnection();
  const controllerCalls: string[] = [];
  const controller = createControllerClient('service-tui-test', controllerCalls);
  const facade = facadeFor(remote, { controller });
  const first = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(first);
  const second = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(second);

  await facade.dispose();

  expect(controllerCalls.filter((call) => call.startsWith('release:'))).toEqual([
    `release:${first}`,
    `release:${second}`,
  ]);
  expect(controllerCalls.filter((call) => call.startsWith('detach:'))).toEqual([]);
  expect(controllerCalls.filter((call) => call.startsWith('create:'))).toEqual([
    `create:${first}`,
    `create:${second}`,
  ]);
  expect(remote.commands).not.toContain('create_session');
  expect(remote.commands).not.toContain('cancel_turn');
  expect(remote.closeCalls).toBe(1);
});

test('Native TUI detaches an active Session lease on dispose without cancelling its Turn', async () => {
  const remote = new FakeRuntimeConnection();
  remote.restoreActiveTurnOnSubscribe();
  const controllerCalls: string[] = [];
  const controller = createControllerClient('service-tui-test', controllerCalls);
  const facade = facadeFor(remote, { controller });
  const sessionId = facade.createSession('/tmp/tui-client-workspace');
  await facade.waitForSessionReady(sessionId);

  await facade.dispose();

  expect(controllerCalls.filter((call) => call.startsWith('detach:'))).toEqual([
    `detach:${sessionId}`,
  ]);
  expect(controllerCalls.filter((call) => call.startsWith('release:'))).toEqual([]);
  expect(remote.commands).not.toContain('cancel_turn');
  expect(remote.closeCalls).toBe(1);
});

class FakeRuntimeConnection implements RuntimeClientConnection {
  readonly commands: string[] = [];
  readonly interactionExpectedRevisions: number[] = [];
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
  #advanceRevisionOnEveryStart = false;
  #deferNextStartTurnReceipt = false;
  #overlapIdleWaiters = false;
  #omitSecondTerminalNotification = false;
  #terminalGapOnNextTurn = false;
  #delayedIdleQueries = 0;
  #startTurnOrdinal = 0;
  #currentRunId = 'run-0';
  readonly #subscriptionBySession = new Map<string, string>();

  requestApprovalOnNextTurn(): void {
    this.#approvalOnNextTurn = true;
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

  advanceRevisionBeforeEveryStartTurn(): void {
    this.#advanceRevisionOnEveryStart = true;
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
    this.#authoritativeRevision = 4;
    this.push(
      subscriptionUpdate(this.#subscriptionBySession.get(sessionId)!, 1, {
        type: 'notification',
        durability: 'durable',
        sessionId,
        revision: 4,
        session: projection(sessionId, 4, 'running'),
        event: {
          type: 'interaction.available',
          interaction: {
            kind: 'approval',
            interactionId: 'approval-native-receipt',
            sessionRevision: 4,
            generation: 0,
            grants: ['approve_once'],
            command: 'echo approved',
            title: 'shell_execute',
            summary: 'Approve a shell command',
          },
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
        this.push(
          subscriptionUpdate(subscriptionId, 1, {
            type: 'notification',
            durability: 'durable',
            sessionId,
            revision: 1,
            session: this.#restoreActiveTurn
              ? projection(sessionId, 1, 'running')
              : projection(sessionId, 1, 'completed'),
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
        if (query.type === 'get_session_projection') {
          const respond = () => {
            const session = this.#overlapIdleWaiters
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
        if (this.interactionExpectedRevisions.length === 1) {
          this.#authoritativeRevision = 5;
          this.push(
            result(message.id, {
              status: 'conflict',
              commandId: command.commandId,
              code: 'revision_conflict',
              currentRevision: 5,
            }),
          );
          return;
        }
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
      if (command.type === 'start_turn') {
        this.#startTurnOrdinal += 1;
        this.#currentRunId = `run-${this.#startTurnOrdinal}`;
        this.startTurnExpectedRevisions.push(command.expectedRevision);
        this.startTurnCommandIds.push(command.commandId);
        if (this.#nextStartTurnConflictRevision !== undefined) {
          this.#authoritativeRevision = this.#nextStartTurnConflictRevision;
          this.#nextStartTurnConflictRevision = undefined;
        }
        if (this.#advanceRevisionOnEveryStart) {
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
        const acceptedRevision = command.expectedRevision + 1;
        const terminalRevision = acceptedRevision + 1;
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
        if (this.#approvalOnNextTurn) {
          this.#approvalOnNextTurn = false;
          this.#emitApproval(command.sessionId);
          return;
        }
        if (this.#approvalSnapshotOnNextTurn) {
          this.#approvalSnapshotOnNextTurn = false;
          this.#authoritativeRevision = 4;
          this.push(
            subscriptionUpdate(this.#subscriptionBySession.get(command.sessionId)!, 1, {
              type: 'notification',
              durability: 'durable',
              sessionId: command.sessionId,
              revision: 4,
              session: projection(command.sessionId, 4, 'waiting', {
                kind: 'approval',
                interactionId: 'approval-native-receipt',
                sessionRevision: 4,
                generation: 0,
                grants: ['approve_once'],
                command: 'echo approved',
                title: 'shell_execute',
                summary: 'Approve a shell command',
              }),
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
          };
          const replacement = {
            kind: 'approval' as const,
            interactionId: 'approval-replacement',
            sessionRevision: 5,
            generation: 0,
            grants: ['approve_once'] as const,
          };
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
          this.push(commandReceipt);
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

function descriptor(): LocalRuntimeServiceDescriptor {
  return {
    schema: 'kite.local-runtime-service.v1',
    instanceId: 'service-tui-test',
    pid: 1,
    startedAt: '2026-08-27T00:00:00.000Z',
    endpoint: {
      origin: 'http://127.0.0.1:43123',
      websocketUrl: 'ws://127.0.0.1:43123/rpc',
    },
    protocolVersion: 1,
    clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    serverVersion: 'test',
    buildId: 'test',
  };
}

function result(id: string | number | null, value: object): object {
  return { jsonrpc: '2.0', id, result: value };
}

function initializeResult(instanceId: string): object {
  return {
    protocolVersion: 1,
    protocolSchema: 'kite.runtime-protocol.v1',
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

function projection(
  sessionId: string,
  revision: number,
  status: 'running' | 'waiting' | 'completed',
  interaction?: import('@kite-ai/runtime-contract').RuntimeClientInteraction,
) {
  return {
    schema: 'kite.runtime-projection.v1',
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
    activeWork: {
      workId: 'work-1',
      phase: 'building',
      status,
      activeTurn: {
        turnId: 'turn-1',
        status,
        ...(interaction === undefined ? {} : { interaction }),
      },
    },
  };
}

function idleProjection(sessionId: string, revision: number) {
  return {
    schema: 'kite.runtime-projection.v1',
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
    readonly appServer?: boolean;
    readonly controller?: WorkerControllerClient;
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
    ...(options.appServer ? {} : { service: descriptor() }),
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
    ...(options.controller === undefined ? {} : { controller: options.controller }),
  } as
    | KiteAppServerConnection
    | (LocalKiteConnection & { readonly controller?: WorkerControllerClient });
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

interface TestControllerState {
  status: 'idle' | 'active' | 'detached';
  controllerGeneration: number;
  connectionGeneration: number;
  interactionGeneration: number;
  clientId: string | null;
  workerInstanceId: string | null;
}

function createControllerClient(workerInstanceId: string, calls: string[]): WorkerControllerClient {
  const states = new Map<string, TestControllerState>();
  const stateFor = (sessionId: string): TestControllerState => {
    const current = states.get(sessionId);
    if (current) return current;
    const initial: TestControllerState = {
      status: 'idle',
      controllerGeneration: 0,
      connectionGeneration: 0,
      interactionGeneration: 0,
      clientId: null,
      workerInstanceId: null,
    };
    states.set(sessionId, initial);
    return initial;
  };
  const operation = (
    request: {
      readonly sessionId: string;
      readonly requestId: string;
      readonly requestDigest: string;
    },
    operationName: WorkerControllerDurableOperation,
    state: TestControllerState,
  ): WorkerControllerMutationResponse => ({
    schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
    operation: operationName,
    status: 'applied',
    receipt: {
      schema: 'kite.app.worker-controller.receipt.v1',
      sessionId: request.sessionId,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      operation: operationName,
      status: 'applied',
      code: operationName === 'request_control' ? 'acquired' : 'detached',
      controllerGeneration: state.controllerGeneration,
      connectionGeneration: state.connectionGeneration,
      interactionGeneration: state.interactionGeneration,
      clientId: state.clientId,
      workerInstanceId: state.workerInstanceId,
      completedAt: 1,
    },
    ...(operationName === 'request_control'
      ? {
          lease: {
            sessionId: request.sessionId,
            clientId: state.clientId!,
            connectionGeneration: state.connectionGeneration,
            controllerGeneration: state.controllerGeneration,
            workerInstanceId,
            status: 'active' as const,
          },
        }
      : {}),
  });
  return {
    async createSession(request) {
      calls.push(`create:${request.sessionId}`);
      const created: TestControllerState = {
        status: 'active',
        controllerGeneration: 1,
        connectionGeneration: 1,
        interactionGeneration: 0,
        clientId: 'client-tui-test',
        workerInstanceId,
      };
      states.set(request.sessionId, created);
      const durable = operation(request, 'request_control', created);
      return { ...durable, operation: 'create_session', sessionRevision: 1 };
    },
    async read(request) {
      calls.push(`read:${request.sessionId}`);
      const state = stateFor(request.sessionId);
      return {
        schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
        operation: 'read_controller',
        state: {
          sessionId: request.sessionId,
          status: state.status,
          controllerGeneration: state.controllerGeneration,
          connectionGeneration: state.connectionGeneration,
          clientId: state.clientId,
          workerInstanceId: state.workerInstanceId,
          interactionGeneration: state.interactionGeneration,
          resumeCapabilityExpiresAtMs: null,
        },
      };
    },
    async requestControl(request) {
      calls.push(`request:${request.sessionId}`);
      const state = stateFor(request.sessionId);
      if (state.status === 'active') throw new Error('Controller is busy.');
      const active: TestControllerState = {
        ...state,
        status: 'active',
        controllerGeneration: state.controllerGeneration + 1,
        connectionGeneration: 1,
        clientId: 'client-tui-test',
        workerInstanceId,
      };
      states.set(request.sessionId, active);
      return operation(request, 'request_control', active);
    },
    async releaseControl(request) {
      calls.push(`release:${request.sessionId}`);
      const state = stateFor(request.sessionId);
      states.set(request.sessionId, {
        ...state,
        status: 'idle',
        controllerGeneration: state.controllerGeneration + 1,
        clientId: null,
        workerInstanceId: null,
      });
      return operation(request, 'release_control', state);
    },
    async detach(request) {
      calls.push(`detach:${request.sessionId}`);
      const state = stateFor(request.sessionId);
      states.set(request.sessionId, { ...state, status: 'detached' });
      return operation(request, 'detach_controller', state);
    },
    async issueResumeCapability() {
      throw new Error('unused');
    },
    async resume() {
      throw new Error('unused');
    },
    async mintDetachedRecoveryCapability() {
      throw new Error('unused');
    },
    async abandonDetachedController() {
      throw new Error('unused');
    },
    async validateResumeCapability() {
      return {
        schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
        operation: 'validate_resume_capability',
        status: 'missing',
      };
    },
  };
}

function subscriptionUpdate(subscriptionId: string, generation: number, message: object): object {
  return {
    jsonrpc: '2.0',
    method: 'runtime/subscription',
    params: { subscriptionId, generation, message },
  };
}
