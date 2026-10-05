import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRuntime } from '@kite-ai/agent';
import type { OperationRef } from '@kite-ai/agent/extensions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';

const [mode, dataRoot, ledger, ready] = process.argv.slice(2);
if (!['effect', 'partial'].includes(mode!) || !dataRoot || !ledger || !ready)
  throw new Error('Explicit disposable child-crash fixture arguments required.');
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string): ModelEvent[] {
  return [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
    { ...finish, reason: 'tool_calls' },
  ];
}
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
let childCalls = 0;
const child: ModelAdapter = {
  async *stream(_request, { signal }) {
    signal.throwIfAborted();
    childCalls++;
    appendFileSync(ledger, `${JSON.stringify({ kind: 'child-model', call: childCalls })}\n`);
    if (childCalls === 1) {
      for (const event of call('fixture.effect')) yield event;
      return;
    }
    yield { type: 'text_delta', text: 'child unfinished partial\n'.repeat(2000) };
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  },
};
const store = await openSqliteStore({ dataRoot, profile: 'new' });
let operation: OperationRef | undefined;
const runtime = createRuntime({
  store,
  model: createFixedModel([call('fixture.delegate'), [finish]]),
  modelId: 'parent-fixed',
  modelConcurrency: 1,
  permissions: {
    async authorize() {
      return { allowed: true, revision: '1' };
    },
  },
  extensions: [
    {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.delegate',
          version: '1',
          description: 'Explicit detached child',
          inputSchema: { type: 'object' },
          async execute(_input, context) {
            operation = await context.operations.ensure({
              key: 'original-child',
              cancellation: 'detached',
              request: {
                kind: 'agent',
                configurationId: 'child',
                input: { content: 'local crash evidence' },
              },
            });
            return { outcome: 'succeeded', content: 'delegated' };
          },
        },
        {
          id: 'fixture.effect',
          version: '1',
          description: 'Disposable external ledger',
          inputSchema: { type: 'object' },
          async execute(_input, context) {
            appendFileSync(
              ledger,
              `${JSON.stringify({ kind: 'effect', executionId: context.executionId, sessionId: context.sessionId })}\n`,
            );
            await gate;
            context.signal.throwIfAborted();
            return { outcome: 'succeeded', content: 'effect recorded' };
          },
        },
      ],
    },
  ],
  childConfigurations: [
    {
      id: 'child',
      version: '1',
      model: child,
      modelId: 'child-fixed',
      toolIds: ['fixture.effect'],
      snapshot: {},
    },
  ],
});
const expectedStoreId = (await store.getMetadata()).storeId;
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'temporary',
  rootUri: `file://${dataRoot}`,
});
await runtime.createSession({
  expectedStoreId,
  sessionId: 'root',
  workspaceId: 'w',
  commandId: 'create-root',
  subjectId: 'owner',
  title: 'root',
});
await runtime.submitCommand({
  expectedStoreId,
  sessionId: 'root',
  subjectId: 'owner',
  commandId: 'original',
  request: { kind: 'run.start', content: 'start detached child' },
});
await runtime.waitForCommand('original', { timeoutMs: 5000 });
if (mode === 'partial') release();
const deadline = Date.now() + 5000;
while (true) {
  const executions = operation?.childSessionId
    ? await store.listExecutions(operation.childSessionId)
    : [];
  const effect = executions.find((execution) => execution.definitionId === 'fixture.effect');
  const messages = operation?.childSessionId
    ? await store.listMessages(operation.childSessionId)
    : [];
  if (
    effect &&
    (mode === 'effect'
      ? effect.status === 'dispatching'
      : messages.some(
          (message) =>
            message.status === 'incomplete' && message.content.startsWith('child unfinished'),
        ))
  ) {
    const root = await store.getSession('root');
    const view = await store.getView(operation!.childSessionId!);
    const currentModel = (await store.listExecutions(operation!.childSessionId!)).find(
      (execution) => execution.kind === 'model' && execution.status === 'dispatching',
    );
    writeFileSync(
      `${ready}.tmp`,
      JSON.stringify({
        storeId: expectedStoreId,
        generation: root!.ownerGeneration,
        operation,
        childRunId: view.runs[0]!.id,
        effectId: effect.id,
        modelId: currentModel?.id,
      }),
    );
    renameSync(`${ready}.tmp`, ready);
    break;
  }
  if (Date.now() > deadline) throw new Error('Child crash evidence not ready.');
  await Bun.sleep(10);
}
setInterval(() => {}, 1000);
await new Promise<void>(() => {});
