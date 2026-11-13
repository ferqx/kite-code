import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { Database } from '@kite-ai/agent/runtime-sqlite';
import { openSqliteStore, preflightSqliteStore } from '@kite-ai/agent/sqlite';
import type { Json } from '@kite-ai/agent/storage';
import { createFixedModel } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { canonicalJson } from '../../../../packages/agent/src/json';
import { startService } from '../../src';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;
const marker = 'PRIVATE_CHECK_HTTP_CONTINUATION';

for (const shape of ['inline', 'artifact', 'artifact-ask'] as const)
  test(`Service projects ${shape} permission check history through messages, view, context and Inspector`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-check-history-http-')));
    const selected = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
    const profile = { dataRoot: selected.dataRoot, profile: selected.profile };
    const store = await openSqliteStore(profile);
    const asksUser = shape.startsWith('artifact-ask');
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
    const checkRequest = {
      task: 'exact operation',
      ...(asksUser ? { full: 'Human-visible check 雪🙂'.repeat(8000) } : {}),
    };
    const checker = createFixedModel([
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
      artifacts,
      model,
      modelId: 'original',
      authorizationCheck: {
        id: 'checker',
        version: '1',
        modelId: 'separate-check',
        model: checker,
      },
      permissions: {
        async authorize(request) {
          return request.definitionId === 'fixture.effect'
            ? { allowed: false, revision: 'p1', check: { request: checkRequest } }
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
        buildId: 'check-history-test',
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
          if (!card) await sleepTimer(10);
        }
        expect(card).toBeDefined();
        expect(effects).toBe(0);
        expect(card!.request).toMatchObject({
          definitionId: 'fixture.effect',
          definitionVersion: '1',
          input: {},
          options: [{ kind: 'once', optionId: 'once' }],
        });
        publicAttachment = (
          card!.request as unknown as {
            policy: { check: { reference: NonNullable<typeof publicAttachment> } };
          }
        ).policy.check.reference;
        expect(publicAttachment.id).toStartWith('authorization-check-request-');
        const beforeRead = (await store.getMetadata()).lastChangeCursor;
        const response = await download('s', publicAttachment);
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toBe(canonicalJson(checkRequest));
        expect(body).not.toContain(marker);
        expect((await store.getMetadata()).lastChangeCursor).toBe(beforeRead);
        expect(effects).toBe(0);
        expect((await download('s', publicAttachment, 'foreign-store')).status).toBe(409);
        const wrongScope = await download('s', {
          ...publicAttachment,
          scope: { kind: 'session', id: 'missing' },
        });
        expect(wrongScope.status).not.toBe(200);
        expect(await wrongScope.text()).not.toContain(checkRequest.full!);
        {
          // Fresh readonly Worker/Runtime/HTTP instances must authorize a persisted pending
          // current card without consulting the live owner's caches or replaying any work.
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
            buildId: 'check-cold-reader',
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
            expect(await response.text()).toBe(canonicalJson(checkRequest));
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
            expect(checker.requests).toHaveLength(1);
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
              answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
            }),
          },
        );
        expect(answer.status).toBe(202);
      }
      await runtime.waitForCommand('work');
      expect(effects).toBe(1);
      expect(checker.requests).toHaveLength(1);
      expect(JSON.stringify(checker.requests)).not.toContain(marker);
      const modelId = checker.requests[0]!.requestId;
      const checkExecution = (await store.getExecution(modelId))!;
      expect(checkExecution).toMatchObject({
        kind: 'model',
        runId: null,
        childSessionId: null,
        status: 'succeeded',
      });
      expect((await store.listExecutions('s')).every((item) => item.childSessionId === null)).toBe(
        true,
      );
      expect((await store.getView('s')).runs).toHaveLength(1);
      await runtime.createSession({
        ...scope,
        sessionId: 'other',
        commandId: 'create-other',
        workspaceId: 'w',
        title: 'other',
      });
      const payload = (await store.getCommand(checkExecution.originCommandId))!.request as {
        input: Json;
      };
      const child = 'other';
      const get = async (path: string) => {
        const response = await fetch(service!.endpoint + path, {
          headers: { authorization: `Bearer ${service!.bootstrap.token}` },
        });
        const body = await response.text();
        expect({
          status: response.status,
          path,
          error: response.status === 200 ? null : body,
        }).toMatchObject({ status: 200 });
        expect(body).not.toContain(marker);
        return JSON.parse(body);
      };
      const check = async () => {
        const background = await get(
          `/v1/background-executions?storeId=${expectedStoreId}&rootSessionId=s`,
        );
        expect(background.items).toHaveLength(0);
        const messages = await get('/v1/sessions/s/messages');
        expect(
          messages.filter((message: { role: string }) => message.role === 'user'),
        ).toHaveLength(1);
        expect(JSON.stringify(messages)).not.toContain('authorization_check');
        await get('/v1/sessions/s/view');
        await get(`/v1/sessions/s/context?storeId=${expectedStoreId}`);
        const inputs = await get(`/v1/sessions/s/model-inputs?storeId=${expectedStoreId}`);
        expect(
          inputs.items.filter((item: { runId: string | null }) => item.runId === null),
        ).toHaveLength(1);
        const inspected = await get(
          `/v1/sessions/s/executions/${modelId}/model-input?storeId=${expectedStoreId}`,
        );
        expect(inspected.runId).toBeNull();
        await get(`/v1/sessions/s/executions/${modelId}/model-output?storeId=${expectedStoreId}`);
      };
      await check();
      if (shape !== 'inline') {
        const context = (
          payload.input as {
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
        const checkInput = await store.getModelInputSnapshot({
          ...scope,
          executionId: modelId,
        });
        const checkBody = (
          checkInput.input as { body?: { reference: typeof context.modelInput.body.reference } }
        ).body;
        const privateReferences = [
          context.modelInput.body.reference,
          originalOutput.output!.head,
          ...(checkBody ? [checkBody.reference] : []),
        ];
        if (asksUser) expect(checkBody).toBeDefined();
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
          expect(await wrongSession.text()).not.toContain(checkRequest.full!);
          const before = (await store.getMetadata()).lastChangeCursor;
          const reread = await download('s', publicAttachment);
          expect(reread.status).toBe(200);
          expect(await reread.text()).toBe(canonicalJson(checkRequest));
          expect((await store.getMetadata()).lastChangeCursor).toBe(before);
          expect(effects).toBe(1);
          expect(checker.requests).toHaveLength(1);
        }
      }
      await check();
      expect(effects).toBe(1);
      expect(checker.requests).toHaveLength(1);
    } finally {
      if (service) await service.close();
      else await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test('same-major legacy pending Auto attachment profile is rejected without exposing or rewriting its private bodies', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-review-legacy-rejected-')));
  const files = JSON.parse(
    gunzipSync(
      readFileSync(new URL('./fixtures/legacy-auto-pending.json.gz', import.meta.url)),
    ).toString(),
  ) as Record<string, { data: string; mode: number }>;
  try {
    const originals = new Map<string, string>();
    for (const [relative, file] of Object.entries(files)) {
      if (relative === 'ready.json' || relative.startsWith('data/.coordination/')) continue;
      if (relative.startsWith('/') || relative.split('/').includes('..'))
        throw Error('invalid_fixture_path');
      const path = join(root, relative),
        bytes = Buffer.from(file.data, 'base64');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { mode: file.mode });
      chmodSync(path, file.mode);
      originals.set(path, file.data);
    }
    const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
    await expect(preflightSqliteStore(profile)).rejects.toMatchObject({
      code: 'store_incompatible',
    });
    // SQLite may update WAL shared-memory even for readonly inspection. Inspect an
    // independent archive copy so the original rejected profile remains untouched.
    const inspection = join(root, 'inspection');
    mkdirSync(inspection, { mode: 0o700 });
    for (const suffix of ['', '-wal', '-shm']) {
      const file = files[`data/owned/core.db${suffix}`];
      if (file)
        writeFileSync(join(inspection, `core.db${suffix}`), Buffer.from(file.data, 'base64'), {
          mode: file.mode,
        });
    }
    const legacy = new Database(join(inspection, 'core.db'), { readonly: true });
    try {
      expect(
        JSON.parse(readFileSync(join(profile.dataRoot, profile.profile, 'profile.json'), 'utf8'))
          .formatMajor,
      ).toBe(1);
      expect(legacy.query('SELECT format_major FROM storage_meta').get()).toEqual({
        format_major: 1,
      });
      const baseline = readFileSync(
        new URL(
          '../../../../packages/agent/src/storage/migrations/0001-baseline.sql',
          import.meta.url,
        ),
      );
      expect(
        legacy
          .query<{ checksum: string }, []>(
            "SELECT checksum FROM schema_migration WHERE id='0001-baseline'",
          )
          .get()!.checksum,
      ).not.toBe(createHash('sha256').update(baseline).digest('hex'));
    } finally {
      legacy.close(true);
    }

    for (const mode of ['readonly', 'readwrite'] as const)
      await expect(openSqliteStore({ ...profile, mode })).rejects.toMatchObject({
        code: 'store_incompatible',
      });
    for (const [path, bytes] of originals)
      expect(readFileSync(path).toString('base64')).toBe(bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
