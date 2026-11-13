import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';
import { AgentError } from '../../../../src/storage/types';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

for (const fault of ['preparation', 'store'] as const)
  test(`creation denial explains the boundary only with verified nonacceptance: ${fault}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-creation-feedback-')));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'fixture' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const privateMarker = 'PRIVATE_CREATION_FAILURE';
    const child = createFixedModel([[finish]]);
    const parent = createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'original-spawn',
          name: 'spawn_agent',
          arguments: '{"prompt":"Inspect the source once."}',
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    if (fault === 'store')
      store.ensureOperation = async () => {
        throw new AgentError('child_agent_creation_denied', privateMarker);
      };
    const runtime = createRuntime({
      store,
      model: parent,
      modelId: 'parent',
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
      extensions: [
        createTaskExtension({
          roles: [{ id: 'worker', configurationId: 'worker', description: 'Owned worker' }],
        }),
      ],
      childConfigurations: [
        { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
      ],
      async resolveChildRunConfiguration() {
        if (fault === 'preparation')
          throw new AgentError('child_agent_creation_denied', privateMarker);
        return { model: child, modelId: 'child', toolIds: [], snapshot: {} };
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'Owned fixture',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        expectedStoreId,
        subjectId: 'owner',
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Creation boundary feedback',
      });
      await runtime.submitCommand({
        expectedStoreId,
        subjectId: 'owner',
        commandId: 'work',
        sessionId: 's',
        request: { kind: 'run.start', content: 'Delegate once and report the original receipt.' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      const rows = await store.listExecutions('s');
      const spawn = rows.find((row) => row.definitionId === 'task.spawn')!;
      const raw = spawn.result as { content: string };
      const receipt = JSON.parse(raw.content);
      expect(receipt.accepted).toBe(fault === 'preparation' ? false : null);
      if (fault === 'preparation') {
        expect(receipt.error).toMatchObject({
          code: 'permission_denied',
          next_action: 'ask_parent_to_delegate',
        });
        expect(receipt.error.message).toContain('Only the main Agent can create collaborators.');
        expect(receipt.error.message).toContain('parent');
        expect(receipt.error.message).toContain('Do not retry');
      } else {
        expect(receipt.error.code).toBe('receipt_unverifiable');
        expect(receipt.error.message).toContain('Do not repeat');
      }
      expect(spawn.status).toBe('failed');
      expect(parent.requests).toHaveLength(2);
      const feedback = parent.requests[1]!.messages.find(
        (message) => message.toolCallId === 'original-spawn',
      )!;
      expect(feedback.content).toContain(raw.content);
      expect(feedback.sourceIds).toEqual([spawn.id]);
      expect(JSON.stringify(parent.requests)).not.toContain(privateMarker);
      expect(raw.content).not.toMatch(/\b(?:Job|Run|carrier)\b/);
      expect(rows.filter((row) => row.childSessionId)).toHaveLength(0);
      expect(child.requests).toHaveLength(0);
    } finally {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
