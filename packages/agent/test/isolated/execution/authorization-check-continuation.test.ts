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
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;
const marker = 'PRIVATE_ENCRYPTED_REVIEW_CONTINUATION';
const reviewRequest = { task: 'review the exact harmless tool' };
const checkerIdentity = { id: 'checker', version: '1', modelId: 'other-review-binding' };
const semanticData = '{"continuation":"ordinary tool data must remain visible"}';

for (const shape of ['inline', 'artifact-private', 'artifact-semantic'] as const)
  test(`Auto authorization check projects private continuation from ${shape} input without losing its original proof`, async () => {
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
    const checker = createFixedModel(
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
      authorizationCheck: { ...checkerIdentity, model: checker },
      permissions: {
        async authorize(request) {
          return request.definitionId === 'fixture.effect'
            ? { allowed: false, revision: 'p1', check: { request: reviewRequest } }
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
      expect(checker.requests).toHaveLength(2);
      expect(JSON.stringify(ordinary.requests[1])).toContain(marker);
      expect(JSON.stringify(ordinary.requests[2])).toContain(marker);
      expect(JSON.stringify(checker.requests)).not.toContain(marker);
      const executions = await store.listExecutions('s');
      const checks = executions.filter((item) => item.kind === 'model' && item.runId === null);
      expect(checks).toHaveLength(2);
      expect(executions.every((item) => item.childSessionId === null)).toBe(true);
      expect((await store.getView('s')).runs).toHaveLength(1);
      for (const [index, actualCheck] of checker.requests.entries()) {
        const execution = checks.find((item) => item.id === actualCheck.requestId)!;
        expect(execution).toMatchObject({
          kind: 'model',
          runId: null,
          childSessionId: null,
          status: 'succeeded',
        });
        expect(actualCheck.tools).toEqual([]);
        const payload = JSON.parse(
          actualCheck.messages.find((item) => item.role === 'user')!.content,
        );
        const original = ordinary.requests[index + 1]!;
        expect(payload.purpose).toBe('authorization_check');
        expect(payload.decisionContext).toEqual({
          modelExecutionId: original.requestId,
          messages: original.messages.map(({ continuation: _private, ...message }) => message),
        });
        expect(JSON.stringify(payload)).not.toContain(marker);
        expect(JSON.stringify(payload)).toContain('ordinary tool data');
        const checkScope = { ...scope, executionId: execution.id };
        const snapshot = await runtime.readModelInput(checkScope);
        inspected.push(snapshot);
        expect(snapshot.runId).toBeNull();
        expect(snapshot.request).toEqual(actualCheck);
        expect(snapshot.bodyHash).toBe(await semanticDigest(actualCheck as unknown as Json));
        expect(JSON.stringify(snapshot)).not.toContain(marker);
        const stored = await store.getModelInputSnapshot(checkScope);
        expect(stored.authorizationReview).toBeNull();
        const proof = {
          expectedStoreId,
          targetExecutionId: execution.parentExecutionId!,
          checkExecutionId: execution.id,
          policyRevision: 'p1',
          request: reviewRequest,
          checker: checkerIdentity,
        };
        expect((await store.getAuthorizationCheck(proof)).decision).toBe('approve_once');
        const db = new Database(join(root, 'data/owned/core.db'));
        try {
          const changed = structuredClone(stored.input) as Record<string, Json>;
          changed.authorizationCheckBindingDigest = '0'.repeat(64);
          db.run('UPDATE execution SET intent_json=? WHERE id=?', [
            canonicalJson(changed),
            execution.id,
          ]);
          let rejected = false;
          try {
            rejected = (await store.getAuthorizationCheck(proof)).decision !== 'approve_once';
          } catch {
            rejected = true;
          }
          expect(rejected).toBe(true);
          db.run('UPDATE execution SET intent_json=? WHERE id=?', [
            canonicalJson(stored.input),
            execution.id,
          ]);
          expect((await store.getAuthorizationCheck(proof)).decision).toBe('approve_once');
        } finally {
          db.close();
        }
      }
      expect(JSON.stringify(await runtime.listMessages('s'))).not.toContain(marker);
      const before = (await store.getMetadata()).lastChangeCursor;
      await runtime.close();
      const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
      const noModel = createFixedModel([]);
      cold = createRuntime({
        store: readonly,
        artifacts: createArtifactStore({ profile, store: readonly }),
        model: noModel,
        permissions: {
          async authorize() {
            throw new Error('Cold Inspector must never authorize');
          },
        },
      });
      for (const snapshot of inspected) {
        const read = await cold.readModelInput({ ...scope, executionId: snapshot.executionId });
        expect(read.request).toEqual(snapshot.request);
        expect(read.bodyHash).toBe(snapshot.bodyHash);
        expect(read.runId).toBeNull();
        expect(JSON.stringify(read)).not.toContain(marker);
      }
      expect((await readonly.getMetadata()).lastChangeCursor).toBe(before);
      expect(noModel.requests).toHaveLength(0);
      expect(checker.requests).toHaveLength(2);
    } finally {
      await cold?.close();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test('ordinary user JSON resembling a check envelope stays verbatim in the Inspector', async () => {
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
