import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelAttemptError, ModelRequestLimitError } from '@kite-ai/ai';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { UnifiedExecution } from '../../../src/execution';
import { ExecutionResources } from '../../../src/execution/resources';
import { openSqliteStore } from '../../../src/sqlite';

for (const outcome of [
  'success',
  'tool',
  'length',
  'unknown',
  '413',
  'commit-revoked',
  'atomic-cancel',
] as const)
  test('durable image observation ' + outcome, async () => {
    const root = temporaryDirectory('kite-observe-');
    let store!: Awaited<ReturnType<typeof openSqliteStore>>;
    try {
      store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
      const expectedStoreId = (await store.getMetadata()).storeId,
        identity = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
      await store.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: pathToFileURL(root).href,
        name: 'test',
      });
      await store.createSession({
        ...identity,
        commandId: 'create',
        workspaceId: 'w',
        title: 'test',
      });
      await store.acceptCommand({
        ...identity,
        commandId: 'start',
        request: { kind: 'run.start', content: 'task' },
      });
      const owner = (await store.acquireSessionOwner('s', 'test'))!;
      const run = await store.startRun({
        expectedStoreId,
        owner,
        commandId: 'start',
        configuration: {},
      });
      const bytes = Buffer.from('image'),
        member = {
          executionId: 'source',
          ordinal: 1,
          hash: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        };
      const finish = store.finishExecution.bind(store);
      let cancelled = false;
      if (outcome === 'atomic-cancel')
        store.finishExecution = async (input) => {
          if (input.status === 'succeeded' && !cancelled) {
            cancelled = true;
            await store.cancelCommand({
              ...identity,
              commandId: 'cancel-at-commit',
              targetCommandId: 'start',
            });
          }
          return finish(input);
        };
      const execution = new UnifiedExecution({
        store,
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'test' };
          },
        },
        resources: new ExecutionResources(),
      });
      let receivedFinish = false;
      let error: unknown;
      try {
        await execution.model(
          {
            run,
            owner,
            workspaceId: 'w',
            checkFreshness: async () => {
              if (receivedFinish && outcome === 'commit-revoked')
                throw Error('capability_refresh_required');
            },
            signal: new AbortController().signal,
            imageWindow: { version: 1, kind: 'observation', route: 'route', members: [member] },
          },
          {
            async *stream() {
              yield { type: 'text_delta', text: 'untrusted note' };
              if (outcome === 'unknown') throw new ModelAttemptError('connection_failed');
              if (outcome === '413') throw new ModelRequestLimitError();
              if (outcome === 'tool')
                yield { type: 'tool_call', id: 'bad', name: 'effect', arguments: '{}' };
              receivedFinish = true;
              yield {
                type: 'finish',
                reason: outcome === 'length' ? 'length' : 'stop',
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            },
          },
          {
            requestId: 'observation',
            modelId: 'fixed',
            tools: [],
            messages: [
              {
                role: 'user',
                content: 'source data',
                images: [{ mediaType: 'image/png', data: bytes.toString('base64') }],
              },
            ],
          },
          'observation-step',
        );
      } catch (e) {
        error = e;
      }
      const row = await store.getExecution('observation');
      if (outcome === 'commit-revoked')
        expect(row?.result).toMatchObject({ code: 'image_window_outcome_unknown' });
      if (outcome === 'atomic-cancel') expect(row?.status).not.toBe('succeeded');
      else expect(row?.status).toBe(outcome === 'success' ? 'succeeded' : 'failed');
      expect(error === undefined).toBe(outcome === 'success');
      const session = await store.getSession('s');
      const facts = await store.readImageWindowFacts({
        ...identity,
        selectionId: session!.contextSelectionId,
        route: 'route',
        runId: run.id,
        executionIds: ['source'],
      });
      const historyQuery = {
        ...identity,
        selectionId: session!.contextSelectionId,
        runId: run.id,
        executionIds: ['source'],
      };
      const historical = await store.readHistoricallyConfirmedImageMembers(historyQuery);
      expect(historical).toEqual(outcome === 'success' ? [member] : []);
      if (outcome === 'success') {
        const db = new Database(join(root, 'data', 'test', 'core.db'));
        try {
          db.run(
            "UPDATE execution SET result_json=json_set(result_json,'$.imageWindow.members[0].ordinal',2) WHERE id='observation'",
          );
          expect(await store.readHistoricallyConfirmedImageMembers(historyQuery)).toEqual([]);
          db.run(
            "UPDATE execution SET result_json=json_set(result_json,'$.imageWindow.members[0].ordinal',1) WHERE id='observation'",
          );
          expect(await store.readHistoricallyConfirmedImageMembers(historyQuery)).toEqual([member]);
        } finally {
          db.close();
        }
        const reader = await openSqliteStore({
          dataRoot: join(root, 'data'),
          profile: 'test',
          mode: 'readonly',
        });
        try {
          expect(await reader.readHistoricallyConfirmedImageMembers(historyQuery)).toEqual([
            member,
          ]);
        } finally {
          await reader.close();
        }
      }

      expect(
        await store.readHistoricallyConfirmedImageMembers({
          ...historyQuery,
          executionIds: ['absent'],
        }),
      ).toEqual([]);
      for (const invalid of [
        { subjectId: 'other' },
        { selectionId: 'other' },
        { runId: 'absent' },
        { expectedStoreId: 'other' },
      ]) {
        let rejected = false;
        try {
          await store.readHistoricallyConfirmedImageMembers({ ...historyQuery, ...invalid });
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
      }
      let invalidIdsRejected = false;
      try {
        await store.readHistoricallyConfirmedImageMembers({
          ...historyQuery,
          executionIds: Array.from({ length: 129 }, (_, i) => String(i)),
        });
      } catch {
        invalidIdsRejected = true;
      }
      expect(invalidIdsRejected).toBe(true);
      expect(facts.confirmed.length).toBe(outcome === 'success' ? 1 : 0);
      expect(facts.rejected.length).toBe(outcome === '413' ? 1 : 0);
      if (outcome === 'success') expect(facts.confirmed[0]?.note).toBe('untrusted note');
      const context = await store.getModelContext({
        ...identity,
        afterSeq: '0',
        afterSourceId: '',
        messageLimit: 100,
        sourceLimit: 100,
        byteLimit: 100000,
      });
      expect(context.messages.some((m) => m.sourceIds?.includes('observation'))).toBe(false);
    } finally {
      try {
        await store?.close();
      } finally {
        removeTemporaryDirectory(root);
      }
      expect(existsSync(root)).toBe(false);
    }
  });
