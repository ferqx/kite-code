import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeAccessNotification,
  type RuntimeBackgroundExecutionProjection,
} from '@kite-ai/runtime-contract';
import { resolveProjectIdentity } from '@kite-ai/runtime-host';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import {
  createMockModelServer,
  type MockChatRequest,
  type MockResponse,
} from '../../../../tests/tui-system/harness/fixtures';
import { createKiteMultiWorkspaceRuntimeServer } from '../../src/bootstrap';
import { createPreparedAppShellExecutor } from '../../src/sandbox/composition';

const A_ROOT = 'CROSS_SESSION_A_BACKGROUND';
const A_CHILD = 'CROSS_SESSION_A_CHILD';
const A_CHILD_RESULT = 'cross-session-a-child-result';
const A_SHELL_RESULT = 'cross-session-a-shell-result';
const B_ORDINARY = 'CROSS_SESSION_B_ORDINARY';
const B_ROOT = 'CROSS_SESSION_B_BACKGROUND';
const B_CHILD = 'CROSS_SESSION_B_CHILD';
const B_CHILD_RESULT = 'cross-session-b-child-result';
const B_SHELL_RESULT = 'cross-session-b-shell-result';

test('background shell and subagent completion stay isolated while another Session runs and is revisited', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-cross-session-background-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const model = createMockModelServer();
  const aShellGate = deferred<void>();
  const bShellGate = deferred<void>();
  const route = (request: MockChatRequest): MockResponse => {
    const snapshot = JSON.stringify(request.messages);
    if (snapshot.includes(A_CHILD) && !snapshot.includes(A_ROOT)) {
      return { delay: 2_000, message: { content: A_CHILD_RESULT } };
    }
    if (snapshot.includes(B_CHILD) && !snapshot.includes(B_ROOT)) {
      return { delay: 2_000, message: { content: B_CHILD_RESULT } };
    }
    if (snapshot.includes('A background sub-agent result is ready.')) {
      return { message: { content: 'background-result-wake-completed' } };
    }
    if (snapshot.includes(A_ROOT)) return backgroundResponse(request, 'a', A_CHILD);
    if (snapshot.includes(B_ROOT)) return backgroundResponse(request, 'b', B_CHILD);
    if (snapshot.includes(B_ORDINARY)) {
      return { message: { content: 'ordinary-session-b-completed' } };
    }
    throw new Error(`Unexpected model request: ${snapshot}`);
  };
  model.setResponses(
    Array.from({ length: 20 }, () => ({ response: route }) satisfies MockResponse),
  );

  const shellExecutor = createPreparedAppShellExecutor({
    workspace,
    sandboxEnabled: false,
    resolveBackend: () => 'none',
    createNativeExecutor: () => async () => {
      throw new Error('The host-shell test seam must be selected.');
    },
    createHostExecutor:
      () =>
      async ({ command }) => {
        if (command === 'cat cross-session-a-service.txt') {
          await aShellGate.promise;
          return shellResult(command, A_SHELL_RESULT);
        }
        if (command === 'cat cross-session-b-service.txt') {
          await bShellGate.promise;
          return shellResult(command, B_SHELL_RESULT);
        }
        throw new Error(`Unexpected shell command: ${command}`);
      },
  });
  const owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: join(root, 'runtime.sqlite'),
    workspaces: [
      {
        userId: 'cross-session-user',
        workspace,
        config: {
          providerName: 'cross-session-provider',
          providerType: 'openai-compatible',
          apiKey: 'test-key',
          baseURL: model.baseURL,
          modelName: 'mock-model',
          modelKwargs: { maxOutputTokens: 64 },
          modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
          features: { afterTurnContinuation: true, resourceBudget: true },
          sandbox: { enabled: true },
        },
        shellExecutor,
        interactionMode: 'accept_edits',
        sandboxBackend: 'seatbelt',
        skillOptions: skillOptions(workspace),
        initialSkillActivations: [],
      },
    ],
  });
  const runtime = client(owner, admission(workspace), 'primary');
  const sessionA = 'cross-session-background-a';
  const sessionB = 'cross-session-background-b';

  try {
    await createSession(runtime, sessionA);
    await createSession(runtime, sessionB);
    const streamA = runtime
      .subscribe({ spec: { scope: 'session', sessionId: sessionA } })
      [Symbol.asyncIterator]();
    await next(streamA);
    await runtime.command(start('start-a-background', sessionA, 0, A_ROOT));
    await waitForBackground(runtime, sessionA, (executions) =>
      hasRunningKinds(executions, ['service', 'subagent']),
    );

    // Leaving A is modeled by ending its subscription. B must complete a plain Run
    // while both of A's external background effects remain blocked.
    await streamA.return?.();
    const streamB = runtime
      .subscribe({ spec: { scope: 'session', sessionId: sessionB } })
      [Symbol.asyncIterator]();
    await next(streamB);
    await runtime.command(start('start-b-ordinary', sessionB, 0, B_ORDINARY));
    await waitForRunCompleted(runtime, sessionB);
    await owner.host.waitForSessionIdle(sessionB);
    expect(await background(runtime, sessionB)).toEqual([]);
    expect(hasRunningKinds(await background(runtime, sessionA), ['service', 'subagent'])).toBe(
      true,
    );

    const bProjection = await projection(runtime, sessionB);
    await expect(
      runtime.command(start('start-b-background', sessionB, bProjection.revision, B_ROOT)),
    ).resolves.toMatchObject({ status: 'applied', sessionId: sessionB });
    await waitForBackground(runtime, sessionB, (executions) =>
      hasRunningKinds(executions, ['service', 'subagent']),
    );

    const runningA = await background(runtime, sessionA);
    const runningB = await background(runtime, sessionB);
    assertDisjointIdentities(runningA, runningB);
    expect(runningA.every((execution) => execution.sessionId === sessionA)).toBe(true);
    expect(runningB.every((execution) => execution.sessionId === sessionB)).toBe(true);

    aShellGate.resolve();
    bShellGate.resolve();
    await waitForBackground(runtime, sessionA, bothKindsCompleted);
    await waitForBackground(runtime, sessionB, bothKindsCompleted);

    // Querying again must project the durable terminal state even
    // though A had no active subscriber when either background execution settled.
    const settledA = await background(runtime, sessionA);
    const settledB = await background(runtime, sessionB);
    assertSettledAndIsolated(settledA, sessionA);
    assertSettledAndIsolated(settledB, sessionB);
    expect(
      await owner.runtime.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: sessionA,
      }),
    ).toMatchObject({ status: 'ok', session: { sessionId: sessionA } });
    await streamB.return?.();
  } finally {
    aShellGate.resolve();
    bShellGate.resolve();
    await runtime.close();
    await owner[Symbol.asyncDispose]();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(resolve(root), { recursive: true, force: true });
  }
}, 30_000);

