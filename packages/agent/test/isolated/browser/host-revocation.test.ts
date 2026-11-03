import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { type AgentRuntime, createRuntime } from '../../../src';
import {
  hostRevocationAuthorization,
  interruptsBrowserContinuation,
} from '../../../src/execution/host-control';
import type { ActionDefinition, Extension, Json } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import {
  createBrowserController,
  createBrowserExtension,
  createBrowserHumanCoordinator,
  createBrowserHumanRequest,
  type NativeBrowserTransport,
} from '../../../src/tools/browser';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function until(read: () => boolean | Promise<boolean>) {
  const end = Date.now() + 4000;
  while (!(await read())) {
    if (Date.now() > end) throw Error('host_revocation_fixture_timeout');
    await Bun.sleep(5);
  }
}

async function fixture(waiting: 'approval' | 'question' | 'async', copied = false) {
  const root = mkdtempSync(join(tmpdir(), 'kite-host-revocation-'));
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  let complete!: (value: { confirmed: boolean }) => void;
  const completion = new Promise<{ confirmed: boolean }>((resolve) => {
    complete = resolve;
  });

  let closes = 0,
    handoffs = 0,
    resumes = 0;
  const transport: NativeBrowserTransport = {
    ready: Promise.resolve(),
    completion,
    async request() {
      return { success: true, data: {} };
    },
    async capture() {
      return {
        frame: { mimeType: 'image/jpeg', data: 'small', width: 800, height: 600 },
        annotations: [],
      };
    },
    async close() {
      closes++;
      complete({ confirmed: true });
      return { confirmed: true };
    },
    async dispose() {},
    async handoff() {
      handoffs++;
    },
    async resume() {
      resumes++;
    },
  };
  const controller = createBrowserController({
    createTransport: () => transport,
    captureIntervalMs: 60000,
  });
  let runtime!: AgentRuntime;
  const human =
    waiting === 'async'
      ? createBrowserHumanCoordinator({ controller, runtime: () => runtime })
      : undefined;
  const original = createBrowserExtension({
    controller,
    human,
    requestHuman: createBrowserHumanRequest({ controller, runtime: () => runtime }),
  });
  const extension: Extension = copied
    ? { ...original, actions: original.actions!.map((action) => ({ ...action })) }
    : original;
  let turns = 0;
  const model: ModelAdapter = {
    async *stream(request, streaming) {
      turns++;
      if (turns === 1) {
        yield* createFixedModel([
          [
            {
              type: 'tool_call',
              id: 'open',
              name: 'browser_open',
              arguments: JSON.stringify({ key: 'original', url: 'https://example.test/' }),
            },
            { ...finish, reason: 'tool_calls' },
          ],
        ]).stream(request, streaming);
      } else if (turns === 2) {
        await until(() => controller.view('session')?.state === 'agent');
        const view = controller.view('session')!;
        yield* createFixedModel([
          [
            {
              type: 'tool_call',
              id: 'wait',
              name: waiting === 'approval' ? 'browser_snapshot' : 'browser_request_human',
              arguments: JSON.stringify({
                key: 'wait',
                browser_id: view.browserId,
                generation: view.generation,
                ...(waiting === 'approval' ? {} : { reason: 'Please check the form.' }),
              }),
            },
            { ...finish, reason: 'tool_calls' },
          ],
        ]).stream(request, streaming);
      } else {
        if (waiting === 'async' && !streaming.signal.aborted)
          await new Promise<void>((resolve) =>
            streaming.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        streaming.signal.throwIfAborted();
        yield finish;
      }
    },
  };
  const authorizationCalls: string[] = [];
  runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [extension],
    permissions: {
      async authorize(request) {
        authorizationCalls.push(request.definitionId);
        if (
          request.definitionId.startsWith('builtin.browser/') ||
          (waiting === 'approval' && request.definitionId === 'browser.snapshot')
        )
          return {
            allowed: false,
            revision: 'fixture-needs-human',
            approval: { request: { reason: 'auto_check_unavailable' } },
          };
        return { allowed: true, revision: 'fixture' };
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'workspace',
    name: 'fixture',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    sessionId: 'session',
    workspaceId: 'workspace',
    subjectId: 'owner',
    commandId: 'create',
    title: 'fixture',
  });
  await runtime.submitCommand({
    expectedStoreId: storeId,
    sessionId: 'session',
    subjectId: 'owner',
    commandId: 'work',
    request: { kind: 'run.start', content: 'Use the browser' },
  });
  if (waiting === 'async')
    await until(async () => {
      const rows = await store.listExtensionRecords({
        extensionId: 'builtin.browser',
        sessionId: 'session',
        contentType: 'application/vnd.kite.browser-human-request+json',
      });
      return (
        turns >= 3 && rows.some((row) => (row.value as { state?: string }).state === 'pending')
      );
    });
  else
    await until(async () =>
      (
        await runtime.listInteractions({
          expectedStoreId: storeId,
          sessionId: 'session',
          state: 'pending',
        })
      ).interactions.some((row) => row.kind === waiting),
    );
  const invoke = async (actionId: string, input?: Json, commandId = actionId) => {
    const view = controller.view('session')!;
    return runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'session',
      subjectId: 'owner',
      commandId,
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.browser',
        actionId,
        definitionVersion: '1',
        input: input ?? { browserId: view.browserId, generation: view.generation },
      },
    });
  };
  const close = async () => {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return {
    store,
    storeId,
    runtime,
    controller,
    original,
    authorizationCalls,
    invoke,
    close,
    get closes() {
      return closes;
    },
    get handoffs() {
      return handoffs;
    },
    get resumes() {
      return resumes;
    },
  };
}

