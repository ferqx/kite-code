import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime } from '../../../src';
import { createToolDispatchBatch } from '../../../src/execution/tool-dispatch-admission';
import type { ToolDefinition } from '../../../src/extensions';
import { createPermissionPolicy } from '../../../src/permissions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw Error('tool_admission_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(tools: ToolDefinition[], ask: boolean, planReadOnly = false) {
  const root = temporaryDirectory('kite-tool-admission-');
  const store = await openSqliteStore({ dataRoot: root, profile: 'admission' });
  const model = createFixedModel([
    [
      ...tools.map((tool, index) => ({
        type: 'tool_call' as const,
        id: `call-${index}`,
        name: tool.id,
        arguments: '{}',
      })),
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'complete' }, finish],
  ]);
  const permissions = createPermissionPolicy({
    readPolicy: (request) => ({
      mode: ask ? 'accept_edits' : 'full',
      workspaceTrust: true,
      revision: 'owned',
      allowed:
        request.kind === 'model'
          ? [
              {
                kind: 'model',
                definitionId: request.definitionId,
                definitionVersion: request.definitionVersion,
              },
            ]
          : tools.map((tool) => ({
              kind: 'tool',
              definitionId: tool.id,
              definitionVersion: tool.version,
            })),
    }),
    describeCapability: (request) => ({
      kind: request.kind,
      definitionId: request.definitionId,
      definitionVersion: request.definitionVersion,
      revision: 'owned',
      hardAllowed: !(planReadOnly && request.definitionId === tools[0]!.id),
      ...(planReadOnly && request.definitionId === tools[0]!.id
        ? { denialReason: 'plan_approval_required' }
        : {}),
      safeRead: request.definitionId !== tools[0]!.id,
      effects: request.definitionId === tools[0]!.id ? ['external'] : ['read'],
    }),
  });
  const runtime = createRuntime({
    store,
    model,
    permissions,
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools }],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'owned',
  });
  await runtime.submitCommand({
    expectedStoreId,
    subjectId: 'owner',
    commandId: 'work',
    sessionId: 's',
    request: { kind: 'run.start', content: 'actual ordered admission' },
  });
  return {
    runtime,
    store,
    model,
    expectedStoreId,
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const definition = (id: string, execute: ToolDefinition['execute']): ToolDefinition => ({
  id,
  version: '1',
  description: id,
  inputSchema: { type: 'object', additionalProperties: false },
  execute,
});

for (const content of ['superseded_by_user_input', 'cancelled_before_dispatch'])
  test(`only a trusted undispatched ${content} retirement releases ordered admission`, async () => {
    for (const dispatched of [false, true, undefined]) {
      const controller = new AbortController();
      const batch = createToolDispatchBatch(['old', 'sibling'], controller.signal, (reason) =>
        controller.abort(reason),
      );
      try {
        await batch.forCall('old')!.wait();
        batch.forCall('old')!.settled(
          {
            outcome: 'cancelled',
            content,
            details: { adapterAttempted: false, dispatchCommitted: false },
          },
          undefined,
          dispatched,
        );
        if (dispatched === false) {
          await batch.forCall('sibling')!.wait();
          expect(controller.signal.aborted).toBe(false);
        } else expect(controller.signal.aborted).toBe(true);
      } finally {
        batch.finish();
      }
    }
  });

test('ordinary cancellation, denial, unknown outcome and errors still stop ordered admission', async () => {
  for (const [outcome, content, error] of [
    ['cancelled', 'cancel_requested', undefined],
    ['failed', 'approval_denied', undefined],
    ['outcome_unknown', 'unknown', undefined],
    ['cancelled', 'superseded_by_user_input', new Error('persistence failed')],
  ] as const) {
    const controller = new AbortController();
    const batch = createToolDispatchBatch(['old'], controller.signal, (reason) =>
      controller.abort(reason),
    );
    try {
      await batch.forCall('old')!.wait();
      batch.forCall('old')!.settled({ outcome, content }, error, false);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      batch.finish();
    }
  }
});

test('restored undispatched retirement releases the original sibling admission', async () => {
  const controller = new AbortController();
  const batch = createToolDispatchBatch(['old', 'sibling'], controller.signal, (reason) =>
    controller.abort(reason),
  );
  try {
    batch.settled('old', { outcome: 'cancelled', content: 'superseded_by_user_input' }, false);
    await batch.forCall('sibling')!.wait();
    expect(controller.signal.aborted).toBe(false);
  } finally {
    batch.finish();
  }
});

test('default policy holds an actual planned sibling behind approval and denial records cancellation without effects', async () => {
  const effects: string[] = [];
  const f = await fixture(
    ['external', 'read'].map((name) =>
      definition(`fixture.${name}`, async () => {
        effects.push(name);
        return { outcome: 'succeeded', content: name };
      }),
    ),
    true,
  );
  try {
    const interaction = await eventually(
      async () =>
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.expectedStoreId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions[0],
    );
    await eventually(async () =>
      (await f.store.listExecutions('s')).find(
        (row) => row.callId === 'call-1' && row.status === 'planned',
      ),
    );
    expect(effects).toEqual([]);
    expect(f.model.requests).toHaveLength(1);
    const pendingTool = (await f.store.listExecutions('s')).find((row) => row.callId === 'call-0');
    expect((await f.store.getRun(pendingTool!.runId!))?.configuration).toMatchObject({
      toolDispatchOrder: 'model',
    });
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'deny',
      presentationSessionId: interaction.presentationSessionId,
      interactionId: interaction.id,
      expectedRevision: interaction.revision,
      answer: { kind: 'approval', decision: 'deny' },
    });
    await f.runtime.waitForCommand('work', { timeoutMs: 3000 });
    const tools = (await f.store.listExecutions('s')).filter((row) => row.kind === 'tool');
    expect(tools.find((row) => row.callId === 'call-0')).toMatchObject({
      status: 'failed',
      result: {
        content: 'approval_denied',
        details: { dispatchCommitted: false, adapterAttempted: false },
      },
    });
    expect(tools.find((row) => row.callId === 'call-1')).toMatchObject({
      status: 'cancelled',
      result: { details: { dispatchCommitted: false, adapterAttempted: false } },
    });
    expect(effects).toEqual([]);
    expect(f.model.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('default ordered admission releases the next Tool after dispatch while the first actual adapter remains active', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const effects: string[] = [];
  const f = await fixture(
    [
      definition('fixture.slow', async () => {
        await held;
        effects.push('slow');
        return { outcome: 'succeeded', content: 'slow' };
      }),
      definition('fixture.fast', async () => {
        effects.push('fast');
        return { outcome: 'succeeded', content: 'fast' };
      }),
    ],
    false,
  );
  try {
    await eventually(async () =>
      (await f.store.listExecutions('s')).find(
        (row) => row.callId === 'call-1' && row.status === 'succeeded',
      ),
    );
    expect(effects).toEqual(['fast']);
    expect((await f.store.listExecutions('s')).find((row) => row.callId === 'call-0')?.status).toBe(
      'dispatching',
    );
    expect(f.model.requests).toHaveLength(1);
    release();
    await f.runtime.waitForCommand('work', { timeoutMs: 3000 });
    expect(effects).toEqual(['fast', 'slow']);
    expect(f.model.requests).toHaveLength(2);
  } finally {
    release();
    await f.close();
  }
});
test('steer retires approved-waiting ordered decisions and their sibling without failing the Run', async () => {
  const effects: string[] = [];
  const f = await fixture(
    ['external', 'read'].map((name) =>
      definition(`fixture.${name}`, async () => {
        effects.push(name);
        return { outcome: 'succeeded', content: name };
      }),
    ),
    true,
  );
  try {
    const interaction = await eventually(
      async () =>
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.expectedStoreId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions[0],
    );
    await eventually(async () =>
      (await f.store.listExecutions('s')).find(
        (row) => row.callId === 'call-1' && row.status === 'planned',
      ),
    );
    const run = (await f.store.getView('s')).runs[0]!;
    expect(run.configuration).toMatchObject({ toolDispatchOrder: 'model' });
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'steer',
      sessionId: 's',
      request: {
        kind: 'input.steer',
        targetRunId: run.id,
        contextSelectionId: run.contextSelectionId,
        content: 'Follow up: Stop the old effects and summarize instead',
      },
    });
    await f.runtime.waitForCommand('work', { timeoutMs: 3000 });
    const steer = (await f.store.getCommand('steer'))!;
    expect(steer).toMatchObject({ status: 'applied', receipt: { runId: run.id } });
    const messageId = (steer.receipt as { messageId: string }).messageId;
    expect(messageId).toBeString();
    expect(steer).toMatchObject({
      id: 'steer',
      kind: 'input.steer',
      rootWorkCommandId: 'work',
      status: 'applied',
      request: {
        targetRunId: run.id,
        content: 'Follow up: Stop the old effects and summarize instead',
      },
      receipt: { runId: run.id },
    });
    expect(
      (await f.store.listMessages('s')).find((message) => message.id === messageId),
    ).toMatchObject({
      runId: run.id,
      originCommandId: 'steer',
      inputKind: 'input.steer',
      sourceIds: ['steer'],
      content: 'Follow up: Stop the old effects and summarize instead',
    });
    expect(await f.store.getRun(run.id)).toMatchObject({
      status: 'completed',
      isActive: false,
    });
    const tools = (await f.store.listExecutions('s')).filter((row) => row.kind === 'tool');
    expect(tools).toHaveLength(2);
    for (const old of tools)
      expect(old).toMatchObject({
        status: 'cancelled',
        authorization: { dispatched: false },
        result: { content: 'superseded_by_user_input' },
      });
    expect(effects).toEqual([]);
    expect(f.model.requests).toHaveLength(2);
    expect(
      f.model.requests[1]!.messages.find(
        (message) => message.content === 'Follow up: Stop the old effects and summarize instead',
      )?.sourceIds,
    ).toEqual(['steer']);
    expect(
      (
        await f.runtime.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          interactionId: interaction.id,
        })
      )?.state,
    ).toBe('cancelled');
  } finally {
    await f.close();
  }
});
for (const rejection of ['schema', 'plan'] as const)
  test(`ordinary known ${rejection} rejection retains independent authorization and Model correction`, async () => {
    const effects: string[] = [];
    const original = definition('fixture.first', async () => {
      effects.push('forbidden');
      return { outcome: 'succeeded', content: 'forbidden' };
    });
    const first =
      rejection === 'schema'
        ? {
            ...original,
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          }
        : original;
    const f = await fixture(
      [
        first,
        definition('fixture.read', async () => {
          effects.push('read');
          return { outcome: 'succeeded', content: 'read' };
        }),
      ],
      false,
      rejection === 'plan',
    );
    try {
      await f.runtime.waitForCommand('work', { timeoutMs: 3000 });
      const tools = (await f.store.listExecutions('s')).filter((row) => row.kind === 'tool');
      expect(tools.find((row) => row.callId === 'call-0')).toMatchObject({
        status: 'failed',
        authorization: { dispatched: false },
      });
      expect(tools.find((row) => row.callId === 'call-1')?.status).toBe('succeeded');
      expect(effects).toEqual(['read']);
      expect(f.model.requests).toHaveLength(2);
      expect((await f.store.getRun(tools[0]!.runId!))?.status).toBe('completed');
    } finally {
      await f.close();
    }
  });
