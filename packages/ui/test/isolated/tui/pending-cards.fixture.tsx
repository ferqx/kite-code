import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  verifierStarts = 0,
  postCount = 0,
  getCount = 0,
  lostCommand: string | undefined,
  cancellations = 0,
  inputEnded = false;
const fullBody = 'MULTI_CARD_DONE';
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
  childConfigurations: ['sibling-a', 'sibling-b'].map((id) => {
    let calls = 0;
    return {
      id,
      snapshot: { id, version: '1' },
      version: '1',
      modelId: `fixed-${id}`,
      toolIds: ['ask'],
      model: {
        async *stream() {
          childCalls++;
          calls++;
          if (calls === 1) {
            yield {
              type: 'tool_call' as const,
              id: `${id}-ask`,
              name: 'ask',
              arguments: JSON.stringify({ label: id }),
            };
            yield {
              type: 'finish' as const,
              reason: 'tool_calls',
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          } else {
            yield { type: 'text_delta' as const, text: `${id} actual effect completed` };
            yield {
              type: 'finish' as const,
              reason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
        },
      },
    };
  }),
  maxConcurrentSubagents: 2,
  permissions: {
    async authorize(invocation) {
      return invocation.kind === 'model' ||
        invocation.definitionId === 'delegate' ||
        ['agent/sibling-a', 'agent/sibling-b'].includes(invocation.definitionId)
        ? { allowed: true, revision: 'host' }
        : {
            allowed: false,
            revision: 'host',
            approval: {
              request: {
                input: invocation.input,
                grants: ['approve_once', 'same_command'],
                policyBody: 'P'.repeat(70000) + ' END_FULL_' + invocation.definitionId,
              },
            },
          };
    },
  },
  extensions: [
    {
      id: 'fixture',
      apiMajor: 1,
      version: '1',
      jobs: [
        {
          id: 'required-verifier',
          version: '1',
          description: 'Independently approved required Job checks both actual child effects',
          inputSchema: { type: 'object', additionalProperties: false },
          async start() {
            verifierStarts++;
            return { reference: { expectedEffects: 2 } };
          },
          async *observe() {
            while (effects < 2) await Bun.sleep(20);
            yield {
              type: 'terminal' as const,
              supervision: 'ended' as const,
              result: {
                outcome: 'succeeded' as const,
                content: `verified actual effects ${effects}`,
              },
            };
          },
          async cancel() {
            return { status: 'stopped' as const };
          },
          async dispose() {},
        },
      ],
      tools: [
        {
          id: 'delegate',
          version: '1',
          description: 'Explicit trusted child delegation',
          inputSchema: { type: 'object', additionalProperties: false },
          async execute(_input, ctx) {
            const children = await Promise.all(
              ['sibling-a', 'sibling-b'].map((id) =>
                ctx.operations.ensure({
                  key: id,
                  request: {
                    kind: 'agent',
                    configurationId: id,
                    input: { content: `${id} original` },
                  },
                  cancellation: 'attached',
                }),
              ),
            );
            const verifier = await ctx.operations.ensure({
              key: 'independent-verifier',
              request: {
                kind: 'job',
                definitionId: 'required-verifier',
                definitionVersion: '1',
                input: {},
              },
              cancellation: 'attached',
            });
            const question = ctx.requestInput({
              schema: {
                type: 'object',
                required: ['choiceId'],
                additionalProperties: false,
                properties: { choiceId: { type: 'string', enum: ['root-choice'] } },
              },
              question: 'Original root independent question',
            });
            const ended = await Promise.all(
              [...children, verifier].map((ref) => ctx.operations.wait(ref)),
            );
            await question;
            return {
              outcome: 'succeeded' as const,
              content: JSON.stringify(ended.map((item) => item.result)),
            };
          },
        },
        {
          id: 'ask',
          description: 'Actual independently approved child effect',
          version: '1',
          inputSchema: {
            type: 'object',
            required: ['label'],
            properties: { label: { type: 'string', enum: ['sibling-a', 'sibling-b'] } },
            additionalProperties: false,
          },
          async execute() {
            effects++;
            return { outcome: 'succeeded', content: 'actual child effect' };
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
const service = await startService({
  runtime,
  profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'private-fixture' },
  buildId: 'test',
  subjectId: 'owner',
});
const originalGetResponses: unknown[] = [];
const actualFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (...args: Parameters<typeof fetch>) => {
    const method = args[1]?.method ?? 'GET',
      path = new URL(String(args[0])).pathname;
    const body = args[1]?.body ? JSON.parse(String(args[1].body)) : null;
    if (process.env.KITE_TUI_WIRE) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.KITE_TUI_WIRE, JSON.stringify({ method, path, body }) + '\n');
    }
    const response = await actualFetch(...args);
    if (method === 'GET' && path.endsWith(`/commands/${lostCommand}`)) {
      const original = await response.clone().json();
      originalGetResponses.push({
        id: original.id,
        kind: original.kind,
        originStoreId: original.originStoreId,
        sessionId: original.sessionId,
        status: original.status,
        receipt: original.receipt,
      });
    }
    if (
      process.env.KITE_LOSE_CARD === '1' &&
      method === 'POST' &&
      path.endsWith('/answer') &&
      !lostCommand
    ) {
      lostCommand = body.commandId;
      await response.arrayBuffer();
      throw Error('physical original POST response lost');
    }
    if (
      process.env.KITE_LOSE_CARD === '1' &&
      method === 'GET' &&
      path.endsWith('/commands/' + lostCommand) &&
      getCount === 1
    ) {
      await response.arrayBuffer();
      throw Error('physical first original GET response lost');
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
const reviewed: {
  key: string;
  bytes: number;
  input: unknown;
  policyBytes: number;
  tail: string;
}[] = [];
const port: TuiPort = {
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
    if (process.env.KITE_TUI_CARDS)
      writeFileSync(process.env.KITE_TUI_CARDS, JSON.stringify(interactions), { mode: 0o600 });
    return { storeId, view, messages, interactions };
  },
  readAttachment: async (card, signal) => {
    const result = await client.readInteractionAttachment(card, { signal }),
      body = JSON.parse(result.text);
    const policies: string[] =
      body.policy.kind === 'parent_child_permission_intersection'
        ? body.policy.policies.map(
            (item: { request: { policyBody: string } }) => item.request.policyBody,
          )
        : [body.policy.policyBody];
    if (policies.some((value) => typeof value !== 'string' || value.length <= 70000))
      throw Error('review_fixture_shape');
    reviewed.push({
      key: JSON.stringify([
        card.originStoreId,
        card.sessionId,
        card.presentationSessionId,
        card.id,
        card.revision,
      ]),
      bytes: Buffer.byteLength(result.text),
      input: body.input,
      policyBytes: policies.reduce((sum, value) => sum + value.length, 0),
      tail: policies.map((value) => value.slice(-80)).join(' '),
    });
    return result.text;
  },
  readModelOutput: (id, executionId, signal) => client.getModelOutput(id, executionId, { signal }),
  submit: (id, intent) =>
    intent.kind === 'run.start'
      ? client.startRun(id, intent)
      : intent.kind === 'input.follow_up'
        ? client.followUp(id, intent)
        : client.steer(id, intent),
  async answer(id, card, intent) {
    postCount++;
    return client.answerInteraction(id, card, intent);
  },
  cancel: (id, intent) => {
    cancellations++;
    return client.cancelCommand(id, intent);
  },
  async getCommand(id) {
    getCount++;
    return client.getCommand(id);
  },
};
const controller = new TuiController(port);
await controller.select('a');
process.stdin.setRawMode(true);
const terminal = render(<TuiSession controller={controller} />, { exitOnCtrlC: false });
let updating = false;
const timer = setInterval(() => {
  if (updating || controller.state.fullOutputs.size) return;
  if (process.env.KITE_TUI_REVIEWS)
    writeFileSync(
      process.env.KITE_TUI_REVIEWS,
      JSON.stringify(
        [...controller.state.attachments].map(([key, body]) => ({
          key,
          bytes: Buffer.byteLength(body),
        })),
      ),
      { mode: 0o600 },
    );
  updating = true;
  void controller.select('a').finally(() => {
    updating = false;
  });
}, 80);
const endInput = () => {
  inputEnded = true;
  clearInterval(timer);
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
controller.dispose();
if (!inputEnded) terminal.unmount();
const view = await runtime.getView('a');
const childSessionId = view.executions.find((e) => e.childSessionId)?.childSessionId;
const childView = childSessionId ? await runtime.getView(childSessionId) : undefined;
const executionFacts = await Promise.all(
  view.executions
    .filter((item) => item.kind !== 'model')
    .map(async (item) => {
      const execution = await runtime.getExecution(item.id);
      return {
        id: execution!.id,
        kind: execution!.kind,
        definitionId: execution!.definitionId,
        sessionId: execution!.sessionId,
        runId: execution!.runId,
        parentExecutionId: execution!.parentExecutionId,
        status: execution!.status,
        childSessionId: execution!.childSessionId,
      };
    }),
);
const facts = JSON.stringify({
  executionFacts,
  originalGetResponses,
  verifierStarts,
  postCount,
  getCount,
  lostCommand,
  attachmentFacts: reviewed,
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
    originStoreId: i.originStoreId,
    id: i.id,
    revision: i.revision,
    acceptedDecisionRevision: i.acceptedDecisionRevision,
    definitionId: i.definitionId,
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
