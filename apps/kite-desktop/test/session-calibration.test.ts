import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createBunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeClientConnection } from '@kite-ai/runtime-client';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../../../packages/kite-client-ui/src/Conversation';
import { startTestHttpServer } from '../../../tests/helpers/test-http-server';
import {
  createMockModelServer,
  type MockResponse,
} from '../../../tests/tui-system/harness/fixtures';
import { CommandResultUnknown, DesktopClient } from '../src/client';
import { createTestDesktopBridge, type DesktopTestCall } from './desktop-bridge';

// Real Service, with response gates at the renderer IPC boundary. No private client state is patched.
async function fixture(
  responses: MockResponse[] = [],
  providerBaseURL?: string,
  options?: { readonly childSessions?: boolean },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-session-cache-')));
  for (const name of ['workspace', 'home', 'runtime', 'config'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const workspace = join(root, 'workspace');
  const model = createMockModelServer();
  model.setResponses(responses);
  writeFileSync(
    join(root, 'config/kite-code.jsonc'),
    JSON.stringify({
      provider: {
        test: {
          type: 'openai-compatible',
          apiKey: 'fixture',
          baseURL: providerBaseURL ?? model.baseURL,
          model: 'mock-model',
          models: ['mock-model'],
        },
      },
      model: { default: { provider: 'test', name: 'mock-model' } },
      interactionMode: 'accept_edits',
      ...(options?.childSessions
        ? { features: { resourceBudget: true, boundedCancellation: true } }
        : {}),
      sandbox: { enabled: false },
      mcpServers: {},
    }),
  );
  let generation = 0;
  let detachRequests = 0;
  let failNextRuntimeOpen = false;
  let nextRuntimeOpenGate: ReturnType<typeof gate> | undefined;
  let historyRequests = 0;
  let droppedEvent: string | undefined;
  let nextLiveFailure: 'projection' | 'subscription' | undefined;
  let nextSubscriptionGate: ReturnType<typeof gate> | undefined;
  let nextSubscriptionScope: 'child_session' | undefined;
  let nextChildProjectionGate: ReturnType<typeof gate> | undefined;
  let nextChildHistoryGate: ReturnType<typeof gate> | undefined;
  let nextChildListGate: ReturnType<typeof gate> | undefined;
  let nextBackgroundGate: { sessionId: string; gate: ReturnType<typeof gate> } | undefined;
  let nextBackgroundOverride: { sessionId: string; status: 'running' | 'completed' } | undefined;
  const backgroundOverrides = new Map<
    unknown,
    { sessionId: string; status: 'running' | 'completed' }
  >();
  let omitNextChildList = false;
  let failNextChildList = false;
  let notFoundNextChildProjection = false;
  const notFoundChildProjections = new Set<unknown>();
  let nextFailure: 'temporary' | 'unauthorized' | 'missing' | undefined;
  let nextGate: ReturnType<typeof gate> | undefined;
  let nextDirectoryGate: ReturnType<typeof gate> | undefined;
  let nextCreationGate: ReturnType<typeof gate> | undefined;
  const lostCreations = new Set<unknown>();
  const lostSteers = new Set<unknown>();
  let loseNextSteer = false;
  let staleNextSendProjection: 'idle' | 'active_on_refresh' | 'stale_on_refresh' | undefined;
  let refreshProjectionAfterConflict: 'active' | 'stale' | undefined;
  const sendCommands: Array<{ type: string; commandId: string }> = [];
  const backgroundQueries: Array<{ sessionId: string; parentRunStatus: string | undefined }> = [];
  let childSubscriptionRequests = 0;
  let childHistoryRequests = 0;
  let childListRequests = 0;
  let parentSubscriptionRequests = 0;
  let unsubscribeRequests = 0;
  let cancelCommands = 0;
  let indexResetEnds = 0;
  const rewrittenProjections = new Map<unknown, 'stale' | 'active'>();
  const omittedChildLists = new Set<unknown>();
  const bufferedMessages: unknown[] = [];
  let injectedMode: 'auto' | 'full' = 'auto';
  const allGates: ReturnType<typeof gate>[] = [];
  const gated = new Map<unknown, ReturnType<typeof gate>>();
  const failures = new Map<unknown, NonNullable<typeof nextFailure>>();
  const carriers = new Map<
    number,
    { connection: RuntimeClientConnection; messages: AsyncIterator<unknown> }
  >();
  const call: DesktopTestCall = async <T>(command: string, args?: Record<string, unknown>) => {
    if (command === 'runtime_status') return { workspace, connectionId: generation || null } as T;
    if (command === 'activate_workspace' || command === 'pick_workspace') return workspace as T;
    if (command === 'list_projects') return [{ path: workspace, lastOpenedAt: 1 }] as T;
    if (command === 'runtime_detach') {
      detachRequests++;
      return undefined as T;
    }
    if (command === 'check_workspace' || command === 'remove_workspace') return undefined as T;
    if (command === 'query_workspace_branch')
      return {
        workspace,
        repository: false,
        root: null,
        current: null,
        head: null,
        branches: [],
        dirty: false,
        canSwitch: false,
      } as T;
    if (command === 'runtime_open') {
      if (nextRuntimeOpenGate) {
        const opening = nextRuntimeOpenGate;
        nextRuntimeOpenGate = undefined;
        opening.arrive();
        await opening.released;
      }
      if (failNextRuntimeOpen) {
        failNextRuntimeOpen = false;
        throw new Error('fixture first reconnect failed');
      }
      const connection = await createBunStdioChildRuntimeClientTransport({
        argv: [
          process.execPath,
          resolve('scripts/release/entrypoints/service.ts'),
          'app-server',
          'run-stdio',
        ],
        cwd: '/',
        env: {
          KITE_CODE_HOME: join(root, 'runtime'),
          KITE_CODE_CONFIG_HOME: join(root, 'config'),
          KITE_APP_SERVER_WORKSPACE: workspace,
          KITE_APP_SERVER_BUILD_ID: 'session-cache-test',
          HOME: join(root, 'home'),
          USERPROFILE: join(root, 'home'),
          PATH: process.env.PATH ?? '/usr/bin:/bin',
        },
      }).connect();
      carriers.set(++generation, {
        connection,
        messages: connection.messages()[Symbol.asyncIterator](),
      });
      return {
        connectionId: generation,
        workspace,
        expectedServerVersion: kiteAppServerVersion('session-cache-test'),
      } as T;
    }
    const carrier = carriers.get(args?.connectionId as number)!;
    if (command === 'runtime_send') {
      const message = JSON.parse(args?.frame as string);
      if (
        message.method === 'runtime/query' &&
        message.params.query.type === 'list_background_executions'
      ) {
        backgroundQueries.push({
          sessionId: message.params.query.sessionId,
          parentRunStatus: client.getSnapshot().projection?.currentRun?.status,
        });
        const backgroundGate = nextBackgroundGate;
        if (backgroundGate && backgroundGate.sessionId === message.params.query.sessionId) {
          gated.set(message.id, backgroundGate.gate);
          nextBackgroundGate = undefined;
        }
        const backgroundOverride = nextBackgroundOverride;
        if (backgroundOverride && backgroundOverride.sessionId === message.params.query.sessionId) {
          backgroundOverrides.set(message.id, backgroundOverride);
          nextBackgroundOverride = undefined;
        }
      }
      if (
        message.method === 'runtime/query' &&
        message.params.query.type === 'get_child_session_projection' &&
        nextChildProjectionGate
      ) {
        gated.set(message.id, nextChildProjectionGate);
        nextChildProjectionGate = undefined;
      }
      if (
        message.method === 'runtime/query' &&
        message.params.query.type === 'get_child_session_projection' &&
        notFoundNextChildProjection
      ) {
        notFoundChildProjections.add(message.id);
        notFoundNextChildProjection = false;
      }
      if (message.method === 'history/load_child_session') {
        childHistoryRequests++;
        if (nextChildHistoryGate) {
          gated.set(message.id, nextChildHistoryGate);
          nextChildHistoryGate = undefined;
        }
      }
      if (
        message.method === 'runtime/query' &&
        message.params.query.type === 'list_child_sessions'
      ) {
        childListRequests++;
        if (nextChildListGate) {
          gated.set(message.id, nextChildListGate);
          nextChildListGate = undefined;
        }
        if (omitNextChildList) {
          omittedChildLists.add(message.id);
          omitNextChildList = false;
        }
        if (failNextChildList) {
          failures.set(message.id, 'temporary');
          failNextChildList = false;
        }
      }
      if (
        message.method === 'runtime/subscribe' &&
        message.params.subscription.scope === 'child_session'
      )
        childSubscriptionRequests++;
      if (message.method === 'runtime/subscribe' && message.params.subscription.scope === 'session')
        parentSubscriptionRequests++;
      if (message.method === 'runtime/unsubscribe') unsubscribeRequests++;
      if (message.method === 'runtime/command' && message.params?.command?.type === 'cancel_turn')
        cancelCommands++;
      if (
        message.method === 'runtime/query' &&
        message.params.query.type === 'get_session_projection' &&
        staleNextSendProjection
      ) {
        rewrittenProjections.set(message.id, refreshProjectionAfterConflict ?? 'stale');
        if (refreshProjectionAfterConflict) {
          staleNextSendProjection = undefined;
          refreshProjectionAfterConflict = undefined;
        } else if (staleNextSendProjection === 'active_on_refresh') {
          refreshProjectionAfterConflict = 'active';
        } else if (staleNextSendProjection === 'stale_on_refresh') {
          refreshProjectionAfterConflict = 'stale';
        } else {
          staleNextSendProjection = undefined;
        }
      }
      if (
        message.method === 'runtime/command' &&
        (message.params?.command?.type === 'start_turn' ||
          message.params?.command?.type === 'steer_turn')
      )
        sendCommands.push({
          type: message.params.command.type,
          commandId: message.params.command.commandId,
        });
      // This fixture keeps a lost creation genuinely unknown: its receipt read is unavailable too.
      if (
        message.method === 'runtime/query' &&
        message.params.query.type === 'get_command_receipt' &&
        message.params.query.command.type === 'create_session'
      )
        failures.set(message.id, 'temporary');
      if (
        loseNextSteer &&
        message.method === 'runtime/command' &&
        message.params?.command?.type === 'steer_turn'
      ) {
        lostSteers.add(message.id);
        loseNextSteer = false;
      }
      if (
        message.method === 'runtime/command' &&
        message.params?.command?.type === 'create_session' &&
        nextCreationGate
      ) {
        gated.set(message.id, nextCreationGate);
        lostCreations.add(message.id);
        nextCreationGate = undefined;
      }
      if (
        (nextLiveFailure === 'projection' &&
          message.method === 'runtime/query' &&
          message.params.query.type === 'get_session_projection') ||
        (nextLiveFailure === 'subscription' && message.method === 'runtime/subscribe')
      ) {
        failures.set(message.id, 'temporary');
        nextLiveFailure = undefined;
      }
      if (
        message.method === 'runtime/subscribe' &&
        nextSubscriptionGate &&
        (!nextSubscriptionScope || message.params.subscription.scope === nextSubscriptionScope)
      ) {
        gated.set(message.id, nextSubscriptionGate);
        nextSubscriptionGate = undefined;
        nextSubscriptionScope = undefined;
      }
      if (message.method === 'history/load_session') {
        historyRequests++;
        if (nextGate) {
          gated.set(message.id, nextGate);
          nextGate = undefined;
        }
        if (nextFailure) {
          failures.set(message.id, nextFailure);
          nextFailure = undefined;
        }
      }
      if (message.method === 'history/list_sessions' && nextDirectoryGate) {
        const directoryGate = nextDirectoryGate;
        nextDirectoryGate = undefined;
        directoryGate.arrive();
        await directoryGate.released;
      }
      await carrier.connection.send(message);
    } else if (command === 'runtime_receive') {
      let item = bufferedMessages.length
        ? { done: false as const, value: bufferedMessages.shift() }
        : await carrier.messages.next();
      const eventType = (value: unknown) => {
        const frame = value as {
          method?: string;
          params?: { message?: { durability?: string; event?: { type?: string } } };
        };
        return frame.method === 'runtime/subscription' &&
          frame.params?.message?.durability === 'durable'
          ? frame.params.message.event?.type
          : undefined;
      };
      if (!item.done && droppedEvent && eventType(item.value) === droppedEvent) {
        droppedEvent = undefined;
        item = await carrier.messages.next();
      }
      if (item.done) throw new Error('closed');
      const message = item.value as { id?: unknown };
      if (omittedChildLists.delete(message.id)) {
        const response = structuredClone(message) as {
          result?: { childSessions?: unknown[]; nextChildCursor?: unknown };
        };
        if (!response.result) throw new Error('Expected child-list fixture response');
        response.result.childSessions = [];
        delete response.result.nextChildCursor;
        return JSON.stringify(response) as T;
      }
      if (notFoundChildProjections.delete(message.id)) {
        const response = structuredClone(message) as {
          result?: { status?: string; queryType?: string; code?: string };
        };
        if (response.result?.queryType !== 'get_child_session_projection')
          throw new Error('Expected child-projection fixture response');
        response.result = {
          status: 'not_found',
          queryType: 'get_child_session_projection',
          code: 'session_not_found',
        };
        return JSON.stringify(response) as T;
      }
      if (
        (message as { params?: { message?: { type?: string } } }).params?.message?.type ===
        'index_reset_end'
      )
        indexResetEnds++;
      const waiting = gated.get(message.id);
      if (waiting) {
        gated.delete(message.id);
        waiting.arrive();
        await waiting.released;
      }
      const backgroundOverride = backgroundOverrides.get(message.id);
      if (backgroundOverride) {
        backgroundOverrides.delete(message.id);
        const response = structuredClone(message) as {
          result?: {
            status?: string;
            backgroundSnapshot?: {
              sessionId: string;
              sessionRevision: number;
              aggregateGeneration: string;
              watermark: number;
              executions: unknown[];
            };
          };
        };
        if (response.result?.status !== 'ok' || !response.result.backgroundSnapshot)
          throw new Error('Expected background list fixture response');
        const snapshot = response.result.backgroundSnapshot;
        snapshot.aggregateGeneration = `fixture-${backgroundOverride.sessionId}`;
        snapshot.watermark += 1;
        snapshot.executions = [
          {
            executionId: 'fixture-shell',
            sessionId: backgroundOverride.sessionId,
            sessionRevision: snapshot.sessionRevision,
            kind: 'shell',
            status: backgroundOverride.status,
            ownerGeneration: 'fixture-shell-owner',
            revision: snapshot.watermark,
            cleanupConfirmed: backgroundOverride.status === 'completed',
            cursor: 1,
          },
        ];
        return JSON.stringify(response) as T;
      }
      if (lostCreations.delete(message.id))
        return JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: 'fixture lost creation receipt',
            data: { code: 'internal_error' },
          },
        }) as T;
      if (lostSteers.delete(message.id))
        return JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: 'fixture lost steer receipt',
            data: { code: 'internal_error' },
          },
        }) as T;
      const failure = failures.get(message.id);
      if (failure) {
        failures.delete(message.id);
        return JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: failure === 'unauthorized' ? -32005 : -32603,
            message: 'fixture history failure',
            data: {
              code: failure === 'unauthorized' ? 'unauthorized' : 'internal_error',
              ...(failure === 'missing' ? { detailCode: 'session_not_found' } : {}),
            },
          },
        }) as T;
      }
      const rewrite = rewrittenProjections.get(message.id);
      if (rewrite) {
        rewrittenProjections.delete(message.id);
        const response = structuredClone(message) as {
          result?: {
            session?: {
              sessionId: string;
              revision: number;
              currentRun?: Record<string, unknown>;
            };
          };
        };
        const session = response.result?.session;
        if (!session) throw new Error('Expected a Session projection fixture response');
        if (rewrite === 'stale') {
          const commandId = crypto.randomUUID();
          const requestId = `injected-revision-${commandId}`;
          await carrier.connection.send({
            jsonrpc: '2.0',
            id: requestId,
            method: 'runtime/command',
            params: {
              command: {
                schema: 'kite.runtime-command.v1',
                commandId,
                type: 'set_interaction_mode',
                sessionId: session.sessionId,
                expectedRevision: session.revision,
                mode: injectedMode,
              },
            },
          });
          injectedMode = injectedMode === 'auto' ? 'full' : 'auto';
          for (;;) {
            const injected = await carrier.messages.next();
            if (injected.done) throw new Error('Fixture Runtime closed during revision injection');
            const injectedMessage = injected.value as {
              id?: unknown;
              result?: { status?: string };
            };
            if (injectedMessage.id === requestId) {
              if (injectedMessage.result?.status !== 'applied')
                throw new Error('Fixture could not advance the Session revision');
              break;
            }
            bufferedMessages.push(injected.value);
          }
        } else
          session.currentRun = {
            runId: 'concurrent-run',
            initialTurnId: 'concurrent-turn',
            activeTurnId: 'concurrent-turn',
            status: 'running',
            revision: session.revision,
          };
        return JSON.stringify(response) as T;
      }
      return JSON.stringify(message) as T;
    } else if (command === 'runtime_close') await carrier.connection.close();
    else throw new Error(`Unexpected IPC ${command}`);
    return undefined as T;
  };
  const client = new DesktopClient(createTestDesktopBridge(call));
  await client.activateProject(workspace);
  const a = await client.newSession();
  await client.selectSession(a);
  const b = await client.newSession();
  await client.selectSession(b);
  await client.refreshSessions();
  return {
    client,
    a,
    b,
    model,
    dropLiveEvent(type: string) {
      droppedEvent = type;
    },
    holdSubscription(scope?: 'child_session') {
      nextSubscriptionGate = gate();
      nextSubscriptionScope = scope;
      allGates.push(nextSubscriptionGate);
      return nextSubscriptionGate;
    },
    holdChildProjection() {
      nextChildProjectionGate = gate();
      allGates.push(nextChildProjectionGate);
      return nextChildProjectionGate;
    },
    holdChildHistory() {
      nextChildHistoryGate = gate();
      allGates.push(nextChildHistoryGate);
      return nextChildHistoryGate;
    },
    holdChildList() {
      nextChildListGate = gate();
      allGates.push(nextChildListGate);
      return nextChildListGate;
    },
    holdRuntimeOpen() {
      nextRuntimeOpenGate = gate();
      allGates.push(nextRuntimeOpenGate);
      return nextRuntimeOpenGate;
    },
    holdBackground(sessionId: string) {
      const held = gate();
      nextBackgroundGate = { sessionId, gate: held };
      allGates.push(held);
      return held;
    },
    injectBackground(sessionId: string, status: 'running' | 'completed') {
      nextBackgroundOverride = { sessionId, status };
    },
    get childHistoryRequests() {
      return childHistoryRequests;
    },
    get childListRequests() {
      return childListRequests;
    },
    omitOneChildList() {
      omitNextChildList = true;
    },
    failOneChildList() {
      failNextChildList = true;
    },
    notFoundChildProjection() {
      notFoundNextChildProjection = true;
    },
    get childSubscriptionRequests() {
      return childSubscriptionRequests;
    },
    get parentSubscriptionRequests() {
      return parentSubscriptionRequests;
    },
    get unsubscribeRequests() {
      return unsubscribeRequests;
    },
    get cancelCommands() {
      return cancelCommands;
    },
    get indexResetEnds() {
      return indexResetEnds;
    },
    failLiveRead(kind: 'projection' | 'subscription') {
      nextLiveFailure = kind;
    },
    get historyRequests() {
      return historyRequests;
    },
    failHistory(failure: NonNullable<typeof nextFailure>) {
      nextFailure = failure;
    },
    holdHistory() {
      nextGate = gate();
      allGates.push(nextGate);
      return nextGate;
    },
    holdDirectory() {
      nextDirectoryGate = gate();
      allGates.push(nextDirectoryGate);
      return nextDirectoryGate;
    },
    holdUnknownCreation() {
      nextCreationGate = gate();
      allGates.push(nextCreationGate);
      return nextCreationGate;
    },
    loseNextSteerReceipt() {
      loseNextSteer = true;
    },
    staleNextStartProjection(refresh: 'idle' | 'active' | 'stale' = 'idle') {
      staleNextSendProjection = refresh === 'idle' ? 'idle' : `${refresh}_on_refresh`;
    },
    get sendCommands() {
      return sendCommands;
    },
    get backgroundQueries() {
      return backgroundQueries;
    },
    get connectionGeneration() {
      return generation;
    },
    get detachRequests() {
      return detachRequests;
    },
    failOneReconnect() {
      failNextRuntimeOpen = true;
    },
    async dropCurrentTransport() {
      await carriers.get(generation)?.connection.close();
    },
    async close() {
      for (const pending of allGates) pending.release();
      for (const pending of gated.values()) pending.release();
      await client.disconnect();
      for (const carrier of carriers.values()) await carrier.connection.close();
      model.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function gate() {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrive, release, arrived, released };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Service state did not settle');
    await Bun.sleep(10);
  }
}

