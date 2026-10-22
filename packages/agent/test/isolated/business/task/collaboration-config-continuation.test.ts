import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../../tests/fixtures/test-filesystem';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

for (const cold of [false, true])
  test(`${cold ? 'cold' : 'hot'} ordinary continuation uses current explicit configuration and permissions without reopening the old Run`, async () => {
    const root = temporaryDirectory('kite-ordinary-config-');
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    let store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    const requests: { model: string; request: ModelRequest }[] = [];
    const resolved: string[] = [],
      authorized: string[] = [];
    let revision = 'before';
    const model = (id: string): ModelAdapter => ({
      async *stream(request) {
        requests.push({ model: id, request: structuredClone(request) });
        expect(
          request.messages.some((message) => message.content.includes('Original input identity:')),
        ).toBe(false);
        yield { type: 'text_delta', text: `Actual reply from ${id}` };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    const permissions = {
      async authorize() {
        authorized.push(revision);
        return { allowed: true, revision };
      },
    };
    const options = () => ({
      store,
      permissions,
      async resolveRunConfiguration(
        input: Parameters<
          NonNullable<Parameters<typeof createRuntime>[0]['resolveRunConfiguration']>
        >[0],
      ) {
        resolved.push(input.command.id);
        const id = (input.command.request as { modelId: string }).modelId;
        return { model: model(id), modelId: id, permissions, snapshot: { chosen: id } };
      },
      async resolveRecoveryRunConfiguration() {
        throw Error('ordinary_input_must_not_restore_old_configuration');
      },
    });
    let runtime = createRuntime(options());
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'fixture',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...scope,
        commandId: 'create',
        workspaceId: 'w',
        title: 'fixture',
      });
      await runtime.submitCommand({
        ...scope,
        commandId: 'A',
        request: { kind: 'run.start', content: 'Original A', modelId: 'A' },
      });
      const a = await runtime.waitForCommand('A', { timeoutMs: 5000 });
      const original = (await store.getRun((a.receipt as { runId: string }).runId))!;
      if (cold) {
        await runtime.close();
        await store.close();
        store = await openSqliteStore(profile);
        runtime = createRuntime(options());
        const cursor = (await store.getMetadata()).lastChangeCursor;
        await runtime.getView('s');
        expect(requests).toHaveLength(1);
        expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      }
      revision = 'latest';
      await runtime.submitCommand({
        ...scope,
        commandId: 'continue',
        request: {
          kind: 'input.follow_up',
          content: '继续 A',
          modelId: 'B',
          afterRunId: original.id,
          contextSelectionId: original.contextSelectionId,
        },
      });
      const next = await runtime.waitForCommand('continue', { timeoutMs: 5000 });
      const run = (await store.getRun((next.receipt as { runId: string }).runId))!;
      expect(run).toMatchObject({
        originCommandId: 'continue',
        rootWorkCommandId: 'continue',
        status: 'completed',
        configuration: { modelId: 'B', snapshot: { chosen: 'B' } },
      });
      expect(await store.getRun(original.id)).toEqual(original);
      expect(resolved).toEqual(['A', 'continue']);
      expect(authorized).toContain('before');
      expect(authorized.at(-1)).toBe('latest');
      expect(
        authorized.slice(authorized.indexOf('latest')).every((value) => value === 'latest'),
      ).toBe(true);
      expect(requests.map((entry) => entry.model)).toEqual(['A', 'B']);
      const messages = requests[1]!.request.messages;
      expect(
        messages.some(
          (message) => message.role === 'assistant' && message.content === 'Actual reply from A',
        ),
      ).toBe(true);
      expect(
        messages.filter((message) => message.role === 'user').map((message) => message.content),
      ).toEqual(['Original A', '继续 A']);
      expect(next.receipt).not.toHaveProperty('humanInputCommandId');
    } finally {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
