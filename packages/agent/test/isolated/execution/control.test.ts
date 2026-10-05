import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { defineExtension, type Permissions, type ToolDefinition } from '@kite-ai/agent/extensions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';

function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call: ModelEvent[] = [
  { type: 'tool_call', id: 'call-1', name: 'fixture.effect', arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
];

async function setup(tool: ToolDefinition, permissions: Permissions, responses: ModelEvent[][]) {
  const root = mkdtempSync(join(tmpdir(), 'kite-execution-control-'));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'disposable' });
  const model = createFixedModel(responses);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions,
    extensions: [
      defineExtension({ id: 'fixture.effects', version: '1', apiMajor: 1, tools: [tool] }),
    ],
  });
  const { storeId: expectedStoreId } = await store.getMetadata();
  await runtime.createWorkspace({
    id: 'workspace',
    rootUri: `file://${root}`,
    name: 'Disposable',
    expectedStoreId,
  });
  await runtime.createSession({
    commandId: 'create',
    sessionId: 'session',
    workspaceId: 'workspace',
    title: 'Controls',
    subjectId: 'owner',
    expectedStoreId,
  });
  const submit = (commandId: string) =>
    runtime.submitCommand({
      commandId,
      sessionId: 'session',
      subjectId: 'owner',
      expectedStoreId,
      request: { kind: 'run.start', content: commandId },
    });
  const cancel = (
    commandId: string,
    targetCommandId = 'original',
    subjectId = 'owner',
    storeId = expectedStoreId,
  ) =>
    runtime.cancelCommand({
      commandId,
      targetCommandId,
      sessionId: 'session',
      subjectId,
      expectedStoreId: storeId,
    });
  return {
    root,
    store,
    model,
    runtime,
    submit,
    cancel,
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const toolBase = {
  id: 'fixture.effect',
  version: '1',
  description: 'Harmless effect control fixture',
  inputSchema: { type: 'object', additionalProperties: false },
} as const;

test('a tool that performs an effect then throws preserves outcome_unknown and cannot complete its Run', async () => {
  const effects = mkdtempSync(join(tmpdir(), 'kite-external-effects-'));
  const ledger = join(effects, 'ledger');
  const data = await setup(
    {
      ...toolBase,
      async execute() {
        appendFileSync(ledger, 'effect\n');
        throw new Error('Lost result after effect');
      },
    },
    {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    [call, [finish]],
  );
  try {
    await data.submit('original');
    await data.runtime.waitForCommand('original');
    const view = await data.runtime.getView('session');
    const tool = view.executions.find((execution) => execution.kind === 'tool')!;
    expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
    expect(tool.status).toBe('outcome_unknown');
    expect(tool.result).toMatchObject({ outcome: 'outcome_unknown' });
    expect(view.runs[0]!.status).toBe('failed');
    expect(view.runs[0]!.isActive).toBe(false);
    expect(data.model.requests).toHaveLength(1);
    await data.submit('original');
    await data.runtime.waitForCommand('original');
    expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
  } finally {
    await data.close();
    rmSync(effects, { recursive: true, force: true });
  }
}, 10_000);

test('intruder or wrong Store cancellation writes no receipt and cannot abort the original live tool', async () => {
  const entered = barrier();
  const proceed = barrier();
  let signal: AbortSignal | undefined;
  let toolCalls = 0;
  const data = await setup(
    {
      ...toolBase,
      async execute(_input, context) {
        signal = context.signal;
        toolCalls++;
        entered.release();
        await proceed.waiting;
        return { outcome: 'succeeded', content: 'done' };
      },
    },
    {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    [call, [finish]],
  );
  try {
    await data.submit('original');
    await entered.waiting;
    const before = await data.runtime.getView('session');
    const intruder = await data.cancel('intruder-cancel', 'original', 'intruder').then(
      () => null,
      (error: unknown) => error,
    );
    expect(intruder).toMatchObject({ code: 'permission_denied' });
    const wrongStore = await data
      .cancel('wrong-store-cancel', 'original', 'owner', 'wrong-store')
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(wrongStore).toMatchObject({ code: 'store_identity_mismatch' });
    expect(signal!.aborted).toBe(false);
    expect(await data.runtime.getCommand('intruder-cancel')).toBeNull();
    expect(await data.runtime.getCommand('wrong-store-cancel')).toBeNull();
    expect((await data.runtime.getView('session')).snapshotCursor).toBe(before.snapshotCursor);
    proceed.release();
    await data.runtime.waitForCommand('original');
    expect((await data.runtime.getView('session')).runs[0]!.status).toBe('completed');
    expect(toolCalls).toBe(1);
  } finally {
    proceed.release();
    await data.close();
  }
}, 10_000);

test('cancel commits during tool authorization before dispatch, then old cancel retry leaves a new Run alive', async () => {
  const effects = mkdtempSync(join(tmpdir(), 'kite-cancel-effects-'));
  const ledger = join(effects, 'ledger');
  const toolAuthorization = barrier();
  const authorizeTool = barrier();
  const secondModel = barrier();
  const authorizeSecondModel = barrier();
  let modelAuthorizations = 0;
  let secondSignal: AbortSignal | undefined;
  let calls = 0;
  const data = await setup(
    {
      ...toolBase,
      async execute() {
        calls++;
        appendFileSync(ledger, 'effect\n');
        return { outcome: 'succeeded', content: 'unexpected' };
      },
    },
    {
      async authorize(request) {
        if (request.definitionId === 'fixture.effect') {
          toolAuthorization.release();
          await authorizeTool.waiting;
        }
        if (request.definitionId === 'fixed' && ++modelAuthorizations === 2) {
          secondSignal = request.signal;
          secondModel.release();
          await authorizeSecondModel.waiting;
        }
        return { allowed: true, revision: '1' };
      },
    },
    [call, [finish]],
  );
  try {
    await data.submit('original');
    await toolAuthorization.waiting;
    const receipt = await data.cancel('cancel-original');
    expect(receipt.status).toBe('applied');
    authorizeTool.release();
    await data.runtime.waitForCommand('original');
    expect(calls).toBe(0);
    const original = (await data.runtime.getView('session')).runs[0]!;
    expect(original.status).toBe('cancelled');
    await data.submit('later');
    await secondModel.waiting;
    expect(await data.cancel('cancel-original')).toEqual(receipt);
    expect(secondSignal!.aborted).toBe(false);
    authorizeSecondModel.release();
    await data.runtime.waitForCommand('later');
    const view = await data.runtime.getView('session');
    expect(view.runs.find((run) => run.originCommandId === 'later')!.status).toBe('completed');
    expect(view.runs.find((run) => run.originCommandId === 'original')!.status).toBe('cancelled');
    expect(calls).toBe(0);
    expect(existsSync(ledger)).toBe(false);
  } finally {
    authorizeTool.release();
    authorizeSecondModel.release();
    await data.close();
    rmSync(effects, { recursive: true, force: true });
  }
}, 10_000);