async function completedChildFixture() {
  let parentRequests = 0;
  const f = await fixture(
    [
      {
        message: {
          tool_calls: [
            {
              id: 'invalidation-child',
              name: 'task',
              args: {
                name: 'Invalidation child',
                subagent_type: 'review',
                task: 'INVALIDATION_CHILD_TASK',
                background: true,
                result_disposition: 'required',
              },
            },
          ],
        },
        toolContinuation: 'required',
      },
      ...Array.from({ length: 5 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const transcript = JSON.stringify(messages);
          if (
            transcript.includes('INVALIDATION_CHILD_TASK') &&
            !transcript.includes('INVALIDATION_PARENT_TASK')
          )
            return { message: { content: 'Child finished.' } };
          parentRequests++;
          return parentRequests === 1
            ? {
                message: { content: 'Parent waiting.' },
                expectedRequest: { toolResults: [{ toolCallId: 'invalidation-child' }] },
              }
            : { message: { content: 'Parent finished.' } };
        },
      })),
    ],
    undefined,
    { childSessions: true },
  );
  try {
    await f.client.selectSession(f.a);
    await f.client.send('INVALIDATION_PARENT_TASK');
    await waitFor(() => (f.client.getSnapshot().childSessions?.entries.length ?? 0) === 1);
    const childSessionId = f.client.getSnapshot().childSessions!.entries[0]!.sessionId;
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'completed');
    return {
      ...f,
      childSessionId,
      get childHistoryRequests() {
        return f.childHistoryRequests;
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test('desktop makes one final background read when the selected Run finishes', async () => {
  const f = await fixture([{ message: { content: 'Final answer.' } }]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Finish this turn.');
    await waitFor(() =>
      f.backgroundQueries.some(
        (query) => query.sessionId === f.a && query.parentRunStatus === 'completed',
      ),
    );
    expect(
      f.client.getSnapshot().messages.some((message) => message.text === 'Final answer.'),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 20_000);

test('leaving the reading page releases its stream while the Service Run continues', async () => {
  const f = await fixture([
    { message: { content_chunks: ['started ', 'finished'] }, chunk_delay: 350 },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Continue while I leave this page.');
    await waitFor(() =>
      f.client.getSnapshot().messages.some((message) => message.role === 'assistant'),
    );
    const previousUnsubscribes = f.unsubscribeRequests;
    f.client.leaveSessionPage();
    await waitFor(() => f.unsubscribeRequests > previousUnsubscribes);
    expect(f.client.getSnapshot().ready).toBe(false);
    expect(f.cancelCommands).toBe(0);
    await Bun.sleep(900);
    await f.client.selectSession(f.a);
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'completed');
    expect(
      f.client.getSnapshot().messages.find((message) => message.role === 'assistant')?.text,
    ).toBe('started finished');
    expect(f.cancelCommands).toBe(0);
  } finally {
    await f.close();
  }
}, 20_000);

test('rapid session switches retain the shared connection and running session', async () => {
  let releaseRun!: () => void;
  let enteredRun = false;
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const f = await fixture([
    {
      response: async () => {
        enteredRun = true;
        await runGate;
        return { message: { content: 'Run A completed.' } };
      },
    },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Run A while I browse.');
    await waitFor(() => enteredRun);
    const connectionGeneration = f.connectionGeneration;
    const selections: Promise<void>[] = [];
    for (let index = 0; index < 100; index++)
      selections.push(f.client.selectSession(index % 2 === 0 ? f.b : f.a));
    await Promise.all(selections);
    await f.client.selectSession(f.a);
    const subscriptionsBefore = f.parentSubscriptionRequests;
    const unsubscribesBefore = f.unsubscribeRequests;
    for (let index = 0; index < 72; index++)
      await f.client.selectSession(index % 2 === 0 ? f.b : f.a);
    expect(f.client.getSnapshot()).toMatchObject({ selected: f.a, ready: true });
    expect(f.client.getSnapshot().projection?.currentRun?.status).toBe('running');
    expect(f.parentSubscriptionRequests - subscriptionsBefore).toBe(72);
    expect(f.unsubscribeRequests - unsubscribesBefore).toBeGreaterThanOrEqual(72);
    expect(f.connectionGeneration).toBe(connectionGeneration);
    expect(f.cancelCommands).toBe(0);
    releaseRun();
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'completed');
    expect(
      f.client.getSnapshot().messages.some((message) => message.text === 'Run A completed.'),
    ).toBe(true);
  } finally {
    releaseRun();
    await f.close();
  }
}, 60_000);

test('switching a parent with three running children retains its Run', async () => {
  const childGates = [gate(), gate(), gate()];
  const startedChildren = new Set<number>();
  let parentRequests = 0;
  const f = await fixture(
    [
      {
        message: {
          tool_calls: childGates.map((_, index) => ({
            id: `child-${index}`,
            name: 'task',
            args: {
              name: `Child ${index}`,
              subagent_type: 'review',
              task: `MULTI_CHILD_${index}`,
              background: true,
              result_disposition: 'required',
            },
          })),
        },
        toolContinuation: 'required',
      },
      ...Array.from({ length: 6 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const transcript = JSON.stringify(messages);
          for (let index = 0; index < childGates.length; index++) {
            if (
              transcript.includes(`MULTI_CHILD_${index}`) &&
              !transcript.includes('MULTI_PARENT')
            ) {
              startedChildren.add(index);
              await childGates[index]!.released;
              return { message: { content: `Child ${index} finished.` } };
            }
          }
          parentRequests++;
          return parentRequests === 1
            ? {
                message: { content: 'Parent waiting.' },
                expectedRequest: {
                  toolResults: childGates.map((_, index) => ({ toolCallId: `child-${index}` })),
                },
              }
            : { message: { content: 'Parent finished.' } };
        },
      })),
    ],
    undefined,
    { childSessions: true },
  );
  try {
    await f.client.selectSession(f.a);
    await f.client.send('MULTI_PARENT');
    await waitFor(() => startedChildren.size >= 2);
    for (let index = 0; index < 70; index++) {
      await f.client.selectSession(f.b);
      await f.client.selectSession(f.a);
    }
    expect(f.client.getSnapshot()).toMatchObject({ selected: f.a, ready: true });
    expect(f.client.getSnapshot().projection?.currentRun?.status).toBe('waiting');
    for (const child of childGates) child.release();
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'completed');
    expect(f.cancelCommands).toBe(0);
  } finally {
    for (const child of childGates) child.release();
    await f.close();
  }
}, 60_000);

test('the directory follows two concurrent Runs after leaving the reading page', async () => {
  const f = await fixture([
    { message: { content_chunks: ['A started ', 'A finished'] }, chunk_delay: 1_000 },
    { message: { content_chunks: ['B started ', 'B finished'] }, chunk_delay: 1_000 },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Run A');
    await waitFor(
      () =>
        f.client.getSnapshot().directory?.find((entry) => entry.sessionId === f.a)?.currentRun
          ?.status === 'running',
    );
    await f.client.selectSession(f.b);
    await f.client.send('Run B');
    await waitFor(() =>
      [f.a, f.b].every(
        (id) =>
          f.client.getSnapshot().directory?.find((entry) => entry.sessionId === id)?.currentRun
            ?.status === 'running',
      ),
    );
    const generation = f.connectionGeneration;
    const subscriptions = f.parentSubscriptionRequests;
    const historyRequests = f.historyRequests;
    const unsubscribes = f.unsubscribeRequests;
    f.client.leaveSessionPage();
    await waitFor(() => f.unsubscribeRequests > unsubscribes);
    await waitFor(() =>
      [f.a, f.b].every(
        (id) =>
          f.client.getSnapshot().directory?.find((entry) => entry.sessionId === id)?.currentRun
            ?.status === 'completed',
      ),
    );
    expect(f.client.getSnapshot().ready).toBe(false);
    expect(f.connectionGeneration).toBe(generation);
    expect(f.parentSubscriptionRequests).toBe(subscriptions);
    expect(f.historyRequests).toBe(historyRequests);
    expect(f.cancelCommands).toBe(0);
  } finally {
    await f.close();
  }
}, 20_000);

test('an index reset arriving before the directory read still supplies the Run status', async () => {
  const f = await fixture([{ message: { content: 'Persisted completion.' } }]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Complete before reconnect');
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'completed');
    await f.client.disconnect();
    const resetEnds = f.indexResetEnds;
    const directoryGate = f.holdDirectory();
    const connecting = f.client.connect();
    await directoryGate.arrived;
    await waitFor(() => f.indexResetEnds > resetEnds);
    directoryGate.release();
    await connecting;
    expect(
      f.client.getSnapshot().directory?.find((entry) => entry.sessionId === f.a)?.currentRun,
    ).toMatchObject({ status: 'completed' });
  } finally {
    await f.close();
  }
}, 20_000);

test('a cached session can be selected while the connection is recovering', async () => {
  const f = await fixture();
  try {
    await f.client.selectSession(f.a);
    await f.dropCurrentTransport();
    await waitFor(() => !f.client.getSnapshot().connected);
    await f.client.selectSession(f.b);
    expect(f.client.getSnapshot()).toMatchObject({
      connected: true,
      selected: f.b,
      ready: true,
    });
    expect(f.cancelCommands).toBe(0);
  } finally {
    await f.close();
  }
}, 20_000);

test('a confirmed environment snapshot stays visible while a reopened parent is revalidated', async () => {
  const f = await fixture();
  try {
    f.injectBackground(f.a, 'running');
    await f.client.selectSession(f.a);
    await waitFor(() =>
      Boolean(
        f.client
          .getSnapshot()
          .backgroundDisplay?.snapshot.executions.some(
            (execution) => execution.executionId === 'fixture-shell',
          ),
      ),
    );
    expect(f.client.getSnapshot().backgroundDisplay).toMatchObject({
      sessionId: f.a,
      stale: false,
      snapshot: { executions: [{ status: 'running' }] },
    });

    await f.client.selectSession(f.b);
    expect(f.client.getSnapshot().backgroundDisplay?.sessionId).toBe(f.b);
    const held = f.holdBackground(f.a);
    f.injectBackground(f.a, 'completed');
    const reopen = f.client.selectSession(f.a);
    expect(f.client.getSnapshot().backgroundDisplay).toMatchObject({
      sessionId: f.a,
      stale: true,
      snapshot: { executions: [{ status: 'running' }] },
    });
    await held.arrived;
    expect(f.client.getSnapshot().backgroundDisplay).toMatchObject({
      sessionId: f.a,
      stale: true,
      snapshot: { executions: [{ status: 'running' }] },
    });
    held.release();
    await reopen;
    await waitFor(() => f.client.getSnapshot().backgroundDisplay?.stale === false);
    expect(f.client.getSnapshot().backgroundDisplay).toMatchObject({
      sessionId: f.a,
      snapshot: { executions: [{ status: 'completed' }] },
    });
    await f.client.removeProject(f.client.getSnapshot().workspace);
    expect(f.client.getSnapshot().backgroundDisplay).toBeUndefined();
  } finally {
    await f.close();
  }
}, 20_000);

test('returning to a parent refreshes a cached child list without loading flicker', async () => {
  const f = await fixture([], undefined, { childSessions: true });
  try {
    await f.client.selectSession(f.a);
    await waitFor(() => f.client.getSnapshot().childSessions?.parentSessionId === f.a);
    await f.client.selectSession(f.b);
    const loadingStates: boolean[] = [];
    const unsubscribe = f.client.subscribe(() => {
      const view = f.client.getSnapshot();
      if (view.selected === f.a && view.childSessions?.parentSessionId === f.a)
        loadingStates.push(view.childSessions.loading);
    });
    try {
      await f.client.selectSession(f.a);
      await waitFor(() => f.client.getSnapshot().childSessions?.parentSessionId === f.a);
      expect(loadingStates.length).toBeGreaterThan(0);
      expect(loadingStates).not.toContain(true);
      for (let attempt = 0; !loadingStates.includes(true) && attempt < 10; attempt++) {
        await f.client.refreshChildSessions(f.a, { silent: false });
        if (!loadingStates.includes(true)) await Bun.sleep(10);
      }
      expect(loadingStates).toContain(true);
    } finally {
      unsubscribe();
    }
  } finally {
    await f.close();
  }
}, 20_000);

for (const openAfterFirstFrame of [false, true])
  test(`child detail renders live text when opened ${openAfterFirstFrame ? 'after' : 'before'} the first frame`, async () => {
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let parentRequests = 0;
    let childEnteredGate = false;
    const f = await fixture(
      Array.from({ length: 8 }, () => ({
        response: async ({ messages }) => {
          const transcript = JSON.stringify(messages);
          if (
            transcript.includes('CHILD_STREAM_TASK') &&
            !transcript.includes('PARENT_STREAM_TASK')
          ) {
            childEnteredGate = true;
            await childGate;
            return {
              message: { content_chunks: ['CHILD_STREAM_ALPHA', 'CHILD_STREAM_OMEGA'] },
              stream_frame_delays: openAfterFirstFrame ? [2_000, 500, 0, 0] : [300, 500, 0, 0],
            };
          }
          parentRequests++;
          if (parentRequests === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'child-stream-task',
                    name: 'task',
                    args: {
                      name: 'Streaming child',
                      subagent_type: 'review',
                      task: 'CHILD_STREAM_TASK',
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          return {
            message: { content: 'Parent finished.' },
            ...(parentRequests === 2
              ? { expectedRequest: { toolResults: [{ toolCallId: 'child-stream-task' }] } }
              : {}),
          };
        },
      })),
      undefined,
      { childSessions: true },
    );
    try {
      await f.client.selectSession(f.a);
      await f.client.send('PARENT_STREAM_TASK');
      await waitFor(() => (f.client.getSnapshot().childSessions?.entries.length ?? 0) === 1);
      const childSessionId = f.client.getSnapshot().childSessions!.entries[0]!.sessionId;
      if (openAfterFirstFrame)
        await waitFor(() =>
          Boolean(
            f.client
              .getSnapshot()
              .backgroundDisplay?.snapshot.executions.some(
                (execution) => execution.kind === 'subagent',
              ),
          ),
        );
      if (openAfterFirstFrame) {
        await waitFor(() => childEnteredGate);
        releaseChild();
        await Bun.sleep(300);
      }
      const parentUnsubscribes = f.unsubscribeRequests;
      await f.client.openChildSession(f.a, childSessionId);
      await waitFor(() => f.unsubscribeRequests > parentUnsubscribes);
      expect(f.client.getSnapshot().ready).toBe(false);
      expect(f.client.getSnapshot().childDetail?.loading).toBe(false);
      if (!openAfterFirstFrame) releaseChild();
      if (!openAfterFirstFrame)
        await waitFor(() =>
          (f.client.getSnapshot().childDetail?.messages ?? []).some(
            (message) => message.text.includes('CHILD_STREAM_ALPHA') && !message.settled,
          ),
        );
      await waitFor(() =>
        (f.client.getSnapshot().childDetail?.messages ?? []).some(
          (message) => message.text.includes('CHILD_STREAM_OMEGA') && !message.settled,
        ),
      );
      const html = renderToStaticMarkup(
        createElement(Conversation, {
          messages: f.client.getSnapshot().childDetail!.messages,
          loading: false,
          selected: true,
          connected: true,
          saveReading: () => undefined,
        }),
      );
      const document = new JSDOM(html).window.document;
      expect(document.body.textContent).toContain('CHILD_STREAM_OMEGA');
      if (openAfterFirstFrame) {
        expect(document.body.textContent).toContain('CHILD_STREAM_ALPHA');
        f.client.leaveChildSession();
        expect(f.client.getSnapshot().backgroundDisplay).toMatchObject({
          sessionId: f.a,
          stale: true,
        });
        expect(
          f.client
            .getSnapshot()
            .backgroundDisplay?.snapshot.executions.some(
              (execution) => execution.kind === 'subagent',
            ),
        ).toBe(true);
        await waitFor(() => f.client.getSnapshot().ready);
        await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'completed');
        await f.client.selectSession(f.b);
        expect(f.client.getSnapshot().childSessions?.parentSessionId).not.toBe(f.a);
        const returningToParent = f.client.selectSession(f.a);
        expect(f.client.getSnapshot().childSessions).toMatchObject({
          parentSessionId: f.a,
          entries: [{ sessionId: childSessionId }],
        });
        await returningToParent;
        await waitFor(() =>
          (f.client.getSnapshot().childSessions?.entries ?? []).some(
            (entry) => entry.sessionId === childSessionId,
          ),
        );
        await f.client.openChildSession(f.a, childSessionId);
        expect(
          f.client.getSnapshot().childDetail?.messages.some((message) => message.settled),
        ).toBe(true);
        const stableConnection = f.connectionGeneration;
        f.client.leaveChildSession();
        await waitFor(() => f.client.getSnapshot().ready);
        const staleProjection = f.holdChildProjection();
        const staleOpen = f.client.openChildSession(f.a, childSessionId);
        await staleProjection.arrived;
        const subscriptionsBeforeLeaving = f.childSubscriptionRequests;
        f.client.leaveChildSession();
        staleProjection.release();
        await staleOpen;
        await waitFor(() => f.client.getSnapshot().ready);
        expect(f.childSubscriptionRequests).toBe(subscriptionsBeforeLeaving);
        expect(f.client.getSnapshot().childDetail).toBeUndefined();

        const subscriptionsBeforeSwitching = f.childSubscriptionRequests;
        let previousUnsubscribes = f.unsubscribeRequests;
        for (let index = 0; index < 100; index++) {
          const pendingAck = f.holdSubscription('child_session');
          const opening = f.client.openChildSession(f.a, childSessionId);
          await pendingAck.arrived;
          f.client.leaveChildSession();
          pendingAck.release();
          await opening;
          await waitFor(() => f.unsubscribeRequests > previousUnsubscribes);
          previousUnsubscribes = f.unsubscribeRequests;
          expect(f.connectionGeneration).toBe(stableConnection);
          expect(f.client.getSnapshot()).toMatchObject({
            connected: true,
            selected: f.a,
          });
          expect(f.client.getSnapshot().childDetail).toBeUndefined();
        }
        expect(f.childSubscriptionRequests).toBe(subscriptionsBeforeSwitching + 100);
        expect(f.cancelCommands).toBe(0);
        await waitFor(() => f.client.getSnapshot().ready);
        await f.client.openChildSession(f.a, childSessionId);
        expect(f.client.getSnapshot().childDetail?.loading).toBe(false);
        const parentSubscriptionsWhileReadingChild = f.parentSubscriptionRequests;
        await f.client.connect();
        expect(f.parentSubscriptionRequests).toBe(parentSubscriptionsWhileReadingChild);
        const previousConnection = f.connectionGeneration;
        f.failOneReconnect();
        await f.dropCurrentTransport();
        await waitFor(
          () =>
            f.connectionGeneration > previousConnection &&
            f.client.getSnapshot().childDetail?.childSessionId === childSessionId &&
            f.client.getSnapshot().childDetail?.loading === false,
        );
        expect(f.client.getSnapshot().selected).toBe(f.a);
      }
    } finally {
      releaseChild();
      await f.close();
    }
  }, 30_000);

test('child history remains visible across sibling and parent navigation while every reopen revalidates', async () => {
  const childGates = [gate(), gate()];
  let parentRequests = 0;
  const f = await fixture(
    [
      {
        message: {
          tool_calls: childGates.map((_, index) => ({
            id: `cache-child-${index}`,
            name: 'task',
            args: {
              name: `Cache child ${index}`,
              subagent_type: 'review',
              task: `CACHE_CHILD_${index}`,
              background: true,
              result_disposition: 'required',
            },
          })),
        },
        toolContinuation: 'required',
      },
      ...Array.from({ length: 5 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const transcript = JSON.stringify(messages);
          for (let index = 0; index < childGates.length; index++) {
            if (
              transcript.includes(`CACHE_CHILD_${index}`) &&
              !transcript.includes('CACHE_PARENT')
            ) {
              await childGates[index]!.released;
              return { message: { content: `Cache child ${index} finished.` } };
            }
          }
          parentRequests++;
          return parentRequests === 1
            ? {
                message: { content: 'Parent waiting.' },
                expectedRequest: {
                  toolResults: childGates.map((_, index) => ({
                    toolCallId: `cache-child-${index}`,
                  })),
                },
              }
            : { message: { content: 'Parent finished.' } };
        },
      })),
    ],
    undefined,
    { childSessions: true },
  );
  try {
    await f.client.selectSession(f.a);
    await f.client.send('CACHE_PARENT');
    await waitFor(() => (f.client.getSnapshot().childSessions?.entries.length ?? 0) === 2);
    const children = f.client.getSnapshot().childSessions!.entries;
    const first = children[0]!.sessionId;
    const second = children[1]!.sessionId;
    for (const child of childGates) child.release();
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'completed');

    await f.client.openChildSession(f.a, first);
    const firstMessages = f.client.getSnapshot().childDetail!.messages;
    expect(firstMessages.length).toBeGreaterThan(0);
    f.client.leaveChildSession();
    await waitFor(() => f.client.getSnapshot().ready);
    await f.client.openChildSession(f.a, second);
    expect(f.client.getSnapshot().childDetail?.childSessionId).toBe(second);
    f.client.leaveChildSession();
    await waitFor(() => f.client.getSnapshot().ready);

    const historyBefore = f.childHistoryRequests;
    const subscriptionBefore = f.childSubscriptionRequests;
    const freshHistory = f.holdChildHistory();
    const reopening = f.client.openChildSession(f.a, first);
    expect(f.client.getSnapshot().childDetail).toMatchObject({
      childSessionId: first,
      hasLoadedHistory: true,
      loading: true,
      messages: firstMessages,
    });
    await freshHistory.arrived;
    expect(f.childHistoryRequests).toBe(historyBefore + 1);
    freshHistory.release();
    await reopening;
    expect(f.client.getSnapshot().childDetail?.loading).toBe(false);
    expect(f.childSubscriptionRequests).toBe(subscriptionBefore + 1);

    // A late response from the old detail cannot overwrite a different child.
    f.client.leaveChildSession();
    await waitFor(() => f.client.getSnapshot().ready);
    const staleHistory = f.holdChildHistory();
    const staleOpen = f.client.openChildSession(f.a, first);
    await staleHistory.arrived;
    const currentOpen = f.client.openChildSession(f.a, second);
    staleHistory.release();
    await Promise.all([staleOpen, currentOpen]);
    expect(f.client.getSnapshot().childDetail?.childSessionId).toBe(second);

    f.client.leaveChildSession();
    await waitFor(() => f.client.getSnapshot().ready);
    await f.client.selectSession(f.b);
    expect(f.client.getSnapshot().childDetail).toBeUndefined();
    await expect(f.client.openChildSession(f.b, first)).rejects.toThrow();
    expect(f.client.getSnapshot().childDetail).toBeUndefined();
    await f.client.selectSession(f.a);
    const afterSwitch = f.holdChildHistory();
    const reopeningAfterSwitch = f.client.openChildSession(f.a, first);
    expect(f.client.getSnapshot().childDetail).toMatchObject({
      childSessionId: first,
      hasLoadedHistory: true,
      loading: true,
      messages: firstMessages,
    });
    await afterSwitch.arrived;
    afterSwitch.release();
    await reopeningAfterSwitch;
    expect(f.client.getSnapshot().childDetail?.loading).toBe(false);
    f.client.leaveChildSession();
    await waitFor(() => f.client.getSnapshot().ready);
    const childListBefore = f.childListRequests;
    f.omitOneChildList();
    for (let attempt = 0; f.childListRequests === childListBefore && attempt < 100; attempt++) {
      await f.client.refreshChildSessions(f.a);
      if (f.childListRequests === childListBefore) await Bun.sleep(10);
    }
    expect(f.childListRequests).toBeGreaterThan(childListBefore);
    expect(f.client.getSnapshot().childSessions?.entries).toEqual([]);
    await expect(f.client.openChildSession(f.a, first)).rejects.toThrow();
    expect(f.client.getSnapshot().childDetail).toBeUndefined();
    expect(f.cancelCommands).toBe(0);
  } finally {
    for (const child of childGates) child.release();
    await f.close();
  }
}, 30_000);

