import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type ModelInputSnapshot } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { canonicalJson, semanticDigest } from '../../../src/json';
import { createProfileBackup, restoreProfileBackup } from '../../../src/maintenance';
import { bodyReference } from '../../../src/model-body';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;
const marker = 'PRIVATE_ENCRYPTED_REVIEW_CONTINUATION';
const reviewRequest = { task: 'review the exact harmless tool' };
const reviewerIdentity = { id: 'reviewer', version: '1', modelId: 'other-review-binding' };
const semanticData = '{"continuation":"ordinary tool data must remain visible"}';

for (const shape of ['inline', 'artifact-private', 'artifact-semantic'] as const)
  test(`Auto review projects private continuation from ${shape} input without losing its original proof`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-review-continuation-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
    const store = await openSqliteStore(profile);
    const artifacts = createArtifactStore({ profile, store });
    const continuation = {
      version: 1,
      protocol: 'responses',
      binding: 'original-only',
      modelId: 'original-model',
      content: [
        {
          type: 'reasoning',
          providerOptions: {
            openai: {
              reasoningEncryptedContent:
                marker + (shape === 'artifact-private' ? 'x'.repeat(80 * 1024) : ''),
            },
          },
        },
      ],
    };
    const call = (id: string, name: string, privateState = false): ModelEvent[] => [
      { type: 'text_delta', text: `Visible request ${id}` },
      { type: 'tool_call', id, name, arguments: semanticData },
      {
        ...finish,
        reason: 'tool_calls',
        ...(privateState ? { continuation } : {}),
      },
    ];
    const ordinary = createFixedModel([
      call('first', 'fixture.noop', true),
      call('second', 'fixture.effect', true),
      call('third', 'fixture.effect'),
      [finish],
    ]);
    const reviewer = createFixedModel(
      Array.from({ length: 2 }, () => [
        {
          type: 'text_delta',
          text: '{"decision":"approve_once","reason":"exact visible operation"}',
        } as const,
        finish,
      ]),
    );
    let effects = 0;
    const runtime = createRuntime({
      store,
      artifacts,
      model: ordinary,
      modelId: 'original-model',
      authorizationReview: { ...reviewerIdentity, model: reviewer },
      permissions: {
        async authorize(request) {
          return request.definitionId === 'fixture.effect'
            ? { allowed: false, revision: 'p1', review: { request: reviewRequest } }
            : { allowed: true, revision: 'p1' };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: ['fixture.noop', 'fixture.effect'].map((id) => ({
            id,
            version: '1',
            description: 'Harmless local test tool',
            inputSchema: { type: 'object' },
            async execute() {
              if (id === 'fixture.effect') effects++;
              return { outcome: 'succeeded' as const, content: semanticData };
            },
          })),
        },
      ],
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    const inspected: ModelInputSnapshot[] = [];
    let cold: ReturnType<typeof createRuntime> | undefined;
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...scope,
        commandId: 'create',
        workspaceId: 'w',
        title: 'owned',
      });
      await runtime.submitCommand({
        ...scope,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content:
            'Exact user instruction' +
            (shape === 'artifact-semantic' ? 'visible '.repeat(12 * 1024) : ''),
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: 10000 });
      expect(effects).toBe(2);
      expect(ordinary.requests).toHaveLength(4);
      expect(reviewer.requests).toHaveLength(2);
      expect(JSON.stringify(ordinary.requests[1])).toContain(marker);
      expect(JSON.stringify(ordinary.requests[2])).toContain(marker);
      expect(JSON.stringify(reviewer.requests)).not.toContain(marker);
      const executions = await store.listExecutions('s');
      const carriers = executions.filter((item) => item.childSessionId);
      expect(carriers).toHaveLength(2);
      for (const [index, actualReview] of reviewer.requests.entries()) {
        expect(actualReview.modelId).toBe(reviewerIdentity.modelId);
        expect(actualReview.tools).toEqual([]);
        const payload = JSON.parse(
          actualReview.messages.find((item) => item.role === 'user')!.content,
        );
        const original = ordinary.requests[index + 1]!;
        const visible = original.messages.map(({ continuation: _private, ...message }) => message);
        expect(payload.decisionContext).toEqual({
          modelExecutionId: original.requestId,
          messages: visible,
        });
        expect(JSON.stringify(payload.decisionContext)).toContain('ordinary tool data');
        expect(
          payload.decisionContext.messages.find(
            (item: { role: string }) => item.role === 'assistant',
          ).toolCalls[0].id,
        ).toBe('first');

        const originalSnapshot = await store.getModelInputSnapshot({
          ...scope,
          executionId: original.requestId,
        });
        expect(originalSnapshot.authorizationReview).toBeNull();
        const originalInput = originalSnapshot.input as Record<string, Json>;
        const originalBody = bodyReference(originalInput.body);
        expect(!!originalBody).toBe(shape !== 'inline');
        const privateRequest = originalBody
          ? JSON.parse(
              new TextDecoder().decode(
                await artifacts.readReference({
                  expectedStoreId,
                  reference: originalBody.reference,
                }),
              ),
            )
          : originalInput;
        expect(privateRequest).toEqual(original);
        expect(JSON.stringify(privateRequest)).toContain(marker);

        const carrier = carriers.find(
          (item) =>
            (item.input as Record<string, Json>).target &&
            ((item.input as Record<string, Json>).decisionContext as Record<string, Json>)
              .modelExecutionId === original.requestId,
        )!;
        expect(carrier.status).toBe('succeeded');
        const childScope = {
          ...scope,
          sessionId: carrier.childSessionId!,
          executionId: actualReview.requestId,
        };
        const snapshot = await runtime.readModelInput(childScope);
        inspected.push(snapshot);
        expect(snapshot.confirmation).toBe('succeeded');
        expect('authorizationReview' in snapshot).toBe(false);
        expect(snapshot.request).toEqual(actualReview);
        expect(JSON.stringify(snapshot)).not.toContain(marker);
        expect(snapshot.bodyHash).toBe(await semanticDigest(snapshot.request as unknown as Json));
        expect(snapshot.bodyBytes).toBe(
          String(Buffer.byteLength(canonicalJson(snapshot.request as unknown as Json))),
        );
        const storedReview = await store.getModelInputSnapshot(childScope);
        expect(storedReview.authorizationReview).toEqual({
          sourceIds: [snapshot.originCommandId, carrier.id],
        });
        const history = await runtime.listMessages(childScope.sessionId);
        const initialMessage = history.find((message) => message.role === 'user')!;
        expect(initialMessage.sourceIds).toEqual([snapshot.originCommandId, carrier.id]);
        expect(JSON.stringify(history)).not.toContain(marker);
        const publicRun = await runtime.getRun(snapshot.runId);
        expect(JSON.stringify(publicRun)).not.toContain(marker);
        expect((await store.getRun(snapshot.runId))!.configuration).toEqual(
          carrier.childConfiguration!.snapshot,
        );
        expect(
          JSON.stringify((await runtime.getView(childScope.sessionId)).messages),
        ).not.toContain(marker);
        expect(JSON.stringify((await runtime.getView(childScope.sessionId)).runs)).not.toContain(
          marker,
        );
        expect(
          JSON.stringify(
            (await runtime.getSelectedContext({ expectedStoreId, sessionId: childScope.sessionId }))
              .messages,
          ),
        ).not.toContain(marker);
        const reviewInput = storedReview.input as Record<string, Json>;
        expect(!!bodyReference(reviewInput.body)).toBe(shape !== 'inline');
        if (shape === 'artifact-private')
          expect(Number(snapshot.bodyBytes)).toBeLessThan(64 * 1024);
        if (shape !== 'inline')
          expect(reviewInput.authorizationReviewBindingDigest).toBe(
            await semanticDigest(carrier.input),
          );
        else expect(JSON.stringify(carrier.input)).toContain(marker);
        const proof = {
          expectedStoreId,
          targetExecutionId: carrier.parentExecutionId!,
          reviewExecutionId: carrier.id,
          policyRevision: 'p1',
          request: reviewRequest,
          reviewer: reviewerIdentity,
        };
        expect((await store.getAuthorizationReview(proof)).decision).toBe('approve_once');
        // The semantic body is not an alternate authority: exact private carrier and proof stay bound.
        const db = new Database(join(root, 'data/owned/core.db'));
        try {
          db.run('UPDATE execution SET intent_json=? WHERE id=?', [
            canonicalJson({
              ...(carrier.input as Record<string, Json>),
              request: { task: 'different' },
            }),
            carrier.id,
          ]);
          let error: unknown;
          try {
            await store.getAuthorizationReview(proof);
          } catch (caught) {
            error = caught;
          }
          expect(error).toMatchObject({ code: 'authorization_review_binding_changed' });
          db.run('UPDATE execution SET intent_json=? WHERE id=?', [
            canonicalJson(carrier.input),
            carrier.id,
          ]);
          const altered = structuredClone(reviewInput);
          if (shape === 'inline') {
            const message = (altered.messages as Record<string, Json>[]).find(
              (item) => item.role === 'user',
            )!;
            const changed = JSON.parse(message.content as string);
            changed.decisionContext.messages[0].content = 'unbound replacement';
            message.content = canonicalJson(changed);
          } else altered.authorizationReviewBindingDigest = '0'.repeat(64);
          db.run('UPDATE execution SET intent_json=? WHERE id=?', [
            canonicalJson(altered),
            actualReview.requestId,
          ]);
          expect((await store.getAuthorizationReview(proof)).decision).not.toBe('approve_once');
          db.run('UPDATE execution SET intent_json=? WHERE id=?', [
            canonicalJson(reviewInput),
            actualReview.requestId,
          ]);
        } finally {
          db.close();
        }
        expect((await store.getAuthorizationReview(proof)).decision).toBe('approve_once');

        // Recreate the pre-fix persisted representation under the same genuine review ancestry.
        // This fixture changes stored history only; it does not replay a historical Provider call.
        const historicalRequest = {
          ...actualReview,
          messages: actualReview.messages.map((message) =>
            message.role === 'user'
              ? {
                  ...message,
                  content: canonicalJson({
                    ...payload,
                    decisionContext: {
                      modelExecutionId: original.requestId,
                      messages: original.messages,
                    },
                  } as unknown as Json),
                }
              : message,
          ),
        };
        const historicalBytes = Buffer.from(canonicalJson(historicalRequest as unknown as Json));
        const historicalHash = await semanticDigest(historicalRequest as unknown as Json);
        const historicalInput =
          shape === 'inline'
            ? (historicalRequest as unknown as Json)
            : {
                ...reviewInput,
                body: {
                  kind: 'model_body',
                  version: 1,
                  reference: await artifacts.publish({
                    expectedStoreId,
                    sessionId: childScope.sessionId,
                    subjectId: 'owner',
                    scope: { kind: 'session', id: childScope.sessionId },
                    refId: `model-body-${historicalHash}`,
                    mediaType: 'application/json',
                    content: historicalBytes,
                  }),
                },
              };
        const model = (await store.getExecution(actualReview.requestId))!;
        const historicalResult = {
          ...(model.result as Record<string, Json>),
          ...(shape === 'inline' ? {} : { modelInputBodyHash: historicalHash }),
        };
        const historyDb = new Database(join(root, 'data/owned/core.db'));
        try {
          const originalMessage = historyDb
            .query('SELECT source_json FROM message WHERE id=?')
            .get(initialMessage.id) as { source_json: string };
          expect(originalMessage.source_json).not.toContain(marker);
          const historicalMessage = JSON.parse(originalMessage.source_json);
          historicalMessage.content = canonicalJson(carrier.input);
          historyDb.run('UPDATE message SET source_json=? WHERE id=?', [
            canonicalJson(historicalMessage),
            initialMessage.id,
          ]);
          historyDb.run('UPDATE message_part SET json=? WHERE message_id=?', [
            canonicalJson(historicalMessage),
            initialMessage.id,
          ]);
          historyDb.run('UPDATE execution SET intent_json=?,result_json=? WHERE id=?', [
            canonicalJson(historicalInput as Json),
            canonicalJson(historicalResult),
            actualReview.requestId,
          ]);
          const historical = await runtime.readModelInput(childScope);
          expect(historical.request).toEqual(actualReview);
          expect(historical.bodyHash).toBe(snapshot.bodyHash);
          expect(historical.bodyBytes).toBe(snapshot.bodyBytes);
          expect(JSON.stringify(historical)).not.toContain(marker);
          expect(JSON.stringify(await runtime.listMessages(childScope.sessionId))).not.toContain(
            marker,
          );
          expect(
            JSON.stringify((await runtime.getView(childScope.sessionId)).messages),
          ).not.toContain(marker);
          expect(
            JSON.stringify(
              (
                await runtime.getSelectedContext({
                  expectedStoreId,
                  sessionId: childScope.sessionId,
                })
              ).messages,
            ),
          ).not.toContain(marker);
          expect(historical.bodyHash).not.toBe(historicalHash);
          if (shape !== 'inline') {
            historyDb.run('UPDATE execution SET result_json=? WHERE id=?', [
              canonicalJson({ ...historicalResult, modelInputBodyHash: '0'.repeat(64) }),
              actualReview.requestId,
            ]);
            let error: unknown;
            try {
              await runtime.readModelInput(childScope);
            } catch (caught) {
              error = caught;
            }
            expect(error).toMatchObject({ code: 'model_body_receipt_invalid' });
            historyDb.run('UPDATE execution SET result_json=? WHERE id=?', [
              canonicalJson(historicalResult),
              actualReview.requestId,
            ]);
          }
          expect((await store.getModelInputSnapshot(childScope)).input).toEqual(
            historicalInput as Json,
          );
          // An ordinary follow-up in this very same review Run is not the bound initial text.
          const ordinaryMessage = { ...historicalMessage, sourceIds: ['ordinary-followup'] };
          historyDb.run('UPDATE message SET source_json=? WHERE id=?', [
            canonicalJson(ordinaryMessage),
            initialMessage.id,
          ]);
          expect(
            (await runtime.listMessages(childScope.sessionId)).find(
              (message) => message.id === initialMessage.id,
            )!.content,
          ).toBe(historicalMessage.content);
          historyDb.run('UPDATE message SET source_json=? WHERE id=?', [
            canonicalJson(historicalMessage),
            initialMessage.id,
          ]);
          if (shape === 'inline') {
            const unrelated = {
              ...historicalRequest,
              messages: historicalRequest.messages.map((message) =>
                message.role === 'user'
                  ? { ...message, sourceIds: ['ordinary-followup'] }
                  : message,
              ),
            };
            historyDb.run('UPDATE execution SET intent_json=? WHERE id=?', [
              canonicalJson(unrelated as unknown as Json),
              actualReview.requestId,
            ]);
            expect((await runtime.readModelInput(childScope)).request).toEqual(unrelated);
            historyDb.run('UPDATE execution SET intent_json=? WHERE id=?', [
              canonicalJson(historicalInput as Json),
              actualReview.requestId,
            ]);
          }
        } finally {
          historyDb.close();
        }
      }
      await runtime.close();
      const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
      const noModel = createFixedModel([]);
      cold = createRuntime({
        store: readonly,
        artifacts: createArtifactStore({ profile, store: readonly }),
        model: noModel,
        modelId: 'unused',
        permissions: {
          async authorize() {
            throw new Error('Inspector must not authorize execution');
          },
        },
      });
      for (const snapshot of inspected) {
        const read = await cold.readModelInput({
          ...scope,
          sessionId: snapshot.sessionId,
          executionId: snapshot.executionId,
        });
        expect(read.request).toEqual(snapshot.request);
        expect(read.bodyHash).toBe(snapshot.bodyHash);
        expect('authorizationReview' in read).toBe(false);
        expect(JSON.stringify(read)).not.toContain(marker);
        expect(JSON.stringify(await cold.listMessages(snapshot.sessionId))).not.toContain(marker);
        expect(JSON.stringify((await cold.getView(snapshot.sessionId)).messages)).not.toContain(
          marker,
        );
        expect(JSON.stringify((await cold.getView(snapshot.sessionId)).runs)).not.toContain(marker);
        expect(JSON.stringify(await cold.getRun(snapshot.runId))).not.toContain(marker);
        const history = await cold.listModelInputs({ ...scope, sessionId: snapshot.sessionId });
        expect(history.items).toHaveLength(1);
      }
      expect(noModel.requests).toHaveLength(0);
      expect(reviewer.requests).toHaveLength(2);
      if (shape === 'artifact-private') {
        await cold.close();
        cold = undefined;
        const backup = await createProfileBackup({
          profile,
          destinationRoot: join(root, 'backup'),
        });
        const restored = await restoreProfileBackup({
          profile,
          expectedStoreId,
          backup,
          intent: 'replace_with_selected_backup',
        });
        expect(restored.storeId).not.toBe(expectedStoreId);
        const restoredStore = await openSqliteStore({ ...profile, mode: 'readonly' });
        cold = createRuntime({
          store: restoredStore,
          artifacts: createArtifactStore({ profile, store: restoredStore }),
          model: noModel,
          permissions: {
            async authorize() {
              throw new Error('Restored Inspector must not authorize execution');
            },
          },
        });
        for (const snapshot of inspected) {
          const read = await cold.readModelInput({
            ...scope,
            expectedStoreId: restored.storeId,
            sessionId: snapshot.sessionId,
            executionId: snapshot.executionId,
          });
          expect(read.storeId).toBe(restored.storeId);
          expect(read.request).toEqual(snapshot.request);
          expect(read.bodyHash).toBe(snapshot.bodyHash);
          expect(JSON.stringify(read)).not.toContain(marker);
          expect(JSON.stringify(await cold.listMessages(snapshot.sessionId))).not.toContain(marker);
          expect(JSON.stringify((await cold.getView(snapshot.sessionId)).runs)).not.toContain(
            marker,
          );
          expect(JSON.stringify(await cold.getRun(snapshot.runId))).not.toContain(marker);
          expect('authorizationReview' in read).toBe(false);
        }
        expect(noModel.requests).toHaveLength(0);
      }
    } finally {
      await cold?.close();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test('ordinary user JSON resembling a review envelope stays verbatim in the Inspector', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-review-text-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'owned' });
  const model = createFixedModel([[finish]]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'ordinary',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'p1' };
      },
    },
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  const content = JSON.stringify(
    {
      purpose: 'authorization_review',
      decisionContext: {
        messages: [{ role: 'assistant', content: 'quoted data', continuation: marker }],
      },
    },
    null,
    2,
  );
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...scope,
      commandId: 'create',
      workspaceId: 'w',
      title: 'owned',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'work',
      request: { kind: 'run.start', content },
    });
    const command = await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const receipt = command.receipt as { runId: string };
    expect(command.request).toEqual({ kind: 'run.start', content });
    expect(command.status).toBe('applied');
    expect(await store.getRun(receipt.runId)).toMatchObject({
      status: 'completed',
      originCommandId: 'work',
    });
    expect(model.requests).toHaveLength(1);
    expect(
      model.requests[0]!.messages.some((message) =>
        message.content.includes('Original input identity:'),
      ),
    ).toBe(false);
    const snapshot = await runtime.readModelInput({
      ...scope,
      executionId: model.requests[0]!.requestId,
    });
    expect(snapshot.request).toEqual(model.requests[0]!);
    expect(snapshot.request.messages.find((message) => message.role === 'user')?.content).toBe(
      content,
    );
    expect(JSON.stringify(snapshot)).toContain(marker);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