function backgroundResponse(request: MockChatRequest, prefix: 'a' | 'b', childMarker: string) {
  const toolIds = new Set(
    request.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id),
  );
  if (toolIds.has(`${prefix}-shell`) && toolIds.has(`${prefix}-child`)) {
    return {
      expectedRequest: {
        toolResults: [{ toolCallId: `${prefix}-shell` }, { toolCallId: `${prefix}-child` }],
      },
      message: { content: `${prefix}-background-parent-completed` },
    };
  }
  return {
    toolContinuation: 'required' as const,
    message: {
      tool_calls: [
        {
          id: `${prefix}-shell`,
          name: 'shell_execute',
          args: {
            command: `cat cross-session-${prefix}-service.txt`,
            mode: 'service',
            yield_ms: 0,
          },
        },
        {
          id: `${prefix}-child`,
          name: 'task',
          args: {
            name: `${prefix.toUpperCase()} isolated child`,
            subagent_type: 'review',
            task: `${childMarker}: return the isolated result marker.`,
            background: true,
            result_disposition: 'after_turn',
          },
        },
      ],
    },
  };
}

function shellResult(command: string, stdout: string) {
  return { ok: true as const, command, exitCode: 0, stdout, stderr: '' };
}

function skillOptions(workspace: string) {
  return {
    userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
    userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
    projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
    projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
  };
}

function admission(workspace: string): RuntimeServerAdmissionPort {
  const canonicalPath = realpathSync.native(workspace);
  const project = resolveProjectIdentity(canonicalPath);
  return Object.freeze({
    authorize: async (_request: RuntimeServerAdmissionInput) => ({
      allowed: true as const,
      workspace: canonicalPath,
      projectId: project.projectId,
      workspaceDigest: project.workspaceDigest,
    }),
  });
}

