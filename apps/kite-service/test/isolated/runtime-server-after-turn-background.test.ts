import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeAccessNotification,
  type RuntimeBackgroundExecutionProjection,
  type RuntimeNotification,
} from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import { openRuntimeServerInProcessPair } from '@kite-ai/runtime-server';
import {
  createMockModelServer,
  type MockChatRequest,
  type MockResponse,
} from '../../../../tests/tui-system/harness/fixtures';
import { createKiteCliRuntimeServer } from '../../src/bootstrap';
import {
  managedShellOwnerKey,
  managedShellRuntime,
} from '../../src/bootstrap/runtime/managed-shell';
import { createPreparedAppShellExecutor } from '../../src/sandbox/composition';

const ROOT_MARKER = 'ROOT_AFTER_TURN_SCENARIO';
const SERVICES_MARKER = 'START_RETAINED_SERVICES';
const CHILD_MARKER = 'LATE_CHILD_SCENARIO';
const CHILD_RESULT_MARKER = 'late-child-artifact-result';
const RECONNECT_MARKER = 'READ_ARTIFACT_AFTER_RECONNECT';

test('default App Server preserves after-turn, retained service, stop, and reconnect authority', async () => {
  const workspace = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-runtime-server-after-turn-')),
  );
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const sessionId = 'after-turn-background-session';
  const model = createMockModelServer();
  let artifactTaskId: string | undefined;
  const routeResponse = (request: MockChatRequest): MockResponse => {
    const toolResultIds = new Set(
      request.messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.tool_call_id),
    );
    if (hasUserText(request, RECONNECT_MARKER)) {
      if (toolResultIds.has('artifact-read')) {
        return {
          expectedRequest: {
            toolResults: [{ toolCallId: 'artifact-read', contentIncludes: [CHILD_RESULT_MARKER] }],
          },
          message: { content: 'artifact-read-after-reconnect' },
        };
      }
      if (!artifactTaskId) throw new Error('Reconnect artifact Task identity is unavailable.');
      return {
        toolContinuation: 'required',
        message: {
          tool_calls: [
            { id: 'artifact-read', name: 'task_read', args: { task_id: artifactTaskId } },
          ],
        },
      };
    }
    if (hasUserText(request, 'A background sub-agent result is ready.')) {
      return { message: { content: 'one-real-after-turn-report' } };
    }
    if (hasUserText(request, CHILD_MARKER)) {
      return { delay: 300, message: { content: CHILD_RESULT_MARKER } };
    }
    if (toolResultIds.has('late-child')) {
      const accepted = request.messages.find(
        (message) => message.role === 'tool' && message.tool_call_id === 'late-child',
      );
      artifactTaskId = JSON.stringify(accepted?.content).match(/subagent-[a-f0-9]+/u)?.[0];
      if (!artifactTaskId) throw new Error('Background Task identity was not returned.');
      return {
        expectedRequest: {
          toolResults: [{ toolCallId: 'late-child' }],
        },
        message: { content: 'root-run-terminal-before-child' },
      };
    }
    if (hasUserText(request, ROOT_MARKER)) {
      return {
        toolContinuation: 'required',
        message: {
          tool_calls: [
            {
              id: 'late-child',
              name: 'task',
              args: {
                name: 'Late child result',
                subagent_type: 'review',
                task: `${CHILD_MARKER}: return durable evidence after the parent completes.`,
                background: true,
                result_disposition: 'after_turn',
              },
            },
          ],
        },
      };
    }
    if (toolResultIds.has('retained-service') || toolResultIds.has('natural-service')) {
      return {
        expectedRequest: {
          toolResults: [{ toolCallId: 'retained-service' }, { toolCallId: 'natural-service' }],
        },
        message: { content: 'service-setup-terminal' },
      };
    }
    if (hasUserText(request, SERVICES_MARKER)) {
      return {
        toolContinuation: 'required',
        message: {
          tool_calls: [
            {
              id: 'retained-service',
              name: 'shell_execute',
              args: { command: 'cat retained-service.txt', mode: 'service', yield_ms: 0 },
            },
            {
              id: 'natural-service',
              name: 'shell_execute',
              args: { command: 'cat natural-service.txt', mode: 'service', yield_ms: 0 },
            },
          ],
        },
      };
    }
    throw new Error(`Unexpected model request: ${JSON.stringify(request.messages)}`);
  };
  model.setResponses(
    Array.from({ length: 8 }, () => ({ response: routeResponse }) satisfies MockResponse),
  );

  let finishNaturalService!: () => void;
  const naturalService = new Promise<void>((resolvePromise) => {
    finishNaturalService = resolvePromise;
  });
  let retainedStopCount = 0;
  const shellExecutor = createPreparedAppShellExecutor({
    workspace,
    sandboxEnabled: false,
    resolveBackend: () => 'none',
    createNativeExecutor: () => async () => {
      throw new Error('The host-shell test seam must be selected.');
    },
    createHostExecutor:
      () =>
      async ({ command, signal }) => {
        if (command === 'cat natural-service.txt') await naturalService;
        if (command === 'cat retained-service.txt') {
          await new Promise<void>((resolvePromise) => {
            if (signal?.aborted) resolvePromise();
            else signal?.addEventListener('abort', () => resolvePromise(), { once: true });
          });
          retainedStopCount += 1;
          return {
            ok: false,
            command,
            exitCode: 130,
            stdout: '',
            stderr: '',
            terminationReason: 'cancelled',
          };
        }
        return { ok: true, command, exitCode: 0, stdout: `${command}:done`, stderr: '' };
      },
  });
  const owner = createKiteCliRuntimeServer({
    sessionId,
    userId: 'after-turn-user',
    workspace,
    checkpointPath: join(workspace, 'runtime.sqlite'),
    config: {
      providerName: 'after-turn-model',
      providerType: 'openai-compatible',
      apiKey: 'test-key',
      baseURL: model.baseURL,
      modelName: 'mock-model',
      modelKwargs: { maxOutputTokens: 64 },
      modelCapabilities: { contextWindowTokens: 16_384, maxOutputTokens: 64 },
      features: { afterTurnContinuation: true, resourceBudget: true },
      sandbox: { enabled: true },
    },
    shellExecutor,
    interactionMode: 'accept_edits',
    sandboxBackend: 'seatbelt',
    skillOptions: skillOptions(workspace),
    initialSkillActivations: [],
  });
  const firstPair = openRuntimeServerInProcessPair(owner.server);
  const first = clientFor(firstPair, 'after-turn-first-client');
  let second: RuntimeClient | undefined;

  try {
    await expect(
      first.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'create-after-turn-session',
        type: 'create_session',
        workspace,
        bootstrapSessionId: sessionId,
      }),
    ).resolves.toMatchObject({ status: 'applied', sessionId, revision: 0 });
    const stream = first
      .subscribe({ spec: { scope: 'session', sessionId } })
      [Symbol.asyncIterator]();
    await nextNotification(stream);
    await expect(
      first.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'start-service-setup',
        type: 'start_turn',
        sessionId,
        expectedRevision: 0,
        input: SERVICES_MARKER,
      }),
    ).resolves.toMatchObject({ status: 'applied', sessionId });
    const setupTerminal = await terminalNotification(stream, sessionId).catch(async (error) => {
      const database = new Database(join(workspace, 'kite-session.sqlite'), { readonly: true });
      const events = database
        .query<{ event_json: string }, [string]>(
          'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
        )
        .all(sessionId)
        .map(({ event_json }) => JSON.parse(event_json));
      database.close();
      throw new Error(
        `Service setup did not terminate: ${String(error)} requests=${model.getRequestCount()} events=${JSON.stringify(events)}`,
      );
    });
    const setupRunId = setupTerminal.projection.session.currentRun?.runId;
    expect(model.getRequestCount()).toBe(2);
    const retainedReceipt = model
      .getRequests()[1]
      ?.messages.find(
        (message) => message.role === 'tool' && message.tool_call_id === 'retained-service',
      );
    const retainedShellId = JSON.stringify(retainedReceipt?.content).match(/sh_[a-f0-9-]+/u)?.[0];
    if (!retainedShellId) throw new Error('Retained service receipt has no Shell identity.');
    await waitForAsync(() => sessionIsIdle(first, sessionId));
    const setupBackground = await backgroundExecutions(first, sessionId);
    if (!setupBackground.some((execution) => execution.kind === 'service')) {
      throw new Error(`Missing setup service: ${JSON.stringify(model.getRequests()[1]?.messages)}`);
    }
    const afterSetup = await sessionProjection(first, sessionId);
    await expect(
      first.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'start-after-turn-root',
        type: 'start_turn',
        sessionId,
        expectedRevision: afterSetup.revision,
        input: ROOT_MARKER,
      }),
    ).resolves.toMatchObject({ status: 'applied', sessionId });

    const rootTerminal = await terminalNotification(stream, sessionId, setupRunId).catch(
      async (error) => {
        const projection = await sessionProjection(first, sessionId);
        const database = new Database(join(workspace, 'kite-session.sqlite'), {
          readonly: true,
        });
        const failedEvents = database
          .query<{ event_json: string }, [string]>(
            'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
          )
          .all(sessionId)
          .map(({ event_json }) => JSON.parse(event_json) as { readonly type?: string })
          .filter((event) => event.type === 'tool.failed');
        database.close();
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} requests=${model.getRequestCount()} run=${JSON.stringify(projection.currentRun)} interactions=${JSON.stringify(projection.interactionQueue)} failures=${JSON.stringify(failedEvents)}`,
        );
      },
    );
    const originRunId = rootTerminal.projection.session.currentRun?.runId;
    expect(originRunId).toBeString();
    expect(rootTerminal.projection.session.currentRun).toMatchObject({ status: 'completed' });
    // The child may finish before this notification is consumed, allowing the
    // after-turn report to begin while the test reads the completed root Run.
    expect(model.getRequestCount()).toBeGreaterThanOrEqual(4);
    expect(model.getRequestCount()).toBeLessThanOrEqual(6);

    await waitForAsync(() => Promise.resolve(model.getRequestCount() === 6)).catch(
      async (error) => {
        const background = await backgroundExecutions(first, sessionId).catch((queryError) => [
          { queryError: String(queryError) },
        ]);
        const database = new Database(join(workspace, 'kite-session.sqlite'), { readonly: true });
        const events = database
          .query<{ event_json: string }, [string]>(
            'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
          )
          .all(sessionId)
          .map(({ event_json }) => JSON.parse(event_json) as { readonly type?: string })
          .filter(
            (event) =>
              event.type?.startsWith('background') ||
              event.type?.startsWith('resource_budget') ||
              event.type?.startsWith('model.') ||
              event.type?.startsWith('run.') ||
              event.type?.startsWith('turn.') ||
              event.type?.startsWith('subagent') ||
              event.type?.startsWith('capability.subagent'),
          );
        const resultArtifacts = database
          .query<{ canonical_json: string }, []>(
            "SELECT canonical_json FROM subagent_task_artifacts WHERE kind = 'subagent_task' ORDER BY created_at",
          )
          .all()
          .map(({ canonical_json }) => JSON.parse(canonical_json));
        database.close();
        throw new Error(
          `After-turn wake did not start: ${String(error)} requests=${model.getRequestCount()} background=${JSON.stringify(background)} artifacts=${JSON.stringify(resultArtifacts)} events=${JSON.stringify(events)}`,
        );
      },
    );
    const afterTurnTerminal = await terminalNotification(stream, sessionId, originRunId);
    const afterTurnRunId = afterTurnTerminal.projection.session.currentRun?.runId;
    expect(afterTurnRunId).toBeString();
    expect(afterTurnRunId).not.toBe(originRunId);
    expect(model.getRequestCount()).toBe(6);

    let background = await backgroundExecutions(first, sessionId);
    const retained = background.find((execution) => execution.executionId === retainedShellId);
    if (!retained) throw new Error('Retained service is absent from the directory.');
    expect(retained).toMatchObject({ kind: 'service', status: 'running' });
    const child = requiredExecution(background, 'subagent', 'completed');
    artifactTaskId = child.executionId;

    finishNaturalService();
    await waitForAsync(async () => {
      background = await backgroundExecutions(first, sessionId);
      return background
        .filter((execution) => execution.kind === 'service')
        .some(
          (execution) =>
            execution.executionId !== retained.executionId && execution.status === 'completed',
        );
    }).catch((error) => {
      const services = background
        .filter((execution) => execution.kind === 'service')
        .map((execution) => {
          try {
            return {
              execution,
              shell: managedShellRuntime.read(
                execution.executionId,
                managedShellOwnerKey(sessionId, workspace),
              ),
            };
          } catch (readError) {
            return { execution, readError: String(readError) };
          }
        });
      throw new Error(
        `Natural service did not complete: ${String(error)} services=${JSON.stringify(services)}`,
      );
    });
    expect(model.getRequestCount()).toBe(6);

    const beforeStop = await sessionProjection(first, sessionId);
    await expect(
      first.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'stop-retained-service',
        type: 'stop_background_execution',
        sessionId,
        expectedRevision: beforeStop.revision,
        executionId: retained.executionId,
        executionKind: retained.kind,
        expectedExecutionRevision: retained.revision,
        expectedOwnerGeneration: retained.ownerGeneration,
      }),
    ).resolves.toMatchObject({ status: 'applied', sessionId });
    await waitForAsync(async () => {
      const executions = await backgroundExecutions(first, sessionId);
      return executions.some(
        (execution) =>
          execution.executionId === retained.executionId &&
          execution.status === 'cancelled' &&
          execution.cleanupConfirmed,
      );
    });
    expect(retainedStopCount).toBe(1);
    expect(model.getRequestCount()).toBe(6);

    await waitForAsync(() => sessionIsIdle(first, sessionId));
    await stream.return?.();
    await first.close();
    const secondPair = openRuntimeServerInProcessPair(owner.server);
    second = clientFor(secondPair, 'after-turn-reconnected-client');
    const runs = await second.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'list_runs',
      sessionId,
      limit: 20,
    });
    expect(runs).toMatchObject({ status: 'ok', queryType: 'list_runs' });
    if (runs.status !== 'ok') throw new Error('Run history was unavailable after reconnect.');
    expect(runs.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: originRunId, status: 'completed' }),
        expect.objectContaining({ runId: afterTurnRunId, status: 'completed' }),
      ]),
    );
    const reconnectedBackground = await backgroundExecutions(second, sessionId);
    expect(reconnectedBackground).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: artifactTaskId,
          kind: 'subagent',
          status: 'completed',
          cleanupConfirmed: true,
        }),
      ]),
    );

    const beforeRead = await sessionProjection(second, sessionId);
    const reconnectedStream = second
      .subscribe({ spec: { scope: 'session', sessionId } })
      [Symbol.asyncIterator]();
    await nextNotification(reconnectedStream);
    await expect(
      second.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'read-artifact-after-reconnect',
        type: 'start_turn',
        sessionId,
        expectedRevision: beforeRead.revision,
        input: RECONNECT_MARKER,
      }),
    ).resolves.toMatchObject({ status: 'applied', sessionId });
    const readTerminal = await terminalNotification(reconnectedStream, sessionId, afterTurnRunId);
    expect(readTerminal.projection.session.currentRun).toMatchObject({ status: 'completed' });
    expect(model.getRequestCount()).toBe(8);
    expect(
      model
        .getRequests()
        .flatMap((request) => request.messages)
        .find((message) => message.tool_call_id === 'artifact-read')?.content,
    ).toContain(CHILD_RESULT_MARKER);
    await reconnectedStream.return?.();
    model.assertComplete();
  } finally {
    finishNaturalService();
    await first.close();
    await second?.close();
    await owner[Symbol.asyncDispose]();
    model.stop();
    if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    rmSync(resolve(workspace), { recursive: true, force: true });
  }
}, 30_000);

function clientFor(
  pair: ReturnType<typeof openRuntimeServerInProcessPair>,
  instanceId: string,
): RuntimeClient {
  return new RuntimeClient({
    transport: inProcessTransport(pair),
    clientInfo: { name: 'after-turn-background-test', version: '1', instanceId },
  });
}

function inProcessTransport(
  pair: ReturnType<typeof openRuntimeServerInProcessPair>,
): RuntimeClientTransport {
  return Object.freeze({
    connect: async () => ({
      send: (message: RuntimeProtocolMessage) => pair.client.send(message),
      messages: async function* () {
        yield* pair.client.messages();
      },
      close: (reason?: string) => pair.client.close(reason),
    }),
  });
}

function hasUserText(request: MockChatRequest, text: string): boolean {
  return request.messages.some(
    (message) => message.role === 'user' && JSON.stringify(message.content).includes(text),
  );
}

async function nextNotification(
  iterator: AsyncIterator<RuntimeAccessNotification>,
): Promise<RuntimeAccessNotification> {
  const item = await Promise.race([
    iterator.next(),
    Bun.sleep(5_000).then(() => {
      throw new Error('Timed out waiting for a Runtime notification.');
    }),
  ]);
  if (item.done) throw new Error('Runtime subscription closed before the expected notification.');
  return item.value;
}

async function terminalNotification(
  iterator: AsyncIterator<RuntimeAccessNotification>,
  sessionId: string,
  excludedRunId?: string,
): Promise<Extract<RuntimeNotification, { readonly durability: 'durable' }>> {
  const observed: unknown[] = [];
  for (let index = 0; index < 100; index += 1) {
    const notification = await nextNotification(iterator);
    if ('durability' in notification && notification.durability === 'durable') {
      observed.push(notification.projection.event);
    }
    if (
      'durability' in notification &&
      notification.durability === 'durable' &&
      notification.sessionId === sessionId &&
      notification.projection.session.currentRun?.status === 'failed'
    ) {
      throw new Error(`Run failed before the expected terminal: ${JSON.stringify(observed)}`);
    }
    if (
      'durability' in notification &&
      notification.durability === 'durable' &&
      notification.sessionId === sessionId &&
      notification.projection.session.currentRun?.status === 'completed' &&
      notification.projection.session.currentRun.runId !== excludedRunId
    ) {
      return notification;
    }
  }
  throw new Error('Runtime subscription did not publish the expected terminal Run.');
}

async function backgroundExecutions(
  client: RuntimeClient,
  sessionId: string,
): Promise<readonly RuntimeBackgroundExecutionProjection[]> {
  const result = await client.query({
    schema: RUNTIME_QUERY_SCHEMA_,
    type: 'list_background_executions',
    sessionId,
  });
  if (result.status !== 'ok' || !result.backgroundSnapshot) {
    throw new Error('Background execution snapshot is unavailable.');
  }
  return result.backgroundSnapshot.executions;
}

function requiredExecution(
  executions: readonly RuntimeBackgroundExecutionProjection[],
  kind: RuntimeBackgroundExecutionProjection['kind'],
  status: RuntimeBackgroundExecutionProjection['status'],
): RuntimeBackgroundExecutionProjection {
  const execution = executions.find(
    (candidate) => candidate.kind === kind && candidate.status === status,
  );
  if (!execution) {
    throw new Error(`Missing ${kind} execution in ${status} state: ${JSON.stringify(executions)}`);
  }
  return execution;
}

async function sessionProjection(client: RuntimeClient, sessionId: string) {
  const result = await client.query({
    schema: RUNTIME_QUERY_SCHEMA_,
    type: 'get_session_projection',
    sessionId,
  });
  if (result.status !== 'ok' || !result.session) {
    throw new Error('Session projection is unavailable.');
  }
  return result.session;
}

async function sessionIsIdle(client: RuntimeClient, sessionId: string): Promise<boolean> {
  const result = await client.query({
    schema: RUNTIME_QUERY_SCHEMA_,
    type: 'get_context_status',
    sessionId,
  });
  return result.status === 'ok' && result.context?.compactionAvailable === true;
}

async function waitForAsync(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for the deterministic App Server state.');
}

function skillOptions(workspace: string) {
  return {
    userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
    userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
    projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
    projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
  };
}
