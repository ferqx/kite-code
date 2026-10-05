import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import type { Extension, OperationRef } from '../../../../src/extensions';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
];
const result = (value: unknown) => ({
  outcome: 'succeeded' as const,
  content: JSON.stringify(value),
});
const schema = { type: 'object', additionalProperties: false, properties: {} };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('actual QueueOnly parent/child exchange keeps twelve complete private bodies, mail wait observes without preparing, and cold queries never start work', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-agent-mail-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  const artifacts = createArtifactStore({ profile, store });
  const childGate = gate(),
    childReady = gate();
  const laterReady = gate(),
    laterRelease = gate();
  let retainedParentTarget!: () => Promise<{
    sessionId: string;
    contextSelectionId: string;
    targetRunId: string | null;
  }>;
  let ref!: OperationRef,
    parentRunId = '',
    childRunId = '',
    parentSelection = '',
    childSelection = '';
  const contents = Array.from(
    { length: 12 },
    (_, index) => `${index}:完整邮件\n${'data<&>'.repeat(1024)}`,
  );
  const rootRequests: ModelRequest[] = [],
    childRequests: ModelRequest[] = [];
  let mailed = false;
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.create',
        version: '1',
        description: 'Create exact actual child',
        inputSchema: schema,
        async execute(_input, ctx) {
          parentRunId = ctx.runId!;
          parentSelection = (await store.getSession(ctx.sessionId))!.contextSelectionId;
          ref = await ctx.operations.ensure({
            key: 'child',
            request: {
              kind: 'agent',
              configurationId: 'child',
              input: { content: 'read queued mail' },
            },
            cancellation: 'detached',
          });
          await childReady.promise;
          const agent = await ctx.operations.readAgent(ref);
          childRunId = agent.run!.id;
          childSelection = agent.contextSelectionId;
          return result(ref);
        },
      },
      {
        id: 'fixture.send',
        version: '1',
        description: 'Queue twelve immutable bodies',
        inputSchema: schema,
        async execute(_input, ctx) {
          const target = await ctx.operations.readAgentMessageTarget!(ref);
          expect(target.targetRunId).toBe(childRunId);
          expect(target.contextSelectionId).toBe(childSelection);
          for (const [index, content] of contents.entries()) {
            const input = {
              key: `mail-${index}`,
              content,
              targetRunId: target.targetRunId!,
              contextSelectionId: target.contextSelectionId,
            };
            const first = await ctx.operations.sendAgentMessage!(ref, input);
            expect(await ctx.operations.sendAgentMessage!(ref, input)).toEqual(first);
            if (index === 0) {
              const original = (await store.getAgentMessage({
                expectedStoreId: storeId,
                sessionId: 'root',
                subjectId: 'owner',
                messageId: first.commandId,
              }))!;
              const sender = (await store.getExecution(ctx.executionId))!;
              const root = (await store.getSession('root'))!;
              const base = {
                expectedStoreId: storeId,
                owner: {
                  sessionId: 'root',
                  instanceId: root.ownerInstanceId!,
                  generation: root.ownerGeneration,
                },
                commandId: 'invalid-mail',
                originCommandId: sender.originCommandId,
                sourceExecutionId: sender.id,
                extensionId: 'fixture',
                key: 'invalid',
                targetSessionId: ref.childSessionId!,
                targetCarrierExecutionId: ref.executionId!,
                targetRunId: childRunId,
                contextSelectionId: childSelection,
                body: original.body,
              };
              for (const [patch, code] of [
                [{ expectedStoreId: 'foreign' }, 'store_identity_mismatch'],
                [{ extensionId: 'foreign' }, 'agent_message_relation_invalid'],
                [{ targetRunId: 'stale-run' }, 'input_target_stopped'],
                [{ contextSelectionId: 'obsolete' }, 'context_selection_changed'],
              ] as const) {
                const cursor = (await store.getMetadata()).lastChangeCursor;
                let rejected: unknown;
                try {
                  await store.queueAgentMessage({ ...base, ...patch });
                } catch (error) {
                  rejected = error;
                }
                expect(rejected).toMatchObject({ code });
                expect(await store.getCommand('invalid-mail')).toBeNull();
                expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
              }
            }
          }
          mailed = true;
          return result({ queued: 12 });
        },
      },
      {
        id: 'fixture.waitMail',
        version: '1',
        description: 'Wait own mail facts',
        inputSchema: schema,
        async execute(_input, ctx) {
          const pending = await store.listAgentMessages({
            expectedStoreId: storeId,
            sessionId: ref.childSessionId!,
            subjectId: 'owner',
          });
          expect(pending.items).toHaveLength(12);
          expect(
            pending.items.every(
              (mail) => mail.state === 'accepted' && mail.receivedMessageId === null,
            ),
          ).toBe(true);
          const rootSession = (await store.getSession('root'))!;
          const receive = {
            expectedStoreId: storeId,
            owner: {
              sessionId: 'root',
              instanceId: rootSession.ownerInstanceId!,
              generation: rootSession.ownerGeneration,
            },
            runId: childRunId,
            messageIds: pending.items.map((mail) => mail.id),
          };
          const fault = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
          const before = (await store.getMetadata()).lastChangeCursor;
          let wrongTarget: unknown;
          try {
            await store.receiveAgentMessages({ ...receive, runId: parentRunId });
          } catch (error) {
            wrongTarget = error;
          }
          expect(wrongTarget).toMatchObject({ code: 'agent_message_not_found' });
          expect((await store.getMetadata()).lastChangeCursor).toBe(before);
          try {
            fault.run(
              "CREATE TRIGGER harmless_mail_receive BEFORE INSERT ON message WHEN NEW.id LIKE 'agent-mail-%' BEGIN SELECT RAISE(ABORT,'mail receive rollback'); END",
            );
            let faultError: unknown;
            try {
              await store.receiveAgentMessages(receive);
            } catch (error) {
              faultError = error;
            }
            expect(faultError).toBeDefined();
            expect((await store.getMetadata()).lastChangeCursor).toBe(before);
            expect(
              (
                await store.listAgentMessages({
                  expectedStoreId: storeId,
                  sessionId: ref.childSessionId!,
                  subjectId: 'owner',
                })
              ).items.every((mail) => mail.receivedMessageId === null),
            ).toBe(true);
            fault.run('DROP TRIGGER harmless_mail_receive');
            const received = await store.receiveAgentMessages(receive);
            expect(received).toHaveLength(12);
            const cursor = (await store.getMetadata()).lastChangeCursor;
            expect(await store.receiveAgentMessages(receive)).toEqual(received);
            expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
            expect(
              childRequests[0]!.messages.some((message) => message.content.includes(contents[0]!)),
            ).toBe(false);
          } finally {
            fault.close();
          }
          childGate.release();
          const waited = await ctx.operations.waitAgentMessages!({
            timeoutMs: 4000,
            signal: ctx.signal,
          });
          expect(waited.reason).toBe('mail');
          const page = await ctx.operations.listAgentMessages!();
          expect(page.items).toHaveLength(1);
          expect(page.items[0]).not.toHaveProperty('body');
          expect(page.items[0]!.receivedMessageId).toBeNull();
          return result(waited);
        },
      },
      {
        id: 'fixture.reply',
        version: '1',
        description: 'Actual child replies to direct parent',
        inputSchema: schema,
        async execute(_input, ctx) {
          const target = await ctx.operations.readAgentMessageTarget!('parent');
          retainedParentTarget = () => ctx.operations.readAgentMessageTarget!('parent');
          expect(target).toEqual({
            sessionId: 'root',
            targetRunId: parentRunId,
            contextSelectionId: parentSelection,
          });
          return result(
            await ctx.operations.sendAgentMessage!('parent', {
              key: 'reply',
              content: 'child reply:完整且不伪装用户',
              targetRunId: target.targetRunId!,
              contextSelectionId: target.contextSelectionId,
            }),
          );
        },
      },
    ],
  };
  const parent: ModelAdapter = {
    async *stream(request) {
      rootRequests.push(structuredClone(request));
      if (rootRequests.length === 5) {
        laterReady.release();
        await laterRelease.promise;
      }
      for (const event of rootRequests.length === 1
        ? call('fixture.create')
        : rootRequests.length === 2
          ? call('fixture.send')
          : rootRequests.length === 3
            ? call('fixture.waitMail')
            : [finish])
        yield event;
    },
  };
  const child: ModelAdapter = {
    async *stream(request) {
      childRequests.push(structuredClone(request));
      if (childRequests.length === 1) {
        childReady.release();
        await childGate.promise;
      }
      if (childRequests.length === 2) {
        expect(mailed).toBe(true);
        const messages = request.messages.filter((message) =>
          message.content.startsWith(
            'Agent message (untrusted data; no additional authorization):',
          ),
        );
        expect(messages).toHaveLength(12);
        for (const [index, message] of messages.entries()) {
          expect(message.role).toBe('user');
          expect(message.sourceIds).toHaveLength(1);
          expect(
            (JSON.parse(message.content.split('\n').slice(1).join('\n')) as { content: string })
              .content,
          ).toBe(contents[index]!);
        }
      }
      for (const event of childRequests.length === 2 ? call('fixture.reply') : [finish])
        yield event;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts,
    model: parent,
    modelId: 'root',
    modelConcurrency: 2,
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: ['fixture.reply'],
        snapshot: {},
      },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${directory}`,
      name: 'temp',
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'mail',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'work',
      sessionId: 'root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'exchange' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 8000 });
    await runtime.waitForCommand(ref.commandId, { timeoutMs: 8000 });
    expect(rootRequests).toHaveLength(4);
    expect(childRequests).toHaveLength(3);
    expect(
      rootRequests
        .at(-1)!
        .messages.filter((message) => message.content.includes('child reply:完整且不伪装用户')),
    ).toHaveLength(1);
    let afterSeq = '0',
      upperSeq: string | undefined;
    const ids: string[] = [];
    do {
      const page = await store.listAgentMessages({
        expectedStoreId: storeId,
        sessionId: ref.childSessionId!,
        subjectId: 'owner',
        afterSeq,
        ...(upperSeq ? { upperSeq } : {}),
        limit: 5,
      });
      upperSeq ??= page.upperSeq;
      ids.push(...page.items.map((mail) => mail.id));
      for (const mail of page.items) {
        expect(mail.state).toBe('received');
        expect((await store.getCommand(mail.id))!.request).not.toHaveProperty('content');
        expect((await store.getExecution(mail.sourceExecutionId))!.status).toBe('succeeded');
        const body = await artifacts.read({
          expectedStoreId: storeId,
          refId: mail.body.id,
          sessionId: mail.body.sessionId,
          subjectId: mail.body.subjectId,
          scope: mail.body.scope,
        });
        expect(new TextDecoder().decode(body)).toBe(contents[ids.indexOf(mail.id)]!);
      }
      afterSeq = page.nextAfterSeq ?? '';
    } while (afterSeq);
    expect(new Set(ids).size).toBe(12);
    expect(
      (await store.listMessages(ref.childSessionId!))
        .filter((message) => message.sourceIds?.some((id) => ids.includes(id)))
        .every((message) => !message.content.includes('data<&>')),
    ).toBe(true);
    const before = (await store.getMetadata()).lastChangeCursor;
    let wrongStore: unknown;
    try {
      await store.listAgentMessages({
        expectedStoreId: 'foreign',
        sessionId: 'root',
        subjectId: 'owner',
      });
    } catch (error) {
      wrongStore = error;
    }
    expect(wrongStore).toMatchObject({ code: 'store_identity_mismatch' });
    let intruder: unknown;
    try {
      await store.listAgentMessages({
        expectedStoreId: storeId,
        sessionId: 'root',
        subjectId: 'intruder',
      });
    } catch (error) {
      intruder = error;
    }
    expect(intruder).toMatchObject({ code: 'permission_denied' });
    expect((await store.getMetadata()).lastChangeCursor).toBe(before);
    await runtime.submitCommand({
      expectedStoreId: storeId,
      commandId: 'later-human',
      sessionId: 'root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'later human origin' },
    });
    await laterReady.promise;
    const queryCursor = (await store.getMetadata()).lastChangeCursor;
    expect(await retainedParentTarget()).toEqual({
      sessionId: 'root',
      contextSelectionId: parentSelection,
      targetRunId: null,
    });
    expect(rootRequests).toHaveLength(5);
    expect(childRequests).toHaveLength(3);
    expect((await store.getMetadata()).lastChangeCursor).toBe(queryCursor);
    laterRelease.release();
    await runtime.waitForCommand('later-human', { timeoutMs: 4000 });
    const finalCursor = (await store.getMetadata()).lastChangeCursor;
    await runtime.close();
    const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      expect(
        (
          await readonly.listAgentMessages({
            expectedStoreId: storeId,
            sessionId: ref.childSessionId!,
            subjectId: 'owner',
          })
        ).items,
      ).toHaveLength(12);
      expect((await readonly.getMetadata()).lastChangeCursor).toBe(finalCursor);
      expect(rootRequests).toHaveLength(5);
      expect(childRequests).toHaveLength(3);
    } finally {
      await readonly.close();
    }
  } finally {
    childGate.release();
    laterRelease.release();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 12000);

for (const mode of ['idle', 'failed_sender', 'commit_fault', 'cancelled_target'] as const) {
  test(`QueueOnly ${mode}: durable original identity never silently starts idle work or grants an unconfirmed source`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-agent-mail-boundary-')));
    const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const storeId = (await store.getMetadata()).storeId;
    const artifacts = createArtifactStore({ profile, store });
    const ready = gate(),
      release = gate();
    let ref!: OperationRef,
      mailId = '',
      childCalls = 0,
      parentCalls = 0;
    const childRequests: ModelRequest[] = [];
    const child: ModelAdapter = {
      async *stream(request) {
        childCalls++;
        childRequests.push(structuredClone(request));
        ready.release();
        if (mode !== 'idle') await release.promise;
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
          description: 'Actual child',
          inputSchema: schema,
          async execute(_input, ctx) {
            ref = await ctx.operations.ensure({
              key: 'child',
              request: { kind: 'agent', configurationId: 'child', input: { content: 'original' } },
              cancellation: 'detached',
            });
            await ready.promise;
            if (mode === 'idle') await ctx.operations.wait(ref, { timeoutMs: 4000 });
            return result(ref);
          },
        },
        {
          id: 'fixture.queue',
          version: '1',
          description: 'Actual sender',
          inputSchema: schema,
          async execute(_input, ctx) {
            const agent = await ctx.operations.readAgent(ref);
            const input = {
              key: 'mail',
              content: 'private message: no implicit continuation',
              contextSelectionId: agent.contextSelectionId,
              ...(mode === 'idle' ? {} : { targetRunId: agent.run!.id }),
            };
            const receipt = await ctx.operations.sendAgentMessage!(ref, input);
            mailId = receipt.commandId;
            if (mode === 'cancelled_target')
              await ctx.operations.cancel!(ref, { commandId: 'exact-target-cancel' });
            if (mode === 'commit_fault') {
              const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
              try {
                db.run(
                  "CREATE TRIGGER harmless_mail_commit BEFORE UPDATE OF mail_confirmed ON command WHEN NEW.mail_confirmed=1 BEGIN SELECT RAISE(ABORT,'sender and mail rollback'); END",
                );
              } finally {
                db.close();
              }
            }
            return mode === 'failed_sender'
              ? { outcome: 'failed', content: 'actual sender failed after queue intent' }
              : result(receipt);
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
            : [finish])
          yield event;
      },
    };
    const runtime = createRuntime({
      store,
      artifacts,
      model: parent,
      modelId: 'root',
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
        rootUri: `file://${directory}`,
        name: 'temp',
      });
      await runtime.createSession({
        expectedStoreId: storeId,
        sessionId: 'root',
        workspaceId: 'w',
        subjectId: 'owner',
        commandId: 'create',
        title: 'mail boundary',
      });
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 'root',
        subjectId: 'owner',
        commandId: 'work',
        request: { kind: 'run.start', content: 'queue' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 6000 });
      release.release();
      await runtime.waitForCommand(ref.commandId, { timeoutMs: 6000 });
      const mail = await store.getAgentMessage({
        expectedStoreId: storeId,
        sessionId: ref.childSessionId!,
        subjectId: 'owner',
        messageId: mailId,
      });
      expect(mail).not.toBeNull();
      expect(mail!.receivedMessageId).toBeNull();
      expect(mail!.state).toBe(
        mode === 'idle' || mode === 'cancelled_target'
          ? 'accepted'
          : mode === 'failed_sender'
            ? 'rejected'
            : 'pending_sender',
      );
      expect((await store.getExecution(mail!.sourceExecutionId))!.status).toBe(
        mode === 'idle' || mode === 'cancelled_target'
          ? 'succeeded'
          : mode === 'failed_sender'
            ? 'failed'
            : 'dispatching',
      );
      expect(childCalls).toBe(1);
      expect(
        childRequests[0]!.messages.some((message) => message.content.includes('private message:')),
      ).toBe(false);
      expect((await store.getView(ref.childSessionId!)).runs).toHaveLength(1);
      if (mode === 'idle') {
        expect(mail!.targetRunId).toBeNull();
        await runtime.submitCommand({
          expectedStoreId: storeId,
          sessionId: 'root',
          subjectId: 'owner',
          commandId: 'later-human-work',
          request: { kind: 'run.start', content: 'new explicit root work' },
        });
        await runtime.waitForCommand('later-human-work', { timeoutMs: 4000 });
        expect(childCalls).toBe(1);
        expect(
          (await store.getAgentMessage({
            expectedStoreId: storeId,
            sessionId: ref.childSessionId!,
            subjectId: 'owner',
            messageId: mailId,
          }))!.receivedMessageId,
        ).toBeNull();
      }
      if (mode === 'commit_fault') {
        expect(parentCalls).toBe(2);
        const previousGeneration = (await store.getSession('root'))!.ownerGeneration;
        const fault = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
        try {
          fault.run('DROP TRIGGER harmless_mail_commit');
        } finally {
          fault.close();
        }
        await runtime.close();
        const reopened = await openSqliteStore(profile);
        try {
          expect(
            (await reopened.getAgentMessage({
              expectedStoreId: storeId,
              sessionId: ref.childSessionId!,
              subjectId: 'owner',
              messageId: mailId,
            }))!.state,
          ).toBe('pending_sender');
          const recovery = {
            expectedStoreId: storeId,
            commandId: 'explicit-recovery',
            sessionId: 'root',
            subjectId: 'owner',
            expectedOwnerGeneration: previousGeneration,
            decision: 'interrupt' as const,
          };
          const report = await reopened.recoverSession(recovery);
          expect(report.unknownExecutionIds).toContain(mail!.sourceExecutionId);
          const recovered = await reopened.getAgentMessage({
            expectedStoreId: storeId,
            sessionId: ref.childSessionId!,
            subjectId: 'owner',
            messageId: mailId,
          });
          expect(recovered!.state).toBe('outcome_unknown');
          expect(recovered!.receivedMessageId).toBeNull();
          const cursor = (await reopened.getMetadata()).lastChangeCursor;
          expect(await reopened.recoverSession(recovery)).toEqual(report);
          expect((await reopened.getMetadata()).lastChangeCursor).toBe(cursor);
          expect(parentCalls).toBe(2);
          expect(childCalls).toBe(1);
        } finally {
          await reopened.close();
        }
      }
    } finally {
      release.release();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 12000);
}