test('only frozen registered builtin objects qualify, and a stop input cannot change to continue', () => {
  const controller = {} as Parameters<typeof createBrowserExtension>[0]['controller'];
  const extension = createBrowserExtension({ controller });
  const handoff = extension.actions!.find((action) => action.id === 'browser.handoff')!;
  expect(Object.isFrozen(handoff)).toBe(true);
  expect(hostRevocationAuthorization(handoff, {})).toMatchObject({ allowed: true });
  expect(hostRevocationAuthorization({ ...handoff }, {})).toBeUndefined();
  expect(hostRevocationAuthorization(Object.freeze({ ...handoff }), {})).toBeUndefined();
  const page = { browserId: 'original', generation: 'current' };
  const continuation = { actionId: 'browser.resume', input: page };
  expect(interruptsBrowserContinuation(handoff, page, continuation)).toBe(true);
  expect(interruptsBrowserContinuation({ ...handoff }, page, continuation)).toBe(false);
  expect(interruptsBrowserContinuation(handoff, { ...page, generation: 'old' }, continuation)).toBe(
    false,
  );
  expect(interruptsBrowserContinuation(handoff, { ...page, extra: true }, continuation)).toBe(
    false,
  );
  expect(
    interruptsBrowserContinuation(handoff, page, { ...continuation, actionId: 'unrelated' }),
  ).toBe(false);
  const fake = Object.freeze({
    ...handoff,
    id: 'browser.close',
    runControl: true,
  }) as ActionDefinition;
  expect(hostRevocationAuthorization(fake, {})).toBeUndefined();
  const human = createBrowserHumanCoordinator({ controller, runtime: () => ({}) as AgentRuntime });
  const response = createBrowserExtension({ controller, human }).actions!.find(
    (action) => action.id === 'browser.respond_human',
  )!;
  const input = { choice: 'stop', nested: { value: 1 } };
  expect(hostRevocationAuthorization(response, input)).toMatchObject({ allowed: true });
  expect(Object.isFrozen(input)).toBe(true);
  expect(Object.isFrozen(input.nested)).toBe(true);
  expect(() => {
    input.choice = 'continue';
  }).toThrow();
  expect(hostRevocationAuthorization(response, { choice: 'continue' })).toBeUndefined();
  expect(
    hostRevocationAuthorization(
      extension.actions!.find((action) => action.id === 'browser.resume')!,
      {},
    ),
  ).toBeUndefined();
});