test('provider authentication failure is visible once during live delivery and after history reload', async () => {
  let requests = 0;
  const provider = startTestHttpServer({
    fetch() {
      requests++;
      return Response.json(
        { error: { message: 'private authentication response', type: 'authentication_error' } },
        { status: 401 },
      );
    },
  });
  const f = await fixture([], `${provider.url.origin}/v1`);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Hello');
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'failed');
    const notices = () =>
      f.client
        .getSnapshot()
        .messages.filter((message) => message.role === 'system' && message.status === 'failed');
    await waitFor(() => notices().length === 1);
    const live = notices();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: 'failed', settled: true });
    expect(live[0]!.text).toContain('认证失败');
    expect(live[0]!.text).toContain('凭据');
    expect(JSON.stringify(f.client.getSnapshot().messages)).not.toContain('private authentication');
    expect(
      f.client.getSnapshot().messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    expect(f.client.getSnapshot().messages.some((message) => message.role === 'assistant')).toBe(
      false,
    );
    expect(requests).toBe(1);

    await f.client.selectSession(f.b);
    await f.client.selectSession(f.a);
    expect(notices()).toEqual(live);
    expect(requests).toBe(1);
  } finally {
    await f.close();
    provider.stop(true);
  }
}, 20_000);

test('sends active input as steer and the same Run uses it at the next model boundary', async () => {
  const f = await fixture([
    { delay: 250, message: { content: 'Old answer.' } },
    {
      response: (request) => {
        expect(
          request.messages.some(
            (message) =>
              message.role === 'user' && String(message.content).includes('new constraint'),
          ),
        ).toBe(true);
        expect(
          request.messages.some(
            (message) => message.role === 'assistant' && message.content === 'Old answer.',
          ),
        ).toBe(false);
        return { message: { content: 'Answer with the new constraint.' } };
      },
    },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Start the work.');
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'running');
    const runId = f.client.getSnapshot().projection!.currentRun!.runId;

    await f.client.send('Apply the new constraint.');
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'completed');

    expect(f.client.getSnapshot().projection?.currentRun?.runId).toBe(runId);
    expect(
      f.client
        .getSnapshot()
        .messages.filter((message) => message.role === 'user')
        .map((message) => message.text),
    ).toEqual(['Start the work.', 'Apply the new constraint.']);
    expect(f.client.getSnapshot().messages.some((message) => message.text === 'Old answer.')).toBe(
      false,
    );
    expect(
      f.client
        .getSnapshot()
        .messages.filter((message) => message.role === 'assistant')
        .at(-1)?.text,
    ).toContain('new constraint');
  } finally {
    await f.close();
  }
}, 20_000);

