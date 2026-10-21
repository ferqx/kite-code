import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import { createClient, type Message } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { render } from 'ink';
import { TuiController, type TuiPort, TuiSession } from '../../../src/tui';

const root = process.env.KITE_TUI_ROOT!;
const profile = { dataRoot: join(root, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
const effects: string[] = [];
const parentRequests: import('@kite-ai/ai').ModelRequest[] = [];
const parentBindings: {
  executionId: string;
  runId: string;
  businessCommandId: string;
  content: string;
}[] = [];
let agentId = '',
  modelCalls = 0;
const finish = {
  type: 'finish' as const,
  reason: 'stop' as const,
  usage: { inputTokens: 1, outputTokens: 1 },
};
const child = {
  async *stream(request: import('@kite-ai/ai').ModelRequest) {
    modelCalls++;
    const users = request.messages.filter((m) => m.role === 'user');
    const text = users.map((m) => m.content).join('\n');
    const tag = text.includes('CHILD_A2') ? 'A2' : text.includes('CHILD_A') ? 'A' : 'B';
    const lastUser = request.messages.map((m) => m.role).lastIndexOf('user');
    if (!request.messages.slice(lastUser + 1).some((m) => m.role === 'tool')) {
      yield {
        type: 'tool_call' as const,
        id: `effect-${tag}`,
        name: 'effect',
        arguments: JSON.stringify({ tag }),
      };
      yield { ...finish, reason: 'tool_calls' as const };
    } else {
      yield { type: 'text_delta' as const, text: `CHILD_${tag}_DONE` };
      yield finish;
    }
  },
};
const runtime = createRuntime({
  store,
  artifacts: createArtifactStore({ profile, store }),
  modelId: 'fixed',
  model: {
    async *stream(request) {
      parentRequests.push(request);
      modelCalls++;
      const execution = await store.getExecution(request.requestId);
      const run = execution?.runId ? await store.getRun(execution.runId) : null;
      const command = run ? await store.getCommand(run.originCommandId) : null;
      const text = (command?.request as { content?: string } | undefined)?.content;
      if (
        execution?.sessionId !== 'a' ||
        !run ||
        !command ||
        command.originStoreId !== storeId ||
        typeof text !== 'string'
      )
        throw Error('parent_original_business_unavailable');
      const users = request.messages.flatMap((message, index) =>
        message.role === 'user' &&
        message.content === text &&
        message.sourceIds?.includes(command.id)
          ? [index]
          : [],
      );
      if (users.length !== 1) throw Error('parent_original_user_source_unverifiable');
      const userIndex = users[0]!;
      parentBindings.push({
        executionId: execution.id,
        runId: run.id,
        businessCommandId: command.id,
        content: text,
      });
      if (
        text === 'six start' &&
        !request.messages.slice(userIndex + 1).some((m) => m.role === 'tool')
      ) {
        for (const tag of ['A', 'B'])
          yield {
            type: 'tool_call' as const,
            id: `spawn-${tag}`,
            name: 'spawn_agent',
            arguments: JSON.stringify({ prompt: `CHILD_${tag}`, task_name: tag }),
          };
        yield { ...finish, reason: 'tool_calls' as const };
      } else if (
        text === '补充：six follow' &&
        !request.messages.slice(userIndex + 1).some((m) => m.role === 'tool')
      ) {
        yield {
          type: 'tool_call' as const,
          id: 'follow-A',
          name: 'follow_up_agent',
          arguments: JSON.stringify({ agent_id: agentId, content: 'CHILD_A2' }),
        };
        yield { ...finish, reason: 'tool_calls' as const };
      } else {
        yield { type: 'text_delta' as const, text: 'PARENT_DONE' };
        yield finish;
      }
    },
  },
  childConfigurations: [
    {
      id: 'worker',
      version: '1',
      inputSchema: {
        type: 'object',
        required: ['content'],
        additionalProperties: false,
        properties: { content: { type: 'string' }, name: { type: 'string' } },
      },
      snapshot: {},
      modelId: 'child',
      model: child,
      toolIds: ['effect'],
    },
  ],
  permissions: {
    async authorize(invocation) {
      return invocation.definitionId === 'effect'
        ? {
            allowed: false,
            revision: 'exact',
            approval: { request: { input: invocation.input, grants: ['approve_once'] } },
          }
        : { allowed: true, revision: 'exact' };
    },
  },
  extensions: [
    createTaskExtension({
      roles: [{ id: 'worker', configurationId: 'worker', description: 'owned worker' }],
    }),
    {
      id: 'fixture',
      apiMajor: 1,
      version: '1',
      tools: [
        {
          id: 'effect',
          version: '1',
          description: 'Owned test effect',
          inputSchema: {
            type: 'object',
            properties: { tag: { type: 'string' } },
            required: ['tag'],
            additionalProperties: false,
          },
          async execute(input) {
            effects.push((input as { tag: string }).tag);
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
  name: 'w',
  rootUri: pathToFileURL(root).href,
});
await runtime.createSession({
  expectedStoreId: storeId,
  subjectId: 'owner',
  commandId: 'create',
  sessionId: 'a',
  workspaceId: 'w',
  title: 'Collaboration',
});
const service = await startService({
  runtime,
  profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'private-fixture' },
  buildId: 'test',
  subjectId: 'owner',
});
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
      return client.cancelExecution(id, request);
    },
    getCommand: (id, signal) => client.getCommand(id, { signal }),
  },

  storeId,
  nextCommandId: () => `intent-${++counter}`,
  listSessions: (signal) => client.listAllSessions({ signal }),
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
    const childViews = await Promise.all(
      view.executions
        .filter((row) => row.childSessionId)
        .map(async (row) => ({
          executionId: row.id,
          view: await client.getView(row.childSessionId!, { signal }),
        })),
    );
    return { storeId, view, messages, interactions, childViews };
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
    return client.cancelCommand(id, intent);
  },
  getCommand: (id) => client.getCommand(id),
};
const controller = new TuiController(port);
await controller.select('a');
controller.observationReady(storeId);
process.stdin.setRawMode(true);
const terminal = render(<TuiSession testDiagnostics controller={controller} />, {
  exitOnCtrlC: false,
});
let updating = false;
const timer = setInterval(() => {
  if (updating) return;
  updating = true;
  void (async () => {
    const view = await runtime.getView('a');
    const interactions = (
      await runtime.listInteractions({ expectedStoreId: storeId, sessionId: 'a', limit: 100 })
    ).interactions;
    const carriers = view.executions.filter(
      (row) => row.childSessionId && row.definitionId === 'agent/worker',
    );
    const first = carriers.find(
      (row) =>
        row.input &&
        typeof row.input === 'object' &&
        !Array.isArray(row.input) &&
        row.input.content === 'CHILD_A',
    );
    agentId ||= first?.childSessionId ?? '';
    if (!controller.state.panel) await controller.select('a');
    writeFileSync(
      process.env.KITE_TUI_STATE!,
      JSON.stringify({
        effects,
        modelCalls,
        parentRequests,
        parentBindings,
        agentId,
        panel: controller.state.panel,
        jobs: view.executions.filter((row) => row.kind !== 'model'),
        carriers,
        interactions,
        runs: view.runs,
        snapshot: controller.state.snapshot?.interactions,
      }),
    );
  })().finally(() => {
    updating = false;
  });
}, 50);
await new Promise<void>((resolve) => process.once('SIGTERM', resolve));
clearInterval(timer);
while (updating) await Bun.sleep(5);
controller.dispose();
terminal.unmount();
client.disposeNetwork();
await service.close();
await runtime.close();