for (const action of ['browser.handoff', 'browser.close'])
  test(`${action} dispatches through its original durable Action while an ordinary approval waits`, async () => {
    const f = await fixture('approval');
    try {
      const view = f.controller.view('session')!;
      const input = { browserId: view.browserId, generation: view.generation };
      await f.invoke(action, input);
      await until(() => (action === 'browser.handoff' ? f.handoffs === 1 : f.closes === 1));
      const command = await f.runtime.waitForCommand(action, { timeoutMs: 4000 });
      const execution = (await f.store.listExecutions('session')).find(
        (row) => row.originCommandId === command.id,
      )!;
      expect(execution.status).toBe('succeeded');
      expect(execution.definitionId).toBe(`builtin.browser/${action}`);
      expect(f.authorizationCalls).not.toContain(`builtin.browser/${action}`);
      await f.invoke(action, input);
      expect(action === 'browser.handoff' ? f.handoffs : f.closes).toBe(1);
      expect(
        (
          await f.runtime.listInteractions({ expectedStoreId: f.storeId, sessionId: 'session' })
        ).interactions.filter((row) => row.definitionId === `builtin.browser/${action}`),
      ).toHaveLength(0);
      if (action === 'browser.handoff') {
        expect(f.controller.view('session')?.state).toBe('human');
        expect(
          (await f.store.listExecutions('session')).find(
            (row) => row.definitionId === 'browser.session',
          )?.status,
        ).toBe('running');
        expect(f.closes).toBe(0);
        await f.invoke('browser.resume');
        await until(async () =>
          (
            await f.runtime.listInteractions({
              expectedStoreId: f.storeId,
              sessionId: 'session',
              state: 'pending',
            })
          ).interactions.some((row) => row.definitionId === 'builtin.browser/browser.resume'),
        );
        expect(f.resumes).toBe(0);
      }
    } finally {
      await f.close();
    }
  });

