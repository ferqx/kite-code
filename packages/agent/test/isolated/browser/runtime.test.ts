import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type FixedModel, type ModelEvent, type ModelRequest } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { type AgentRuntime, createRuntime } from '../../../src';
import type { Json } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import {
  browserPageReference,
  createBrowserController,
  createBrowserExtension,
  createBrowserHumanRequest,
  type NativeBrowserTransport,
} from '../../../src/tools/browser';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const until = async (check: () => boolean | Promise<boolean>) => {
  const limit = Date.now() + 4000;
  while (!(await check())) {
    if (Date.now() > limit) throw Error('browser_fixture_timeout');
    await sleepTimer(5);
  }
};
test('public browser references flow through real receipts; stale elements and foreign scope never reach native input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-browser-public-refs-'));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  let ended!: (value: { confirmed: boolean }) => void;
  const completion = new Promise<{ confirmed: boolean }>((resolve) => {
    ended = resolve;
  });
  const inputs: Json[] = [];
  const controller = createBrowserController({
    captureIntervalMs: 60000,
    createTransport: () => ({
      ready: Promise.resolve(),
      completion,
      async request(command) {
        inputs.push(command);
        return { success: true, data: {} };
      },
      async capture() {
        return {
          frame: { mimeType: 'image/jpeg', data: 'small', width: 800, height: 600 },
          annotations: [
            {
              ref: '@e1',
              number: 1,
              role: 'button',
              name: 'Once',
              box: { x: 1, y: 1, width: 20, height: 20 },
            },
          ],
        };
      },
      async close() {
        ended({ confirmed: true });
        return { confirmed: true };
      },
      async dispose() {},
    }),
  });
  let step = 0,
    page = '',
    element = '';
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    extensions: [createBrowserExtension({ controller })],
    permissions: { authorize: async () => ({ allowed: true, revision: 'actual' }) },
    model: {
      async *stream(request) {
        const last = request.messages.filter((message) => message.role === 'tool').at(-1);
        let presented:
          | {
              details?: { page_ref: string; element_refs: { element_ref: string }[] };
              page_ref: string;
              element_refs: { element_ref: string }[];
            }
          | undefined;
        try {
          presented = last ? JSON.parse(last.content) : undefined;
        } catch {
          presented = undefined;
        }
        const receipt = (await store.listExecutions('s'))
          .filter((row) => row.kind === 'tool')
          .at(-1)?.result;
        const body = receipt as { outcome: string; details: unknown } | undefined;
        const details = (presented?.details ?? presented)!;
        let name = '',
          input: Json = {};
        switch (step++) {
          case 0:
            expect(
              JSON.stringify(request.tools.find((tool) => tool.id === 'browser_open')!.inputSchema),
            ).not.toContain('"key"');
            name = 'browser_open';
            input = { url: 'https://example.test/' };
            break;
          case 1:
            page = details.page_ref;
            expect(typeof page).toBe('string');
            name = 'browser_snapshot';
            input = { page_ref: page };
            break;
          case 2:
            page = details.page_ref;
            element = details.element_refs[0]!.element_ref;
            name = 'browser_click';
            input = { element_ref: element };
            break;
          case 3:
            expect(body?.outcome).toBe('succeeded');
            name = 'browser_click';
            input = { element_ref: element };
            break;
          case 4:
            expect(body?.outcome).toBe('failed');
            expect(
              inputs.filter((value) => (value as Record<string, Json>).action === 'click'),
            ).toHaveLength(1);
            name = 'browser_snapshot';
            input = {
              page_ref: browserPageReference(
                { storeId, sessionId: 'foreign', runId: 'foreign' },
                controller.view('s')!,
              ),
            };
            break;
          case 5:
            expect(body).toMatchObject({ outcome: 'failed', details: { adapterAttempted: false } });
            name = 'browser_snapshot';
            input = { page_ref: page };
            break;
          case 6:
            expect(body?.outcome).toBe('succeeded');
            name = 'browser_fill';
            input = { element_ref: details.element_refs[0]!.element_ref, value: 'exact' };
            break;
          case 7:
            expect(body?.outcome).toBe('succeeded');
            name = 'browser_close';
            input = { page_ref: page };
            break;
          default:
            expect(body?.outcome).toBe('succeeded');
        }
        if (name) {
          yield { type: 'tool_call', id: `public-${step}`, name, arguments: JSON.stringify(input) };
          yield { ...finish, reason: 'tool_calls' };
        } else yield finish;
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'test',
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'refs',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Use exact public browser references' },
    });
    const command = await runtime.waitForCommand('work', { timeoutMs: 10000 });
    expect(
      (await store.listExecutions('s'))
        .filter((row) => row.kind === 'model' && row.status !== 'succeeded')
        .map((row) => row.result),
    ).toEqual([]);
    expect(await store.getRun((command.receipt as { runId: string }).runId)).toMatchObject({
      status: 'completed',
    });
    expect(step).toBe(9);
    expect(
      inputs.filter((value) => (value as Record<string, Json>).action === 'click'),
    ).toHaveLength(1);
    expect(
      inputs.filter((value) => (value as Record<string, Json>).action === 'fill'),
    ).toHaveLength(1);
    expect(controller.view('s')?.state).toBe('closed');
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
async function fixture(
  confirmed: boolean,
  options: { human?: boolean; denyHuman?: boolean; denyResume?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-browser-runtime-'));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'browser' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  let finishOwner!: (proof: { confirmed: boolean }) => void;
  const completion = new Promise<{ confirmed: boolean }>((resolve) => {
    finishOwner = resolve;
  });
  let starts = 0,
    closes = 0,
    disposals = 0,
    bindings = 0;
  const requests: Json[] = [];
  const timeline: string[] = [];
  let handoffs = 0,
    resumes = 0;
  const authorizations: { kind: string; definitionId: string }[] = [];
  const transport: NativeBrowserTransport = {
    ready: Promise.resolve(),
    completion,
    async request(command) {
      requests.push(command);
      return { success: true, data: {} };
    },
    async capture() {
      return {
        frame: { mimeType: 'image/jpeg', data: 'small', width: 960, height: 540 },
        annotations: [],
      };
    },
    async close() {
      closes++;
      finishOwner({ confirmed });
      return { confirmed };
    },
    async dispose() {
      disposals++;
    },
    async handoff() {
      handoffs++;
      timeline.push('handoff-confirmed');
    },
    async resume() {
      resumes++;
      timeline.push('human-resume-confirmed');
    },
  };
  const controller = createBrowserController({
    createTransport() {
      starts++;
      return transport;
    },
    captureIntervalMs: 60000,
  });
  let runtime!: AgentRuntime;
  const extension = createBrowserExtension({
    controller,
    requestHuman: createBrowserHumanRequest({ controller, runtime: () => runtime }),
  });
  const originalModel = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'open',
        name: 'browser_open',
        arguments: JSON.stringify({ url: 'https://example.test/' }),
      },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const modelRequests: ModelRequest[] = [];
  const model: FixedModel = options.human
    ? {
        get requests() {
          return modelRequests.map((value) => structuredClone(value));
        },
        async *stream(request, streaming) {
          modelRequests.push(structuredClone(request));
          const turn = modelRequests.length;
          timeline.push(`model-${turn}`);
          if (turn === 1) {
            yield* originalModel.stream(request, streaming);
            return;
          }
          if (turn === 2) {
            await until(() => {
              streaming.signal.throwIfAborted();
              return controller.view('session')?.state === 'agent';
            });
            const view = controller.view('session')!;
            yield* createFixedModel([
              [
                {
                  type: 'tool_call',
                  id: 'human',
                  name: 'browser_request_human',
                  arguments: JSON.stringify({
                    page_ref: browserPageReference(
                      {
                        storeId: expectedStoreId,
                        sessionId: 'session',
                        runId: (await store.getExecution(request.requestId))!.runId!,
                      },
                      view,
                    ),
                    reason: 'Check the local form, then continue.',
                  }),
                },
                { ...finish, reason: 'tool_calls' },
              ],
            ]).stream(request, streaming);
            return;
          }
          if (turn === 3 && !options.denyHuman && controller.view('session')?.state === 'agent') {
            const view = controller.view('session')!;
            yield* createFixedModel([
              [
                {
                  type: 'tool_call',
                  id: 'after-human',
                  name: 'browser_snapshot',
                  arguments: JSON.stringify({
                    page_ref: browserPageReference(
                      {
                        storeId: expectedStoreId,
                        sessionId: 'session',
                        runId: (await store.getExecution(request.requestId))!.runId!,
                      },
                      view,
                    ),
                  }),
                },
                { ...finish, reason: 'tool_calls' },
              ],
            ]).stream(request, streaming);
            return;
          }
          yield* createFixedModel([
            [{ type: 'text_delta', text: 'MOCK_HUMAN_CONTINUED' }, finish],
          ]).stream(request, streaming);
        },
      }
    : originalModel;
  runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [extension],
    permissions: {
      async authorize(request) {
        authorizations.push({ kind: request.kind, definitionId: request.definitionId });
        if (options.denyHuman && request.definitionId === 'browser.request_human')
          return { allowed: false, revision: 'deny-human-fixture', reason: 'fixture-denied' };
        if (options.denyResume && request.definitionId === 'builtin.browser/browser.resume')
          return { allowed: false, revision: 'deny-resume-fixture', reason: 'fixture-denied' };
        return { allowed: true, revision: 'trusted-browser-fixture' };
      },
    },
    async resolveRunConfiguration() {
      return {
        model,
        modelId: 'fixed',
        snapshot: {},
        async dispose() {
          bindings++;
        },
      };
    },
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    rootUri: pathToFileURL(root).href,
    name: 'browser',
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 'session',
    workspaceId: 'workspace',
    commandId: 'create',
    subjectId: 'owner',
    title: 'browser',
  });
  await runtime.submitCommand({
    expectedStoreId,
    sessionId: 'session',
    commandId: 'root-work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'Open managed browser' },
  });
  return {
    root,
    store,
    runtime,
    controller,
    expectedStoreId,
    model,
    requests,
    timeline,
    authorizations,
    endOwner: () => finishOwner({ confirmed: true }),
    get handoffs() {
      return handoffs;
    },
    get resumes() {
      return resumes;
    },
    get starts() {
      return starts;
    },
    get closes() {
      return closes;
    },
    get disposals() {
      return disposals;
    },
    get bindings() {
      return bindings;
    },
  };
}

