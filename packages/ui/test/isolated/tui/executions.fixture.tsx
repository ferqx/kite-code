import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient, type Message } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { render } from 'ink';
import { TuiController, type TuiPort, TuiSession } from '../../../src/tui';

const root = process.env.KITE_TUI_ROOT ?? mkdtempSync(join(tmpdir(), 'kite-tui-paired-'));
const profile = { dataRoot: join(root, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
let effects = 0,
  modelCalls = 0,
  childCalls = 0,
  stopPosts = 0,
  stopGets = 0,
  lostStop: string | undefined,
  cancellations = 0,
  inputEnded = false;
const fullBody = 'PARENT_COMPLETED_ORIGINAL';
const childBody = `CHILD_MODEL_ORIGINAL ${'原完整🙂e\u0301正文'.repeat(18000)} CHILD_MODEL_FULL_TAIL`;
const outputProduced: Record<string, boolean> = {};
const starts: Record<string, number> = {},
  stops: Record<string, number> = {},
  finished: Record<string, boolean> = {};
const readProofs = new Map<string, NonNullable<TuiController['state']['executionReading']>>();
const releaseJobs = join(root, 'release-jobs');
const runtime = createRuntime({
  store,
  artifacts: createArtifactStore({ profile, store }),
  modelId: 'fixed',
  model: {
    async *stream() {
      modelCalls++;
      if (modelCalls === 1) {
        yield { type: 'tool_call', id: 'delegate', name: 'delegate', arguments: '{}' };
        yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: 'text_delta', text: fullBody };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  },
  childConfigurations: [
    {
      id: 'reader-child',
      snapshot: { id: 'reader-child', version: '1' },
      version: '1',
      modelId: 'fixed-child',
      toolIds: ['child-step'],
      model: {
        async *stream() {
          childCalls++;
          if (childCalls < 3) {
            for (let i = 1; i <= 100; i++) {
              const step = (childCalls - 1) * 100 + i;
              yield {
                type: 'tool_call' as const,
                id: `step-${step}`,
                name: 'child-step',
                arguments: JSON.stringify({ step }),
              };
            }
            yield {
              type: 'finish' as const,
              reason: 'tool_calls',
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          } else {
            yield { type: 'text_delta' as const, text: childBody };
            yield {
              type: 'finish' as const,
              reason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
        },
      },
    },
  ],
  permissions: {
    async authorize(invocation) {
      return invocation.kind === 'model' ||
        ['delegate', 'agent/reader-child', 'child-step', 'long-one', 'long-two'].includes(
          invocation.definitionId,
        )
        ? { allowed: true, revision: 'explicit-owned-harmless-config' }
        : { allowed: false, revision: 'unconfigured-denied' };
    },
  },
  extensions: [
    {
      id: 'fixture',
      apiMajor: 1,
      version: '1',
      jobs: ['long-one', 'long-two'].map((id) => ({
        id,
        version: '1',
        description: 'Owned independent original ' + id,
        inputSchema: { type: 'object', additionalProperties: false },
        async start() {
          starts[id] = (starts[id] ?? 0) + 1;
          return { reference: { id } };
        },
        async *observe() {
          for (let i = 0; i < 220; i++)
            yield {
              type: 'output' as const,
              stream: i % 2 ? ('stderr' as const) : ('stdout' as const),
              content: `${id} ORIGINAL_${i} ${'原UTF8🙂e\u0301正文'.repeat(30)}\n`,
            };
          yield { type: 'progress' as const, value: { originalJob: id, progress: 'actual-half' } };
          yield { type: 'output_dropped' as const, stream: 'stderr' as const, bytes: '17' };
          yield {
            type: 'output' as const,
            stream: 'stdout' as const,
            content: `AFTER_GAP_ORIGINAL_${id}\n`,
          };
          outputProduced[id] = true;
          while (!stops[id] && !existsSync(releaseJobs)) await Bun.sleep(20);
          finished[id] = true;
          yield {
            type: 'terminal' as const,
            supervision: 'ended' as const,
            result: {
              outcome: stops[id] ? ('cancelled' as const) : ('succeeded' as const),
              content: `ORIGINAL_JOB_TERMINAL_${id}`,
            },
          };
        },
        async cancel() {
          stops[id] = (stops[id] ?? 0) + 1;
          return { status: 'stopped' as const };
        },
        async dispose() {},
      })),
      tools: [
        {
          id: 'delegate',
          version: '1',
          description: 'Explicit trusted child delegation',
          inputSchema: { type: 'object', additionalProperties: false },
          async execute(_input, ctx) {
            for (const id of ['long-one', 'long-two'])
              await ctx.operations.ensure({
                key: id,
                request: { kind: 'job', definitionId: id, definitionVersion: '1', input: {} },
                cancellation: 'detached',
              });
            await ctx.operations.ensure({
              key: 'original-child',
              request: {
                kind: 'agent',
                configurationId: 'reader-child',
                input: { content: 'CHILD_LOG_ORIGINAL' },
              },
              cancellation: 'detached',
            });
            return { outcome: 'succeeded', content: 'actual detached operations launched' };
          },
        },
        {
          id: 'child-step',
          description: 'Harmless original child history step',
          version: '1',
          inputSchema: {
            type: 'object',
            required: ['step'],
            properties: { step: { type: 'integer', minimum: 1, maximum: 200 } },
            additionalProperties: false,
          },
          async execute(input) {
            effects++;
            return { outcome: 'succeeded', content: JSON.stringify(input) };
          },
        },
      ],
    },
  ],
});
const storeId = (await store.getMetadata()).storeId;
await runtime.createWorkspace({
  expectedStoreId: storeId,
  id: 'w',
  name: 'temporary',
  rootUri: `file://${root}`,
});
await runtime.createSession({
  expectedStoreId: storeId,
  subjectId: 'owner',
  commandId: 'create',
  sessionId: 'a',
  workspaceId: 'w',
  title: 'PTY original',
});
await runtime.createSession({
  expectedStoreId: storeId,
  subjectId: 'owner',
  commandId: 'create-b',
  sessionId: 'b',
  workspaceId: 'w',
  title: 'Other original root',
});
const service = await startService({
  runtime,
  profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'private-fixture' },
  buildId: 'test',
  subjectId: 'owner',
});
const actualFetch = globalThis.fetch;
let heldOutput = false;
globalThis.fetch = Object.assign(
  async (...args: Parameters<typeof fetch>) => {
    const method = args[1]?.method ?? 'GET',
      path = new URL(String(args[0])).pathname,
      body = args[1]?.body ? JSON.parse(String(args[1].body)) : null;
    if (process.env.KITE_TUI_WIRE) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.KITE_TUI_WIRE, JSON.stringify({ method, path, body }) + '\n');
    }
    const response = await actualFetch(...args);
    if (
      method === 'GET' &&
      path.endsWith('/output') &&
      existsSync(join(root, 'hold-output')) &&
      !heldOutput
    ) {
      heldOutput = true;
      writeFileSync(join(root, 'output-held'), 'actual original response held');
      while (!existsSync(join(root, 'release-output'))) await Bun.sleep(20);
    }
    if (method === 'POST' && body?.kind === 'execution.cancel' && !lostStop) {
      lostStop = body.commandId;
      await response.arrayBuffer();
      throw Error('physical stop response lost');
    }
    if (method === 'GET' && path.endsWith('/commands/' + lostStop) && stopGets === 1) {
      await response.arrayBuffer();
      throw Error('physical first original stop GET response lost');
    }
    return response;
  },
  { preconnect: actualFetch.preconnect },
);
const client = createClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  bootstrap: service.bootstrap,
  expected: {
    profile: service.bootstrap.profile,
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'commands', 'history', 'interactions'],
    instanceId: service.bootstrap.instanceId,
    buildId: 'test',
  },
});
await client.connect();
let counter = 0;
const port: TuiPort = {
  executions: {
    getRun: (id, signal) => client.getRun(id, { signal }),
    getExecution: (id, signal) => client.getExecution(id, { signal }),
    output: (id, query, signal) => client.listExecutionOutput(id, { ...query, signal }),
    getView: (id, signal) => client.getView(id, { signal }),
    messages: (id, query, signal) => client.listMessages(id, { ...query, signal }),
    modelOutput: (id, executionId, signal) =>
      client.getModelOutput(id, executionId, { expectedStoreId: storeId, signal }),
    stop: async (id, request) => {
      stopPosts++;
      return client.cancelExecution(id, request);
    },
    getCommand: async (id, signal) => {
      stopGets++;
      return client.getCommand(id, { signal });
    },
  },
  storeId,
  nextCommandId: () => `intent-${++counter}`,
  listSessions: async (signal) =>
    (await client.listAllSessions({ signal })).filter(
      (session) => session.parentSessionId === null,
    ),
  async readSession(id, signal) {
    const view = await client.getView(id, { signal }),
      messages: Message[] = [];
    let afterSeq = '0';
    for (;;) {
      const page = await client.listMessages(id, {
        afterSeq,
        upperSeq: view.session.nextSeq,
        limit: 200,
        signal,
      });
      messages.push(...page);
      if (page.length < 200) break;
      afterSeq = page.at(-1)!.seq;
    }
    const interactions = (
      await client.listInteractions(id, { storeId, limit: 100, state: 'pending' }, { signal })
    ).interactions;
    return { storeId, view, messages, interactions };
  },
  readModelOutput: (id, executionId, signal) => client.getModelOutput(id, executionId, { signal }),
  submit: (id, intent) =>
    intent.kind === 'run.start'
      ? client.startRun(id, intent)
      : intent.kind === 'input.follow_up'
        ? client.followUp(id, intent)
        : client.steer(id, intent),
  answer: (id, card, intent) => client.answerInteraction(id, card, intent),
  cancel: (id, intent) => {
    cancellations++;
    return client.cancelCommand(id, intent);
  },
  getCommand: (id) => client.getCommand(id),
};
const controller = new TuiController(port);
await controller.select('a');
process.stdin.setRawMode(true);
const terminal = render(<TuiSession controller={controller} />, { exitOnCtrlC: false });
let updating = false;
let eventReader = new AbortController(),
  brokeObserver = false,
  resumedObserver = false;
