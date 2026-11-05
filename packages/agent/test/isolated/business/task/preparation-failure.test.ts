import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent, type ModelRequest } from '@kite-ai/ai';
import { createTaskExtension } from '../../../../src/extensions/task';
import { ConfigurationPreparationCleanupError, createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';
import { AgentError, type Json } from '../../../../src/storage/types';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const privateMarker = 'PRIVATE_CHILD_PREPARATION_DO_NOT_PUBLISH';
const cases = [
  { mode: 'skill', accepted: false, cause: 'requires a capability' },
  { mode: 'private-prepare', accepted: false, cause: 'configuration could not be prepared' },
  { mode: 'cancelled-prepare', accepted: null },
  { mode: 'cleanup-unconfirmed', accepted: null },
  { mode: 'initial-receipt-read', accepted: null },
  { mode: 'failed-prepare-receipt-read', accepted: null },
  { mode: 'same-code-store', accepted: null },
  { mode: 'committed-response-lost', accepted: true },
  { mode: 'concurrent-original-accepted', accepted: true },
] as const;

for (const entry of cases)
  test(`child admission feedback uses the original acceptance boundary: ${entry.mode}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-preparation-')));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'fixture' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const child = createFixedModel([[finish]]);
    const parent = createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'original-spawn',
          name: 'spawn_agent',
          arguments: '{"prompt":"Inspect once without modifications."}',
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    let prepares = 0;
    let commits = 0;
    let receiptReads = 0;
    let disposals = 0;
    let releaseCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      releaseCommitted = resolve;
    });
    const ensure = store.ensureOperation.bind(store);
    store.ensureOperation = async (input) => {
      commits++;
      if (entry.mode === 'same-code-store')
        throw new AgentError('skill_capability_missing', privateMarker);
      const ref = await ensure(input);
      releaseCommitted();
      if (entry.mode === 'committed-response-lost')
        throw new AgentError('skill_capability_missing', privateMarker);
      return ref;
    };
    const getOperation = store.getOperation.bind(store);
    store.getOperation = async (input) => {
      receiptReads++;
      if (
        entry.mode === 'initial-receipt-read' ||
        (entry.mode === 'failed-prepare-receipt-read' && receiptReads === 2)
      )
        throw new Error(privateMarker);
      return getOperation(input);
    };
    let task = createTaskExtension({
      roles: [{ id: 'worker', configurationId: 'worker', description: 'Owned child' }],
    });
    if (entry.mode === 'concurrent-original-accepted') {
      const spawn = task.tools!.find((tool) => tool.id === 'task.spawn')!;
      const execute = spawn.execute;
      task = {
        ...task,
        tools: task.tools!.map((tool) =>
          tool !== spawn
            ? tool
            : {
                ...tool,
                async execute(input, context) {
                  const [first, second] = await Promise.all([
                    execute(input, context),
                    execute(input, context),
                  ]);
                  expect(JSON.parse(first.content)).toMatchObject({ accepted: true });
                  expect(JSON.parse(second.content)).toEqual(JSON.parse(first.content));
                  return first;
                },
              },
        ),
      };
    }
    const runtime = createRuntime({
      store,
      model: parent,
      modelId: 'parent',
      extensions: [task],
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
      childConfigurations: [
        { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
      ],
      async resolveChildRunConfiguration() {
        const attempt = ++prepares;
        if (entry.mode === 'concurrent-original-accepted' && attempt === 1) {
          await committed;
          throw new AgentError('skill_capability_missing', privateMarker);
        }
        if (['skill', 'failed-prepare-receipt-read'].includes(entry.mode))
          throw new AgentError('skill_capability_missing', privateMarker);
        if (entry.mode === 'private-prepare') throw new Error(privateMarker);
        if (entry.mode === 'cancelled-prepare')
          throw new AgentError('cancel_requested', privateMarker);
        if (entry.mode === 'cleanup-unconfirmed') {
          const resources = {
            async dispose() {
              disposals++;
              throw new Error(privateMarker);
            },
          };
          try {
            await resources.dispose();
          } catch (cleanupError) {
            throw new ConfigurationPreparationCleanupError({
              originalError: new AgentError('skill_capability_missing'),
              cleanupError,
              resources,
            });
          }
        }
        return { model: child, modelId: 'child', toolIds: [], snapshot: {} };
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'fixture',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        expectedStoreId,
        subjectId: 'owner',
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Child preparation',
      });
      await runtime.submitCommand({
        expectedStoreId,
        subjectId: 'owner',
        commandId: 'work',
        sessionId: 's',
        request: {
          kind: 'run.start',
          content: 'Delegate exactly once and report the original result without retry.',
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      const rows = await store.listExecutions('s');
      const carrier = rows.find((row) => row.childSessionId);
      if (entry.accepted === true && carrier)
        await runtime.waitForCommand(`child-start-${carrier.id}`, { timeoutMs: 5000 });
      const spawn = rows.find((row) => row.definitionId === 'task.spawn')!;
      const raw = spawn.result as { content: string; details: Record<string, unknown> };
      const receipt = JSON.parse(raw.content);
      expect(receipt.accepted).toBe(entry.accepted);
      expect(parent.requests).toHaveLength(2);
      const feedback = parent.requests[1]!.messages.find(
        (message) => message.toolCallId === 'original-spawn',
      )!;
      expect(feedback.sourceIds).toEqual([spawn.id]);
      expect(feedback.toolCallId).toBe(spawn.callId);
      expect(feedback.content).toContain(raw.content);
      expect(JSON.stringify(parent.requests)).not.toContain(privateMarker);
      expect(raw.content).not.toContain(privateMarker);
      if (entry.accepted === false) {
        expect(receipt.error).toMatchObject({
          code: 'preparation_failed',
          next_action: 'resolve_configuration',
        });
        expect(receipt.error.message).toContain('not accepted');
        expect(receipt.error.message).toContain(
          'did not start new collaborator work or deliver new guidance',
        );
        expect(receipt.error.message).toContain(entry.cause);
        expect(receipt.error.message).not.toMatch(/\b(?:Job|Run|carrier)\b/);
        expect(raw.details.diagnostic).toEqual({
          code: entry.mode === 'skill' ? 'skill_capability_missing' : 'child_preparation_failed',
        });
      }
      if (entry.accepted === null) {
        expect(receipt.error.code).toBe('receipt_unverifiable');
        expect(receipt.error.message).toContain('Do not repeat');
      }
      if (entry.accepted === true) {
        expect(spawn.status).toBe('succeeded');
        expect(commits).toBe(1);
        expect(child.requests).toHaveLength(1);
        expect(rows.filter((row) => row.childSessionId)).toHaveLength(1);
        expect(carrier!.childSessionId).toBe(receipt.agent_id);
        expect(await store.getSession(receipt.agent_id)).toMatchObject({ parentSessionId: 's' });
      } else {
        expect(spawn.status).toBe('failed');
        expect(commits).toBe(entry.mode === 'same-code-store' ? 1 : 0);
        expect(child.requests).toHaveLength(0);
        expect(rows.filter((row) => row.childSessionId)).toHaveLength(0);
        expect(await store.listSessions()).toHaveLength(1);
      }
      expect(prepares).toBe(
        entry.mode === 'initial-receipt-read'
          ? 0
          : entry.mode === 'concurrent-original-accepted'
            ? 2
            : 1,
      );
      if (entry.mode === 'cleanup-unconfirmed') {
        await expect(runtime.close()).rejects.toMatchObject({
          code: 'shutdown_cleanup_unconfirmed',
        });
        expect(disposals).toBe(1);
      } else await runtime.close();
    } finally {
      releaseCommitted();
      if (entry.mode !== 'cleanup-unconfirmed') await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

for (const entry of cases)
  test(`follow-up admission preserves existing work and its original receipt: ${entry.mode}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-followup-preparation-')));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'fixture' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const child = createFixedModel([[finish], [finish]]);
    const requests: ModelRequest[] = [];
    let assigned = false,
      followed = false,
      cursor = '0';
    let prepares = 0,
      admissions = 0,
      receiptReads = 0,
      disposals = 0;
    let originalId = '';
    let originalResult: Json = null;
    let releaseCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      releaseCommitted = resolve;
    });
    const apply = store.applyAgentCommand.bind(store);
    store.applyAgentCommand = async (input) => {
      admissions++;
      if (entry.mode === 'same-code-store')
        throw new AgentError('skill_capability_missing', privateMarker);
      const receipt = await apply(input);
      releaseCommitted();
      if (entry.mode === 'committed-response-lost')
        throw new AgentError('skill_capability_missing', privateMarker);
      return receipt;
    };
    const getCommand = store.getCommand.bind(store);
    store.getCommand = async (id) => {
      if (id.startsWith('agent-control-')) {
        receiptReads++;
        if (
          entry.mode === 'initial-receipt-read' ||
          (entry.mode === 'failed-prepare-receipt-read' && receiptReads === 2)
        )
          throw new Error(privateMarker);
      }
      return getCommand(id);
    };
    let task = createTaskExtension({
      roles: [{ id: 'worker', configurationId: 'worker', description: 'Owned child' }],
    });
    if (entry.mode === 'concurrent-original-accepted') {
      const follow = task.tools!.find((tool) => tool.id === 'task.follow_up')!;
      const execute = follow.execute;
      task = {
        ...task,
        tools: task.tools!.map((tool) =>
          tool !== follow
            ? tool
            : {
                ...tool,
                async execute(input, context) {
                  const [first, second] = await Promise.all([
                    execute(input, context),
                    execute(input, context),
                  ]);
                  expect(JSON.parse(first.content)).toMatchObject({ accepted: true });
                  expect(JSON.parse(second.content)).toEqual(JSON.parse(first.content));
                  return first;
                },
              },
        ),
      };
    }
    const runtime = createRuntime({
      store,
      model: {
        async *stream(request) {
          requests.push(request);
          if (!assigned) {
            assigned = true;
            yield {
              type: 'tool_call',
              id: 'spawn-first',
              name: 'spawn_agent',
              arguments: '{"prompt":"Inspect once without modifications."}',
            };
          } else if (followed) {
            yield finish;
            return;
          } else {
            const original = (await store.listExecutions('s')).find((row) => row.childSessionId)!;
            if (original.status === 'succeeded') {
              originalId = original.id;
              originalResult = structuredClone(original.result);
              followed = true;
              yield {
                type: 'tool_call',
                id: 'original-followup',
                name: 'follow_up_agent',
                arguments: JSON.stringify({
                  agent_id: original.childSessionId,
                  content: 'Continue this same collaborator once.',
                }),
              };
            } else {
              const observed = request.messages.filter((message) => message.role === 'tool').at(-1);
              if (observed?.toolCallId?.startsWith('wait-'))
                cursor = JSON.parse(observed.content).next_seq;
              yield {
                type: 'tool_call',
                id: `wait-${requests.length}`,
                name: 'wait_agent_events',
                arguments: JSON.stringify({ after_seq: cursor, wait_ms: 1000 }),
              };
            }
          }
          yield { ...finish, reason: 'tool_calls' };
        },
      },
      modelId: 'parent',
      modelConcurrency: 2,
      extensions: [task],
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
      childConfigurations: [
        { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
      ],
      async resolveChildRunConfiguration() {
        const attempt = ++prepares;
        if (attempt === 1) return { model: child, modelId: 'child', toolIds: [], snapshot: {} };
        if (entry.mode === 'concurrent-original-accepted' && attempt === 2) {
          await committed;
          throw new AgentError('skill_capability_missing', privateMarker);
        }
        if (['skill', 'failed-prepare-receipt-read'].includes(entry.mode))
          throw new AgentError('skill_capability_missing', privateMarker);
        if (entry.mode === 'private-prepare') throw new Error(privateMarker);
        if (entry.mode === 'cancelled-prepare')
          throw new AgentError('cancel_requested', privateMarker);
        if (entry.mode === 'cleanup-unconfirmed') {
          const resources = {
            async dispose() {
              disposals++;
              throw new Error(privateMarker);
            },
          };
          try {
            await resources.dispose();
          } catch (cleanupError) {
            throw new ConfigurationPreparationCleanupError({
              originalError: new AgentError('skill_capability_missing'),
              cleanupError,
              resources,
            });
          }
        }
        return { model: child, modelId: 'child', toolIds: [], snapshot: {} };
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'fixture',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        expectedStoreId,
        subjectId: 'owner',
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Follow-up preparation',
      });
      await runtime.submitCommand({
        expectedStoreId,
        subjectId: 'owner',
        commandId: 'work',
        sessionId: 's',
        request: {
          kind: 'run.start',
          content: 'Start once, then continue the same collaborator once.',
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      const rows = await store.listExecutions('s');
      if (entry.accepted === true) {
        const successor = rows.find((row) => row.childSessionId && row.id !== originalId)!;
        await runtime.waitForCommand(`child-start-${successor.id}`, { timeoutMs: 5000 });
      }
      const follow = rows.find((row) => row.definitionId === 'task.follow_up')!;
      const raw = follow.result as { content: string; details: Record<string, unknown> };
      const receipt = JSON.parse(raw.content);
      expect(receipt.accepted).toBe(entry.accepted);
      const feedback = requests
        .at(-1)!
        .messages.find((message) => message.toolCallId === 'original-followup')!;
      expect(feedback.sourceIds).toEqual([follow.id]);
      expect(feedback.toolCallId).toBe(follow.callId);
      expect(feedback.content).toContain(raw.content);
      expect(JSON.stringify(requests)).not.toContain(privateMarker);
      expect((await store.getExecution(originalId))!.result).toEqual(originalResult);
      if (entry.accepted === false) {
        expect(receipt.error).toMatchObject({
          code: 'preparation_failed',
          next_action: 'resolve_configuration',
        });
        expect(receipt.error.message).toContain('not accepted');
        expect(receipt.error.message).toContain(
          'did not start new collaborator work or deliver new guidance',
        );
        expect(receipt.error.message).toContain(entry.cause);
      } else if (entry.accepted === null) {
        expect(receipt.error.code).toBe('receipt_unverifiable');
        expect(receipt.error.message).toContain('Do not repeat');
      }
      const carriers = rows.filter((row) => row.childSessionId);
      expect(carriers).toHaveLength(entry.accepted === true ? 2 : 1);
      expect(new Set(carriers.map((row) => row.childSessionId)).size).toBe(1);
      expect(child.requests).toHaveLength(entry.accepted === true ? 2 : 1);
      expect(admissions).toBe(entry.accepted === true || entry.mode === 'same-code-store' ? 1 : 0);
      expect(prepares).toBe(
        entry.mode === 'initial-receipt-read'
          ? 1
          : entry.mode === 'concurrent-original-accepted'
            ? 3
            : 2,
      );
      if (entry.mode === 'cleanup-unconfirmed') {
        await expect(runtime.close()).rejects.toMatchObject({
          code: 'shutdown_cleanup_unconfirmed',
        });
        expect(disposals).toBe(1);
      } else await runtime.close();
    } finally {
      releaseCommitted();
      if (entry.mode !== 'cleanup-unconfirmed') await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
