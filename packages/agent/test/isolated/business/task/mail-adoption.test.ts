import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import type { Extension, OperationRef } from '../../../../src/extensions';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
];
const success = (value: unknown) => ({
  outcome: 'succeeded' as const,
  content: JSON.stringify(value),
});
const schema = { type: 'object', additionalProperties: false, properties: {} };

test('explicit follow-up seals the idle mail set: complete private body once, old same-key retry cannot adopt later or later-confirmed mail', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-agent-mail-adoption-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const artifacts = createArtifactStore({ profile, store });
  let old!: OperationRef, next!: OperationRef;
  let accepted = '',
    lateConfirmed = '',
    later = '',
    parentCalls = 0;
  const body = `complete idle private body ${'真实邮件🙂'.repeat(1100)}`;
  let childReady!: () => void, releaseChild!: () => void;
  const childStarted = new Promise<void>((resolve) => {
    childReady = resolve;
  });
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const confirmedIds: string[] = [];
  const requests: ModelRequest[] = [];
  const child: ModelAdapter = {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 2) {
        childReady();
        await childGate;
      }
      yield finish;
    },
  };
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.create',
        version: '1',
        description: 'create actual child',
        inputSchema: schema,
        async execute(_input, ctx) {
          old = await ctx.operations.ensure({
            key: 'original',
            request: {
              kind: 'agent',
              configurationId: 'child',
              input: { content: 'original work' },
            },
            cancellation: 'detached',
          });
          await ctx.operations.wait(old, { timeoutMs: 4000 });
          return success(old);
        },
      },
      {
        id: 'fixture.queue',
        version: '1',
        description: 'queue while child idle',
        inputSchema: schema,
        async execute(_input, ctx) {
          const target = await ctx.operations.readAgentMessageTarget!(old);
          expect(target.targetRunId).toBeNull();
          for (let index = 0; index < 51; index++) {
            const receipt = await ctx.operations.sendAgentMessage!(old, {
              key: `confirmed-before-followup-${index}`,
              content: index === 0 ? body : `complete small mail ${index}`,
              contextSelectionId: target.contextSelectionId,
            });
            confirmedIds.push(receipt.commandId);
          }
          accepted = confirmedIds[0]!;
          return success(confirmedIds);
        },
      },
      {
        id: 'fixture.followup',
        version: '1',
        description: 'explicit real new work',
        inputSchema: schema,
        async execute(_input, ctx) {
          const target = await ctx.operations.readAgent(old);
          const before = await ctx.operations.sendAgentMessage!(old, {
            key: 'lower-but-not-yet-confirmed',
            content: 'late confirmation stays queued',
            contextSelectionId: target.contextSelectionId,
          });
          lateConfirmed = before.commandId;
          const input = {
            mode: 'follow_up' as const,
            key: 'next',
            afterRunId: target.run!.id,
            contextSelectionId: target.contextSelectionId,
            content: 'explicit new work',
          };
          for (const [ref, request] of [
            [{ ...old, originStoreId: 'foreign' }, input],
            [{ ...old, executionId: 'foreign-carrier' }, input],
            [old, { ...input, contextSelectionId: 'obsolete-selection' }],
          ] as const) {
            let failure = '';
            try {
              await ctx.operations.sendAgentInput(ref, request);
            } catch (error) {
              failure = (error as { code: string }).code;
            }
            expect(failure).not.toBe('');
            expect(requests).toHaveLength(1);
            expect((await store.getView(old.childSessionId!)).runs).toHaveLength(1);
          }
          const first = await ctx.operations.sendAgentInput(old, input);
          next = (first.receipt as unknown as { ref: OperationRef }).ref;
          await childStarted;
          const after = await ctx.operations.sendAgentMessage!(old, {
            key: 'after-sealed-cutoff',
            content: 'later mail stays queued',
            contextSelectionId: target.contextSelectionId,
          });
          later = after.commandId;
          const cursor = (await store.getMetadata()).lastChangeCursor;
          expect(await ctx.operations.sendAgentInput(old, input)).toEqual(first);
          expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
          return success(next);
        },
      },
    ],
  };
  const parent: ModelAdapter = {
    async *stream() {
      parentCalls++;
      for (const event of parentCalls === 1
        ? call('fixture.create')
        : parentCalls === 2
          ? call('fixture.queue')
          : parentCalls === 4
            ? call('fixture.followup')
            : [finish])
        yield event;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 2,
    extensions: [extension],
    childConfigurations: [
      { id: 'child', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'temp',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'mail adoption',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'explicit continuation' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 7000 });
    expect(requests).toHaveLength(1);
    const beforeSelection = (await store.getSession('root'))!.contextSelectionId;
    const rewound = await runtime.selectContext({
      expectedStoreId: storeId,
      commandId: 'rewind-root-only',
      sessionId: 'root',
      subjectId: 'owner',
      expectedContextSelectionId: beforeSelection,
      boundary: null,
    });
    expect(rewound.selection.id).not.toBe(beforeSelection);
    expect(
      (await store.getAgentMessage({
        expectedStoreId: storeId,
        sessionId: old.childSessionId!,
        subjectId: 'owner',
        messageId: accepted,
      }))!.receivedRunId,
    ).toBeNull();
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'explicit-followup',
      request: { kind: 'run.start', content: 'explicit new child work after root-only rewind' },
    });
    await runtime.waitForCommand('explicit-followup', { timeoutMs: 7000 });
    expect(next).toBeDefined();
    releaseChild();
    await runtime.waitForCommand(next.commandId, { timeoutMs: 7000 });
    const childView = await store.getView(old.childSessionId!);
    expect(childView.runs).toHaveLength(2);
    expect(requests).toHaveLength(2);
    const mail = await store.getAgentMessage({
      expectedStoreId: storeId,
      sessionId: old.childSessionId!,
      subjectId: 'owner',
      messageId: accepted,
    });
    expect(mail!.targetRunId).toBeNull();
    expect(mail!.receivedRunId).toBe(
      childView.runs.find((run) => run.originCommandId === `child-start-${next.executionId}`)!.id,
    );
    expect(mail!.receivedContextSelectionId).toBe(mail!.contextSelectionId);
    expect(mail!.state).toBe('received');
    const actual = requests[1]!.messages.filter((message) => message.sourceIds?.includes(accepted));
    expect(actual).toHaveLength(1);
    for (const id of confirmedIds)
      expect(
        requests[1]!.messages.filter((message) => message.sourceIds?.includes(id)),
      ).toHaveLength(1);
    expect(actual[0]!.role).toBe('user');
    expect(actual[0]!.content).toContain(body);
    expect(requests[0]!.messages.some((message) => message.sourceIds?.includes(accepted))).toBe(
      false,
    );
    for (const id of [lateConfirmed, later]) {
      const excluded = await store.getAgentMessage({
        expectedStoreId: storeId,
        sessionId: old.childSessionId!,
        subjectId: 'owner',
        messageId: id,
      });
      expect(excluded!.state).toBe('accepted');
      expect(excluded!.targetRunId).toBeNull();
      expect(excluded!.receivedRunId).toBeNull();
      expect(requests[1]!.messages.some((message) => message.sourceIds?.includes(id))).toBe(false);
    }
    const frozen = (await store.getMetadata()).lastChangeCursor;
    let intruder = '';
    try {
      await store.getAgentMessage({
        expectedStoreId: storeId,
        sessionId: 'root',
        subjectId: 'intruder',
        messageId: accepted,
      });
    } catch (error) {
      intruder = (error as { code: string }).code;
    }
    expect(intruder).toBe('permission_denied');
    let wrongStore = '';
    try {
      await store.listAgentMessages({
        expectedStoreId: 'foreign',
        sessionId: old.childSessionId!,
        subjectId: 'owner',
      });
    } catch (error) {
      wrongStore = (error as { code: string }).code;
    }
    expect(wrongStore).toBe('store_identity_mismatch');
    expect((await store.getMetadata()).lastChangeCursor).toBe(frozen);
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'later-human',
      request: { kind: 'run.start', content: 'ordinary later human work' },
    });
    await runtime.waitForCommand('later-human', { timeoutMs: 4000 });
    expect(requests).toHaveLength(2);
    await runtime.close();
    const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      const cursor = (await readonly.getMetadata()).lastChangeCursor;
      const page = await readonly.listAgentMessages({
        expectedStoreId: storeId,
        sessionId: old.childSessionId!,
        subjectId: 'owner',
      });
      expect(page.items).toHaveLength(53);
      expect(page.items.filter((mail) => mail.receivedRunId !== null)).toHaveLength(51);
      expect((await readonly.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(requests).toHaveLength(2);
    } finally {
      await readonly.close();
    }
  } finally {
    releaseChild();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 12000);