const observe = () => {
  void client
    .observe({
      signal: eventReader.signal,
      onChange: async (change) => {
        if (
          change.sessionId === controller.state.sessionId &&
          !updating &&
          controller.state.panel !== 'executions'
        ) {
          updating = true;
          try {
            await controller.select(change.sessionId);
          } finally {
            updating = false;
          }
        }
      },
      onReady: (ready) => controller.observationReady(ready.storeId),
      onReset: (reason) => controller.observationUnavailable(reason),
    })
    .catch(() => {
      if (!inputEnded) controller.observationUnavailable('actual_observer_closed');
    });
};
observe();
let factView = await runtime.getView('a');
const timer = setInterval(() => {
  void runtime.getView(controller.state.sessionId ?? 'a').then((view) => {
    factView = view;
  });
  if (existsSync(join(root, 'break-observer')) && !brokeObserver) {
    brokeObserver = true;
    eventReader.abort();
    controller.observationUnavailable('actual_observer_closed');
  }
  if (existsSync(join(root, 'resume-observer')) && !resumedObserver) {
    resumedObserver = true;
    eventReader = new AbortController();
    observe();
  }
  const read = controller.state.executionReading;
  if (read?.phase === 'ready') readProofs.set(read.target.executionId, read);
  if (process.env.KITE_TUI_STATE)
    writeFileSync(
      process.env.KITE_TUI_STATE,
      JSON.stringify({
        sessionId: controller.state.sessionId,
        panel: controller.state.panel,
        observation: controller.state.observationState,
        read,
        jobStops: [...controller.state.jobStops.values()],
        panelJobs: controller.state.snapshot?.view.executions.filter((e) => e.kind === 'job'),
        scopeProof: {
          viewStore: controller.state.snapshot?.view.storeId,
          viewSession: controller.state.snapshot?.view.session.id,
          carriers: factView.executions
            .filter((e) => e.childSessionId)
            .map((e) => ({
              id: e.id,
              parentExecutionId: e.parentExecutionId,
              childSessionId: e.childSessionId,
            })),
        },
        jobs: factView.executions.filter((item) => item.kind === 'job'),
        runs: factView.runs,
        childCalls,
        effects,
        starts,
        stops,
        finished,
        outputProduced,
      }),
      { mode: 0o600 },
    );
  if (updating || controller.state.fullOutputs.size || controller.state.panel === 'executions')
    return;
  updating = true;
  void controller.select(controller.state.sessionId ?? 'a').finally(() => {
    updating = false;
  });
}, 80);
const endInput = () => {
  inputEnded = true;
  clearInterval(timer);
  eventReader.abort();
  controller.dispose();
};
process.stdin.once('end', endInput);
process.stdin.once('error', endInput);
let resolve!: () => void;
const stop = new Promise<void>((r) => {
  resolve = r;
});
process.once('SIGTERM', resolve);
process.once('SIGHUP', resolve);
await stop;
clearInterval(timer);
eventReader.abort();
controller.dispose();
if (!inputEnded) terminal.unmount();
const view = await runtime.getView('a');
const childSessionId = view.executions.find((e) => e.childSessionId)?.childSessionId;
const childView = childSessionId ? await runtime.getView(childSessionId) : undefined;
const childExecutions = view.executions.filter((item) => item.childSessionId);
const facts = JSON.stringify({
  starts,
  stops,
  finished,
  stopPosts,
  stopGets,
  lostStop,
  originalJobs: view.executions
    .filter((item) => item.kind === 'job')
    .map((item) => ({
      id: item.id,
      definitionId: item.definitionId,
      sessionId: item.sessionId,
      status: item.status,
      cancelRequestedAt: item.cancelRequestedAt,
      childSessionId: item.childSessionId,
      parentExecutionId: item.parentExecutionId,
    })),
  readFacts: [...readProofs.values()].map((read) =>
    read.output
      ? { kind: 'output', target: read.target, output: read.output }
      : {
          kind: 'child',
          target: read.target,
          childSessionId: read.child!.view.session.id,
          selection: read.child!.view.session.contextSelectionId,
          upper: read.child!.view.session.nextSeq,
          messageCount: read.child!.messages.length,
          outputBodyCount: read.child!.messages.filter(
            (message) =>
              message.outputBody && message.outputBody.readAvailability !== 'unsupported',
          ).length,
          fullBodies: [...read.child!.modelOutputs.values()].map((body) => ({
            content: body.output.content,
            contentBytes: body.contentBytes,
            complete: body.output.complete,
          })),
        },
  ),
  childBody,
  childExecutionCount: childExecutions.length,
  fullOutputExact: [...controller.state.fullOutputs.values()].some(
    (content) => content === fullBody,
  ),
  fullOutputBytes: Math.max(
    0,
    ...[...controller.state.fullOutputs.values()].map((content) => Buffer.byteLength(content)),
  ),
  rootWaitingOnChild: view.executions.some(
    (e) => e.definitionId === 'delegate' && e.status === 'dispatching',
  ),
  childRuns: childView?.runs.map((r) => r.status) ?? [],
  effects,
  modelCalls,
  childCalls,
  cancellations,
  inputEnded,
  runs: view.runs.map((r) => r.status),
  interactions: (
    await runtime.listInteractions({ expectedStoreId: storeId, sessionId: 'a', limit: 100 })
  ).interactions.map((i) => ({
    kind: i.kind,
    state: i.state,
    answer: i.answer,
    sessionId: i.sessionId,
    presentationSessionId: i.presentationSessionId,
    executionId: i.executionId,
  })),
});
if (process.env.KITE_TUI_FACTS) writeFileSync(process.env.KITE_TUI_FACTS, facts, { mode: 0o600 });
if (!inputEnded) console.log(`SAFE_FACTS ${facts}`);
client.disposeNetwork();
await service.close();
await runtime.close();
rmSync(root, { recursive: true, force: true });