test('close during the original human Question cancels its waiting Tool without creating another approval', async () => {
  const f = await fixture('question');
  try {
    await f.invoke('browser.close');
    await until(() => f.closes === 1);
    await until(async () =>
      (await f.store.listExecutions('session')).some(
        (row) =>
          row.definitionId === 'browser.request_human' &&
          row.cancelRequestedAt !== null &&
          ['failed', 'cancelled', 'outcome_unknown'].includes(row.status),
      ),
    );
    expect(f.authorizationCalls).not.toContain('builtin.browser/browser.close');
    expect(
      (
        await f.runtime.listInteractions({
          expectedStoreId: f.storeId,
          sessionId: 'session',
          state: 'pending',
        })
      ).interactions,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a same-name spread of the builtin Action still requires ordinary approval', async () => {
  const f = await fixture('approval', true);
  try {
    await f.invoke('browser.close');
    await until(async () =>
      (
        await f.runtime.listInteractions({
          expectedStoreId: f.storeId,
          sessionId: 'session',
          state: 'pending',
        })
      ).interactions.some((row) => row.definitionId === 'builtin.browser/browser.close'),
    );
    expect(f.closes).toBe(0);
    expect(f.authorizationCalls).toContain('builtin.browser/browser.close');
  } finally {
    await f.close();
  }
});

test('host permission cannot make a stale browser generation control the current page', async () => {
  const f = await fixture('approval');
  try {
    await f.invoke('browser.close', { browserId: 'original', generation: 'foreign' });
    const command = await f.runtime.waitForCommand('browser.close', { timeoutMs: 4000 });
    const execution = (await f.store.listExecutions('session')).find(
      (row) => row.originCommandId === command.id,
    )!;
    expect(execution.status).toBe('failed');
    expect(execution.result).toMatchObject({ content: 'browser_stale_or_foreign_target' });
    expect(f.closes).toBe(0);
    expect(f.controller.view('session')?.state).toBe('agent');
  } finally {
    await f.close();
  }
});

for (const choice of ['stop', 'continue'])
  test(`respond_human ${choice} ${choice === 'stop' ? 'revokes directly' : 'keeps ordinary approval'}`, async () => {
    const f = await fixture('async');
    try {
      const view = f.controller.view('session')!;
      const row = (
        await f.store.listExtensionRecords({
          extensionId: 'builtin.browser',
          sessionId: 'session',
          contentType: 'application/vnd.kite.browser-human-request+json',
        })
      )[0]!;
      const value = row.value as { requestId: string };
      await f.invoke('browser.respond_human', {
        browserId: view.browserId,
        generation: view.generation,
        requestId: value.requestId,
        expectedRevision: row.revision,
        choice,
      });
      if (choice === 'stop') {
        await until(() => f.closes === 1);
        await until(async () =>
          (await f.store.listExecutions('session')).some(
            (row) =>
              row.definitionId === 'browser.human_wait' &&
              ['succeeded', 'cancelled'].includes(row.status),
          ),
        );
        expect(f.authorizationCalls).not.toContain('builtin.browser/browser.respond_human');
      } else {
        await until(async () =>
          (
            await f.runtime.listInteractions({
              expectedStoreId: f.storeId,
              sessionId: 'session',
              state: 'pending',
            })
          ).interactions.some(
            (row) => row.definitionId === 'builtin.browser/browser.respond_human',
          ),
        );
        expect(f.resumes).toBe(0);
        expect(f.closes).toBe(0);
      }
    } finally {
      await f.close();
    }
  });

for (const [waiting, stop] of [
  ['approval', 'close'],
  ['async', 'close'],
  ['async', 'human-stop'],
] as const)
  test(`${stop} cancels an earlier ${waiting === 'async' ? 'human continue' : 'resume'} approval before draining the control queue`, async () => {
    const f = await fixture(waiting);
    try {
      if (waiting === 'approval') {
        await f.invoke('browser.handoff');
        await until(() => f.controller.view('session')?.state === 'human');
      }
      const view = f.controller.view('session')!;
      let input: Json = { browserId: view.browserId, generation: view.generation };
      const action = waiting === 'async' ? 'browser.respond_human' : 'browser.resume';
      if (waiting === 'async') {
        const row = (
          await f.store.listExtensionRecords({
            extensionId: 'builtin.browser',
            sessionId: 'session',
            contentType: 'application/vnd.kite.browser-human-request+json',
          })
        )[0]!;
        input = {
          ...(input as object),
          requestId: (row.value as { requestId: string }).requestId,
          expectedRevision: row.revision,
          choice: 'continue',
        } as Json;
      }
      await f.invoke(action, input, 'waiting-continue');
      await until(async () =>
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.storeId,
            sessionId: 'session',
            state: 'pending',
          })
        ).interactions.some((row) => row.definitionId === `builtin.browser/${action}`),
      );
      const approval = (
        await f.runtime.listInteractions({
          expectedStoreId: f.storeId,
          sessionId: 'session',
          state: 'pending',
        })
      ).interactions.find((row) => row.definitionId === `builtin.browser/${action}`)!;
      if (stop === 'human-stop')
        await f.invoke(
          'browser.respond_human',
          { ...(input as object), choice: 'stop' } as Json,
          'stop-response',
        );
      else await f.invoke('browser.close');
      await until(() => f.closes === 1);
      await f.runtime.waitForCommand('waiting-continue', { timeoutMs: 4000 });
      expect(
        (await f.store.listExecutions('session')).find(
          (row) => row.originCommandId === 'waiting-continue',
        ),
      ).toMatchObject({
        status: 'cancelled',
        authorization: { dispatched: false },
      });
      expect(f.resumes).toBe(0);
      await until(() => f.controller.view('session')?.state === 'closed');
      await f.runtime
        .answerInteraction({
          expectedStoreId: f.storeId,
          subjectId: 'owner',
          commandId: 'late-allow',
          presentationSessionId: 'session',
          interactionId: approval.id,
          expectedRevision: approval.revision,
          answer: { kind: 'approval', decision: 'approve' },
        })
        .catch(() => {});
      expect(f.resumes).toBe(0);
      expect(f.controller.view('session')?.state).toBe('closed');
    } finally {
      await f.close();
    }
  });

