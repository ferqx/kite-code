import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient, type Message } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { Box, render, Text } from 'ink';
import { useSyncExternalStore } from 'react';
import { TuiController, type TuiPort, TuiSession, type TuiSnapshot } from '../../../src/tui';

const root = process.env.KITE_TUI_ROOT ?? mkdtempSync(join(tmpdir(), 'kite-tui-paired-'));
const profile = { dataRoot: join(root, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
let effects = 0,
  modelCalls = 0,
  childCalls = 0,
  cancellations = 0,
  inputEnded = false;
const fullBody = `FULL TUI BODY ${'正文'.repeat(20000)} VERIFIED TAIL`;
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
      id: 'child',
      snapshot: { id: 'child', version: '1' },
      version: '1',
      modelId: 'fixed-child',
      toolIds: ['ask'],
      model: {
        async *stream() {
          childCalls++;
          if (childCalls === 1) {
            yield { type: 'tool_call' as const, id: 'child-ask', name: 'ask', arguments: '{}' };
            yield {
              type: 'finish' as const,
              reason: 'tool_calls',
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          } else {
            yield { type: 'text_delta' as const, text: 'original child answer' };
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
        invocation.definitionId === 'delegate' ||
        invocation.definitionId === 'agent/child'
        ? { allowed: true, revision: 'host' }
        : {
            allowed: false,
            revision: 'host',
            approval: {
              request: { input: invocation.input, grants: ['approve_once', 'same_command'] },
            },
          };
    },
  },
  extensions: [
    {
      id: 'fixture',
      apiMajor: 1,
      version: '1',
      tools: [
        {
          id: 'delegate',
          version: '1',
          description: 'Explicit trusted child delegation',
          inputSchema: { type: 'object', additionalProperties: false },
          async execute(_input, ctx) {
            const ref = await ctx.operations.ensure({
              key: 'original-child',
              request: {
                kind: 'agent',
                configurationId: 'child',
                input: { content: 'child question' },
              },
              cancellation: 'attached',
            });
            const ended = await ctx.operations.wait(ref);
            return { outcome: 'succeeded' as const, content: JSON.stringify(ended.result) };
          },
        },
        {
          id: 'ask',
          description: 'Actual fixed approval/question effect',
          version: '1',
          inputSchema: { type: 'object', additionalProperties: false },
          async execute(_input, ctx) {
            const answer = await ctx.requestInput({
              schema: {
                type: 'object',
                required: ['choiceId'],
                additionalProperties: false,
                properties: { choiceId: { type: 'string', enum: ['internal-choice'] } },
              },
              question: 'Original choice ID',
            });
            effects++;
            return { outcome: 'succeeded', content: JSON.stringify(answer) };
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
function completePreview(snapshot?: TuiSnapshot) {
  if (snapshot?.storeId !== storeId || snapshot.view.session.id !== 'a') return false;
  const run = snapshot.view.runs.find((candidate) => candidate.originCommandId === 'intent-1');
  return (
    run?.status === 'completed' &&
    snapshot.messages.some(
      (message) =>
        message.runId === run.id &&
        message.outputBody?.complete &&
        snapshot.view.executions.some(
          (execution) =>
            execution.id === message.outputBody?.executionId &&
            execution.runId === run.id &&
            execution.kind === 'model' &&
            execution.status === 'succeeded',
        ),
    )
  );
}
function ChildPermissionsFixture() {
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);
  return (
    <Box flexDirection="column">
      <TuiSession controller={controller} />
      {completePreview(state.snapshot) && (
        <Text>Original completed Run / complete output preview ready</Text>
      )}
    </Box>
  );
}
await controller.select('a');
process.stdin.setRawMode(true);
const terminal = render(<ChildPermissionsFixture />, { exitOnCtrlC: false });
let updating = false;
const timer = setInterval(() => {
  if (updating || controller.state.fullOutputs.size) return;
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
const facts = JSON.stringify({
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
