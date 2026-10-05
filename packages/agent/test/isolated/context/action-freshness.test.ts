import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { defineExtension, type Json } from '../../../src/extensions';
import { createProjectSources } from '../../../src/sources';
import { openSqliteStore } from '../../../src/sqlite';

function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
async function within(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fresh Action effect event did not arrive')),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.each([
  'addition',
  'rewrite',
  'deletion',
  'unrelated',
] as const)('Action refreshes actual applicable instructions at the permission barrier: %s', async (change) => {
  const root = mkdtempSync(join(tmpdir(), 'kite-action-sources-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'unrelated'));
  const instruction = join(root, 'src/AGENTS.md');
  const ledger = join(root, 'external-effect.json');
  writeFileSync(join(root, 'AGENTS.md'), 'root rule');
  if (change !== 'addition') writeFileSync(instruction, 'old rule');
  const entered = barrier();
  const proceed = barrier();
  const effect = barrier();
  const nextPreparation = barrier();
  const finishPreparation = barrier();
  let preparations = 0;
  let executions = 0;
  const approvals: { executionId: string; input: Json }[] = [];
  const extension = defineExtension({
    id: 'fixture.sources',
    version: '1',
    apiMajor: 1,
    actions: [
      {
        id: 'fixture.sources.apply',
        version: '1',
        description: 'Instruction-bound effect',
        inputSchema: { type: 'object', additionalProperties: false },
        async prepare() {
          preparations++;
          if (preparations === 2) {
            nextPreparation.release();
            await finishPreparation.waiting;
          }
          return { rule: existsSync(instruction) ? readFileSync(instruction, 'utf8') : 'absent' };
        },
        async execute(prepared) {
          executions++;
          writeFileSync(ledger, JSON.stringify(prepared));
          effect.release();
          return { outcome: 'succeeded', content: 'applied current description' };
        },
      },
    ],
  });
  const store = await openSqliteStore({ dataRoot: join(root, 'profile'), profile: 'disposable' });
  const model = createFixedModel([]);
  const runtime = createRuntime({
    store,
    model,
    extensions: [extension],
    sources: createProjectSources({
      async workspaceRoot() {
        return root;
      },
      targetPaths: () => ['src/new.ts'],
    }),
    permissions: {
      async authorize(request) {
        approvals.push({ executionId: request.executionId, input: structuredClone(request.input) });
        if (approvals.length === 1) {
          entered.release();
          await proceed.waiting;
        }
        return { allowed: true, revision: String(approvals.length) };
      },
    },
  });
  try {
    const metadata = await store.getMetadata();
    await runtime.createWorkspace({
      expectedStoreId: metadata.storeId,
      id: 'workspace',
      rootUri: `file://${root}`,
      name: 'Disposable',
    });
    await runtime.createSession({
      expectedStoreId: metadata.storeId,
      commandId: 'create',
      sessionId: 'session',
      workspaceId: 'workspace',
      title: 'Action',
      subjectId: 'owner',
    });
    await runtime.submitCommand({
      expectedStoreId: metadata.storeId,
      commandId: 'apply',
      sessionId: 'session',
      subjectId: 'owner',
      request: {
        kind: 'extension.invoke',
        extensionId: extension.id,
        actionId: extension.actions[0]!.id,
        definitionVersion: '1',
        input: {},
      },
    });
    await entered.waiting;
    expect(executions).toBe(0);
    expect(existsSync(ledger)).toBe(false);
    if (change === 'addition' || change === 'rewrite') writeFileSync(instruction, 'new rule');
    else if (change === 'deletion') rmSync(instruction);
    else writeFileSync(join(root, 'unrelated/AGENTS.md'), 'unrelated change');
    proceed.release();
    const relevant = change !== 'unrelated';
    if (relevant) {
      await within(nextPreparation.waiting);
      const pending = await runtime.getCommand('apply');
      expect(pending!.receipt).toMatchObject({ preparingNextAttempt: true });
      const premature = await runtime.waitForCommand('apply', { timeoutMs: 60 }).then(
        () => null,
        (error) => error,
      );
      expect(premature).toMatchObject({ code: 'wait_timeout' });
      expect(executions).toBe(0);
      finishPreparation.release();
    }
    const completed = await runtime.waitForCommand('apply', { timeoutMs: 3000 });
    await within(effect.waiting);
    expect(model.requests).toHaveLength(0);
    expect(executions).toBe(1);
    expect(preparations).toBe(relevant ? 2 : 1);
    const authorizedAttempts = [
      ...new Map(approvals.map((approval) => [approval.executionId, approval])).values(),
    ];
    expect(authorizedAttempts).toHaveLength(relevant ? 2 : 1);
    const expectedRule = change === 'deletion' ? 'absent' : relevant ? 'new rule' : 'old rule';
    expect(JSON.parse(readFileSync(ledger, 'utf8'))).toEqual({ rule: expectedRule });
    expect(approvals.at(-1)!.input).toEqual({ rule: expectedRule });
    const view = await store.getView('session');
    expect(view.runs).toHaveLength(0);
    expect(view.executions).toHaveLength(relevant ? 2 : 1);
    expect(view.executions.filter((execution) => execution.status === 'succeeded')).toHaveLength(1);
    if (relevant) {
      expect(authorizedAttempts[0]!.executionId).not.toBe(authorizedAttempts[1]!.executionId);
      const old = view.executions.find(
        (execution) => execution.id === authorizedAttempts[0]!.executionId,
      )!;
      const fresh = view.executions.find(
        (execution) => execution.id === authorizedAttempts[1]!.executionId,
      )!;
      expect(old).toMatchObject({
        status: 'failed',
        attempt: 1,
        result: {
          details: { code: 'context_refresh_required', adapterAttempted: false },
        },
      });
      expect(fresh).toMatchObject({ status: 'succeeded', attempt: 2 });
      expect(completed.receipt).toMatchObject({
        executionId: fresh.id,
        preparingNextAttempt: false,
      });
    }
  } finally {
    proceed.release();
    finishPreparation.release();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test('unavailable required filesystem source blocks only its Action; Query, cancel and unrelated scope remain usable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-action-source-unavailable-'));
  mkdirSync(join(root, 'blocked'));
  mkdirSync(join(root, 'blocked/AGENTS.md'));
  mkdirSync(join(root, 'unrelated'));
  let executions = 0;
  const extension = defineExtension({
    id: 'fixture.unavailable',
    version: '1',
    apiMajor: 1,
    actions: [
      {
        id: 'apply',
        version: '1',
        description: 'Scoped effect',
        inputSchema: { type: 'object' },
        async prepare() {
          return {};
        },
        async execute() {
          executions++;
          return { outcome: 'succeeded', content: 'done' };
        },
      },
    ],
    queries: [
      {
        id: 'read',
        version: '1',
        description: 'Independent history query',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'array' },
        async execute() {
          return [];
        },
      },
    ],
  });
  const store = await openSqliteStore({ dataRoot: join(root, 'profile'), profile: 'disposable' });
  const model = createFixedModel([]);
  const runtime = createRuntime({
    store,
    model,
    extensions: [extension],
    sources: createProjectSources({
      async workspaceRoot(workspaceId) {
        return join(root, workspaceId);
      },
    }),
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    const metadata = await store.getMetadata();
    for (const id of ['blocked', 'unrelated']) {
      await runtime.createWorkspace({
        expectedStoreId: metadata.storeId,
        id,
        rootUri: `file://${join(root, id)}`,
        name: id,
      });
      await runtime.createSession({
        expectedStoreId: metadata.storeId,
        commandId: `create-${id}`,
        sessionId: id,
        workspaceId: id,
        title: id,
        subjectId: 'owner',
      });
    }
    const command = {
      expectedStoreId: metadata.storeId,
      subjectId: 'owner',
      request: {
        kind: 'extension.invoke' as const,
        extensionId: extension.id,
        actionId: 'apply',
        definitionVersion: '1',
        input: {},
      },
    };
    await runtime.submitCommand({ ...command, commandId: 'blocked-action', sessionId: 'blocked' });
    expect((await runtime.waitForCommand('blocked-action')).status).toBe('rejected');
    expect(executions).toBe(0);
    const view = await store.getView('blocked');
    expect(view.executions).toHaveLength(0);
    const before = (await store.getMetadata()).lastChangeCursor;
    expect(
      await runtime.queryExtension({
        sessionId: 'blocked',
        extensionId: extension.id,
        queryId: 'read',
        input: {},
      }),
    ).toEqual([]);
    expect((await store.getMetadata()).lastChangeCursor).toBe(before);
    expect(
      (
        await runtime.cancelCommand({
          expectedStoreId: metadata.storeId,
          commandId: 'cancel-blocked',
          targetCommandId: 'blocked-action',
          sessionId: 'blocked',
          subjectId: 'owner',
        })
      ).status,
    ).toBe('applied');
    await runtime.submitCommand({
      ...command,
      commandId: 'unrelated-action',
      sessionId: 'unrelated',
    });
    await runtime.waitForCommand('unrelated-action');
    expect(executions).toBe(1);
    expect((await store.getView('unrelated')).executions[0]!.status).toBe('succeeded');
    expect(model.requests).toHaveLength(0);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