function client(
  owner: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>,
  workspaceAdmission: RuntimeServerAdmissionPort,
  instanceId: string,
) {
  const transport: RuntimeClientTransport = Object.freeze({
    connect: async () => {
      const pair = owner.open({ admission: workspaceAdmission });
      return Object.freeze({
        send: (message: RuntimeProtocolMessage) => pair.client.send(message),
        messages: () => pair.client.messages(),
        close: (reason?: string) => pair.client.close(reason),
      });
    },
  });
  return new RuntimeClient({
    transport,
    clientInfo: { name: 'cross-session-background-test', version: '1', instanceId },
  });
}

async function createSession(runtime: RuntimeClient, sessionId: string) {
  await runtime.command({
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId: `create-${sessionId}`,
    type: 'create_session',
    workspace: '/untrusted-wire-workspace',
    bootstrapSessionId: sessionId,
  });
}

function start(commandId: string, sessionId: string, expectedRevision: number, input: string) {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId,
    type: 'start_turn' as const,
    sessionId,
    expectedRevision,
    input,
  };
}

async function next(iterator: AsyncIterator<RuntimeAccessNotification>) {
  const item = await Promise.race([
    iterator.next(),
    Bun.sleep(5_000).then(() => {
      throw new Error('Timed out waiting for Runtime notification.');
    }),
  ]);
  if (item.done) throw new Error('Runtime subscription closed unexpectedly.');
  return item.value;
}

async function waitForRunCompleted(
  runtime: RuntimeClient,
  sessionId: string,
  excludedRunId?: string,
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const session = await projection(runtime, sessionId);
    if (session.currentRun?.status === 'completed' && session.currentRun.runId !== excludedRunId)
      return;
    if (
      session.currentRun?.status === 'failed' ||
      session.currentRun?.status === 'recovery_required'
    ) {
      throw new Error(`Session ${sessionId} failed: ${JSON.stringify(session.currentRun)}`);
    }
    await Bun.sleep(10);
  }
  throw new Error(`Session ${sessionId} did not reach a terminal Run.`);
}

async function projection(runtime: RuntimeClient, sessionId: string) {
  const result = await runtime.query({
    schema: RUNTIME_QUERY_SCHEMA_,
    type: 'get_session_projection',
    sessionId,
  });
  if (result.status !== 'ok' || !result.session) throw new Error('Session projection unavailable.');
  return result.session;
}

async function background(runtime: RuntimeClient, sessionId: string) {
  const result = await runtime.query({
    schema: RUNTIME_QUERY_SCHEMA_,
    type: 'list_background_executions',
    sessionId,
  });
  if (result.status !== 'ok' || !result.backgroundSnapshot) {
    throw new Error(`Background snapshot unavailable for ${sessionId}.`);
  }
  return result.backgroundSnapshot.executions;
}

async function waitForBackground(
  runtime: RuntimeClient,
  sessionId: string,
  predicate: (executions: readonly RuntimeBackgroundExecutionProjection[]) => boolean,
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const executions = await background(runtime, sessionId);
      if (predicate(executions)) return;
    } catch {
      // The execution context may still be composing immediately after start_turn.
    }
    await Bun.sleep(10);
  }
  throw new Error(`Background executions did not settle for ${sessionId}.`);
}

function hasRunningKinds(
  executions: readonly RuntimeBackgroundExecutionProjection[],
  kinds: readonly RuntimeBackgroundExecutionProjection['kind'][],
) {
  return kinds.every((kind) =>
    executions.some((execution) => execution.kind === kind && execution.status === 'running'),
  );
}

function bothKindsCompleted(executions: readonly RuntimeBackgroundExecutionProjection[]) {
  return (['service', 'subagent'] as const).every((kind) =>
    executions.some((execution) => execution.kind === kind && execution.status === 'completed'),
  );
}

function assertDisjointIdentities(
  left: readonly RuntimeBackgroundExecutionProjection[],
  right: readonly RuntimeBackgroundExecutionProjection[],
) {
  const leftIds = new Set(left.map((execution) => execution.executionId));
  expect(right.every((execution) => !leftIds.has(execution.executionId))).toBe(true);
}

function assertSettledAndIsolated(
  executions: readonly RuntimeBackgroundExecutionProjection[],
  sessionId: string,
) {
  expect(bothKindsCompleted(executions)).toBe(true);
  expect(executions.every((execution) => execution.sessionId === sessionId)).toBe(true);
  expect(executions.every((execution) => execution.cleanupConfirmed)).toBe(true);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