test('trusted Run presentation hides selected internal tools without changing nested execution or later legacy surfaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-run-hidden-tools-'));
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  const surfaces: string[][] = [];
  let leaves = 0;
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'entry',
        version: '1',
        description: 'One entry',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          const ref = await context.operations.ensure({
            key: 'nested',
            request: { kind: 'tool', definitionId: 'leaf', definitionVersion: '1', input: {} },
          });
          const result = await context.operations.wait(ref);
          return {
            outcome: result.status === 'succeeded' ? 'succeeded' : 'failed',
            content: 'nested done',
          };
        },
      },
      {
        id: 'leaf',
        version: '1',
        description: 'Internal operation',
        inputSchema: { type: 'object' },
        async execute() {
          leaves++;
          return { outcome: 'succeeded', content: 'leaf done' };
        },
      },
    ],
  };
  const model: ModelAdapter = {
    async *stream(request, options) {
      surfaces.push(request.tools.map((tool) => tool.id));
      yield* createFixedModel([
        request.messages.some((message) => message.role === 'tool')
          ? [{ type: 'text_delta', text: 'done' }, finish]
          : [
              { type: 'tool_call', id: 'entry-call', name: 'entry', arguments: '{}' },
              { ...finish, reason: 'tool_calls' },
            ],
      ]).stream(request, options);
    },
  };
  const runtime = createRuntime({
    store,
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    async resolveRunConfiguration({ command }) {
      return {
        model,
        modelId: 'fixed',
        toolIds: ['entry', 'leaf'],
        ...(command.sessionId === 'hidden' ? { modelHiddenToolIds: ['leaf'] } : {}),
        readStepCapabilities: async () => ({ toolIds: ['entry', 'leaf'], snapshot: null }),
        snapshot: { hidden: command.sessionId === 'hidden' },
      };
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      name: 'fixture',
      rootUri: pathToFileURL(root).href,
    });
    for (const sessionId of ['hidden', 'legacy']) {
      await runtime.createSession({
        expectedStoreId: storeId,
        sessionId,
        workspaceId: 'workspace',
        subjectId: 'owner',
        commandId: `create-${sessionId}`,
        title: sessionId,
      });
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId,
        subjectId: 'owner',
        commandId: `work-${sessionId}`,
        request: { kind: 'run.start', content: 'Do the work' },
      });
      await runtime.waitForCommand(`work-${sessionId}`, { timeoutMs: 4000 });
      const rows = await store.listExecutions(sessionId);
      expect(rows.find((row) => row.definitionId === 'entry')?.status).toBe('succeeded');
      expect(rows.find((row) => row.definitionId === 'leaf')?.status).toBe('succeeded');
      expect(rows.find((row) => row.definitionId === 'leaf')?.parentExecutionId).toBe(
        rows.find((row) => row.definitionId === 'entry')?.id,
      );
    }
    expect(surfaces.slice(0, 2)).toEqual([['entry'], ['entry']]);
    expect(surfaces.slice(2)).toEqual([
      ['entry', 'leaf'],
      ['entry', 'leaf'],
    ]);
    expect(leaves).toBe(2);
    expect(extension.tools?.[1]?.model).toBeUndefined();
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
