import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';

test('child Provider retries keep the required parent waiting and then complete without an attempt cap', async () => {
  const fixture = await createFixture('required-child-failure');
  const { model, runtime, storage, sessionId } = fixture;
  const parentInput = 'Start one required failing child and wait for it.';
  let parentRequests = 0;
  let childRequests = 0;
  model.setResponses(
    Array.from({ length: 12 }, () => ({
      response: ({ messages }: { messages: readonly unknown[] }) => {
        const request = JSON.stringify(messages);
        if (request.includes('REQUIRED_CHILD_FAILURE') && !request.includes(parentInput)) {
          childRequests += 1;
          return childRequests <= 2
            ? { error: 'injected child provider failure' }
            : { message: { content: 'The child recovered after two Provider retries.' } };
        }
        parentRequests += 1;
        if (parentRequests === 1)
          return {
            message: {
              tool_calls: [
                {
                  id: 'required-failing-child',
                  name: 'task',
                  args: {
                    name: 'Failing child',
                    subagent_type: 'explore',
                    task: 'REQUIRED_CHILD_FAILURE',
                    background: true,
                    result_disposition: 'required',
                  },
                },
              ],
            },
            toolContinuation: 'required' as const,
          };
        return {
          message: { content: 'The required child completed successfully.' },
          expectedRequest: { toolResults: [{ toolCallId: 'required-failing-child' }] },
        };
      },
    })),
  );

  try {
    await createAndStart(runtime, fixture, parentInput);
    const active = await waitForActiveRun(storage, sessionId);
    const originRunId = active.runId;
    await waitFor(() =>
      storage.storage.sessions
        .loadEventsStrict(sessionId)
        .some(({ event }) => event.type === 'resource_budget.required_child_wait_started'),
    );
    const events = storage.storage.sessions.loadEventsStrict(sessionId).map(({ event }) => event);
    const childSessionId = events.find(
      (event) => event.type === 'subagent.child_session_intended',
    )?.childThreadId;
    if (!childSessionId) throw new Error('Required child Session was not created.');
    await waitFor(() =>
      storage.storage.sessions
        .loadEventsStrict(childSessionId)
        .some(({ event }) => event.type === 'model.retry' && event.attempt >= 2),
    );
    const childEvents = storage.storage.sessions
      .loadEventsStrict(childSessionId)
      .map(({ event }) => event);
    expect(childEvents).toContainEqual(
      expect.objectContaining({ type: 'model.retry', maxAttempts: Number.MAX_SAFE_INTEGER }),
    );
    expect(storage.storage.runs?.getActive(sessionId)?.runId).toBe(originRunId);
    expect(events.some((event) => event.type === 'subagent.child_terminal_imported')).toBe(false);
    expect(parentRequests).toBe(2);
    expect(
      model
        .getRequests()
        .some(({ messages }) =>
          messages.some((message) =>
            Array.isArray((message as { tool_calls?: unknown }).tool_calls)
              ? (
                  (message as { tool_calls: Array<{ function?: { name?: string } }> }).tool_calls ??
                  []
                ).some((call) => call.function?.name === 'task_read')
              : false,
          ),
        ),
    ).toBe(false);
    await waitFor(() => storage.loadCurrentSnapshot(sessionId)?.turn.status === 'completed');
    await waitFor(() => !storage.storage.runs?.getActive(childSessionId));
    expect(storage.loadCurrentSnapshot(childSessionId)?.turn.status).toBe('completed');
    expect(childRequests).toBe(3);
    expect(
      storage.storage.sessions
        .loadEventsStrict(sessionId)
        .some(({ event }) => event.type === 'subagent.child_terminal_imported'),
    ).toBe(true);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

test('cancelling a required-background wait clears its child and late Provider output cannot revive the Run', async () => {
  const fixture = await createFixture('required-child-cancel');
  const { model, runtime, storage, sessionId } = fixture;
  const parentInput = 'Start one required child and keep waiting.';
  let parentRequests = 0;
  model.setResponses(
    Array.from({ length: 8 }, () => ({
      response: ({ messages }: { messages: readonly unknown[] }) => {
        const request = JSON.stringify(messages);
        if (request.includes('REQUIRED_CHILD_LATE_RESULT') && !request.includes(parentInput))
          return { delay: 300, message: { content: 'This late child result must be ignored.' } };
        parentRequests += 1;
        if (parentRequests === 1)
          return {
            message: {
              tool_calls: [
                {
                  id: 'required-cancelled-child',
                  name: 'task',
                  args: {
                    name: 'Cancelled child',
                    subagent_type: 'explore',
                    task: 'REQUIRED_CHILD_LATE_RESULT',
                    background: true,
                    result_disposition: 'required',
                  },
                },
              ],
            },
            toolContinuation: 'required' as const,
          };
        return {
          message: { content: 'The parent must remain waiting for its required child.' },
          expectedRequest: { toolResults: [{ toolCallId: 'required-cancelled-child' }] },
        };
      },
    })),
  );

  try {
    await createAndStart(runtime, fixture, parentInput);
    await waitFor(() => model.getRequestCount() === 3);
    const before = storage.loadCurrentSnapshot(sessionId);
    const active = storage.storage.runs?.getActive(sessionId);
    if (!before || !active) throw new Error('Expected an active required-background Run.');
    const originRunId = active.runId;

    expect(
      await runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'cancel_turn',
        commandId: 'cancel-required-background',
        sessionId,
        runId: originRunId,
        turnId: before.turn.turnId,
        expectedRevision: before.revision,
      }),
    ).toMatchObject({ status: 'applied' });

    await waitFor(() => storage.loadCurrentSnapshot(sessionId)?.turn.status === 'aborted');
    await Bun.sleep(500);
    const after = storage.loadCurrentSnapshot(sessionId);
    const events = storage.storage.sessions.loadEventsStrict(sessionId).map(({ event }) => event);
    expect(storage.storage.runs?.get(sessionId, originRunId)).toMatchObject({
      runId: originRunId,
      status: 'cancelled',
    });
    expect(after?.turn.status).toBe('aborted');
    expect(model.getRequestCount()).toBe(3);
    expect(events.filter((event) => event.type === 'subagent.completed')).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent.child_terminal_imported',
        status: 'cancelled',
      }),
    );
    expect(JSON.stringify(events)).not.toContain('This late child result must be ignored.');
    const background = await runtime.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'list_background_executions',
      sessionId,
    });
    expect(background).toMatchObject({
      backgroundSnapshot: {
        executions: [expect.objectContaining({ status: 'cancelled', cleanupConfirmed: true })],
      },
    });
  } finally {
    await fixture.dispose();
  }
}, 20_000);