test('root stop at the new carrier permission barrier preserves idle mail but admits zero new child Model', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-agent-mail-stop-'))),
    profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId,
    artifacts = createArtifactStore({ profile, store });
  let old!: OperationRef,
    next!: OperationRef,
    mailId = '',
    models = 0,
    rootModels = 0,
    blocked!: () => void,
    release!: () => void;
  const stopped = new Promise<void>((resolve) => {
      blocked = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const child: ModelAdapter = {
    async *stream() {
      models++;
      yield finish;
    },
  };
  const fixture: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.original',
        version: '1',
        description: 'actual idle mail',
        inputSchema: schema,
        async execute(_input, ctx) {
          old = await ctx.operations.ensure({
            key: 'old',
            request: { kind: 'agent', configurationId: 'child', input: { content: 'old' } },
            cancellation: 'detached',
          });
          await ctx.operations.wait(old, { timeoutMs: 4000 });
          const target = await ctx.operations.readAgentMessageTarget!(old);
          mailId = (
            await ctx.operations.sendAgentMessage!(old, {
              key: 'idle',
              content: 'retain this private accepted body',
              contextSelectionId: target.contextSelectionId,
            })
          ).commandId;
          return success(old);
        },
      },
      {
        id: 'fixture.next',
        version: '1',
        description: 'explicit new work',
        inputSchema: schema,
        async execute(_input, ctx) {
          const target = await ctx.operations.readAgent(old);
          const receipt = await ctx.operations.sendAgentInput(old, {
            mode: 'follow_up',
            key: 'new',
            afterRunId: target.run!.id,
            contextSelectionId: target.contextSelectionId,
            content: 'new work',
          });
          next = (receipt.receipt as unknown as { ref: OperationRef }).ref;
          return success(next);
        },
      },
    ],
  };
  const parent: ModelAdapter = {
    async *stream() {
      rootModels++;
      for (const event of rootModels === 1
        ? call('fixture.original')
        : rootModels === 3
          ? call('fixture.next')
          : [finish])
        yield event;
    },
  };
  let jobChecks = 0;
  const runtime = createRuntime({
    store,
    artifacts,
    model: parent,
    modelId: 'root',
    modelConcurrency: 2,
    extensions: [fixture],
    childConfigurations: [
      { id: 'child', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
    permissions: {
      async authorize(request) {
        if (request.kind === 'job' && request.definitionId === 'agent/child' && ++jobChecks > 2) {
          blocked();
          await gate;
        }
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'temp',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'cancel adoption',
    });
    for (const commandId of ['first', 'second']) {
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 'root',
        subjectId: 'owner',
        commandId,
        request: { kind: 'run.start', content: commandId },
      });
      if (commandId === 'first') await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    }
    await stopped;
    expect(models).toBe(1);
    await runtime.cancelSession({
      expectedStoreId: storeId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'stop',
      includeBackground: true,
    });
    release();
    await runtime.waitForCommand('second', { timeoutMs: 5000 });
    if (next) await runtime.waitForCommand(next.commandId, { timeoutMs: 5000 });
    expect(models).toBe(1);
    expect((await store.getView(old.childSessionId!)).runs).toHaveLength(1);
    const mail = await store.getAgentMessage({
      expectedStoreId: storeId,
      sessionId: old.childSessionId!,
      subjectId: 'owner',
      messageId: mailId,
    });
    expect(mail!.state).toBe('accepted');
    expect(mail!.targetRunId).toBeNull();
    expect(mail!.receivedRunId).toBeNull();
  } finally {
    release();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 12000);
