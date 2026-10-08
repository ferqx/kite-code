import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createProfileBackup, restoreProfileBackup } from '../../../src/maintenance';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

test('offline restore preserves immutable original Store provenance for inline user, Model and Tool Fork history in cold read-only Core', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-restored-inline-origin-')),
    profile = { dataRoot: join(root, 'data'), profile: 'test' },
    store = await openSqliteStore(profile),
    originalStoreId = (await store.getMetadata()).storeId,
    finish: ModelEvent = {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    model = createFixedModel([
      [
        { type: 'tool_call', id: 'original-call', name: 'fixture.effect', arguments: '{}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: '原任务完成 雪🙂\r\n' }, finish],
    ]);
  let effects = 0;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'one harmless fixture effect',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded' as const, content: '原工具回执' };
            },
          },
        ],
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: originalStoreId,
      id: 'w',
      name: 'original',
      rootUri: `file://${root}`,
    });
    await runtime.createSession({
      expectedStoreId: originalStoreId,
      subjectId: 'owner',
      sessionId: 'source',
      workspaceId: 'w',
      commandId: 'create',
      title: 'original',
    });
    await runtime.submitCommand({
      expectedStoreId: originalStoreId,
      subjectId: 'owner',
      sessionId: 'source',
      commandId: 'work',
      request: { kind: 'run.start', content: '原用户输入' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const original = await store.getView('source');
    expect(original.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(2);
    await runtime.forkSession({
      expectedStoreId: originalStoreId,
      subjectId: 'owner',
      sourceSessionId: 'source',
      expectedContextSelectionId: original.session.contextSelectionId,
      newSessionId: 'fork',
      commandId: 'fork',
      title: 'sealed',
    });
    const copies = (await store.getView('fork')).messages;
    expect(copies).toHaveLength(original.messages.length);
    await runtime.close();
    const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backup') }),
      restored = await restoreProfileBackup({
        profile,
        expectedStoreId: originalStoreId,
        backup,
        intent: 'replace_with_selected_backup',
      });
    expect(restored.storeId).not.toBe(originalStoreId);
    const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      const before = (await cold.getMetadata()).lastChangeCursor;
      for (let index = 0; index < copies.length; index++) {
        const origin = await cold.getMessageOrigin({
          expectedStoreId: restored.storeId,
          subjectId: 'owner',
          sessionId: 'fork',
          messageId: copies[index]!.id,
        });
        expect(origin).toMatchObject({
          originStoreId: originalStoreId,
          subjectId: 'owner',
          message: original.messages[index]!,
        });
        expect(copies[index]!.runId).toBeNull();
      }
      expect((await cold.getMetadata()).lastChangeCursor).toBe(before);
      expect((await cold.getView('fork')).messages).toEqual(copies);
      expect(model.requests).toHaveLength(2);
      expect(effects).toBe(1);
    } finally {
      await cold.close();
    }
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