test('real Runtime keeps the browser Job and Run binding after model completion, then root cancellation stops original owner', async () => {
  const f = await fixture(true);
  try {
    await until(async () => {
      const execution = (await f.store.listExecutions('session')).find(
        (entry) => entry.kind === 'tool' && entry.status === 'failed',
      );
      if (execution) throw Error(JSON.stringify(execution.result));
      return f.controller.view('session')?.state === 'agent';
    });
    await f.runtime.waitForCommand('root-work', { timeoutMs: 4000 });
    expect(f.starts).toBe(1);
    expect(f.bindings).toBe(0);
    expect(f.runtime.tryBeginShutdown('if_idle').accepted).toBe(false);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const views = await f.runtime.queryExtension({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 'session',
      extensionId: 'builtin.browser',
      queryId: 'browser.view',
      input: {},
    });
    expect(views[0]?.payload).toMatchObject({
      state: 'agent',
      browserId: f.controller.view('session')!.browserId,
    });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(f.closes).toBe(0);
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 'session',
      commandId: 'stop-original',
      targetCommandId: 'root-work',
    });
    await until(() => f.disposals === 1 && f.bindings === 1);
    expect(f.closes).toBe(1);
    expect(f.bindings).toBe(1);
    const jobs = (await f.store.listExecutions('session')).filter(
      (execution) => execution.kind === 'job',
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.definitionId).toBe('browser.session');
    expect(jobs[0]?.status).toBe('cancelled');
    await f.runtime.close();
    expect(f.runtime.getLifecycleState().state).toBe('closed');
  } finally {
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

test('real Runtime refuses shutdown and retains original browser binding when owned stop is unconfirmed', async () => {
  const f = await fixture(false);
  try {
    await until(async () => {
      const execution = (await f.store.listExecutions('session')).find(
        (entry) => entry.kind === 'tool' && entry.status === 'failed',
      );
      if (execution) throw Error(JSON.stringify(execution.result));
      return f.controller.view('session')?.state === 'agent';
    });
    await f.runtime.waitForCommand('root-work', { timeoutMs: 4000 });
    const view = f.controller.view('session')!;
    await f.controller.close('session', { browserId: view.browserId, generation: view.generation });
    await until(async () =>
      (await f.store.listExecutions('session')).some(
        (entry) => entry.kind === 'job' && entry.status === 'outcome_unknown',
      ),
    );
    // Await directly: Bun's async rejection matcher can stall this SQLite Worker turn.
    const closeError = await f.runtime.close().then(
      () => null,
      (error: unknown) => error,
    );
    expect(closeError).toMatchObject({ code: 'shutdown_cleanup_unconfirmed' });
    expect(f.runtime.getLifecycleState().state).toBe('drain_failed');
    expect(f.disposals).toBe(0);
    expect(f.bindings).toBe(0);
    expect(f.starts).toBe(1);
    expect((await f.runtime.getMetadata()).storeId).toBe(f.expectedStoreId);
  } finally {
    // Fixture has no external process; this is test cleanup, never production stop evidence.
    await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);
test('same Runtime model task waits for human Action, then the original Tool and model continue without a new Run', async () => {
  const f = await fixture(true, { human: true });
  try {
    await until(
      async () =>
        f.controller.view('session')?.state === 'human' &&
        (await f.store.listExecutions('session')).some(
          (row) =>
            row.definitionId === 'browser.request_human' &&
            ['dispatching', 'running'].includes(row.status),
        ),
    ).catch(async (error) => {
      throw new Error(
        JSON.stringify({
          error: String(error),
          view: f.controller.view('session'),
          timeline: f.timeline,
          authorizations: f.authorizations,
          executions: (await f.store.listExecutions('session')).map((row) => ({
            id: row.id,
            definitionId: row.definitionId,
            kind: row.kind,
            status: row.status,
            result: row.result,
          })),
        }),
      );
    });
    const waiting = (await f.store.listExecutions('session')).find(
      (row) => row.definitionId === 'browser.request_human',
    )!;
    expect(waiting.runId).not.toBeNull();
    expect(f.model.requests).toHaveLength(2);
    expect(f.handoffs).toBe(1);
    expect(f.resumes).toBe(0);
    expect(f.controller.view('session')?.humanRequest).toBe('Check the local form, then continue.');
    expect(
      f.requests.filter((value) => (value as { action?: string }).action === 'snapshot'),
    ).toHaveLength(0);
    expect(
      f.authorizations.some(
        (row) => row.kind === 'tool' && row.definitionId === 'browser.request_human',
      ),
    ).toBe(true);
    let question:
      | Awaited<ReturnType<typeof f.runtime.listInteractions>>['interactions'][number]
      | undefined;
    await until(async () => {
      question = (
        await f.runtime.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 'session',
          state: 'pending',
        })
      ).interactions.find((row) => row.definitionId === 'browser.request_human');
      return !!question;
    }).catch(async (error) => {
      throw Error(
        JSON.stringify({
          error: String(error),
          interactions: await f.runtime.listInteractions({
            expectedStoreId: f.expectedStoreId,
            sessionId: 'session',
          }),
          executions: (await f.store.listExecutions('session')).map((row) => ({
            definitionId: row.definitionId,
            status: row.status,
            result: row.result,
          })),
        }),
      );
    });
    expect(question!.executionId).toBe(waiting.id);
    expect(question!.runId).toBe(waiting.runId);
    expect(question!.kind).toBe('question');
    const humanFrame = f.controller.view('session')!;
    // An unrelated ordinary Action stays queued; resolving information does not
    // grant general concurrent Action dispatch or relax the Session pump.
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 'session',
      commandId: 'ordinary-select',
      request: {
        kind: 'extension.invoke',
        extensionId: 'builtin.browser',
        actionId: 'browser.select',
        definitionVersion: '1',
        input: {
          browserId: humanFrame.browserId,
          generation: humanFrame.generation,
          seq: humanFrame.seq,
          ref: null,
        },
      },
    });
    await sleepTimer(70);
    expect((await f.runtime.getCommand('ordinary-select'))?.status).toBe('accepted');
    expect(
      f.authorizations.some((row) => row.definitionId === 'builtin.browser/browser.select'),
    ).toBe(false);
    const answer = {
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'human-continue',
      presentationSessionId: 'session',
      interactionId: question!.id,
      expectedRevision: question!.revision,
      answer: { kind: 'question' as const, answers: { control: 'continue' } },
    };
    await f.runtime.answerInteraction(answer);
    await f.runtime.answerInteraction(answer); // exact accepted human command is idempotent
    await until(async () => (await f.store.getRun(waiting.runId!))?.status === 'completed');
    const entries = await f.store.listExecutions('session');
    expect(entries.find((row) => row.id === waiting.id)?.status).toBe('succeeded');
    expect(entries.find((row) => row.definitionId === 'browser.snapshot')?.runId).toBe(
      waiting.runId,
    );
    expect(entries.find((row) => row.definitionId === 'browser.snapshot')?.status).toBe(
      'succeeded',
    );
    expect(new Set(entries.filter((row) => row.kind === 'tool').map((row) => row.runId)).size).toBe(
      1,
    );
    expect(f.model.requests).toHaveLength(4);
    expect(f.resumes).toBe(1);
    expect(f.controller.view('session')?.humanRequest).toBeUndefined();
    expect(f.timeline.indexOf('model-3')).toBeGreaterThan(
      f.timeline.indexOf('human-resume-confirmed'),
    );
    expect(
      f.requests.filter((value) => (value as { action?: string }).action === 'snapshot'),
    ).toHaveLength(1);
    expect(f.starts).toBe(1);
    const after = f.controller.view('session')!;
    expect(after.generation).not.toBe(humanFrame.generation);
    expect(BigInt(after.seq)).toBeGreaterThan(BigInt(humanFrame.seq));
    const stale = await f.controller.command(
      'session',
      humanFrame,
      { action: 'click', ref: '@e1', seq: humanFrame.seq },
      new AbortController().signal,
    );
    expect(stale).toMatchObject({
      outcome: 'failed',
      details: { code: 'browser_stale_or_foreign_target' },
    });
    await f.runtime.waitForCommand('ordinary-select', { timeoutMs: 4000 });
    expect(
      f.authorizations.some(
        (row) => row.kind === 'job' && row.definitionId === 'builtin.browser/browser.resume',
      ),
    ).toBe(true);
  } finally {
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

test('request_human stays behind ordinary Tool permission and cannot yield when denied', async () => {
  const f = await fixture(true, { human: true, denyHuman: true });
  try {
    await until(async () =>
      (await f.store.listExecutions('session')).some(
        (row) => row.definitionId === 'browser.request_human' && row.status === 'failed',
      ),
    );
    expect(
      f.authorizations.some(
        (row) => row.kind === 'tool' && row.definitionId === 'browser.request_human',
      ),
    ).toBe(true);
    expect(f.handoffs).toBe(0);
    expect(f.resumes).toBe(0);
    expect(f.controller.view('session')?.state).toBe('agent');
    expect(f.controller.view('session')?.humanRequest).toBeUndefined();
  } finally {
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

async function pendingHuman(f: Awaited<ReturnType<typeof fixture>>) {
  let question:
    | Awaited<ReturnType<typeof f.runtime.listInteractions>>['interactions'][number]
    | undefined;
  await until(async () => {
    question = (
      await f.runtime.listInteractions({
        expectedStoreId: f.expectedStoreId,
        sessionId: 'session',
        state: 'pending',
      })
    ).interactions.find((row) => row.definitionId === 'browser.request_human');
    return !!question;
  });
  return question!;
}
test('accepted human information never grants resume permission, and refusal leaves the page human controlled', async () => {
  const f = await fixture(true, { human: true, denyResume: true });
  try {
    const q = await pendingHuman(f);
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'continue-denied',
      presentationSessionId: 'session',
      interactionId: q.id,
      expectedRevision: q.revision,
      answer: { kind: 'question', answers: { control: 'continue' } },
    });
    await until(async () => (await f.store.getExecution(q.executionId))?.status === 'failed');
    expect(
      f.authorizations.some((row) => row.definitionId === 'builtin.browser/browser.resume'),
    ).toBe(true);
    expect(f.resumes).toBe(0);
    expect(f.controller.view('session')?.state).toBe('human');
    expect(f.controller.view('session')?.humanRequest).toBe('Check the local form, then continue.');
  } finally {
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);

for (const mode of ['cancel', 'close', 'disconnect'] as const) {
  test(`human wait settles on ${mode}; a late answer cannot reacquire control`, async () => {
    const f = await fixture(true, { human: true });
    try {
      const q = await pendingHuman(f);
      const before = f.controller.view('session')!;
      if (mode === 'cancel')
        await f.runtime.cancelRun({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'owner',
          sessionId: 'session',
          commandId: 'cancel-waiting-run',
          runId: q.runId!,
        });
      else if (mode === 'close') await f.controller.close('session', before);
      else f.endOwner();
      await until(
        async () =>
          !['dispatching', 'running', 'planned'].includes(
            (await f.store.getExecution(q.executionId))!.status,
          ),
      );
      await f.runtime.answerInteraction({
        expectedStoreId: f.expectedStoreId,
        subjectId: 'owner',
        commandId: `late-${mode}`,
        presentationSessionId: 'session',
        interactionId: q.id,
        expectedRevision: q.revision,
        answer: { kind: 'question', answers: { control: 'continue' } },
      });
      // Existing interaction semantics retain late information as history;
      // acceptedDecisionRevision stays absent and it cannot resume execution.
      const historical = await f.runtime.getInteraction({
        expectedStoreId: f.expectedStoreId,
        sessionId: 'session',
        interactionId: q.id,
      });
      expect(historical?.state).toBe('cancelled');
      expect(historical?.acceptedDecisionRevision).toBeNull();
      expect(f.resumes).toBe(0);
      expect(f.controller.view('session')?.state).not.toBe('agent');
      expect(
        (await f.store.listExecutions('session')).some(
          (row) => row.definitionId === 'builtin.browser/browser.resume',
        ),
      ).toBe(false);
    } finally {
      await f.runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 15000);
}
