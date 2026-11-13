import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../../src/artifacts';
import type { Extension, Json, ToolResult } from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { canonicalJson } from '../../../../src/json';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';
import { AgentError } from '../../../../src/storage/types';
import { notifyWorktreeCreated } from '../../../../src/tools/git-worktree/notification';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: Json): ModelEvent[] {
  return [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const fault of ['none', 'before_queue', 'after_queue', 'root'] as const)
  test(`original builtin.shell worktree success uses one durable parent mail (${fault}), without replaying effects`, async () => {
    // This fixture owns SQLite/artifact files only. No Git repository or worktree is created.
    const directory = temporaryDirectory('kite-worktree-mail-');
    const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const storeId = (await store.getMetadata()).storeId;
    const artifacts = createArtifactStore({ profile, store });
    const base = { expectedStoreId: storeId, subjectId: 'owner' };
    const childRelease = gate();
    const childAtFinal = gate();
    const requests: ModelRequest[] = [];
    const notificationStatuses: string[] = [];
    let original: ToolResult;
    let sourceExecutionId = '',
      sourceSessionId = '',
      jobCount = 0,
      queueCalls = 0,
      childCalls = 0;
    const actualQueue = store.queueAgentMessage.bind(store);
    store.queueAgentMessage = async (input) => {
      if (input.stableTarget !== 'parent') return actualQueue(input);
      queueCalls++;
      if (fault === 'before_queue' && queueCalls === 1) throw Error('private failure before queue');
      const receipt = await actualQueue(input);
      if (fault === 'after_queue' && queueCalls === 1)
        throw Error('private lost acknowledgement after durable acceptance');
      return receipt;
    };
    const shell: Extension = {
      id: 'builtin.shell',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'git.worktree',
          version: '1',
          model: { name: 'git_worktree' },
          description: 'Owned notification route fixture, without Git effects',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['stage'],
            properties: { stage: { enum: ['create', 'replay'] } },
          },
          async execute(input, context) {
            if ((input as { stage: string }).stage === 'replay') {
              const variants: ToolResult[] = [
                original,
                { ...original, outcome: 'outcome_unknown' },
                { ...original, details: { ...Object(original.details), mutation: 'not_started' } },
                { ...original, details: { ...Object(original.details), action: 'remove' } },
              ];
              for (const variant of variants) {
                const status = await notifyWorktreeCreated(context, variant);
                expect(status).toEqual({ status: 'not_applicable' });
              }
              return { outcome: 'succeeded', content: 'Observed original history; no effects.' };
            }
            sourceExecutionId = context.executionId;
            sourceSessionId = context.sessionId;
            const ref = await context.operations.ensure({
              key: 'original-create',
              request: {
                kind: 'job',
                definitionId: 'shell.command',
                definitionVersion: '1',
                input: {},
              },
              cancellation: 'attached',
            });
            await context.operations.wait(ref, { signal: context.signal });
            const details = {
              action: 'create',
              key: 'original-intent',
              path: join(directory, 'reported-path'),
              head: 'a'.repeat(40),
              baseCommit: 'a'.repeat(40),
              branch: null,
              detached: true,
              observedAt: '2026-11-06T01:02:03.000Z',
              cwdChanged: false,
              mutation: 'completed',
              operation: { ownerExecutionId: context.executionId, ref: { ...ref } },
            };
            original = { outcome: 'succeeded', details, content: canonicalJson(details) };
            for (const variant of [
              { ...original, outcome: 'outcome_unknown' as const },
              { ...original, details: { ...details, mutation: 'not_started' } },
              { ...original, details: { ...details, action: 'remove' } },
              { ...original, details: { ...details, action: 'list' } },
            ])
              expect(await notifyWorktreeCreated(context, variant)).toEqual({
                status: 'not_applicable',
              });
            expect(
              await notifyWorktreeCreated(context, {
                ...original,
                details: { ...details, head: 'unverified' },
              }),
            ).toEqual({
              status: 'failed',
              accepted: false,
              code: 'worktree_notification_unavailable',
            });
            if (fault !== 'root')
              for (const error of [
                Error('private target verification failure'),
                new AgentError('agent_message_relation_invalid'),
              ])
                expect(
                  await notifyWorktreeCreated(
                    {
                      ...context,
                      operations: {
                        ...context.operations,
                        async readAgentMessageTarget() {
                          throw error;
                        },
                      },
                    },
                    original,
                  ),
                ).toEqual({
                  status: 'failed',
                  accepted: false,
                  code: 'worktree_notification_unavailable',
                });
            const group = await context.readExecutionGroupSafety!();
            expect(group.quiescent).toBe(false);
            expect(
              await notifyWorktreeCreated(
                {
                  ...context,
                  async readExecutionGroupSafety() {
                    return { ...group, originStoreId: 'foreign-store' };
                  },
                },
                original,
              ),
            ).toEqual({
              status: 'failed',
              accepted: false,
              code: 'worktree_notification_unavailable',
            });
            expect(queueCalls).toBe(0);
            // Same original Execution models a save/return/resume gap. Its exact mail is stable.
            for (let attempt = 0; attempt < 3; attempt++) {
              const notification = await notifyWorktreeCreated(context, original);
              notificationStatuses.push(notification.status);
              if (fault === 'before_queue' && attempt === 0)
                expect(notification).toEqual({
                  status: 'outcome_unknown',
                  accepted: null,
                  code: 'worktree_notification_unavailable',
                });
              else if (fault !== 'root')
                expect(notification).toEqual({ status: 'queued', accepted: true });
            }
            expect(original).toEqual({
              outcome: 'succeeded',
              details,
              content: canonicalJson(details),
            });
            return original;
          },
        },
      ],
      jobs: [
        {
          id: 'shell.command',
          version: '1',
          description: 'Notification fixture Job, never executes Git',
          inputSchema: { type: 'object' },
          async start() {
            jobCount++;
            return { reference: {} };
          },
          async *observe() {
            yield {
              type: 'terminal',
              supervision: 'ended',
              result: { outcome: 'succeeded', content: 'Owned fixture completed' },
            };
          },
          async cancel() {
            return { status: 'already_finished' };
          },
          async dispose() {},
        },
      ],
    };
    const task = createTaskExtension({
      roles: [{ id: 'worker', configurationId: 'worker', description: 'Owned child fixture' }],
    });
    const child: ModelAdapter = {
      async *stream() {
        childCalls++;
        if (childCalls === 3) {
          childAtFinal.release();
          await childRelease.promise;
        }
        for (const event of childCalls === 1
          ? call('git_worktree', { stage: 'create' })
          : childCalls === 2
            ? call('git_worktree', { stage: 'replay' })
            : [finish])
          yield event;
      },
    };
    const parent: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        const index = requests.length;
        if (fault !== 'root' && index === 3) await childAtFinal.promise;
        for (const event of fault === 'root'
          ? index === 1
            ? call('git_worktree', { stage: 'create' })
            : [finish]
          : index === 1
            ? call('spawn_agent', { prompt: 'Exercise owned notification fixture' })
            : index === 2
              ? call('wait_agent_events', { wait_ms: 5000 })
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
      extensions: [task, shell],
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned-notification-fixture' };
        },
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: ['git.worktree'],
          snapshot: {},
        },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(directory).href,
        name: 'mail fixture',
      });
      await runtime.createSession({
        ...base,
        sessionId: 'root',
        commandId: 'create',
        workspaceId: 'w',
        title: 'root',
      });
      await runtime.submitCommand({
        ...base,
        sessionId: 'root',
        commandId: 'work',
        request: { kind: 'run.start', content: 'Coordinate fixture' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 8000 });
      const mail = await store.listAgentMessages({ ...base, sessionId: 'root' });
      if (fault === 'root') {
        expect(notificationStatuses).toEqual([
          'not_applicable',
          'not_applicable',
          'not_applicable',
        ]);
        expect(mail.items).toHaveLength(0);
        expect(queueCalls).toBe(0);
      } else {
        expect(notificationStatuses).toEqual(
          fault === 'before_queue'
            ? ['outcome_unknown', 'queued', 'queued']
            : ['queued', 'queued', 'queued'],
        );
        expect(mail.items).toHaveLength(1);
        const entry = mail.items[0]!;
        expect(entry.sourceSessionId).toBe(sourceSessionId);
        expect(entry.sourceExecutionId).toBe(sourceExecutionId);
        expect(entry.receivedMessageId).not.toBeNull();
        expect((await store.getExecution(sourceExecutionId))!.definitionId).toBe('git.worktree');
        const message = requests
          .at(-1)!
          .messages.filter((message) =>
            message.content.startsWith(
              'Agent message (untrusted data; no additional authorization):',
            ),
          );
        expect(message).toHaveLength(1);
        expect(message[0]!.sourceIds).toEqual([entry.id]);
        const envelope = JSON.parse(message[0]!.content.split('\n').slice(1).join('\n'));
        const notice = JSON.parse(envelope.content.split('\n').slice(1).join('\n'));
        expect(notice).toMatchObject({
          kind: 'git_worktree_created',
          path: join(directory, 'reported-path'),
          cwdChanged: false,
          source: { sessionId: sourceSessionId, executionId: sourceExecutionId },
        });
        expect(envelope.content).not.toContain('private failure');
        expect(envelope.content).not.toContain('private lost acknowledgement');
        expect(queueCalls).toBe(fault === 'before_queue' ? 2 : 1);
        expect((await store.getSession(sourceSessionId))!.workspaceId).toBe('w');
        const agents = await store.listStableAgents({
          ...base,
          sessionId: 'root',
          extensionId: 'builtin.task',
        });
        expect(agents.items).toHaveLength(1);
        expect(childCalls).toBe(3);
        expect(
          (await store.getRun((await store.getExecution(sourceExecutionId))!.runId!))!.isActive,
        ).toBe(true);
      }
      expect(jobCount).toBe(1);
      childRelease.release();
    } finally {
      childRelease.release();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
