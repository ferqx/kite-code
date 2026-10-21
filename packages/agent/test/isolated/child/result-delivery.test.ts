import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel } from '@kite-ai/ai';
import type { OperationOptions, OperationRef, ToolDefinition } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;
const childText = 'PRIVATE_CHILD_RESULT_FOR_CALLER';

test.each([
  'caller',
  'session',
  'caller_failed',
] as const)('agent result delivery %s preserves outcome and controls automatic context consumption', async (delivery) => {
  const caller = delivery !== 'session';
  const childFailed = delivery === 'caller_failed';
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-result-delivery-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'delegate', name: 'fixture.delegate', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'Original task done' }, finish],
    [{ type: 'text_delta', text: 'Later task done' }, finish],
  ]);
  const child = createFixedModel([
    childFailed
      ? [new Error('finite child model failure')]
      : [{ type: 'text_delta', text: childText }, finish],
  ]);
  let ref: OperationRef | undefined;
  let deliveryAtWait: string | null | undefined;
  const tool: ToolDefinition = {
    id: 'fixture.delegate',
    version: '1',
    description: 'A finite caller that owns its result',
    inputSchema: { type: 'object' },
    async execute(_input, context) {
      const request = {
        kind: 'agent',
        configurationId: 'worker',
        input: { content: 'Run child' },
      } as const;
      const options: OperationOptions = {
        key: 'once',
        request,
        ...(caller ? { resultDelivery: 'caller' } : {}),
      };
      for (const invalid of [
        { ...options, resultDelivery: 'session' },
        {
          ...options,
          resultDelivery: 'caller',
          request: { kind: 'tool', definitionId: tool.id, definitionVersion: '1', input: {} },
        },
        {
          ...options,
          resultDelivery: 'caller',
          request: { kind: 'job', definitionId: 'worker', definitionVersion: '1', input: {} },
        },
        { ...options, resultDelivery: 'caller', resultRequirement: {} },
        { ...options, resultDelivery: 'caller', continuation: { kind: 'after_turn' } },
      ]) {
        expect(
          await context.operations
            .ensure(invalid as unknown as OperationOptions)
            .catch((error: unknown) => error),
        ).toMatchObject({ code: 'invalid_operation_result_delivery' });
      }
      ref = await context.operations.ensure(options);
      expect(await context.operations.ensure(options)).toEqual(ref);
      const conflict = await context.operations
        .ensure({ ...options, resultDelivery: caller ? undefined : 'caller' })
        .catch((error: unknown) => error);
      expect(conflict).toMatchObject({ code: 'operation_conflict' });
      const session = (await store.getSession(context.sessionId))!;
      const command = (await store.getCommand(ref.commandId))!;
      const persisted = command.request as unknown as {
        childConfiguration: Parameters<Store['ensureOperation']>[0]['childConfiguration'];
      };
      const direct = {
        expectedStoreId: (await store.getMetadata()).storeId,
        owner: {
          sessionId: session.id,
          instanceId: session.ownerInstanceId!,
          generation: session.ownerGeneration,
        },
        sessionId: session.id,
        extensionId: 'fixture',
        originCommandId: 'work',
        parentExecutionId: context.executionId,
        operationKey: options.key,
        request,
        childConfiguration: persisted.childConfiguration,
        ...(caller ? { resultDelivery: 'caller' as const } : {}),
      };
      expect(
        await store
          .ensureOperation({
            ...direct,
            resultDelivery: caller ? undefined : 'caller',
          })
          .catch((error: unknown) => error),
      ).toMatchObject({ code: 'operation_conflict' });
      expect(
        await store
          .ensureOperation({
            ...direct,
            resultDelivery: 'caller',
            request: { kind: 'tool', definitionId: tool.id, definitionVersion: '1', input: {} },
          })
          .catch((error: unknown) => error),
      ).toMatchObject({ code: 'invalid_operation_result_delivery' });
      const result = await context.operations.wait(ref, { signal: context.signal });
      expect(result.status).toBe(childFailed ? 'failed' : 'succeeded');
      expect(result.result).toMatchObject(
        childFailed ? { outcome: 'failed' } : { outcome: 'succeeded', content: childText },
      );
      deliveryAtWait = (await store.getExecution(ref.executionId!))?.delivery;
      return { outcome: 'succeeded', content: 'Caller consumed its result' };
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'parent',
    modelConcurrency: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools: [tool] }],
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'worker', toolIds: [], snapshot: {} },
    ],
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Fixture',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'Fixture',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Delegate work' },
    });
    await runtime.waitForCommand('work');
    expect((await runtime.getView('s')).runs[0]?.status).toBe('completed');
    expect(deliveryAtWait).toBe(caller ? 'suppressed' : 'pending');
    expect(child.requests).toHaveLength(1);
    if (caller)
      expect(await store.getExecution(ref!.executionId!)).toMatchObject({
        delivery: 'suppressed',
        deliveryReason: 'caller_owned',
        status: childFailed ? 'failed' : 'succeeded',
      });
    await runtime.submitCommand({
      ...base,
      commandId: 'later',
      request: { kind: 'run.start', content: 'Continue work.' },
    });
    const later = await runtime.waitForCommand('later');
    expect(later.status).toBe('applied');
    const laterRun = (await store.getView('s')).runs.find(
      (run) => run.id === (later.receipt as { runId: string }).runId,
    );
    expect(laterRun).toMatchObject({
      rootWorkCommandId: 'work',
      status: 'completed',
      isActive: false,
    });
    expect(model.requests).toHaveLength(3);
    expect(JSON.stringify(model.requests.at(-1)!.messages).includes(childText)).toBe(
      delivery === 'session',
    );
    expect(child.requests).toHaveLength(1);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