test('retries one pre-commit start conflict with a fresh revision and command identity', async () => {
  const f = await fixture([{ message: { content: 'Accepted after refresh.' } }]);
  try {
    await f.client.selectSession(f.a);
    f.staleNextStartProjection();

    await expect(f.client.send('Retry this admission once.')).resolves.toBeUndefined();

    const starts = f.sendCommands.filter((command) => command.type === 'start_turn');
    expect(starts).toHaveLength(2);
    expect(starts[0]!.commandId).not.toBe(starts[1]!.commandId);
  } finally {
    await f.close();
  }
}, 20_000);

test('does not retarget a conflicted start when the refreshed Session has an active Run', async () => {
  const f = await fixture();
  try {
    await f.client.selectSession(f.a);
    f.staleNextStartProjection('active');

    await expect(f.client.send('Keep this as a draft.')).rejects.toThrow('已有任务正在运行');

    expect(f.sendCommands.filter((command) => command.type === 'start_turn')).toHaveLength(1);
    expect(f.sendCommands.filter((command) => command.type === 'steer_turn')).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 20_000);

test('does not retry a second start revision conflict', async () => {
  const f = await fixture();
  try {
    await f.client.selectSession(f.a);
    f.staleNextStartProjection('stale');

    await expect(f.client.send('Only one retry is allowed.')).rejects.toThrow('revision_conflict');

    expect(f.sendCommands.filter((command) => command.type === 'start_turn')).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 20_000);

test('recovers a lost steer response from the same command receipt without creating another Run', async () => {
  const f = await fixture([
    { delay: 250, message: { content: 'Old answer.' } },
    { message: { content: 'Recovered steer answer.' } },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Start one run.');
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'running');
    const runId = f.client.getSnapshot().projection!.currentRun!.runId;
    f.loseNextSteerReceipt();
    await expect(f.client.send('Steer with a lost response.')).resolves.toBeUndefined();
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'completed');
    expect(f.client.getSnapshot().projection?.currentRun?.runId).toBe(runId);
    expect(
      f.client
        .getSnapshot()
        .messages.filter((message) => message.role === 'user')
        .map((m) => m.text),
    ).toEqual(['Start one run.', 'Steer with a lost response.']);
  } finally {
    await f.close();
  }
}, 20_000);

test.each([
  false,
  true,
])('an unknown creation cannot replace a newer selection (return to original: %s)', async (returnToOriginal) => {
  const f = await fixture();
  try {
    const held = f.holdUnknownCreation();
    const creation = f.client.newSession().catch((error: unknown) => error);
    await held.arrived;
    const reading = f.client.selectSession(f.a);
    const returning = returnToOriginal ? f.client.selectSession(f.b) : undefined;
    held.release();
    const error = await creation;
    await Promise.all([reading, returning]);
    expect(error).toBeInstanceOf(CommandResultUnknown);
    if (!(error instanceof CommandResultUnknown)) throw new Error('Expected an unknown receipt');
    expect(error.sessionId).toBeDefined();
    const selected = returnToOriginal ? f.b : f.a;
    expect(f.client.getSnapshot()).toMatchObject({
      selected,
      projection: { sessionId: selected },
      ready: true,
      hasLoadedHistory: true,
    });
    await f.client.refreshSessions();
    expect(
      f.client.getSnapshot().sessions.filter((s) => s.sessionId === error.sessionId),
    ).toHaveLength(1);
    expect(f.client.getSnapshot().selected).toBe(selected);
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('an unknown creation detaches the previous reading subscription without stopping its run', async () => {
  const f = await fixture([
    { message: { content_chunks: ['first ', 'later ', 'finished'] }, chunk_delay: 200 },
  ]);
  try {
    await f.client.send('Keep running while a new conversation is created.');
    await waitFor(() => f.client.getSnapshot().messages.some((m) => m.role === 'assistant'));
    const held = f.holdUnknownCreation();
    const creation = f.client.newSession().catch((error: unknown) => error);
    await held.arrived;
    held.release();
    const error = await creation;
    if (!(error instanceof CommandResultUnknown)) throw new Error('Expected an unknown receipt');
    expect(f.client.getSnapshot().selected).toBe(error.sessionId);
    await Bun.sleep(800);
    expect(f.client.getSnapshot().messages).toEqual([]);
    expect(f.client.getSnapshot().ready).toBe(false);
    await f.client.selectSession(f.b);
    await waitFor(() =>
      f.client.getSnapshot().messages.some((m) => m.role === 'assistant' && m.settled),
    );
    expect(f.client.getSnapshot().messages.find((m) => m.role === 'assistant')?.text).toBe(
      'first later finished',
    );
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('cached empty history appears before calibration and duplicate selections share one request', async () => {
  const f = await fixture();
  try {
    const held = f.holdHistory();
    const before = f.historyRequests;
    const selection = f.client.selectSession(f.a);
    expect(f.client.getSnapshot()).toMatchObject({
      selected: f.a,
      messages: [],
      hasLoadedHistory: true,
      loadingSession: true,
      ready: false,
    });
    expect(f.client.selectSession(f.a)).toBe(selection);
    await held.arrived;
    expect(f.client.getSnapshot().ready).toBe(false);
    await expect(f.client.send('must remain a draft')).rejects.toThrow('同步');
    expect(f.historyRequests).toBe(before + 1);
    held.release();
    await selection;
    expect(f.client.getSnapshot().ready).toBe(true);
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('failed calibration retains cached history but cannot regain readiness until retry succeeds', async () => {
  const f = await fixture([{ message: { content: 'durable answer' } }]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('remember this');
    await waitFor(() =>
      f.client.getSnapshot().messages.some((m) => m.text === 'durable answer' && m.settled),
    );
    const previous = f.client.getSnapshot().messages;
    await f.client.selectSession(f.b);
    f.failHistory('temporary');
    await expect(f.client.selectSession(f.a)).rejects.toThrow('fixture history failure');
    expect(f.client.getSnapshot().messages).toBe(previous);
    await f.client.refreshDirectory();
    expect(f.client.getSnapshot()).toMatchObject({
      ready: false,
      loadingSession: false,
      hasLoadedHistory: true,
    });
    await f.client.selectSession(f.a);
    expect(f.client.getSnapshot().ready).toBe(true);
    // Historical folding may add durable details; a second unchanged calibration must preserve the array.
    const settled = f.client.getSnapshot().messages;
    await f.client.selectSession(f.b);
    await f.client.selectSession(f.a);
    expect(f.client.getSnapshot().messages).toBe(settled);
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test.each([
  'unauthorized',
  'missing',
] as const)('explicit %s discards history; switching away cannot resurrect it', async (failure) => {
  const f = await fixture();
  try {
    f.failHistory(failure);
    await expect(f.client.selectSession(f.a)).rejects.toThrow();
    expect(f.client.getSnapshot()).toMatchObject({
      hasLoadedHistory: false,
      messages: [],
      ready: false,
    });
    await f.client.selectSession(f.b);
    const next = f.client.selectSession(f.a);
    expect(f.client.getSnapshot().hasLoadedHistory).toBe(false);
    await next;
  } finally {
    await f.close();
  }
}, 20_000);

test('a refused parent history removes its cached child entries and environment state', async () => {
  const f = await completedChildFixture();
  try {
    await waitFor(() =>
      Boolean(
        f.client
          .getSnapshot()
          .backgroundDisplay?.snapshot.executions.some(
            (execution) => execution.kind === 'subagent',
          ),
      ),
    );
    await f.client.selectSession(f.b);
    f.failHistory('unauthorized');
    await expect(f.client.selectSession(f.a)).rejects.toThrow();
    expect(f.client.getSnapshot()).toMatchObject({
      selected: f.a,
      ready: false,
      hasLoadedHistory: false,
      childSessions: undefined,
      backgroundDisplay: undefined,
    });
    await Bun.sleep(30);
    expect(f.client.getSnapshot().childSessions).toBeUndefined();
    expect(f.client.getSnapshot().backgroundDisplay).toBeUndefined();
    await f.client.selectSession(f.a);
    await waitFor(() => f.client.getSnapshot().ready);
    await waitFor(() => (f.client.getSnapshot().childSessions?.entries.length ?? 0) === 1);
    expect(f.client.getSnapshot().childSessions?.entries[0]?.sessionId).toBe(f.childSessionId);
  } finally {
    await f.close();
  }
}, 30_000);

test('same-workspace reconnect requires a fresh child list and reports its failure', async () => {
  const f = await completedChildFixture();
  try {
    expect(f.client.getSnapshot().childSessions?.entries).toHaveLength(1);
    await f.client.disconnect();
    f.failOneChildList();
    await f.client.connect();
    await waitFor(() => !!f.client.getSnapshot().childSessions?.error);
    expect(f.client.getSnapshot().childSessions).toMatchObject({
      parentSessionId: f.a,
      entries: [],
      loading: false,
    });
  } finally {
    await f.close();
  }
}, 30_000);

test('reconnecting a child keeps its page and list until the user returns to its parent', async () => {
  const f = await completedChildFixture();
  try {
    await f.client.openChildSession(f.a, f.childSessionId);
    const childMessages = f.client.getSnapshot().childDetail!.messages;
    const pendingList = f.holdChildList();
    await f.dropCurrentTransport();
    await pendingList.arrived;
    expect(f.client.getSnapshot().childDetail).toMatchObject({
      childSessionId: f.childSessionId,
      messages: childMessages,
    });
    expect(f.client.getSnapshot().childSessions?.entries).toHaveLength(1);

    const childReadsBeforeReturn = f.childHistoryRequests;
    f.client.leaveChildSession();
    expect(f.client.getSnapshot().childDetail).toBeUndefined();
    expect(f.client.getSnapshot().childSessions?.entries).toHaveLength(1);
    pendingList.release();
    await f.client.refreshChildSessions(f.a);
    await waitFor(() => f.client.getSnapshot().ready);
    expect(f.client.getSnapshot().childDetail).toBeUndefined();
    expect(f.childHistoryRequests).toBe(childReadsBeforeReturn);
  } finally {
    await f.close();
  }
}, 30_000);

test('reconnecting the current page keeps confirmed environment rows as stale display', async () => {
  const f = await completedChildFixture();
  try {
    await waitFor(() =>
      Boolean(
        f.client
          .getSnapshot()
          .backgroundDisplay?.snapshot.executions.some(
            (execution) => execution.kind === 'subagent',
          ),
      ),
    );
    const display = f.client.getSnapshot().backgroundDisplay!;
    const opening = f.holdRuntimeOpen();
    await f.dropCurrentTransport();
    await opening.arrived;
    expect(f.client.getSnapshot().backgroundDisplay).toMatchObject({
      sessionId: f.a,
      snapshot: display.snapshot,
      stale: true,
    });
    expect(f.client.getSnapshot().childSessions?.entries).toHaveLength(1);
    opening.release();
    await waitFor(() => f.client.getSnapshot().ready);
    expect(f.client.getSnapshot().backgroundDisplay?.sessionId).toBe(f.a);
  } finally {
    await f.close();
  }
}, 30_000);

test('a child restored after reconnect never exposes a temporary empty parent page', async () => {
  const f = await completedChildFixture();
  try {
    await f.client.openChildSession(f.a, f.childSessionId);
    const detailIds: Array<string | undefined> = [];
    const unsubscribe = f.client.subscribe(() => {
      detailIds.push(f.client.getSnapshot().childDetail?.childSessionId);
    });
    const pendingList = f.holdChildList();
    const childReadsBefore = f.childHistoryRequests;
    await f.dropCurrentTransport();
    await pendingList.arrived;
    expect(f.client.getSnapshot().childSessions?.entries).toHaveLength(1);
    pendingList.release();
    await waitFor(
      () =>
        f.childHistoryRequests > childReadsBefore &&
        f.client.getSnapshot().childDetail?.loading === false,
    );
    unsubscribe();
    expect(detailIds.length).toBeGreaterThan(0);
    expect(detailIds.every((id) => id === f.childSessionId)).toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);

test('session clicks during reconnect show the latest selection and load it once', async () => {
  const f = await fixture();
  try {
    await f.client.selectSession(f.a);
    const opening = f.holdRuntimeOpen();
    await f.dropCurrentTransport();
    await opening.arrived;
    const first = f.client.selectSession(f.b);
    expect(f.client.getSnapshot()).toMatchObject({ selected: f.b, loadingSession: true });
    const second = f.client.selectSession(f.a);
    expect(f.client.getSnapshot().selected).toBe(f.a);
    const last = f.client.selectSession(f.b);
    expect(f.client.getSnapshot().selected).toBe(f.b);
    const historyBeforeReconnect = f.historyRequests;
    opening.release();
    await Promise.all([first, second, last]);
    await waitFor(() => f.client.getSnapshot().ready);
    expect(f.client.getSnapshot().selected).toBe(f.b);
    expect(f.client.getSnapshot().projection?.sessionId).toBe(f.b);
    expect(f.historyRequests).toBe(historyBeforeReconnect + 1);
    await f.client.selectSession(f.a);
    expect(f.client.getSnapshot().selected).toBe(f.a);
  } finally {
    await f.close();
  }
}, 30_000);

test('repeated A/B clicks during reconnect retain read main histories and honor the last choice', async () => {
  const f = await fixture([
    { message: { content: 'A durable answer' } },
    { message: { content: 'B durable answer' } },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('A question');
    await waitFor(() =>
      f.client.getSnapshot().messages.some((m) => m.text === 'A durable answer' && m.settled),
    );
    const aMessages = f.client.getSnapshot().messages;
    await f.client.selectSession(f.b);
    await f.client.send('B question');
    await waitFor(() =>
      f.client.getSnapshot().messages.some((m) => m.text === 'B durable answer' && m.settled),
    );
    const bMessages = f.client.getSnapshot().messages;
    const opening = f.holdRuntimeOpen();
    await f.dropCurrentTransport();
    await opening.arrived;
    const first = f.client.selectSession(f.a);
    expect(f.client.getSnapshot()).toMatchObject({
      selected: f.a,
      hasLoadedHistory: true,
      loadingSession: true,
      ready: false,
    });
    expect(f.client.getSnapshot().messages).toBe(aMessages);
    const second = f.client.selectSession(f.b);
    expect(f.client.getSnapshot().messages).toBe(bMessages);
    const last = f.client.selectSession(f.a);
    expect(f.client.getSnapshot().messages).toBe(aMessages);
    const historyBefore = f.historyRequests;
    const held = f.holdHistory();
    opening.release();
    await held.arrived;
    expect(f.client.getSnapshot()).toMatchObject({
      selected: f.a,
      hasLoadedHistory: true,
      loadingSession: true,
      ready: false,
    });
    expect(f.client.getSnapshot().messages).toBe(aMessages);
    expect(f.historyRequests).toBe(historyBefore + 1);
    held.release();
    await Promise.all([first, second, last]);
    await waitFor(() => f.client.getSnapshot().ready);
    expect(f.client.getSnapshot().projection?.sessionId).toBe(f.a);
    const heldB = f.holdHistory();
    const toB = f.client.selectSession(f.b);
    expect(f.client.getSnapshot().messages).toBe(bMessages);
    await heldB.arrived;
    expect(f.client.getSnapshot().ready).toBe(false);
    heldB.release();
    await toB;
  } finally {
    await f.close();
  }
}, 30_000);

test('a child projection confirmed missing removes its parent detail entry', async () => {
  const f = await completedChildFixture();
  try {
    f.notFoundChildProjection();
    await f.client.openChildSession(f.a, f.childSessionId);
    expect(f.client.getSnapshot().childDetail).toMatchObject({
      childSessionId: f.childSessionId,
      hasLoadedHistory: false,
      loading: false,
    });
    expect(f.client.getSnapshot().childDetail?.error).toContain('子会话已不可用');
    expect(f.client.getSnapshot().childSessions?.entries).toEqual([]);
    f.client.leaveChildSession();
    expect(f.client.getSnapshot().childSessions?.entries).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

test('late failed selection cannot clear the next view or restore unauthorized history', async () => {
  const f = await fixture();
  try {
    const held = f.holdHistory();
    f.failHistory('unauthorized');
    const stale = f.client.selectSession(f.a);
    await held.arrived;
    const current = f.client.selectSession(f.b);
    held.release();
    await Promise.all([stale, current]);
    expect(f.client.getSnapshot()).toMatchObject({
      selected: f.b,
      ready: true,
      hasLoadedHistory: true,
      error: undefined,
    });
    await f.client.disconnect();
    await f.client.connect();
    const next = f.client.selectSession(f.a);
    expect(f.client.getSnapshot().hasLoadedHistory).toBe(false);
    await next;
  } finally {
    await f.close();
  }
}, 20_000);

test('switching back during streaming joins full history with queued live events exactly once', async () => {
  const f = await fixture([
    { message: { content_chunks: ['first ', 'second ', 'final'] }, chunk_delay: 100 },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('stream then finish');
    await waitFor(() => f.client.getSnapshot().messages.some((m) => m.role === 'assistant'));
    const reading = f.client.getSnapshot().messages;
    await f.client.selectSession(f.b);
    const held = f.holdHistory();
    const selection = f.client.selectSession(f.a);
    expect(f.client.getSnapshot().messages).toBe(reading);
    await held.arrived;
    await Bun.sleep(800);
    held.release();
    await selection;
    await waitFor(() =>
      f.client.getSnapshot().messages.some((m) => m.role === 'assistant' && m.settled),
    );
    expect(
      f.client
        .getSnapshot()
        .messages.filter((m) => m.role === 'assistant')
        .map((m) => m.text),
    ).toEqual(['first second final']);
    await f.client.selectSession(f.b);
    await f.client.selectSession(f.a);
    expect(
      f.client
        .getSnapshot()
        .messages.filter((m) => m.role === 'assistant')
        .map((m) => m.text),
    ).toEqual(['first second final']);
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('a cached waiting interaction remains non-actionable until fresh history and subscription settle', async () => {
  const f = await fixture([
    {
      message: {
        tool_calls: [
          {
            id: 'question',
            name: 'ask_user',
            args: {
              questions: [
                {
                  question: 'Choose a language',
                  options: [
                    { label: 'TypeScript', description: 'Typed code', recommended: true },
                    { label: 'Python', description: 'Scripts', recommended: false },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'question', contentIncludes: ['TypeScript'] }],
      },
      message: { content: 'Question answered.' },
    },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Ask me which language to use.');
    await waitFor(
      () =>
        f.client
          .getSnapshot()
          .projection?.interactionQueue.interactions.some((item) => item.kind === 'input') === true,
    );
    const oldInteraction = f.client.getSnapshot().projection!.interactionQueue.interactions[0]!;
    expect(oldInteraction.kind).toBe('input');
    if (oldInteraction.kind !== 'input') throw new Error('Expected a question');
    await f.client.selectSession(f.b);
    const held = f.holdHistory();
    const loading = f.client.selectSession(f.a);
    await held.arrived;
    expect(f.client.getSnapshot().hasLoadedHistory).toBe(true);
    await expect(f.client.respondInput(f.a, oldInteraction, 'TypeScript')).rejects.toThrow('会话');
    held.release();
    await loading;
    const fresh = f.client.getSnapshot().projection!.interactionQueue.interactions[0]!;
    if (fresh.kind !== 'input') throw new Error('Expected a fresh question');
    await f.client.respondInput(f.a, fresh, 'TypeScript');
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((message) => message.text === 'Question answered.' && message.settled),
    );
    expect(new Set(f.client.getSnapshot().messages.map((message) => message.id)).size).toBe(
      f.client.getSnapshot().messages.length,
    );
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('one ask_user call projects and settles every question with stable ownership', async () => {
  const f = await fixture([
    {
      message: {
        tool_calls: [
          {
            id: 'batch-question',
            name: 'ask_user',
            args: {
              questions: [
                {
                  question: 'Choose a language',
                  options: [
                    { label: 'TypeScript', description: 'Typed code', recommended: true },
                    { label: 'Python', description: 'Scripts', recommended: false },
                  ],
                },
                {
                  question: 'Choose a database',
                  options: [
                    { label: 'Postgres', description: 'Server database', recommended: true },
                    { label: 'SQLite', description: 'Local database', recommended: false },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'batch-question', contentIncludes: ['TypeScript', 'SQLite'] }],
      },
      message: { content: 'Both questions answered.' },
    },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Ask both questions in one call.');
    await waitFor(
      () => f.client.getSnapshot().projection?.interactionQueue.interactions[0]?.kind === 'input',
    );
    const interaction = f.client.getSnapshot().projection!.interactionQueue.interactions[0]!;
    if (interaction.kind !== 'input') throw new Error('Expected a batch question');
    expect(interaction.questions?.map((question) => question.id)).toEqual(['q1', 'q2']);
    expect(interaction.questions?.map((question) => question.question)).toEqual([
      'Choose a language',
      'Choose a database',
    ]);
    await f.client.respondInput(f.a, interaction, 'q1: TypeScript\nq2: SQLite', {
      q1: 'q1-o1',
      q2: 'q2-o2',
    });
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((message) => message.text === 'Both questions answered.' && message.settled),
    );
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('cached approval requires fresh calibration before an external file write can be approved', async () => {
  const f = await fixture();
  const path = resolve(f.client.getSnapshot().workspace, '../home/approved.txt');
  f.model.setResponses([
    {
      message: {
        tool_calls: [
          { id: 'write-approved', name: 'write_file', args: { path, content: 'approved' } },
        ],
      },
    },
    {
      expectedRequest: {
        toolResults: [{ toolCallId: 'write-approved', contentIncludes: ['approved.txt'] }],
      },
      message: { content: 'Approved write completed.' },
    },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Write the requested file.');
    await waitFor(
      () =>
        f.client
          .getSnapshot()
          .projection?.interactionQueue.interactions.some((item) => item.kind === 'approval') ===
        true,
    );
    const old = f.client.getSnapshot().projection!.interactionQueue.interactions[0]!;
    if (old.kind !== 'approval') throw new Error('Expected an approval');
    await f.client.selectSession(f.b);
    const held = f.holdHistory();
    const loading = f.client.selectSession(f.a);
    await held.arrived;
    expect(f.client.getSnapshot().hasLoadedHistory).toBe(true);
    await expect(f.client.respondApproval(f.a, old, 'approve_once')).rejects.toThrow('会话');
    held.release();
    await loading;
    const fresh = f.client.getSnapshot().projection!.interactionQueue.interactions[0]!;
    if (fresh.kind !== 'approval') throw new Error('Expected a fresh approval');
    await f.client.respondApproval(f.a, fresh, 'approve_once');
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((m) => m.text === 'Approved write completed.' && m.settled),
    );
    expect(await Bun.file(path).text()).toBe('approved');
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test('an explicit new-session send keeps its target while another cached selection calibrates', async () => {
  const f = await fixture([{ message: { content: 'Reply belongs to the new session.' } }]);
  try {
    const created = await f.client.newSession();
    expect(f.client.getSnapshot().selected).toBe(f.b);
    const held = f.holdHistory();
    const reading = f.client.selectSession(f.a);
    await held.arrived;
    const sending = f.client.send('Send to the newly created session.', created);
    held.release();
    await Promise.all([reading, sending]);
    expect(f.client.getSnapshot().selected).toBe(f.a);
    expect(f.client.getSnapshot().messages).toEqual([]);
    await f.client.selectSession(created);
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((m) => m.text === 'Reply belongs to the new session.' && m.settled),
    );
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);

test.each([
  'projection',
  'subscription',
] as const)('first history stays readable when live %s fails', async (kind) => {
  const f = await fixture([{ message: { content: 'Saved before the live failure.' } }]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Keep this history readable.');
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((m) => m.text === 'Saved before the live failure.' && m.settled),
    );
    await f.client.selectSession(f.b);
    await f.client.disconnect();
    await f.client.connect();
    f.failLiveRead(kind);
    await expect(f.client.selectSession(f.a)).rejects.toThrow('fixture history failure');
    expect(f.client.getSnapshot()).toMatchObject({
      selected: f.a,
      hasLoadedHistory: true,
      loadingSession: false,
      ready: false,
    });
    expect(
      f.client.getSnapshot().messages.some((m) => m.text === 'Saved before the live failure.'),
    ).toBe(true);
    await expect(f.client.send('must not send while uncalibrated')).rejects.toThrow('同步');
    await f.client.selectSession(f.a);
    expect(f.client.getSnapshot().ready).toBe(true);
    expect(f.model.getRequestCount()).toBe(1);
  } finally {
    await f.close();
  }
}, 20_000);

test('a subscription readiness timeout preserves history and the shared connection', async () => {
  const f = await fixture([{ message: { content: 'Readable during live outage.' } }]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Save this before the outage.');
    await waitFor(() =>
      f.client
        .getSnapshot()
        .messages.some((m) => m.text === 'Readable during live outage.' && m.settled),
    );
    await f.client.selectSession(f.b);
    await f.client.disconnect();
    await f.client.connect();
    const connectionGeneration = f.connectionGeneration;
    const detachRequests = f.detachRequests;
    const held = f.holdSubscription();
    const loading = f.client.selectSession(f.a);
    const timeout = expect(loading).rejects.toThrow('会话加载超时');
    await held.arrived;
    expect(f.client.getSnapshot()).toMatchObject({ hasLoadedHistory: true, ready: false });
    expect(
      f.client.getSnapshot().messages.some((m) => m.text === 'Readable during live outage.'),
    ).toBe(true);
    await timeout;
    expect(f.client.getSnapshot()).toMatchObject({
      connected: true,
      hasLoadedHistory: true,
      loadingSession: false,
      ready: false,
    });
    expect(f.detachRequests).toBe(detachRequests);
    held.release();
    await f.client.selectSession(f.b);
    expect(f.client.getSnapshot().ready).toBe(true);
    await f.client.selectSession(f.a);
    expect(f.client.getSnapshot().ready).toBe(true);
    expect(f.connectionGeneration).toBe(connectionGeneration);
    expect(f.detachRequests).toBe(detachRequests);
    expect(f.model.getRequestCount()).toBe(1);
  } finally {
    await f.close();
  }
}, 30_000);

test('a History timeout stays local while another Session Run continues', async () => {
  const run = gate();
  const f = await fixture([
    {
      response: async () => {
        run.arrive();
        await run.released;
        return { message: { content: 'Run survived another Session History timeout.' } };
      },
    },
  ]);
  try {
    await f.client.selectSession(f.a);
    await f.client.send('Keep running while I read another Session.');
    await run.arrived;
    const connectionGeneration = f.connectionGeneration;
    const detachRequests = f.detachRequests;
    const held = f.holdHistory();
    const loading = f.client.selectSession(f.b);
    const timeout = expect(loading).rejects.toThrow('会话加载超时');
    await held.arrived;
    await timeout;
    expect(f.client.getSnapshot()).toMatchObject({
      connected: true,
      selected: f.b,
      loadingSession: false,
      ready: false,
    });
    expect(f.detachRequests).toBe(detachRequests);
    held.release();
    await f.client.selectSession(f.a);
    expect(f.client.getSnapshot()).toMatchObject({ selected: f.a, ready: true });
    expect(f.client.getSnapshot().projection?.currentRun?.status).toBe('running');
    expect(f.connectionGeneration).toBe(connectionGeneration);
    expect(f.cancelCommands).toBe(0);
    run.release();
    await waitFor(() => f.client.getSnapshot().projection?.currentRun?.status === 'completed');
    expect(
      f.client
        .getSnapshot()
        .messages.some(
          (message) =>
            message.text === 'Run survived another Session History timeout.' && message.settled,
        ),
    ).toBe(true);
    expect(f.model.getRequestCount()).toBe(1);
  } finally {
    run.release();
    await f.close();
  }
}, 30_000);

test('a live durable gap reloads omitted messages before restoring selected-session readiness', async () => {
  const f = await fixture([{ message: { content: 'answer after gap' } }]);
  try {
    await f.client.selectSession(f.a);
    const before = f.historyRequests;
    const held = f.holdHistory();
    f.dropLiveEvent('user.message');
    await f.client.send('message omitted from live delivery');
    await Promise.race([
      held.arrived,
      Bun.sleep(2000).then(() => {
        throw new Error('Gap did not trigger history calibration');
      }),
    ]);
    expect(f.client.getSnapshot()).toMatchObject({
      selected: f.a,
      ready: false,
      hasLoadedHistory: true,
    });
    held.release();
    await waitFor(
      () =>
        f.client.getSnapshot().ready &&
        f.client
          .getSnapshot()
          .messages.some((message) => message.text === 'answer after gap' && message.settled),
    );
    expect(
      f.client
        .getSnapshot()
        .messages.filter((message) => message.text === 'message omitted from live delivery'),
    ).toHaveLength(1);
    expect(f.historyRequests).toBeGreaterThan(before);
    const after = f.historyRequests;
    await f.client.refreshDirectory();
    await Bun.sleep(30);
    expect(f.historyRequests).toBe(after);
    f.model.assertComplete();
  } finally {
    await f.close();
  }
}, 20_000);
