import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ArtifactReference, Json } from '@kite-ai/agent/storage';
import { createFixedModel } from '@kite-ai/ai';
import { canonicalJson } from '../../../../packages/agent/src/json';
import { startService } from '../../src';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;
const marker = 'PRIVATE_REVIEW_HTTP_CONTINUATION';

for (const shape of ['inline', 'artifact', 'artifact-ask', 'artifact-ask-legacy'] as const)
  test(`Service projects ${shape} review history through messages, view, context and Inspector`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-review-history-http-')));
    const selected = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
    const profile = { dataRoot: selected.dataRoot, profile: selected.profile };
    const store = await openSqliteStore(profile);
    const asksUser = shape.startsWith('artifact-ask');
    const legacy = shape === 'artifact-ask-legacy';
    const artifacts = createArtifactStore({ profile, store });
    const model = createFixedModel([
      [
        { type: 'tool_call', id: 'first', name: 'fixture.noop', arguments: '{}' },
        {
          ...finish,
          reason: 'tool_calls',
          continuation: { encrypted: marker + (shape !== 'inline' ? 'x'.repeat(80 * 1024) : '') },
        },
      ],
      [
        { type: 'tool_call', id: 'second', name: 'fixture.effect', arguments: '{}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    const reviewRequest = {
      task: 'exact operation',
      ...(asksUser ? { full: 'Human-visible review 雪🙂'.repeat(8000) } : {}),
    };
    const reviewer = createFixedModel([
      [
        {
          type: 'text_delta',
          text: JSON.stringify({
            decision: asksUser ? 'ask_user' : 'approve_once',
            reason: 'exact harmless operation',
          }),
        },
        finish,
      ],
    ]);
    let effects = 0;
    const runtime = createRuntime({
      store,
      artifacts: {
        ...artifacts,
        // Reproduce the original producer without editing any persisted identity or binding.
        publish: (input) =>
          artifacts.publish({
            ...input,
            refId: legacy
              ? input.refId.replace(/^authorization-review-request-/, 'model-body-')
              : input.refId,
          }),
      },
      model,
      modelId: 'original',
      authorizationReview: {
        id: 'reviewer',
        version: '1',
        modelId: 'separate-review',
        model: reviewer,
      },
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
            description: 'Local harmless fixture',
            inputSchema: { type: 'object' },
            async execute() {
              if (id === 'fixture.effect') effects++;
              return { outcome: 'succeeded' as const, content: 'visible result' };
            },
          })),
        },
      ],
    });
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    try {
      service = await startService({
        runtime,
        profile: {
          dataRoot: selected.dataRoot,
          name: selected.profile,
          accessKey: selected.profileAccessKey,
        },
        buildId: 'review-history-test',
        subjectId: 'owner',
      });
      const expectedStoreId = (await store.getMetadata()).storeId;
      const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
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
        request: { kind: 'run.start', content: 'Run the harmless tools' },
      });
      let publicAttachment: { id: string; scope: { kind: string; id: string } } | undefined;
      const download = (
        sessionId: string,
        ref: { id: string; scope: { kind: string; id: string } },
        storeId = expectedStoreId,
      ) =>
        fetch(
          `${service!.endpoint}/v1/sessions/${sessionId}/artifacts/${ref.id}?${new URLSearchParams({ storeId, scopeKind: ref.scope.kind, scopeId: ref.scope.id })}`,
          { headers: { authorization: `Bearer ${service!.bootstrap.token}` } },
        );
      if (asksUser) {
        let card:
          | Awaited<ReturnType<typeof runtime.listInteractions>>['interactions'][number]
          | undefined;
        const deadline = Date.now() + 10000;
        while (!card && Date.now() < deadline) {
          const response = await fetch(
            `${service.endpoint}/v1/sessions/s/interactions?storeId=${expectedStoreId}&state=pending`,
            {
              headers: { authorization: `Bearer ${service.bootstrap.token}` },
            },
          );
          expect(response.status).toBe(200);
          const body = await response.text();
          expect(body).not.toContain(marker);
          card = JSON.parse(body).interactions[0];
          if (!card) await Bun.sleep(10);
        }
        expect(card).toBeDefined();
        expect(effects).toBe(0);
        publicAttachment = (
          card!.request as unknown as {
            policy: { review: { reference: NonNullable<typeof publicAttachment> } };
          }
        ).policy.review.reference;
        expect(publicAttachment.id).toStartWith(
          legacy ? 'model-body-' : 'authorization-review-request-',
        );
        const beforeRead = (await store.getMetadata()).lastChangeCursor;
        const response = await download('s', publicAttachment);
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(JSON.parse(body)).toEqual(reviewRequest);
        expect(body).not.toContain(marker);
        expect((await store.getMetadata()).lastChangeCursor).toBe(beforeRead);
        expect(effects).toBe(0);
        expect((await download('s', publicAttachment, 'foreign-store')).status).toBe(409);
        const wrongScope = await download('s', {
          ...publicAttachment,
          scope: { kind: 'session', id: 'missing' },
        });
        expect(wrongScope.status).not.toBe(200);
        expect(await wrongScope.text()).not.toContain(reviewRequest.full!);
        if (legacy) {
          // Fresh readonly Worker/Runtime/HTTP instances must authorize a persisted pending
          // legacy card without consulting the live owner's caches or replaying any work.
          const coldStore = await openSqliteStore({ ...profile, mode: 'readonly' });
          const coldModel = createFixedModel([]);
          const coldRuntime = createRuntime({
            store: coldStore,
            artifacts: createArtifactStore({ profile, store: coldStore }),
            model: coldModel,
            modelId: 'offline',
            permissions: {
              async authorize() {
                throw new Error('readonly permission evaluation');
              },
            },
          });
          const coldService = await startService({
            runtime: coldRuntime,
            profile: {
              dataRoot: selected.dataRoot,
              name: selected.profile,
              accessKey: selected.profileAccessKey,
            },
            buildId: 'legacy-review-cold-reader',
            subjectId: 'owner',
          });
          try {
            const before = await coldStore.getMetadata();
            const coldCard = await coldRuntime.getInteraction({
              ...scope,
              interactionId: card!.id,
            });
            expect(coldCard!.state).toBe('pending');
            expect(coldCard!.request).toEqual(card!.request);
            const response = await fetch(
              `${coldService.endpoint}/v1/sessions/s/artifacts/${publicAttachment.id}?${new URLSearchParams({ storeId: expectedStoreId, scopeKind: publicAttachment.scope.kind, scopeId: publicAttachment.scope.id })}`,
              { headers: { authorization: `Bearer ${coldService.bootstrap.token}` } },
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual(reviewRequest);
            const original = (await coldStore.listExecutions('s')).filter(
              (e) => e.kind === 'model',
            );
            for (const execution of original) {
              const saved = await coldStore.getModelInputSnapshot({
                ...scope,
                executionId: execution.id,
              });
              const body = (
                saved.input as {
                  body?: { reference: { id: string; scope: { kind: string; id: string } } };
                }
              ).body;
              if (!body) continue;
              const denied = await fetch(
                `${coldService.endpoint}/v1/sessions/s/artifacts/${body.reference.id}?${new URLSearchParams({ storeId: expectedStoreId, scopeKind: body.reference.scope.kind, scopeId: body.reference.scope.id })}`,
                { headers: { authorization: `Bearer ${coldService.bootstrap.token}` } },
              );
              expect(denied.status).toBe(403);
              expect(await denied.text()).not.toContain(marker);
            }
            expect(await coldStore.getMetadata()).toEqual(before);
            expect(coldModel.requests).toHaveLength(0);
            expect(effects).toBe(0);
            expect(reviewer.requests).toHaveLength(1);
          } finally {
            await coldService.close();
          }
        }
        const answer = await fetch(
          `${service.endpoint}/v1/sessions/s/interactions/${card!.id}/answer`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${service.bootstrap.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              expectedStoreId,
              commandId: 'human-approve',
              expectedRevision: card!.revision,
              answer: { kind: 'approval', decision: 'approve' },
            }),
          },
        );
        expect(answer.status).toBe(202);
      }
      await runtime.waitForCommand('work');
      expect(effects).toBe(1);
      expect(reviewer.requests).toHaveLength(1);
      expect(JSON.stringify(reviewer.requests)).not.toContain(marker);
      const carrier = (await store.listExecutions('s')).find(
        (execution) => execution.childSessionId,
      )!;
      const child = carrier.childSessionId!;
      const modelId = reviewer.requests[0]!.requestId;
      const childRun = (await store.getView(child)).runs[0]!;
      const get = async (path: string) => {
        const response = await fetch(service!.endpoint + path, {
          headers: { authorization: `Bearer ${service!.bootstrap.token}` },
        });
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(body).not.toContain(marker);
        return JSON.parse(body);
      };
      const check = async () => {
        const messages = await get(`/v1/sessions/${child}/messages`);
        expect(messages.some((message: { role: string }) => message.role === 'user')).toBe(true);
        await get(`/v1/sessions/${child}/view`);
        await get(`/v1/runs/${childRun.id}`);
        await get(`/v1/sessions/${child}/context?storeId=${expectedStoreId}`);
        const inputs = await get(`/v1/sessions/${child}/model-inputs?storeId=${expectedStoreId}`);
        expect(inputs.items).toHaveLength(1);
        await get(
          `/v1/sessions/${child}/executions/${modelId}/model-input?storeId=${expectedStoreId}`,
        );
      };
      await check();
      if (shape !== 'inline') {
        const context = (
          carrier.input as {
            decisionContext: {
              modelInput: {
                body: {
                  reference: {
                    id: string;
                    sessionId: string;
                    scope: { kind: string; id: string };
                  };
                };
              };
            };
          }
        ).decisionContext;
        const originalOutput = await store.getModelOutputSnapshot({
          ...scope,
          executionId: model.requests[0]!.requestId,
        });
        const reviewInput = await store.getModelInputSnapshot({
          ...scope,
          sessionId: child,
          executionId: modelId,
        });
        const reviewBody = (
          reviewInput.input as { body?: { reference: typeof context.modelInput.body.reference } }
        ).body;
        const privateReferences = [
          context.modelInput.body.reference,
          originalOutput.output!.head,
          ...(reviewBody ? [reviewBody.reference] : []),
        ];
        if (asksUser) expect(reviewBody).toBeDefined();
        for (const ref of privateReferences) {
          for (const sessionId of new Set([ref.sessionId, 's', child])) {
            const response = await download(sessionId, ref);
            expect(response.status).toBe(403);
            const body = await response.text();
            expect(body).toContain('artifact_scope_denied');
            expect(body).not.toContain(marker);
          }
        }
        if (publicAttachment) {
          const wrongSession = await download(child, publicAttachment);
          expect(wrongSession.status).not.toBe(200);
          expect(await wrongSession.text()).not.toContain(reviewRequest.full!);
          const before = (await store.getMetadata()).lastChangeCursor;
          const reread = await download('s', publicAttachment);
          expect(reread.status).toBe(200);
          expect(await reread.json()).toEqual(reviewRequest);
          expect((await store.getMetadata()).lastChangeCursor).toBe(before);
          expect(effects).toBe(1);
          expect(reviewer.requests).toHaveLength(1);
        }
      }
      // A pre-fix initial Message used the private carrier payload as plain user text.
      const initial = (await runtime.listMessages(child)).find(
        (message) => message.role === 'user',
      )!;
      const db = new Database(selected.databasePath);
      try {
        const row = db.query('SELECT source_json FROM message WHERE id=?').get(initial.id) as {
          source_json: string;
        };
        const old = JSON.parse(row.source_json);
        old.content = JSON.stringify(carrier.input);
        db.run('UPDATE message SET source_json=? WHERE id=?', [JSON.stringify(old), initial.id]);
        db.run('UPDATE message_part SET json=? WHERE message_id=?', [
          JSON.stringify(old),
          initial.id,
        ]);
      } finally {
        db.close();
      }
      await check();
      expect(effects).toBe(1);
      expect(reviewer.requests).toHaveLength(1);
    } finally {
      if (service) await service.close();
      else await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test('Legacy pending Auto attachment survives SIGKILL and cold HTTP reads without exposing private bodies', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-review-legacy-cold-')));
  const selected = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const profile = { dataRoot: selected.dataRoot, profile: selected.profile };
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('./authorization-review-legacy-fixture.ts', import.meta.url).pathname,
    ],
    {
      env: { ...process.env, KITE_REVIEW_FIXTURE_ROOT: root },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    const ready = join(root, 'ready.json');
    const deadline = Date.now() + 15000;
    while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null)
      await Bun.sleep(20);
    if (!existsSync(ready)) {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      throw new Error(`Legacy producer failed: ${await new Response(child.stderr).text()}`);
    }
    child.kill('SIGKILL');
    await child.exited;
    const saved = JSON.parse(readFileSync(ready, 'utf8')) as {
      expectedStoreId: string;
      card: { id: string; request: { policy: { review: { reference: ArtifactReference } } } };
      request: Json;
      privateReferences: ArtifactReference[];
      child: string;
    };
    const store = await openSqliteStore({ ...profile, mode: 'readonly' });
    const model = createFixedModel([]);
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model,
      modelId: 'offline',
      permissions: {
        async authorize() {
          throw new Error('Cold read attempted authorization');
        },
      },
    });
    service = await startService({
      runtime,
      profile: {
        dataRoot: selected.dataRoot,
        name: selected.profile,
        accessKey: selected.profileAccessKey,
      },
      buildId: 'legacy-cold-test',
      subjectId: 'owner',
    });
    const scope = { expectedStoreId: saved.expectedStoreId, sessionId: 's', subjectId: 'owner' };
    const publicRef = saved.card.request.policy.review.reference;
    expect(publicRef.id).toStartWith('model-body-');
    const before = await store.getMetadata();
    const executions = await store.listExecutions('s');
    const card = await runtime.getInteraction({ ...scope, interactionId: saved.card.id });
    expect(card!.state).toBe('pending');
    expect(card!.request).toEqual(saved.card.request as unknown as Json);
    const download = (
      sessionId: string,
      ref: Pick<ArtifactReference, 'id' | 'scope'>,
      storeId = scope.expectedStoreId,
    ) =>
      fetch(
        `${service!.endpoint}/v1/sessions/${sessionId}/artifacts/${ref.id}?${new URLSearchParams({ storeId, scopeKind: ref.scope.kind, scopeId: ref.scope.id })}`,
        { headers: { authorization: `Bearer ${service!.bootstrap.token}` } },
      );
    const publicResponse = await download('s', publicRef);
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toEqual(saved.request);
    expect((await download('s', publicRef, 'foreign-store')).status).toBe(409);
    expect((await download(saved.child, publicRef)).status).not.toBe(200);
    await expect(
      runtime.readArtifact({
        ...scope,
        subjectId: 'foreign-subject',
        refId: publicRef.id,
        scope: publicRef.scope,
      }),
    ).rejects.toMatchObject({ code: 'artifact_scope_denied' });
    expect(saved.privateReferences.length).toBeGreaterThanOrEqual(4);
    for (const ref of saved.privateReferences) {
      for (const sessionId of new Set([ref.sessionId, 's', saved.child])) {
        const denied = await download(sessionId, ref);
        expect(denied.status).toBe(403);
        const body = await denied.text();
        expect(body).toContain('artifact_scope_denied');
        expect(body).not.toContain('PRIVATE_LEGACY_COLD');
        expect(body).not.toContain('PRIVATE_REVIEWER_COLD');
      }
    }
    // Even a self-consistent card digest must not authorize a private model input:
    // it is not the requestBody sealed on the original review carrier.
    const db = new Database(selected.databasePath);
    try {
      const old = db.query('SELECT * FROM interaction WHERE id=?').get(saved.card.id) as Record<
        string,
        string | number | null
      >;
      const privateRef = saved.privateReferences.find(
        (ref) => ref.sessionId === 's' && ref.id.startsWith('model-body-'),
      )!;
      const request = structuredClone(saved.card.request);
      request.policy.review.reference = {
        id: privateRef.id,
        mediaType: privateRef.mediaType,
        size: privateRef.size,
        scope: privateRef.scope,
      } as ArtifactReference;
      const digest = createHash('sha256')
        .update(
          canonicalJson({
            executionId: String(old.execution_id),
            attempt: Number(old.attempt),
            kind: 'approval',
            definitionId: String(old.definition_id),
            definitionVersion: String(old.definition_version),
            inputDigest: String(old.input_digest),
            policyRevision: String(old.policy_revision),
            requiredRefs: JSON.parse(String(old.required_refs_json)),
            source: JSON.parse(String(old.source_json)),
            request: request as unknown as Json,
          }),
        )
        .digest('hex');
      db.run('UPDATE interaction SET request_json=?,request_digest=? WHERE id=?', [
        canonicalJson(request as unknown as Json),
        digest,
        saved.card.id,
      ]);
      expect((await download('s', privateRef)).status).toBe(403);
      expect((await download('s', publicRef)).status).toBe(403);
      db.run('UPDATE interaction SET request_json=?,request_digest=? WHERE id=?', [
        String(old.request_json),
        String(old.request_digest),
        saved.card.id,
      ]);
      const restored = await download('s', publicRef);
      expect(restored.status).toBe(200);
      expect(await restored.json()).toEqual(saved.request);
    } finally {
      db.close();
    }
    expect(await store.getMetadata()).toEqual(before);
    expect(await store.listExecutions('s')).toEqual(executions);
    expect((await runtime.getInteraction({ ...scope, interactionId: saved.card.id }))!.state).toBe(
      'pending',
    );
    expect(model.requests).toHaveLength(0);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    if (service) await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