async function createFixture(label: string) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), `kite-${label}-`));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(root, 'kite-session.sqlite');
  const sessionId = `${label}-session`;
  const model = createMockModelServer();
  const storage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: `${label}-host`,
  });
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: storage,
    workspaces: [runtimeInput(workspace, model.baseURL)],
  });
  const runtime = client(server, workspace);
  return {
    root,
    workspace,
    sessionId,
    model,
    storage,
    server,
    runtime,
    async dispose() {
      await runtime.close();
      await server[Symbol.asyncDispose]();
      storage.disposeStorage();
      model.assertComplete({ allowUnconsumedResponses: true });
      model.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function createAndStart(
  runtime: RuntimeClient,
  fixture: { readonly workspace: string; readonly sessionId: string },
  input: string,
) {
  expect(
    await runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: `${fixture.sessionId}-create`,
      workspace: fixture.workspace,
      bootstrapSessionId: fixture.sessionId,
    }),
  ).toMatchObject({ status: 'applied' });
  expect(
    await runtime.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'start_turn',
      commandId: `${fixture.sessionId}-start`,
      sessionId: fixture.sessionId,
      expectedRevision: 0,
      input,
    }),
  ).toMatchObject({ status: 'applied' });
}

async function waitForActiveRun(
  storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>>,
  sessionId: string,
) {
  await waitFor(() => storage.storage.runs?.getActive(sessionId) !== undefined);
  const run = storage.storage.runs?.getActive(sessionId);
  if (!run) throw new Error('Expected an active Run.');
  return run;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error('Timed out waiting for the Runtime condition.');
}

function runtimeInput(workspace: string, baseURL: string) {
  return {
    userId: 'required-terminal-user',
    workspace,
    config: {
      providerName: 'required-terminal-model',
      providerType: 'openai-compatible' as const,
      apiKey: 'fixture-key',
      baseURL,
      modelName: 'mock-model',
      modelKwargs: { maxOutputTokens: 64 },
      modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
      features: { resourceBudget: true },
      sandbox: { enabled: false },
    },
    shellExecutor: async ({ command }: { command: string }) => ({
      ok: true as const,
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
    }),
    interactionMode: 'accept_edits' as const,
    sandboxBackend: 'none' as const,
    skillOptions: {
      userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
      userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
      projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
      projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
    },
    initialSkillActivations: [],
  };
}

function client(
  server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>,
  workspace: string,
) {
  const admission: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async (_request: RuntimeServerAdmissionInput) => ({
      allowed: true as const,
      workspace,
    }),
  });
  const transport: RuntimeClientTransport = Object.freeze({
    connect: async () => {
      const pair = server.open({ admission });
      return Object.freeze({
        send: (message: RuntimeProtocolMessage) => pair.client.send(message),
        messages: () => pair.client.messages(),
        close: (reason?: string) => pair.client.close(reason),
      });
    },
  });
  return new RuntimeClient({
    transport,
    clientInfo: { name: 'required-terminal-test', version: '1', instanceId: 'client' },
  });
}
