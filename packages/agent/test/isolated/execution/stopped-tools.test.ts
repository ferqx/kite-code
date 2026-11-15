import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { OperationRef, ToolDefinition } from '../../../src/extensions';
import type { ExtensionHost } from '../../../src/extensions/host';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const stopped = '用户停止了上一轮，此工具未执行';
const schema = { type: 'object', properties: {}, additionalProperties: false };
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (id: string, name: string): ModelEvent => ({
  type: 'tool_call',
  id,
  name,
  arguments: '{}',
});
const batchEnd = { ...finish, reason: 'tool_calls' as const };

async function until<T>(read: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw Error('stop_fixture_wait_expired');
    await Bun.sleep(5);
  }
}
async function createSession(
  runtime: ReturnType<typeof createRuntime>,
  store: Store,
  directory: string,
) {
  const expectedStoreId = (await store.getMetadata()).storeId;
  const identity = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: pathToFileURL(directory).href,
  });
  await runtime.createSession({
    ...identity,
    commandId: 'create',
    title: 'owned',
    workspaceId: 'w',
  });
  return identity;
}

for (const phase of [
  'approved and waiting for a resource',
  'preparing ToolContext',
  'dispatch committed before acknowledgement',
  'denial before stop',
  'stop before denial',
] as const) {
  test(`a user stop prevents adapter entry while ${phase}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-tool-stop-boundary-'));
    const profile = { dataRoot: join(directory, 'data'), profile: 'owned' };
    const store = await openSqliteStore(profile);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const approvalRace = phase === 'denial before stop' || phase === 'stop before denial';
    let attempts = 0;
    const wrapped = new Proxy(store, {
      get(target, key, receiver) {
        if (key === 'getInteraction' && approvalRace)
          return async (input: Parameters<Store['getInteraction']>[0]) => {
            held.resolve();
            await release.promise;
            return target.getInteraction(input);
          };
        if (key === 'markDispatching' && phase === 'dispatch committed before acknowledgement')
          return async (input: Parameters<Store['markDispatching']>[0]) => {
            const result = await target.markDispatching(input);
            if ((await target.getExecution(input.executionId))?.callId === 'focus') {
              held.resolve();
              await release.promise;
            }
            return result;
          };
        return Reflect.get(target, key, receiver);
      },
    });
    const definitions: ToolDefinition[] = [
      {
        id: 'fixture.focus',
        version: '1',
        description: 'Tool held before adapter entry',
        inputSchema: schema,
        ...(phase === 'approved and waiting for a resource'
          ? { resources: { serial: { scope: 'workspace', key: 'held-test-lock' } } as const }
          : {}),
        async execute() {
          attempts++;
          return { outcome: 'succeeded', content: 'UNEXPECTED EXECUTION' };
        },
      },
      {
        id: 'fixture.done',
        version: '1',
        description: 'Independent Tool',
        inputSchema: schema,
        async execute() {
          return { outcome: 'succeeded', content: 'ALREADY COMPLETED' };
        },
      },
    ];
    const model = createFixedModel([
      [call('focus', 'fixture.focus'), call('done', 'fixture.done'), batchEnd],
      [{ type: 'text_delta', text: 'Read the prior Tool receipts' }, finish],
    ]);
    let lockReleases = 0;
    const runtime = createRuntime({
      store: wrapped,
      artifacts: createArtifactStore({ profile, store: wrapped }),
      model,
      permissions: {
        async authorize(request) {
          return (phase === 'approved and waiting for a resource' || approvalRace) &&
            request.definitionId === 'fixture.focus'
            ? {
                allowed: false,
                revision: '1',
                approval: { request: { title: 'Approve before lock' } },
              }
            : { allowed: true, revision: '1' };
        },
      },
      workspaceSerialLocks: {
        async acquire() {
          held.resolve();
          await release.promise;
          return () => {
            lockReleases++;
          };
        },
      },
      extensions: [{ id: 'fixture.stopped', version: '1', apiMajor: 1, tools: definitions }],
    });
    if (phase === 'preparing ToolContext') {
      // Hold the real host context read on this isolated Runtime only.
      const { extensionHost } = runtime as unknown as {
        extensionHost: Pick<ExtensionHost, 'toolContext'>;
      };
      const context = extensionHost.toolContext.bind(extensionHost);
      extensionHost.toolContext = async (...args) => {
        if (args[1].id === 'fixture.focus') {
          held.resolve();
          await release.promise;
        }
        return context(...args);
      };
    }
    try {
      const identity = await createSession(runtime, store, directory);
      await runtime.submitCommand({
        ...identity,
        commandId: 'work',
        request: { kind: 'run.start', content: 'Original batch' },
      });
      const approval =
        phase === 'approved and waiting for a resource' || approvalRace
          ? await until(
              async () =>
                (await runtime.listInteractions({ ...identity, state: 'pending' })).interactions[0],
            )
          : null;
      const answer = async (decision: 'approve' | 'deny') =>
        runtime.answerInteraction({
          ...identity,
          commandId: decision,
          presentationSessionId: 's',
          interactionId: approval!.id,
          expectedRevision: approval!.revision,
          answer:
            decision === 'approve'
              ? { kind: 'approval', decision, optionId: 'once' }
              : { kind: 'approval', decision },
        });
      if (phase === 'approved and waiting for a resource') await answer('approve');
      await held.promise;
      const before = await until(async () =>
        (await store.listExecutions('s')).find((row) => row.callId === 'focus'),
      );
      expect(before.authorization?.dispatched).toBe(
        phase === 'dispatch committed before acknowledgement',
      );
      await until(async () =>
        (await store.listMessages('s')).some((row) => row.toolCallId === 'done'),
      );
      if (phase === 'denial before stop')
        expect((await answer('deny')).receipt).toMatchObject({ cancelled: false });
      expect(
        await runtime.cancelCommand({ ...identity, commandId: 'stop', targetCommandId: 'work' }),
      ).toMatchObject({ status: 'applied' });
      if (phase === 'stop before denial')
        expect((await answer('deny')).receipt).toMatchObject({ cancelled: true });
      const next = {
        ...identity,
        commandId: 'next',
        request: { kind: 'run.start' as const, content: 'Continue from saved results' },
      };
      if (approvalRace)
        expect(await runtime.submitCommand(next)).toMatchObject({ status: 'accepted' });
      expect(model.requests).toHaveLength(1);
      expect(attempts).toBe(0);
      release.resolve();
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(await store.getRun(before.runId!)).toMatchObject({ status: 'cancelled' });
      expect(await store.getExecution(before.id)).toMatchObject({
        status: phase === 'denial before stop' ? 'failed' : 'cancelled',
        result: {
          content: phase === 'denial before stop' ? 'approval_denied' : stopped,
          details: {
            adapterAttempted: false,
            dispatchCommitted: phase === 'dispatch committed before acknowledgement',
          },
        },
      });
      if (phase === 'approved and waiting for a resource') await until(() => lockReleases === 1);
      if (!approvalRace) await runtime.submitCommand(next);
      await runtime.waitForCommand('next', { timeoutMs: 5000 });
      expect(attempts).toBe(0);
      expect(
        (await store.listMessages('s'))
          .filter((row) => row.role === 'tool')
          .map((row) => row.toolCallId),
      ).toEqual(['done', 'focus']);
      const messages = model.requests[1]!.messages;
      expect(messages.flatMap((message) => message.toolCalls?.map(({ id }) => id) ?? [])).toEqual([
        'focus',
        'done',
      ]);
      expect(
        messages
          .filter((message) => message.role === 'tool')
          .map((row) => [row.toolCallId, row.content]),
      ).toEqual([
        [
          'focus',
          phase === 'denial before stop'
            ? 'The user denied this request. It was not executed. Do not resubmit it or bypass the refusal.'
            : stopped,
        ],
        ['done', 'ALREADY COMPLETED'],
      ]);
    } finally {
      release.resolve();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
}

for (const actor of [
  'user stops child',
  'user stops only the Tool',
  'parent Agent stops child',
] as const) {
  test(`${actor} preserves the exact affected Run and receipt attribution`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-child-stop-scope-'));
    const profile = { dataRoot: join(directory, 'data'), profile: 'owned' };
    const store = await openSqliteStore(profile);
    const parentGate = Promise.withResolvers<void>();
    const childRef = Promise.withResolvers<OperationRef>();
    const agentStop = Promise.withResolvers<string>();
    let attempts = 0;
    const rootModel = createFixedModel([
      [call('spawn', 'fixture.spawn'), batchEnd],
      [{ type: 'text_delta', text: 'Parent continued' }, finish],
    ]);
    const childModel = createFixedModel([
      [call('child-tool', 'fixture.child'), batchEnd],
      [{ type: 'text_delta', text: 'Child continued' }, finish],
    ]);
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model: rootModel,
      modelId: 'root',
      permissions: {
        async authorize(request) {
          return request.definitionId === 'fixture.child'
            ? { allowed: false, revision: '1', approval: { request: { title: 'Hold child Tool' } } }
            : { allowed: true, revision: '1' };
        },
      },
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: childModel,
          modelId: 'child',
          toolIds: ['fixture.child'],
          snapshot: {},
        },
      ],
      extensions: [
        {
          id: 'fixture.child-control',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.spawn',
              version: '1',
              description: 'Spawn an isolated child',
              inputSchema: schema,
              async execute(_input, context) {
                const ref = await context.operations.ensure({
                  key: 'child',
                  request: {
                    kind: 'agent',
                    configurationId: 'child',
                    input: { content: 'Wait for the child tool' },
                  },
                  cancellation: 'detached',
                });
                childRef.resolve(ref);
                if (actor === 'parent Agent stops child') {
                  const targetRunId = await agentStop.promise;
                  await context.operations.interruptAgent!(ref, {
                    commandId: 'agent-stop',
                    targetRunId,
                  });
                }
                await parentGate.promise;
                return { outcome: 'succeeded', content: 'Parent retained its work' };
              },
            },
            {
              id: 'fixture.child',
              version: '1',
              description: 'Wait for approval',
              inputSchema: schema,
              async execute() {
                attempts++;
                return { outcome: 'succeeded', content: 'Unexpected call' };
              },
            },
          ],
        },
      ],
    });
    try {
      const identity = await createSession(runtime, store, directory);
      await runtime.submitCommand({
        ...identity,
        commandId: 'root-work',
        request: { kind: 'run.start', content: 'Create a child' },
      });
      const ref = await childRef.promise;
      const child = { ...identity, sessionId: ref.childSessionId! };
      await until(
        async () =>
          (await runtime.listInteractions({ ...identity, state: 'pending' })).interactions[0],
      );
      const tool = (await store.listExecutions(child.sessionId)).find(
        (execution) => execution.callId === 'child-tool',
      )!;
      expect(tool.authorization?.dispatched).toBe(false);
      if (actor === 'user stops child') {
        expect(
          await runtime.cancelExecution({
            ...identity,
            commandId: 'ui-stop-child',
            executionId: ref.executionId!,
          }),
        ).toMatchObject({ status: 'applied' });
      } else if (actor === 'user stops only the Tool') {
        expect(
          await runtime.cancelExecution({
            ...child,
            commandId: 'ui-stop-tool',
            executionId: tool.id,
          }),
        ).toMatchObject({ status: 'applied' });
      } else agentStop.resolve(tool.runId!);
      const terminal = await until(async () => {
        const run = await store.getRun(tool.runId!);
        return run?.isActive === false ? run : undefined;
      });
      expect(terminal.status).toBe(
        actor === 'user stops only the Tool' ? 'completed' : 'cancelled',
      );
      const result = (await store.listMessages(child.sessionId)).filter(
        (message) => message.role === 'tool',
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.toolCallId).toBe('child-tool');
      if (actor === 'user stops child') expect(result[0]!.content).toBe(stopped);
      else
        expect(result[0]!.content).toMatch(
          /^(?:execution_cancel_requested|child_cancel_requested|cancel_requested|cancelled_before_dispatch)$/,
        );
      expect(attempts).toBe(0);
      const work = (await store.getCommand('root-work'))!;
      const parentRunId = (work.receipt as { runId: string }).runId;
      expect(await store.getRun(parentRunId)).toMatchObject({ isActive: true });
      parentGate.resolve();
      await runtime.waitForCommand('root-work', { timeoutMs: 5000 });
      expect(await store.getRun(parentRunId)).toMatchObject({ status: 'completed' });
    } finally {
      agentStop.resolve('cleanup');
      parentGate.resolve();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
}
